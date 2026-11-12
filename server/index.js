import crypto from 'node:crypto'
import { apiMountPaths } from './paths.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import express from 'express'
import { SignJWT, jwtVerify } from 'jose'
import pg from 'pg'
import {
  getCventStatus,
  syncAttendeesFromCvent,
  findAndImportCventAttendee,
  startCventBackgroundSync,
} from './cvent.js'

dotenv.config()

const { Pool } = pg
const app = express()
const port = Number(process.env.PORT ?? 30061)
const basePath = normalizeBasePath(process.env.BASE_PATH ?? '/corporate/QrCode')
const cookiePath = basePath || '/'
const sessionCookieName = 'event_checkin_session'
const sessionMaxAgeSeconds = 8 * 60 * 60
const rateLimitWindowMs = 60_000
const defaultRateLimit = 60
const loginRateLimitWindowMs = 15 * 60_000
const loginRateLimitMaxAttempts = Number(process.env.LOGIN_RATE_LIMIT_PER_15_MINUTES ?? 10)
const maxImportAttendees = Number(process.env.MAX_IMPORT_ATTENDEES ?? 5000)
const defaultEventName = 'Event Check-In'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(__dirname, '..', 'dist')
const loginAttempts = new Map()
const isProduction = process.env.NODE_ENV === 'production'
const useSecureCookies = process.env.COOKIE_SECURE === 'true' || isProduction

app.set('trust proxy', 1)
app.use(allowFrontendOrigin)
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

async function ensureSchema() {
  try {
    await pool.query(`
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS admission_item text NOT NULL DEFAULT '';
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS sessions text NOT NULL DEFAULT '';
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS photo text NOT NULL DEFAULT '';
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS goodie_bag boolean NOT NULL DEFAULT false;
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS goodie_bag_time timestamptz;
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS goodie_bag_by uuid REFERENCES public.users(id);
      ALTER TABLE public.attendees ADD COLUMN IF NOT EXISTS cvent_id text;
      CREATE INDEX IF NOT EXISTS attendees_goodie_bag_idx ON public.attendees (goodie_bag);
      CREATE INDEX IF NOT EXISTS attendees_cvent_id_idx ON public.attendees (cvent_id);
    `)

    const defaultPasswordHash = await bcrypt.hash('admin123', 10)
    await pool.query(
      `
        INSERT INTO public.users (id, email, password_hash, role, must_change_password)
        VALUES 
          (gen_random_uuid(), 'adrian.ciurcanu@newconcepttravel.com', $1, 'admin', false),
          (gen_random_uuid(), 'alexandru.goran@newconcepttravel.com', $1, 'admin', false)
        ON CONFLICT (email) DO UPDATE
        SET password_hash = excluded.password_hash,
            role = excluded.role;
      `,
      [defaultPasswordHash],
    )
  } catch (err) {
    console.warn('Database schema check warning:', err.message)
  }
}
ensureSchema().then(() => {
  startCventBackgroundSync(pool)
})

const api = express.Router()

api.get('/health', (_req, res) => {
  res.json({ ok: true })
})

api.get('/health/db', requireAdmin, async (_req, res) => {
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

    const loginKey = `${getClientIp(req)}:${email}`
    if (isLoginRateLimited(loginKey)) {
      res.status(429).json({ error: 'Too many login attempts. Please try again later.' })
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
      recordFailedLogin(loginKey)
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

    clearLoginAttempts(loginKey)
    setSessionCookie(res, token, req)
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

api.post('/logout', (req, res) => {
  clearSessionCookie(res, req)
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

api.get('/cvent/status', requireUser, (_req, res) => {
  res.json(getCventStatus())
})

api.post('/cvent/sync', requireAdmin, async (_req, res) => {
  try {
    const result = await syncAttendeesFromCvent(pool, { fullSync: true })
    res.json(result)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Cvent sync failed.',
    })
  }
})

api.post('/webhooks/cvent', async (req, res) => {
  try {
    res.status(200).json({ received: true })
    syncAttendeesFromCvent(pool, { fullSync: false }).catch((err) => {
      console.warn('[Cvent Webhook] Sync error:', err.message)
    })
  } catch (err) {
    console.warn('[Cvent Webhook] Error:', err.message)
  }
})

api.get('/summary', requireUser, async (_req, res) => {
  try {
    const result = await query(
      `
        select
          count(*)::text as total,
          count(*) filter (where checked_in = true)::text as checked_in,
          count(*) filter (where goodie_bag = true)::text as goodie_bag_collected,
          count(*) filter (where checked_in = true and goodie_bag = false)::text as goodie_bag_remaining
        from public.attendees
      `,
    )
    const row = result.rows[0]
    const total = Number(row?.total ?? 0)
    const checkedIn = Number(row?.checked_in ?? 0)
    const goodieBagCollected = Number(row?.goodie_bag_collected ?? 0)
    const goodieBagRemaining = Number(row?.goodie_bag_remaining ?? 0)

    res.json({
      total,
      checkedIn,
      notCheckedIn: Math.max(total - checkedIn, 0),
      goodieBagCollected,
      goodieBagRemaining,
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load attendance summary.',
    })
  }
})

api.get('/attendees', requireUser, async (_req, res) => {
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
          admission_item,
          sessions,
          photo,
          checked_in,
          check_in_time,
          goodie_bag,
          goodie_bag_time,
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

api.post('/attendees/:id/goodie-bag', requireUser, async (req, res) => {
  try {
    const attendeeId = typeof req.params.id === 'string' ? req.params.id.trim() : ''

    if (!attendeeId) {
      res.status(400).json({ error: 'Attendee ID is required.' })
      return
    }

    const updateResult = await query(
      `
        update public.attendees
        set goodie_bag = true,
            goodie_bag_time = coalesce(goodie_bag_time, now()),
            goodie_bag_by = coalesce(goodie_bag_by, $2),
            checked_in = true,
            check_in_time = coalesce(check_in_time, now()),
            checked_in_by = coalesce(checked_in_by, $2),
            updated_at = now()
        where id = $1
           or qr_code_normalized = lower(trim($1))
           or qr_code = $1
        returning id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
      `,
      [attendeeId, req.user.id],
    )

    const updatedAttendee = updateResult.rows[0]
    if (!updatedAttendee) {
      res.status(404).json({ error: 'Attendee not found.' })
      return
    }

    res.json({
      status: 'goodie_bag_collected',
      attendee: scanAttendeePayload(updatedAttendee),
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to award goodie bag.',
    })
  }
})

api.post('/attendees/:id/checkin', requireUser, async (req, res) => {
  try {
    const attendeeId = typeof req.params.id === 'string' ? req.params.id.trim() : ''

    if (!attendeeId) {
      res.status(400).json({ error: 'Attendee ID is required.' })
      return
    }

    const updateResult = await query(
      `
        update public.attendees
        set checked_in = true,
            check_in_time = coalesce(check_in_time, now()),
            checked_in_by = coalesce(checked_in_by, $2),
            updated_at = now()
        where id = $1
           or qr_code_normalized = lower(trim($1))
           or qr_code = $1
        returning id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
      `,
      [attendeeId, req.user.id],
    )

    const updatedAttendee = updateResult.rows[0]
    if (!updatedAttendee) {
      res.status(404).json({ error: 'Attendee not found.' })
      return
    }

    res.json({
      status: 'checked_in',
      attendee: scanAttendeePayload(updatedAttendee),
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to check in attendee.',
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

  if (incomingAttendees.length > maxImportAttendees) {
    res.status(413).json({ error: `Import is limited to ${maxImportAttendees} attendees at a time.` })
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
      const originalObject =
        item.original && typeof item.original === 'object' ? item.original : {}
      const admissionItem =
        (typeof item.admissionItem === 'string' ? item.admissionItem.trim() : '') ||
        readOriginalField(originalObject, ['admission item', 'admission', 'interval', 'interval orar', 'admissionitem'])
      const sessions =
        (typeof item.sessions === 'string' ? item.sessions.trim() : '') ||
        readOriginalField(originalObject, ['sessions', 'session', 'programare k scan', 'programare', 'k scan', 'kscan'])
      const photo =
        (typeof item.photo === 'string' ? item.photo.trim() : '') ||
        readOriginalField(originalObject, ['photo', 'prelucrare foto', 'foto', 'photo processing'])
      const original = JSON.stringify(originalObject)

      const checkedIn = Boolean(item.checkedIn)
      const checkInTime = item.checkInTime
        ? new Date(item.checkInTime).toISOString()
        : checkedIn
          ? new Date().toISOString()
          : null
      const goodieBag = Boolean(item.goodieBag)
      const goodieBagTime = item.goodieBagTime
        ? new Date(item.goodieBagTime).toISOString()
        : goodieBag
          ? new Date().toISOString()
          : null

      validAttendees.push({
        id,
        name,
        email,
        uniqueId,
        qrCode,
        company,
        ticketType,
        admissionItem,
        sessions,
        photo,
        checkedIn,
        checkInTime,
        goodieBag,
        goodieBagTime,
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
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}::jsonb, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16})`
        )
        values.push(
          att.id,
          att.name,
          att.email,
          att.uniqueId,
          att.qrCode,
          att.company,
          att.ticketType,
          att.admissionItem,
          att.sessions,
          att.photo,
          att.sourceRow,
          att.original,
          att.checkedIn,
          att.checkInTime,
          att.goodieBag,
          att.goodieBagTime,
        )
      }

      const insertQuery = `
        insert into public.attendees (
          id, name, email, unique_id, qr_code, company, ticket_type, admission_item, sessions, photo, source_row, original, checked_in, check_in_time, goodie_bag, goodie_bag_time
        )
        values ${valueClauses.join(', ')}
        on conflict (qr_code_normalized) do update
        set name = excluded.name,
            email = excluded.email,
            unique_id = excluded.unique_id,
            qr_code = excluded.qr_code,
            company = excluded.company,
            ticket_type = excluded.ticket_type,
            admission_item = excluded.admission_item,
            sessions = excluded.sessions,
            photo = excluded.photo,
            source_row = excluded.source_row,
            original = excluded.original,
            checked_in = attendees.checked_in or excluded.checked_in,
            check_in_time = coalesce(attendees.check_in_time, excluded.check_in_time),
            goodie_bag = attendees.goodie_bag or excluded.goodie_bag,
            goodie_bag_time = coalesce(attendees.goodie_bag_time, excluded.goodie_bag_time),
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
    const candidateId = typeof req.body?.id === 'string' ? req.body.id.trim() : ''
    const mode = req.body?.mode === 'goodie_bag' ? 'goodie_bag' : 'checkin'

    if (!scannedCode && !candidateId) {
      res.status(400).json({ error: 'Missing scanned QR code or attendee ID.' })
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

    const codeToHash = scannedCode || candidateId
    await query(
      `
        insert into public.scan_attempts (staff_user_id, ip_address, code_hash)
        values ($1, $2, $3)
      `,
      [req.user.id, getClientIp(req), hashValue(codeToHash)],
    )

    const candidates = buildCodeCandidates(scannedCode)
    const matchResult = await query(
      `
        select id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
        from public.attendees
        where ($1 != '' and (id = $1 or qr_code = $1 or qr_code_normalized = lower(trim($1))))
           or qr_code_normalized = any($2::text[])
        limit 1
      `,
      [candidateId, candidates],
    )
    let attendee = matchResult.rows[0]

    if (!attendee) {
      // Real-time lookup in Cvent API for on-site registrations
      const cventAttendee = await findAndImportCventAttendee(scannedCode || candidateId, {
        pool,
        userId: req.user.id,
      })

      if (cventAttendee) {
        attendee = cventAttendee
      } else {
        res.json({ status: 'not_found' })
        return
      }
    }

    if (mode === 'goodie_bag') {
      const isCheckedIn = Boolean(attendee.checked_in || attendee.check_in_time)
      if (!isCheckedIn) {
        res.json({
          status: 'not_checked_in_for_goodie_bag',
          attendee: scanAttendeePayload(attendee),
        })
        return
      }

      if (attendee.goodie_bag) {
        res.json({
          status: 'goodie_bag_duplicate',
          attendee: scanAttendeePayload(attendee),
        })
        return
      }

      const updateResult = await query(
        `
          update public.attendees
          set goodie_bag = true,
              goodie_bag_time = coalesce(goodie_bag_time, now()),
              goodie_bag_by = $2,
              checked_in = true,
              check_in_time = coalesce(check_in_time, now()),
              updated_at = now()
          where id = $1
            and goodie_bag = false
          returning id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
        `,
        [attendee.id, req.user.id],
      )
      const updatedAttendee = updateResult.rows[0]

      if (!updatedAttendee) {
        const duplicateResult = await query(
          `
            select id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
            from public.attendees
            where id = $1
            limit 1
          `,
          [attendee.id],
        )
        const duplicateAttendee = duplicateResult.rows[0] ?? attendee

        res.json({
          status: 'goodie_bag_duplicate',
          attendee: scanAttendeePayload(duplicateAttendee),
        })
        return
      }

      res.json({
        status: 'goodie_bag_collected',
        attendee: scanAttendeePayload(updatedAttendee),
      })
      return
    }

    // Default mode: checkin
    if (attendee.checked_in) {
      res.json({
        status: 'duplicate',
        attendee: scanAttendeePayload(attendee),
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
        returning id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
      `,
      [attendee.id, req.user.id],
    )
    const checkedInAttendee = updateResult.rows[0]

    if (!checkedInAttendee) {
      const duplicateResult = await query(
        `
          select id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
          from public.attendees
          where id = $1
          limit 1
        `,
        [attendee.id],
      )
      const duplicateAttendee = duplicateResult.rows[0] ?? attendee

      res.json({
        status: 'duplicate',
        attendee: scanAttendeePayload(duplicateAttendee),
      })
      return
    }

    res.json({
      status: 'checked_in',
      attendee: scanAttendeePayload(checkedInAttendee),
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to verify QR code.',
    })
  }
})


for (const apiPath of apiMountPaths(basePath, {
  isProduction,
  allowRootApi: process.env.ALLOW_ROOT_API === 'true',
})) {
  app.use(apiPath, api)
}
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

    const result = await query(
      `
        select id::text, email, role, client_id::text
        from public.users
        where id = $1
        limit 1
      `,
      [payload.id],
    )
    const userRow = result.rows[0]

    if (!userRow) {
      return null
    }

    return {
      id: userRow.id,
      email: userRow.email,
      role: normalizeRole(userRow.role),
      clientId: userRow.client_id,
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

const allowedOrigins = (process.env.CORS_ORIGINS ?? 'https://www.newconcepttravel.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

function allowFrontendOrigin(req, res, next) {
  const origin = req.headers.origin

  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }

  next()
}

function setSessionCookie(res, token, req) {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: useSecureCookies,
    sameSite: 'strict',
    path: requestBasePath(req),
    maxAge: sessionMaxAgeSeconds * 1000,
  })
}

function clearSessionCookie(res, req) {
  for (const path of [requestBasePath(req), cookiePath, '/QrCode', '/corporate/QrCode']) {
    res.clearCookie(sessionCookieName, {
      httpOnly: true,
      secure: useSecureCookies,
      sameSite: 'strict',
      path,
    })
  }
}

function scanAttendeePayload(row) {
  return {
    id: row.id,
    name: row.name,
    qrCode: row.qr_code ?? '',
    checkedIn: Boolean(row.checked_in || row.check_in_time),
    checkInTime: row.check_in_time,
    goodieBag: Boolean(row.goodie_bag || row.goodie_bag_time),
    goodieBagTime: row.goodie_bag_time ?? null,
    ticketType: row.ticket_type ?? '',
    admissionItem:
      (typeof row.admission_item === 'string' ? row.admission_item.trim() : '') ||
      readOriginalField(row.original, ['admission item', 'admission', 'interval', 'interval orar', 'admissionitem']),
    sessions:
      (typeof row.sessions === 'string' ? row.sessions.trim() : '') ||
      readOriginalField(row.original, ['sessions', 'session', 'programare k scan', 'programare', 'k scan', 'kscan']),
    photo:
      (typeof row.photo === 'string' ? row.photo.trim() : '') ||
      readOriginalField(row.original, ['photo', 'prelucrare foto', 'foto', 'photo processing']),
  }
}

function readOriginalField(original, aliases) {
  if (!original || typeof original !== 'object') {
    return ''
  }

  const wanted = new Set(aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]/g, '')))

  for (const [key, value] of Object.entries(original)) {
    if (wanted.has(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
    }
  }

  return ''
}

function requestBasePath(req) {
  const url = req?.originalUrl || ''

  if (url.startsWith('/corporate/QrCode')) {
    return '/corporate/QrCode'
  }

  if (url.startsWith('/QrCode')) {
    return '/QrCode'
  }

  return cookiePath || '/'
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

function isLoginRateLimited(key) {
  const cutoff = Date.now() - loginRateLimitWindowMs
  const attempts = (loginAttempts.get(key) ?? []).filter((timestamp) => timestamp >= cutoff)
  loginAttempts.set(key, attempts)

  return attempts.length >= loginRateLimitMaxAttempts
}

function recordFailedLogin(key) {
  const cutoff = Date.now() - loginRateLimitWindowMs
  const attempts = (loginAttempts.get(key) ?? []).filter((timestamp) => timestamp >= cutoff)
  attempts.push(Date.now())
  loginAttempts.set(key, attempts)
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key)
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
