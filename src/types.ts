export type CheckInStatus = 'checked-in' | 'not-checked-in'

export type Attendee = {
  id: string
  name: string
  email: string
  uniqueId: string
  qrCode: string
  company: string
  ticketType: string
  admissionItem: string
  sessions: string
  photo: string
  checkedIn: boolean
  checkInTime: string | null
  goodieBag: boolean
  goodieBagTime: string | null
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
  goodieBagCollected: number
  goodieBagRemaining: number
}

export type MinimalScannedAttendee = {
  id?: string
  name: string
  qrCode?: string
  checkedIn?: boolean
  goodieBag?: boolean
  checkInTime: string | null
  goodieBagTime?: string | null
  ticketType: string
  admissionItem: string
  sessions: string
  photo: string
}

export type ScanMode = 'checkin' | 'goodie_bag'

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
      type: 'goodie_bag_collected'
      attendee: MinimalScannedAttendee
      message: string
    }
  | {
      type: 'goodie_bag_duplicate'
      attendee: MinimalScannedAttendee
      message: string
    }
  | {
      type: 'not_checked_in_for_goodie_bag'
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
      status: 'goodie_bag_collected'
      attendee: MinimalScannedAttendee
    }
  | {
      status: 'goodie_bag_duplicate'
      attendee: MinimalScannedAttendee
    }
  | {
      status: 'not_checked_in_for_goodie_bag'
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

export type CventSyncStatus = {
  configured: boolean
  region?: string
  eventId?: string | null
  syncIntervalSec?: number
  syncInProgress?: boolean
  lastSyncTimestamp?: string | null
  lastResult?: {
    success: boolean
    imported: number
    updated: number
    total: number
    error?: string | null
  }
}


