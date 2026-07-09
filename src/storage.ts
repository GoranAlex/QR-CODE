import { supabase } from './supabase'
import type { Attendee } from './types'

const EVENT_NAME_KEY = 'event_name'
const DEFAULT_EVENT_NAME = 'Event Check-In'

type AttendeeRow = {
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

function normalizeQrCode(value: string) {
  return value.trim().toLowerCase()
}

function toAttendee(row: AttendeeRow): Attendee {
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

function toAttendeeRow(attendee: Attendee) {
  return {
    id: attendee.id,
    name: attendee.name,
    email: attendee.email,
    unique_id: attendee.uniqueId,
    qr_code: attendee.qrCode,
    qr_code_normalized: normalizeQrCode(attendee.qrCode),
    company: attendee.company,
    ticket_type: attendee.ticketType,
    checked_in: attendee.checkedIn,
    check_in_time: attendee.checkInTime,
    imported_at: attendee.importedAt,
    source_row: attendee.sourceRow,
    original: attendee.original,
  }
}

function throwStorageError(action: string, error: { message: string }) {
  throw new Error(`${action}: ${error.message}`)
}

export async function loadAttendees(): Promise<Attendee[]> {
  const { data, error } = await supabase
    .from('attendees')
    .select(
      'id,name,email,unique_id,qr_code,company,ticket_type,checked_in,check_in_time,imported_at,source_row,original',
    )
    .order('source_row', { ascending: true })

  if (error) {
    throwStorageError('Could not load attendees', error)
  }

  return (data ?? []).map((row) => toAttendee(row as AttendeeRow))
}

export async function replaceAttendees(attendees: Attendee[]) {
  const { error: deleteError } = await supabase
    .from('attendees')
    .delete()
    .neq('id', '__never__')

  if (deleteError) {
    throwStorageError('Could not clear existing attendees', deleteError)
  }

  if (attendees.length === 0) {
    return
  }

  const { error: insertError } = await supabase.from('attendees').insert(attendees.map(toAttendeeRow))

  if (insertError) {
    throwStorageError('Could not import attendees', insertError)
  }
}

export async function checkInAttendee(attendeeId: string, staffUserId: string): Promise<Attendee | null> {
  const checkInTime = new Date().toISOString()
  const { data, error } = await supabase
    .from('attendees')
    .update({
      checked_in: true,
      check_in_time: checkInTime,
      checked_in_by: staffUserId,
    })
    .eq('id', attendeeId)
    .eq('checked_in', false)
    .select(
      'id,name,email,unique_id,qr_code,company,ticket_type,checked_in,check_in_time,imported_at,source_row,original',
    )
    .maybeSingle()

  if (error) {
    throwStorageError('Could not check in attendee', error)
  }

  return data ? toAttendee(data as AttendeeRow) : null
}

export async function clearAttendees() {
  const { error } = await supabase.from('attendees').delete().neq('id', '__never__')

  if (error) {
    throwStorageError('Could not clear attendees', error)
  }
}

export async function loadEventName(): Promise<string> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', EVENT_NAME_KEY)
    .maybeSingle()

  if (error) {
    throwStorageError('Could not load event name', error)
  }

  return data?.value ?? DEFAULT_EVENT_NAME
}

export async function saveEventName(eventName: string, staffUserId: string) {
  const { error } = await supabase.from('app_settings').upsert({
    key: EVENT_NAME_KEY,
    value: eventName,
    updated_by: staffUserId,
  })

  if (error) {
    throwStorageError('Could not save event name', error)
  }
}
