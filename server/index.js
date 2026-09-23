import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import express from 'express'
import { SignJWT, jwtVerify } from 'jose'
import pg from 'pg'

dotenv.config()

const { Pool } = pg
const app = express()
const port = Number(process.env.PORT ?? 3001)
const basePath = normalizeBasePath(process.env.BASE_PATH ?? '/corporate/QRCode')
const cookiePath = basePath || '/'
const sessionCookieName = 'event_checkin_session'
const sessionMaxAgeSeconds = 8 * 60 * 60
const rateLimitWindowMs = 60_000
const defaultRateLimit = 60
const defaultEventName = 'Event Check-In'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(__dirname, '..', 'dist')

app.set('trust proxy', 1)
app.use(express.json({ limit: '10mb' }))

const pool = new Pool({
  connectionString: requireEnv('DATABASE_URL'),
  ssl:
    process.env.POSTGRES_SSL === 'false'
      ? false
      : {
          rejectUnauthorized: false,
        },
})

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err)
})

const api = express.Router()

api.get('/health', (_req, res) => {
  res.json({ ok: true })
})

api.get('/health/db', async (_req, res) => {
  try {
    const result = await query(
      `
        select
          current_database() as database,
          current_user as user,
          now() as server_time
      `,
    )

    res.json({
      ok: true,
      database: result.rows[0]?.database,
      user: result.rows[0]?.user,
      serverTime: result.rows[0]?.server_time,
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Database connection failed.',
    })
  }
})

api.post('/login', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' })
      return
    }

    const result = await query(
      `
        select id::text, email, password_hash, role, client_id::text
        from public.users
        where lower(email) = $1
        limit 1
      `,
      [email],
    )
    const userRow = result.rows[0]

    if (!userRow || !(await bcrypt.compare(password, userRow.password_hash))) {
      res.status(401).json({ error: 'Invalid email or password.' })
      return
    }

    const user = {
      id: userRow.id,
      email: userRow.email,
      role: normalizeRole(userRow.role),
      clientId: userRow.client_id,
    }
    const token = await createSessionToken(user)

    setSessionCookie(res, token)
    res.json({ user })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to sign in.',
    })
  }
})

api.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user })
})

api.post('/logout', (_req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})

api.get('/settings', requireUser, async (_req, res) => {
  try {
    const result = await query(`select value from public.app_settings where key = 'event_name' limit 1`)

    res.json({
      eventName: result.rows[0]?.value ?? defaultEventName,
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load settings.',
    })
  }
})

api.put('/settings', requireAdmin, async (req, res) => {
  try {
    const eventName =
      typeof req.body?.eventName === 'string' && req.body.eventName.trim()
        ? req.body.eventName.trim()
        : defaultEventName

    await query(
      `
        insert into public.app_settings (key, value, updated_by)
        values ('event_name', $1, $2)
        on conflict (key) do update
        set value = excluded.value,
            updated_by = excluded.updated_by,
            updated_at = now()
      `,
      [eventName, req.user.id],
    )

    res.json({ eventName })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to save settings.',
    })
  }
})

api.get('/summary', requireUser, async (_req, res) => {
  try {
    const result = await query(
      `
        select
          count(*)::text as total,
          count(*) filter (where checked_in = true)::text as checked_in
        from public.attendees
      `,
    )
    const row = result.rows[0]
    const total = Number(row?.total ?? 0)
    const checkedIn = Number(row?.checked_in ?? 0)

    res.json({
      total,
      checkedIn,
      notCheckedIn: Math.max(total - checkedIn, 0),
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load attendance summary.',
    })
  }
})

api.get('/attendees', requireAdmin, async (_req, res) => {
  try {
    const result = await query(
      `
        select
          id,
          name,
          email,
          unique_id,
          qr_code,
          company,
          ticket_type,
          checked_in,
          check_in_time,
          imported_at,
          source_row,
          original
        from public.attendees
        order by source_row asc, name asc
      `,
    )

    res.json({ attendees: result.rows })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load attendees.',
    })
  }
})

api.delete('/attendees', requireAdmin, async (_req, res) => {
  try {
    await query(`delete from public.attendees`)
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to clear attendees.',
    })
  }
})

api.post('/attendees/import', requireAdmin, async (req, res) => {
  const incomingAttendees = Array.isArray(req.body?.attendees) ? req.body.attendees : []

  if (incomingAttendees.length === 0) {
    res.status(400).json({ error: 'No attendee records provided.' })
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    let importedCount = 0
    const seenCodes = new Set()
    const validAttendees = []

    for (const item of incomingAttendees) {
      const qrCode = typeof item.qrCode === 'string' ? item.qrCode.trim() : ''
      if (!qrCode) continue

      const normalized = qrCode.toLowerCase()
      if (seenCodes.has(normalized)) continue
      seenCodes.add(normalized)

      const id =
        typeof item.id === 'string' && item.id.trim()
          ? item.id.trim()
          : `att-${crypto.randomUUID()}`
      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : 'Unnamed attendee'
      const email = typeof item.email === 'string' ? item.email.trim() : ''
      const uniqueId = typeof item.uniqueId === 'string' ? item.uniqueId.trim() : ''
      const company = typeof item.company === 'string' ? item.company.trim() : ''
      const ticketType = typeof item.ticketType === 'string' ? item.ticketType.trim() : ''
      const sourceRow = typeof item.sourceRow === 'number' ? item.sourceRow : 0
      const original =
        item.original && typeof item.original === 'object'
          ? JSON.stringify(item.original)
          : '{}'

      validAttendees.push({
        id,
        name,
        email,
        uniqueId,
        qrCode,
        company,
        ticketType,
        sourceRow,
        original,
      })
    }

    if (validAttendees.length === 0) {
      await client.query('ROLLBACK')
      res.status(400).json({ error: 'No valid attendees with QR codes were found in the import.' })
      return
    }

    const batchSize = 100
    for (let i = 0; i < validAttendees.length; i += batchSize) {
      const chunk = validAttendees.slice(i, i + batchSize)
      const values = []
      const valueClauses = []

      for (const att of chunk) {
        const offset = values.length
        valueClauses.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::jsonb)`
        )
        values.push(
          att.id,
          att.name,
          att.email,
          att.uniqueId,
          att.qrCode,
          att.company,
          att.ticketType,
          att.sourceRow,
          att.original,
        )
      }

      const insertQuery = `
        insert into public.attendees (
          id, name, email, unique_id, qr_code, company, ticket_type, source_row, original
        )
        values ${valueClauses.join(', ')}
        on conflict (qr_code_normalized) do update
        set name = excluded.name,
            email = excluded.email,
            unique_id = excluded.unique_id,
            company = excluded.company,
            ticket_type = excluded.ticket_type,
            source_row = excluded.source_row,
            original = excluded.original,
            updated_at = now()
      `
      const result = await client.query(insertQuery, values)
      importedCount += result.rowCount ?? 0
    }

    await client.query('COMMIT')

    res.json({
      ok: true,
      count: importedCount,
      message: `Successfully imported ${importedCount} attendee${importedCount === 1 ? '' : 's'}.`,
    })
  } catch (error) {
    await client.query('ROLLBACK')
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to import attendees.',
    })
  } finally {
    client.release()
  }
})

api.post('/verify-scan', requireUser, async (req, res) => {
  try {
    const scannedCode = typeof req.body?.code === 'string' ? req.body.code.trim() : ''

    if (!scannedCode) {
      res.status(400).json({ error: 'Missing scanned QR code.' })
      return
    }

    const rateLimit = Number(process.env.SCAN_RATE_LIMIT_PER_MINUTE ?? defaultRateLimit)
    const windowStart = new Date(Date.now() - rateLimitWindowMs).toISOString()
    const countResult = await query(
      `
        select count(*)::text as count
        from public.scan_attempts
        where staff_user_id = $1
          and created_at >= $2
      `,
      [req.user.id, windowStart],
    )

    if (Number(countResult.rows[0]?.count ?? 0) >= rateLimit) {
      res.status(429).json({
        status: 'rate_limited',
        retryAfterSeconds: Math.ceil(rateLimitWindowMs / 1000),
      })
      return
    }

    await query(
      `
        insert into public.scan_attempts (staff_user_id, ip_address, code_hash)
        values ($1, $2, $3)
      `,
      [req.user.id, getClientIp(req), hashValue(scannedCode)],
    )

    const candidates = buildCodeCandidates(scannedCode)
    const matchResult = await query(
      `
        select id, name, checked_in, check_in_time
        from public.attendees
        where qr_code_normalized = any($1::text[])
        limit 1
      `,
      [candidates],
    )
    const attendee = matchResult.rows[0]

    if (!attendee) {
      res.json({ status: 'not_found' })
      return
    }

    if (attendee.checked_in) {
      res.json({
        status: 'duplicate',
        attendee: {
          name: attendee.name,
          checkInTime: attendee.check_in_time,
        },
      })
      return
    }

    const updateResult = await query(
      `
        update public.attendees
        set checked_in = true,
            check_in_time = now(),
            checked_in_by = $2,
            updated_at = now()
        where id = $1
          and checked_in = false
        returning name, check_in_time
      `,
      [attendee.id, req.user.id],
    )
    const checkedInAttendee = updateResult.rows[0]

    if (!checkedInAttendee) {
      res.json({
        status: 'duplicate',
        attendee: {
          name: attendee.name,
          checkInTime: new Date().toISOString(),
        },
      })
      return
    }

    res.json({
      status: 'checked_in',
      attendee: {
        name: checkedInAttendee.name,
        checkInTime: checkedInAttendee.check_in_time,
      },
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to verify QR code.',
    })
  }
})

app.use(`${basePath}/api`, api)
app.use('/api', api)
if (basePath) {
  app.get(basePath, (_req, res) => {
    res.redirect(308, `${basePath}/`)
  })
}
app.use(cookiePath, express.static(distPath))
app.use(cookiePath, (req, res, next) => {
  if (req.method !== 'GET') {
    next()
    return
  }

  res.sendFile(path.join(distPath, 'index.html'))
})

const server = app.listen(port, () => {
  console.log(`Event check-in server listening on http://localhost:${port}${basePath}`)
})

server.on('error', (error) => {
  console.error('Event check-in server failed to start:', error)
  process.exitCode = 1
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
  server.close(() => {
    pool.end().finally(() => {
      process.exit(0)
    })
  })
}

async function query(text, values = []) {
  return pool.query(text, values)
}

async function createSessionToken(user) {
  return new SignJWT(user)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${sessionMaxAgeSeconds}s`)
    .sign(getJwtSecret())
}

async function authenticate(req) {
  const token = getCookie(req, sessionCookieName) || getBearerToken(req)

  if (!token) {
    return null
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret())

    if (!payload.id || !payload.email || !payload.role) {
      return null
    }

    return {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      clientId: payload.clientId ?? null,
    }
  } catch {
    return null
  }
}

async function requireUser(req, res, next) {
  const user = await authenticate(req)

  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.user = user
  next()
}

async function requireAdmin(req, res, next) {
  const user = await authenticate(req)

  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }

  req.user = user
  next()
}

function setSessionCookie(res, token) {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: cookiePath,
    maxAge: sessionMaxAgeSeconds * 1000,
  })
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: cookiePath,
  })
}

function normalizeRole(role) {
  return String(role).toLowerCase() === 'admin' ? 'admin' : 'scanner'
}

function getJwtSecret() {
  const jwtSecret = requireEnv('JWT_SECRET')

  if (jwtSecret.length < 32) {
    throw new Error('Missing JWT_SECRET. Use a random value at least 32 characters long.')
  }

  return new TextEncoder().encode(jwtSecret)
}

function getBearerToken(req) {
  const authorization = req.headers.authorization

  if (!authorization?.startsWith('Bearer ')) {
    return ''
  }

  return authorization.slice('Bearer '.length).trim()
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie

  if (!cookieHeader) {
    return ''
  }

  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim())
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`))

  return match ? decodeURIComponent(match.slice(name.length + 1)) : ''
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for']

  if (typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0]?.trim() ?? 'unknown'
  }

  return req.socket.remoteAddress ?? 'unknown'
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeCode(value) {
  return value.trim().toLowerCase()
}

function buildCodeCandidates(value) {
  const trimmedValue = value.trim()
  const candidates = new Set()
  addCandidate(candidates, trimmedValue)

  try {
    addCandidate(candidates, decodeURIComponent(trimmedValue))
  } catch {
    // Non-URI QR values are still matched as plain text.
  }

  try {
    const url = new URL(trimmedValue)
    addCandidate(candidates, url.href)
    addCandidate(candidates, url.pathname.split('/').filter(Boolean).at(-1) ?? '')

    for (const key of [
      'code',
      'qr',
      'qrcode',
      'badge',
      'badgecode',
      'id',
      'attendeeid',
      'registrationid',
      'inviteeid',
      'confirmation',
      'confirmationnumber',
    ]) {
      addCandidate(candidates, url.searchParams.get(key) ?? '')
    }

    for (const queryValue of url.searchParams.values()) {
      addCandidate(candidates, queryValue)
    }
  } catch {
    return [...candidates]
  }

  return [...candidates]
}

function addCandidate(candidates, value) {
  const normalizedValue = normalizeCode(value)

  if (normalizedValue) {
    candidates.add(normalizedValue)
  }
}

function normalizeBasePath(value) {
  const trimmedValue = value.trim()

  if (!trimmedValue || trimmedValue === '/') {
    return ''
  }

  return `/${trimmedValue.replace(/^\/+|\/+$/g, '')}`
}

function requireEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing ${name}.`)
  }

  return value
}
