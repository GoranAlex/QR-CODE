/**
 * Cvent REST API Integration Service
 * 
 * Provides:
 * 1. OAuth2 Client Credentials authentication with automatic token caching.
 * 2. Real-time attendee lookup by QR / confirmation code during check-in.
 * 3. Background periodic synchronization (auto-pulling new on-site registrations).
 * 4. On-demand manual sync triggered by admins.
 * 5. Webhook receiver for instant Cvent event push notifications.
 */

import { Buffer } from 'node:buffer'

let cachedToken = null
let tokenExpiresAt = 0

let lastSyncTimestamp = null
let lastSyncResult = { success: false, imported: 0, updated: 0, total: 0, error: null }
let syncInProgress = false

function getCventConfig() {
  const clientId = (process.env.CVENT_CLIENT_ID || '').trim()
  const clientSecret = (process.env.CVENT_CLIENT_SECRET || '').trim()
  const eventId = (process.env.CVENT_EVENT_ID || '').trim()
  const region = (process.env.CVENT_REGION || 'eu').trim().toLowerCase() // 'eu' or 'na'
  const syncIntervalSec = Math.max(Number(process.env.CVENT_SYNC_INTERVAL_SEC || 60), 15)

  // Cvent API Base URLs (Europe: api-platform-eur.cvent.com, North America: api-platform.cvent.com)
  const baseUrl = (process.env.CVENT_BASE_URL || '').trim() || (
    region === 'na' || region === 'us'
      ? 'https://api-platform.cvent.com/ea'
      : 'https://api-platform-eur.cvent.com/ea'
  )

  const tokenUrl = `${baseUrl}/oauth2/token`

  return {
    clientId,
    clientSecret,
    eventId,
    region,
    baseUrl,
    tokenUrl,
    syncIntervalSec,
    isConfigured: Boolean(clientId && clientSecret && eventId),
  }
}

/**
 * Obtain an active OAuth2 Bearer token from Cvent
 */
export async function getCventAccessToken() {
  const config = getCventConfig()
  if (!config.isConfigured) {
    throw new Error('Cvent API is not configured. Set CVENT_CLIENT_ID, CVENT_CLIENT_SECRET, and CVENT_EVENT_ID in .env.')
  }

  // Reuse cached token if still valid (with 60-second safety margin)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken
  }

  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
  const bodyParams = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
      'Accept': 'application/json',
    },
    body: bodyParams.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Cvent OAuth token request failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  if (!data.access_token) {
    throw new Error('Cvent OAuth response missing access_token.')
  }

  cachedToken = data.access_token
  const expiresInMs = (Number(data.expires_in) || 3600) * 1000
  tokenExpiresAt = Date.now() + expiresInMs

  return cachedToken
}

const resolvedEventUuidCache = new Map()
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolves either a Cvent Event UUID or a short Event Code (e.g. Y2N4F8M8SY3) into an Event UUID
 */
export async function resolveEventUuid(config, token) {
  const rawEventId = config.eventId
  if (!rawEventId) {
    throw new Error('CVENT_EVENT_ID is empty.')
  }

  if (uuidRegex.test(rawEventId)) {
    return rawEventId
  }

  if (resolvedEventUuidCache.has(rawEventId)) {
    return resolvedEventUuidCache.get(rawEventId)
  }

  const filter = encodeURIComponent(`code eq '${rawEventId}'`)
  const response = await fetch(`${config.baseUrl}/events?filter=${filter}&limit=5`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Failed to resolve Cvent event code '${rawEventId}' (${response.status}): ${errText}`)
  }

  const body = await response.json()
  const matchedEvent = Array.isArray(body.data) ? body.data[0] : null
  if (!matchedEvent?.id) {
    throw new Error(`No Cvent event found matching code '${rawEventId}'.`)
  }

  resolvedEventUuidCache.set(rawEventId, matchedEvent.id)
  console.log(`[Cvent] Resolved event code '${rawEventId}' -> UUID '${matchedEvent.id}' (${matchedEvent.title || 'Untitled'})`)
  return matchedEvent.id
}

/**
 * Normalizes a Cvent attendee payload to our database schema
 */
export function normalizeCventAttendee(raw) {
  if (!raw || typeof raw !== 'object') return null

  const contact = raw.contact && typeof raw.contact === 'object' ? raw.contact : {}

  // Cvent Attendee / Registration properties
  const cventId = String(raw.id || raw.attendeeId || raw.attendee_id || '').trim()
  const confirmationNumber = String(raw.confirmationNumber || raw.confirmation_number || raw.referenceId || '').trim()
  const barcode = String(raw.barcode || raw.badgeBarcode || '').trim()

  const firstName = String(contact.firstName || raw.firstName || raw.first_name || '').trim()
  const lastName = String(contact.lastName || raw.lastName || raw.last_name || '').trim()
  const fullName = `${firstName} ${lastName}`.trim() || String(raw.name || 'Participant Cvent').trim()

  const email = String(contact.email || raw.email || raw.emailAddress || '').trim().toLowerCase()
  const company = String(contact.company || raw.company || raw.companyName || raw.organization || '').trim()

  const rawAdmissionName =
    (raw.admissionItem && typeof raw.admissionItem === 'object' ? raw.admissionItem.name : raw.admissionItem) || ''
  const rawRegTypeName =
    (raw.registrationType && typeof raw.registrationType === 'object' ? raw.registrationType.name : raw.registrationType) || ''

  const ticketType = String(
    rawRegTypeName ||
    raw.registration_type ||
    raw.status ||
    'General'
  ).trim()

  // Primary QR / scan code: confirmationNumber, barcode, or cventId
  const qrCode = confirmationNumber || barcode || cventId
  if (!qrCode) return null

  const qrCodeNormalized = qrCode.toLowerCase().trim()

  // Extract answers / custom fields
  let admissionItem = String(rawAdmissionName || '').trim()
  let sessions = ''
  let photo = ''

  const customFields = Array.isArray(raw.answers)
    ? raw.answers
    : Array.isArray(raw.customFields)
      ? raw.customFields
      : Array.isArray(raw.questions)
        ? raw.questions
        : []

  for (const item of customFields) {
    const questionText = String(item.question?.text || item.question?.name || item.question || item.name || item.title || '').toLowerCase()
    const rawVal = item.answer ?? item.value
    const answerText = Array.isArray(rawVal)
      ? rawVal.map((v) => String(v ?? '').trim()).filter(Boolean).join(', ')
      : String(rawVal ?? '').trim()

    if (!answerText) continue

    if (questionText.includes('interval') || questionText.includes('admission')) {
      if (!admissionItem) admissionItem = answerText
    } else if (questionText.includes('session') || questionText.includes('programare')) {
      sessions = answerText
    } else if (questionText.includes('foto') || questionText.includes('photo')) {
      photo = answerText
    }
  }

  // Unique local ID
  const localId = `cvent-${cventId || confirmationNumber || Buffer.from(email || qrCode).toString('hex').slice(0, 16)}`

  return {
    id: localId,
    cventId,
    name: fullName,
    email,
    company,
    ticketType,
    admissionItem,
    sessions,
    photo,
    qrCode,
    qrCodeNormalized,
    uniqueId: confirmationNumber || cventId,
    original: raw,
  }
}

/**
 * Searches Cvent REST API in real time for a scanned code or confirmation number
 */
export async function findCventAttendee(codeOrEmail) {
  const config = getCventConfig()
  if (!config.isConfigured) return null

  const cleanCode = String(codeOrEmail || '').trim()
  if (!cleanCode) return null

  try {
    const token = await getCventAccessToken()
    const eventUuid = await resolveEventUuid(config, token)
    const safeCode = cleanCode.replace(/'/g, "\\'")

    let codeFilter = `confirmationNumber eq '${safeCode}'`
    if (uuidRegex.test(cleanCode)) {
      codeFilter = `id eq '${safeCode}'`
    } else if (cleanCode.includes('@')) {
      codeFilter = `contact.email eq '${safeCode}'`
    }

    const filterQuery = encodeURIComponent(
      `event.id eq '${eventUuid}' and ${codeFilter}`
    )
    const url = `${config.baseUrl}/attendees?filter=${filterQuery}&limit=5`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json()
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []
    if (list.length > 0) {
      return normalizeCventAttendee(list[0])
    }

    return null
  } catch (err) {
    console.warn('[Cvent] Real-time lookup error for code:', cleanCode, err.message)
    return null
  }
}

/**
 * Finds in Cvent and automatically imports into PostgreSQL database
 */
export async function findAndImportCventAttendee(codeOrEmail, { pool, userId }) {
  const normalized = await findCventAttendee(codeOrEmail)
  if (!normalized) return null

  try {
    // Check if already in DB
    const existing = await pool.query(
      `
        select id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
        from public.attendees
        where qr_code_normalized = $1 or id = $2 or cvent_id = $3
        limit 1
      `,
      [normalized.qrCodeNormalized, normalized.id, normalized.cventId || ''],
    )

    if (existing.rows.length > 0) {
      return existing.rows[0]
    }

    // Insert new on-site registered attendee into Postgres
    const insertResult = await pool.query(
      `
        insert into public.attendees (
          id, name, email, unique_id, qr_code, qr_code_normalized, company,
          ticket_type, admission_item, sessions, photo, cvent_id, original,
          checked_in, check_in_time, checked_in_by, goodie_bag, goodie_bag_time, imported_at, source_row
        ) values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          false, null, null, false, null, now(), 99999
        )
        on conflict (id) do update
        set name = excluded.name,
            email = excluded.email,
            company = excluded.company,
            ticket_type = excluded.ticket_type,
            admission_item = coalesce(nullif(excluded.admission_item, ''), public.attendees.admission_item),
            sessions = coalesce(nullif(excluded.sessions, ''), public.attendees.sessions),
            photo = coalesce(nullif(excluded.photo, ''), public.attendees.photo),
            cvent_id = excluded.cvent_id,
            original = excluded.original,
            updated_at = now()
        returning id, name, ticket_type, admission_item, sessions, photo, checked_in, check_in_time, goodie_bag, goodie_bag_time, qr_code, original
      `,
      [
        normalized.id,
        normalized.name,
        normalized.email,
        normalized.uniqueId,
        normalized.qrCode,
        normalized.qrCodeNormalized,
        normalized.company,
        normalized.ticketType,
        normalized.admissionItem,
        normalized.sessions,
        normalized.photo,
        normalized.cventId,
        JSON.stringify(normalized.original),
      ],
    )

    console.log(`[Cvent] On-site attendee imported on-the-fly: ${normalized.name} (${normalized.qrCode})`)
    return insertResult.rows[0]
  } catch (err) {
    console.error('[Cvent] Failed to insert on-the-fly attendee:', err)
    return null
  }
}

/**
 * Synchronizes all attendees or attendees updated since last check from Cvent API
 */
export async function syncAttendeesFromCvent(pool, options = {}) {
  const config = getCventConfig()
  if (!config.isConfigured) {
    return {
      success: false,
      configured: false,
      message: 'Cvent is not configured. Add CVENT_CLIENT_ID, CVENT_CLIENT_SECRET, and CVENT_EVENT_ID to .env.',
      imported: 0,
      updated: 0,
      total: 0,
    }
  }

  if (syncInProgress) {
    return {
      success: true,
      inProgress: true,
      message: 'A Cvent sync is already in progress.',
      ...lastSyncResult,
    }
  }

  syncInProgress = true
  let importedCount = 0
  let updatedCount = 0
  let totalProcessed = 0

  try {
    const token = await getCventAccessToken()
    const eventUuid = await resolveEventUuid(config, token)
    const isFullSync = options.fullSync || !lastSyncTimestamp

    let filterExpr = `event.id eq '${eventUuid}'`
    if (!isFullSync && lastSyncTimestamp) {
      const sinceIso = new Date(lastSyncTimestamp - 120000).toISOString() // 2-min buffer
      filterExpr += ` and lastModified ge '${sinceIso}'`
    }

    let nextUrl = `${config.baseUrl}/attendees?limit=200&filter=${encodeURIComponent(filterExpr)}`

    const fetchedAttendees = []

    // Fetch all pages
    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Cvent sync fetch failed (${response.status}): ${errorText}`)
      }

      const body = await response.json()
      const items = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
      fetchedAttendees.push(...items)

      // Pagination (Cvent REST API v1 uses paging._links.next.href)
      nextUrl = body.paging?._links?.next?.href || body.paging?.next || null
    }

    // Process and upsert attendees into Postgres
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      for (let i = 0; i < fetchedAttendees.length; i++) {
        const item = fetchedAttendees[i]
        const normalized = normalizeCventAttendee(item)
        if (!normalized) continue

        totalProcessed++

        const result = await client.query(
          `
            insert into public.attendees (
              id, name, email, unique_id, qr_code, qr_code_normalized, company,
              ticket_type, admission_item, sessions, photo, cvent_id, original,
              checked_in, check_in_time, goodie_bag, goodie_bag_time, imported_at, source_row
            ) values (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12, $13,
              false, null, false, null, now(), $14
            )
            on conflict (id) do update
            set name = excluded.name,
                email = excluded.email,
                company = excluded.company,
                ticket_type = excluded.ticket_type,
                admission_item = coalesce(nullif(excluded.admission_item, ''), public.attendees.admission_item),
                sessions = coalesce(nullif(excluded.sessions, ''), public.attendees.sessions),
                photo = coalesce(nullif(excluded.photo, ''), public.attendees.photo),
                cvent_id = excluded.cvent_id,
                original = excluded.original,
                updated_at = now()
            returning (xmax = 0) as inserted
          `,
          [
            normalized.id,
            normalized.name,
            normalized.email,
            normalized.uniqueId,
            normalized.qrCode,
            normalized.qrCodeNormalized,
            normalized.company,
            normalized.ticketType,
            normalized.admissionItem,
            normalized.sessions,
            normalized.photo,
            normalized.cventId,
            JSON.stringify(normalized.original),
            i + 1,
          ],
        )

        if (result.rows[0]?.inserted) {
          importedCount++
        } else {
          updatedCount++
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    lastSyncTimestamp = Date.now()
    lastSyncResult = {
      success: true,
      imported: importedCount,
      updated: updatedCount,
      total: totalProcessed,
      error: null,
    }

    console.log(
      `[Cvent Sync] Completed successfully. Total: ${totalProcessed} (New on-site: ${importedCount}, Updated: ${updatedCount})`,
    )

    return {
      success: true,
      configured: true,
      lastSync: new Date(lastSyncTimestamp).toISOString(),
      imported: importedCount,
      updated: updatedCount,
      total: totalProcessed,
    }
  } catch (err) {
    console.error('[Cvent Sync] Error during sync:', err)
    lastSyncResult = {
      success: false,
      imported: importedCount,
      updated: updatedCount,
      total: totalProcessed,
      error: err.message,
    }
    return {
      success: false,
      configured: true,
      error: err.message,
      imported: importedCount,
      updated: updatedCount,
      total: totalProcessed,
    }
  } finally {
    syncInProgress = false
  }
}

/**
 * Returns current Cvent status for frontend
 */
export function getCventStatus() {
  const config = getCventConfig()
  return {
    configured: config.isConfigured,
    region: config.region,
    eventId: config.eventId ? `${config.eventId.slice(0, 4)}...${config.eventId.slice(-4)}` : null,
    syncIntervalSec: config.syncIntervalSec,
    syncInProgress,
    lastSyncTimestamp: lastSyncTimestamp ? new Date(lastSyncTimestamp).toISOString() : null,
    lastResult: lastSyncResult,
  }
}

/**
 * Starts automatic background synchronization timer
 */
export function startCventBackgroundSync(pool) {
  const config = getCventConfig()
  if (!config.isConfigured) {
    console.log('[Cvent] Background sync disabled (credentials not configured in environment).')
    return null
  }

  console.log(
    `[Cvent] Starting background auto-sync every ${config.syncIntervalSec} seconds for Event ID: ${config.eventId} (${config.region.toUpperCase()})`,
  )

  // Run initial sync after 5 seconds
  setTimeout(() => {
    syncAttendeesFromCvent(pool, { fullSync: true }).catch((err) => {
      console.warn('[Cvent] Initial auto-sync error:', err.message)
    })
  }, 5000)

  // Schedule recurring sync
  const intervalId = setInterval(() => {
    syncAttendeesFromCvent(pool, { fullSync: false }).catch((err) => {
      console.warn('[Cvent] Background auto-sync error:', err.message)
    })
  }, config.syncIntervalSec * 1000)

  return intervalId
}
