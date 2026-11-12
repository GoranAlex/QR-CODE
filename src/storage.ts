import type { AttendanceSummary, Attendee, AuthUser, CventSyncStatus, ImportAttendeesResponse, ScanMode, VerifyScanResponse } from './types'

type AttendeeApiRow = {
  id: string
  name: string
  email: string
  unique_id: string
  qr_code: string
  company: string
  ticket_type: string
  admission_item?: string
  sessions?: string
  photo?: string
  checked_in: boolean
  check_in_time: string | null
  goodie_bag?: boolean
  goodie_bag_time?: string | null
  imported_at: string
  source_row: number
  original: Record<string, string> | null
}

type UserResponse = {
  user: AuthUser
}

type SettingsResponse = {
  eventName: string
}

type AttendeesResponse = {
  attendees: AttendeeApiRow[]
}

function readOriginalValue(original: Record<string, string> | null | undefined, aliases: string[]): string {
  if (!original || typeof original !== 'object') return ''
  const wanted = new Set(aliases.map((a) => a.toLowerCase().replace(/[^a-z0-9]/g, '')))
  for (const [key, value] of Object.entries(original)) {
    if (wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
    }
  }
  return ''
}

function toAttendee(row: AttendeeApiRow): Attendee {
  const original = row.original ?? {}
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    uniqueId: row.unique_id,
    qrCode: row.qr_code,
    company: row.company,
    ticketType: row.ticket_type,
    admissionItem:
      (typeof row.admission_item === 'string' ? row.admission_item.trim() : '') ||
      readOriginalValue(original, ['admission item', 'admission', 'interval', 'interval orar', 'admissionitem']),
    sessions:
      (typeof row.sessions === 'string' ? row.sessions.trim() : '') ||
      readOriginalValue(original, ['sessions', 'session', 'programare k scan', 'programare', 'k scan', 'kscan']),
    photo:
      (typeof row.photo === 'string' ? row.photo.trim() : '') ||
      readOriginalValue(original, ['photo', 'prelucrare foto', 'foto', 'photo processing']),
    checkedIn: row.checked_in,
    checkInTime: row.check_in_time,
    goodieBag: Boolean(row.goodie_bag),
    goodieBagTime: row.goodie_bag_time ?? null,
    importedAt: row.imported_at,
    sourceRow: row.source_row,
    original,
  }
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const response = await apiFetch<UserResponse>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })

  return response.user
}

export async function loadCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await apiFetch<UserResponse>('/api/me', {
      method: 'GET',
    })

    return response.user
  } catch {
    return null
  }
}

export async function signOut() {
  await apiFetch('/api/logout', {
    method: 'POST',
  })
}

export async function loadAttendees(): Promise<Attendee[]> {
  const response = await apiFetch<AttendeesResponse>('/api/attendees', {
    method: 'GET',
  })

  return response.attendees.map(toAttendee)
}

export async function clearAttendees() {
  await apiFetch('/api/attendees', {
    method: 'DELETE',
  })
}

export async function importAttendees(attendees: Attendee[]): Promise<ImportAttendeesResponse> {
  return apiFetch<ImportAttendeesResponse>('/api/attendees/import', {
    method: 'POST',
    body: JSON.stringify({ attendees }),
  })
}

export async function loadEventName(): Promise<string> {
  const response = await apiFetch<SettingsResponse>('/api/settings', {
    method: 'GET',
  })

  return response.eventName
}

export async function saveEventName(eventName: string): Promise<string> {
  const response = await apiFetch<SettingsResponse>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ eventName }),
  })

  return response.eventName
}

export async function loadAttendanceSummary(): Promise<AttendanceSummary> {
  const data = await apiFetch<Partial<AttendanceSummary>>('/api/summary', {
    method: 'GET',
  })

  const total = Number(data?.total ?? 0)
  const checkedIn = Number(data?.checkedIn ?? 0)
  const notCheckedIn =
    typeof data?.notCheckedIn === 'number'
      ? Number(data.notCheckedIn)
      : Math.max(total - checkedIn, 0)
  const goodieBagCollected = Number(data?.goodieBagCollected ?? 0)
  const goodieBagRemaining =
    typeof data?.goodieBagRemaining === 'number'
      ? Number(data.goodieBagRemaining)
      : Math.max(checkedIn - goodieBagCollected, 0)

  return {
    total: Number.isNaN(total) ? 0 : total,
    checkedIn: Number.isNaN(checkedIn) ? 0 : checkedIn,
    notCheckedIn: Number.isNaN(notCheckedIn) ? 0 : notCheckedIn,
    goodieBagCollected: Number.isNaN(goodieBagCollected) ? 0 : goodieBagCollected,
    goodieBagRemaining: Number.isNaN(goodieBagRemaining) ? 0 : goodieBagRemaining,
  }
}

export async function verifyScan(
  code: string,
  mode: ScanMode = 'checkin',
  id?: string,
): Promise<VerifyScanResponse> {
  return apiFetch<VerifyScanResponse>(
    '/api/verify-scan',
    {
      method: 'POST',
      body: JSON.stringify({ code, mode, id }),
    },
    { allowStatuses: [429] },
  )
}

export async function markAttendeeGoodieBag(id: string, code?: string): Promise<VerifyScanResponse> {
  try {
    return await apiFetch<VerifyScanResponse>(`/api/attendees/${encodeURIComponent(id)}/goodie-bag`, {
      method: 'POST',
    })
  } catch {
    return verifyScan(code || id, 'goodie_bag', id)
  }
}

export async function markAttendeeCheckIn(id: string, code?: string): Promise<VerifyScanResponse> {
  try {
    return await apiFetch<VerifyScanResponse>(`/api/attendees/${encodeURIComponent(id)}/checkin`, {
      method: 'POST',
    })
  } catch {
    return verifyScan(code || id, 'checkin', id)
  }
}

export async function loadCventStatus(): Promise<CventSyncStatus> {
  try {
    return await apiFetch<CventSyncStatus>('/api/cvent/status', { method: 'GET' })
  } catch {
    return { configured: false }
  }
}

export async function triggerCventSync(): Promise<{ success: boolean; imported: number; updated: number; total: number; error?: string }> {
  return await apiFetch('/api/cvent/sync', { method: 'POST' })
}

type ApiFetchOptions = {
  allowStatuses?: number[]
}

async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit,
  options: ApiFetchOptions = {},
): Promise<T> {
  const response = await fetch(apiUrl(url), {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const body = await parseApiResponse(response)
  const allowedStatus = options.allowStatuses?.includes(response.status) ?? false

  if (!response.ok && !allowedStatus) {
    if (response.status === 401 && url !== '/api/me' && url !== '/api/login') {
      window.dispatchEvent(new CustomEvent('event-checkin:unauthorized'))
    }

    throw new Error(body.error ?? 'Request failed.')
  }

  return body as T
}

const productionApiBase = 'https://qrcode.newconcepttravel.com/corporate/QrCode'

export function apiUrl(path: string) {
  const apiPath = path.replace(/^\/+/, '')
  const configuredBase = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? productionApiBase : ''))
    .replace(/\/+$/, '')

  if (configuredBase) {
    return `${configuredBase}/${apiPath}`
  }

  const pagePath = window.location.pathname
  const marker = '/qrcode'
  const markerIndex = pagePath.toLowerCase().lastIndexOf(marker)

  if (markerIndex >= 0) {
    const prefix = pagePath.slice(0, markerIndex + marker.length).replace(/\/+$/, '')
    return `${prefix}/${apiPath}`
  }

  const baseUrl = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`

  return `${baseUrl}${apiPath}`
}

async function parseApiResponse(response: Response): Promise<{ error?: string }> {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return (await response.json()) as { error?: string }
  }

  const fallbackMessage =
    response.status === 404
      ? 'API route not found. Make sure the Express backend is running.'
      : 'API returned an unexpected response.'

  return { error: fallbackMessage }
}
