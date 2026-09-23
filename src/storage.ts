import type { AttendanceSummary, Attendee, AuthUser, ImportAttendeesResponse, VerifyScanResponse } from './types'

type AttendeeApiRow = {
  id: string
  name: string
  email: string
  unique_id: string
  qr_code: string
  company: string
  ticket_type: string
  checked_in: boolean
  check_in_time: string | null
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

function toAttendee(row: AttendeeApiRow): Attendee {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    uniqueId: row.unique_id,
    qrCode: row.qr_code,
    company: row.company,
    ticketType: row.ticket_type,
    checkedIn: row.checked_in,
    checkInTime: row.check_in_time,
    importedAt: row.imported_at,
    sourceRow: row.source_row,
    original: row.original ?? {},
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
  return apiFetch<AttendanceSummary>('/api/summary', {
    method: 'GET',
  })
}

export async function verifyScan(code: string): Promise<VerifyScanResponse> {
  return apiFetch<VerifyScanResponse>(
    '/api/verify-scan',
    {
      method: 'POST',
      body: JSON.stringify({ code }),
    },
    { allowStatuses: [429] },
  )
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
    credentials: 'same-origin',
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

function apiUrl(path: string) {
  const baseUrl = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`

  return `${baseUrl}${path.replace(/^\/+/, '')}`
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
