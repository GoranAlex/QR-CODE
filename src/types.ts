export type CheckInStatus = 'checked-in' | 'not-checked-in'

export type Attendee = {
  id: string
  name: string
  email: string
  uniqueId: string
  qrCode: string
  company: string
  ticketType: string
  checkedIn: boolean
  checkInTime: string | null
  importedAt: string
  sourceRow: number
  original: Record<string, string>
}

export type StaffRole = 'admin' | 'scanner'

export type StaffProfile = {
  userId: string
  role: StaffRole
}

export type AuthUser = {
  id: string
  email: string
  role: StaffRole
  clientId: string | null
}

export type AttendanceSummary = {
  total: number
  checkedIn: number
  notCheckedIn: number
}

export type MinimalScannedAttendee = {
  name: string
  checkInTime: string | null
}

export type ScanResult =
  | {
      type: 'success'
      attendee: MinimalScannedAttendee
      message: string
    }
  | {
      type: 'duplicate'
      attendee: MinimalScannedAttendee
      message: string
    }
  | {
      type: 'not-found'
      scannedCode: string
      message: string
    }
  | {
      type: 'rate-limited'
      scannedCode: string
      message: string
    }
  | {
      type: 'idle'
      message: string
    }

export type ImportSummary = {
  attendees: Attendee[]
  warnings: string[]
  fileName: string
}

export type VerifyScanResponse =
  | {
      status: 'checked_in'
      attendee: MinimalScannedAttendee
    }
  | {
      status: 'duplicate'
      attendee: MinimalScannedAttendee
    }
  | {
      status: 'not_found'
    }
  | {
      status: 'rate_limited'
      retryAfterSeconds: number
    }

export type ImportAttendeesResponse = {
  ok: boolean
  count: number
  message?: string
}
