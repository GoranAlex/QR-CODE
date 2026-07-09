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

export type ScanResult =
  | {
      type: 'success'
      attendee: Attendee
      message: string
    }
  | {
      type: 'duplicate'
      attendee: Attendee
      message: string
    }
  | {
      type: 'not-found'
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
