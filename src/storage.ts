import type { Attendee } from './types'

const ATTENDEE_STORAGE_KEY = 'event-checkin.attendees.v1'
const EVENT_NAME_STORAGE_KEY = 'event-checkin.event-name.v1'

export function loadAttendees(): Attendee[] {
  try {
    const raw = localStorage.getItem(ATTENDEE_STORAGE_KEY)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed as Attendee[]
  } catch {
    return []
  }
}

export function saveAttendees(attendees: Attendee[]) {
  localStorage.setItem(ATTENDEE_STORAGE_KEY, JSON.stringify(attendees))
}

export function clearAttendees() {
  localStorage.removeItem(ATTENDEE_STORAGE_KEY)
}

export function loadEventName(): string {
  return localStorage.getItem(EVENT_NAME_STORAGE_KEY) ?? 'Event Check-In'
}

export function saveEventName(eventName: string) {
  localStorage.setItem(EVENT_NAME_STORAGE_KEY, eventName)
}
