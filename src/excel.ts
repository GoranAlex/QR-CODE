import * as XLSX from 'xlsx'
import type { Attendee, ImportSummary } from './types'

const maxImportFileSizeBytes = 10 * 1024 * 1024

const headerAliases = {
  name: [
    'attendee name',
    'full name',
    'name',
    'contact name',
    'registrant name',
    'invitee name',
  ],
  firstName: ['first name', 'firstname', 'given name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'email address', 'e-mail', 'attendee email'],
  uniqueId: [
    'attendee id',
    'unique attendee id',
    'id',
    'registration id',
    'confirmation number',
    'confirmation',
    'invitee id',
    'contact id',
  ],
  qrCode: [
    'qr code',
    'qr code value',
    'qrcode',
    'cvent qr code',
    'cvent code',
    'badge qr code',
    'badge code',
    'barcode',
    'code',
    'check-in code',
    'attendee code',
  ],
  company: ['company', 'organization', 'organisation', 'account', 'employer'],
  ticketType: [
    'ticket type',
    'registration type',
    'attendee type',
    'pass type',
    'category',
  ],
  admissionItem: ['admission item', 'admission', 'interval', 'interval orar', 'admissionitem'],
  sessions: ['sessions', 'session', 'programare k scan', 'programare', 'k scan', 'kscan'],
  photo: ['photo', 'prelucrare foto', 'foto', 'photo processing'],
  checkedIn: ['check-in', 'checked in', 'check in', 'prezent', 'prezenta', 'attended', 'sosire'],
  checkInTime: ['check-in time', 'check in time', 'checkin time', 'ora check in', 'data check in', 'check-in date', 'check in date', 'timp check in', 'cand a fost check in'],
  goodieBag: ['goodie bag', 'goodiebag', 'goodie-bag', 'cadou', 'gift', 'pachet', 'pachete'],
} as const

function isTruthyValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    return ['da', 'yes', 'true', '1', 'checked', 'prezent', 'ridicat', 'ok'].includes(v)
  }
  return false
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function normalizeCode(value: string) {
  return value.trim().toLowerCase()
}

export function buildCodeCandidates(value: string) {
  const trimmedValue = value.trim()
  const candidates = new Set<string>()
  addCandidate(candidates, trimmedValue)

  try {
    addCandidate(candidates, decodeURIComponent(trimmedValue))
  } catch {
    // The QR value is still usable as-is when it is not URI encoded.
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

function addCandidate(candidates: Set<string>, value: string) {
  const normalizedValue = normalizeCode(value)

  if (normalizedValue) {
    candidates.add(normalizedValue)
  }
}

function cellToString(value: unknown) {
  if (value === null || value === undefined) {
    return ''
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  return String(value).trim()
}

function findHeader(headers: string[], aliases: readonly string[]) {
  const normalizedHeaders = headers.map((header) => ({
    raw: header,
    normalized: normalizeHeader(header),
  }))

  return normalizedHeaders.find((header) =>
    aliases.some((alias) => normalizeHeader(alias) === header.normalized),
  )?.raw
}

function buildName(
  row: Record<string, unknown>,
  nameHeader: string | undefined,
  firstNameHeader: string | undefined,
  lastNameHeader: string | undefined,
) {
  const directName = nameHeader ? cellToString(row[nameHeader]) : ''

  if (directName) {
    return directName
  }

  return [firstNameHeader ? row[firstNameHeader] : '', lastNameHeader ? row[lastNameHeader] : '']
    .map(cellToString)
    .filter(Boolean)
    .join(' ')
}

function makeAttendeeId(email: string, uniqueId: string, qrCode: string, sourceRow: number) {
  const stableValue = email || uniqueId || qrCode

  if (stableValue) {
    return `${normalizeCode(stableValue)}-${sourceRow}`
  }

  return `row-${sourceRow}`
}

export async function parseAttendeeWorkbook(file: File): Promise<ImportSummary> {
  if (file.size > maxImportFileSizeBytes) {
    return {
      attendees: [],
      warnings: ['The selected file is too large. Use a file smaller than 10 MB.'],
      fileName: file.name,
    }
  }

  const data = await file.arrayBuffer()
  const workbook = XLSX.read(data, { cellDates: true, type: 'array' })
  const firstSheetName = workbook.SheetNames[0]

  if (!firstSheetName) {
    return {
      attendees: [],
      warnings: ['The workbook does not contain any sheets.'],
      fileName: file.name,
    }
  }

  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  })

  if (rows.length === 0) {
    return {
      attendees: [],
      warnings: ['The first sheet is empty.'],
      fileName: file.name,
    }
  }

  const headers = Object.keys(rows[0] ?? {})
  const nameHeader = findHeader(headers, headerAliases.name)
  const firstNameHeader = findHeader(headers, headerAliases.firstName)
  const lastNameHeader = findHeader(headers, headerAliases.lastName)
  const emailHeader = findHeader(headers, headerAliases.email)
  const uniqueIdHeader = findHeader(headers, headerAliases.uniqueId)
  const qrCodeHeader = findHeader(headers, headerAliases.qrCode)
  const companyHeader = findHeader(headers, headerAliases.company)
  const ticketTypeHeader = findHeader(headers, headerAliases.ticketType)
  const admissionItemHeader = findHeader(headers, headerAliases.admissionItem)
  const sessionsHeader = findHeader(headers, headerAliases.sessions)
  const photoHeader = findHeader(headers, headerAliases.photo)
  const checkedInHeader = findHeader(headers, headerAliases.checkedIn)
  const checkInTimeHeader = findHeader(headers, headerAliases.checkInTime)
  const goodieBagHeader = findHeader(headers, headerAliases.goodieBag)
  const warnings: string[] = []

  if (!qrCodeHeader) {
    warnings.push(
      'No QR code column was detected. Add a column named QR Code, QR Code Value, Badge Code, Barcode, or Code.',
    )
  }

  if (!nameHeader && (!firstNameHeader || !lastNameHeader)) {
    warnings.push('No attendee name column was detected. Names will appear as "Unnamed attendee".')
  }

  const seenQrCodes = new Set<string>()
  const attendees = rows
    .map((row, index): Attendee | null => {
      const sourceRow = index + 2
      const name = buildName(row, nameHeader, firstNameHeader, lastNameHeader) || 'Unnamed attendee'
      const email = emailHeader ? cellToString(row[emailHeader]) : ''
      const uniqueId = uniqueIdHeader ? cellToString(row[uniqueIdHeader]) : ''
      const qrCode = qrCodeHeader ? cellToString(row[qrCodeHeader]) : ''
      const company = companyHeader ? cellToString(row[companyHeader]) : ''
      const ticketType = ticketTypeHeader ? cellToString(row[ticketTypeHeader]) : ''
      const admissionItem = admissionItemHeader ? cellToString(row[admissionItemHeader]) : ''
      const sessions = sessionsHeader ? cellToString(row[sessionsHeader]) : ''
      const photo = photoHeader ? cellToString(row[photoHeader]) : ''
      const original = Object.fromEntries(headers.map((header) => [header, cellToString(row[header])]))

      if (!qrCode) {
        warnings.push(`Row ${sourceRow} was skipped because it has no QR code value.`)
        return null
      }

      const normalizedQrCode = normalizeCode(qrCode)

      if (seenQrCodes.has(normalizedQrCode)) {
        warnings.push(`Row ${sourceRow} has a duplicate QR code and was skipped.`)
        return null
      }

      seenQrCodes.add(normalizedQrCode)

      const rawCheckInTime = checkInTimeHeader ? cellToString(row[checkInTimeHeader]) : ''
      const parsedCheckInTime =
        rawCheckInTime && !Number.isNaN(new Date(rawCheckInTime).getTime())
          ? new Date(rawCheckInTime).toISOString()
          : null
      const checkedIn = checkedInHeader
        ? isTruthyValue(row[checkedInHeader])
        : Boolean(parsedCheckInTime || (rawCheckInTime && rawCheckInTime.toLowerCase() !== 'nu' && rawCheckInTime.toLowerCase() !== 'neprezentat'))
      const checkInTime = parsedCheckInTime || (checkedIn ? new Date().toISOString() : null)
      const goodieBag = goodieBagHeader ? isTruthyValue(row[goodieBagHeader]) : false
      const goodieBagTime = goodieBag ? new Date().toISOString() : null

      return {
        id: makeAttendeeId(email, uniqueId, qrCode, sourceRow),
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
        importedAt: new Date().toISOString(),
        sourceRow,
        original,
      }
    })
    .filter((attendee): attendee is Attendee => attendee !== null)

  return {
    attendees,
    warnings,
    fileName: file.name,
  }
}

function formatExportDate(value: string | null) {
  if (!value) {
    return ''
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function buildExportRows(attendees: Attendee[]) {
  return attendees.map((attendee) => ({
    Name: attendee.name,
    Email: attendee.email,
    'Attendee ID': attendee.uniqueId,
    'QR Code': attendee.qrCode,
    Company: attendee.company,
    'Ticket Type': attendee.ticketType,
    Interval: attendee.admissionItem,
    'Programare K Scan': attendee.sessions,
    'Prelucrare foto': attendee.photo,
    Status: attendee.checkedIn ? 'Checked In' : 'Not Checked In',
    'Check-In Time': formatExportDate(attendee.checkInTime),
    'Goodie Bag': attendee.goodieBag
      ? 'Ridicat'
      : attendee.checkedIn
        ? 'Eligibil (Neridicat)'
        : 'Neeligibil (Fără Check-In)',
    'Data/Ora Goodie Bag': formatExportDate(attendee.goodieBagTime),
  }))
}

export function exportAttendeesAsCsv(attendees: Attendee[]) {
  const worksheet = XLSX.utils.json_to_sheet(buildExportRows(attendees))
  const csv = XLSX.utils.sheet_to_csv(worksheet)
  downloadFile(csv, 'event-checkins.csv', 'text/csv;charset=utf-8')
}

export function exportAttendeesAsXlsx(attendees: Attendee[]) {
  const worksheet = XLSX.utils.json_to_sheet(buildExportRows(attendees))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Check-Ins')
  XLSX.writeFile(workbook, 'event-checkins.xlsx')
}

function downloadFile(content: string, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
