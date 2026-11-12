import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import './App.css'
import { exportAttendeesAsCsv, exportAttendeesAsXlsx, normalizeCode, parseAttendeeWorkbook } from './excel'
import {
  clearAttendees,
  importAttendees,
  loadAttendanceSummary,
  loadAttendees,
  loadCurrentUser,
  loadCventStatus,
  loadEventName,
  markAttendeeCheckIn,
  markAttendeeGoodieBag,
  saveEventName,
  signIn,
  signOut,
  triggerCventSync,
  verifyScan,
} from './storage'
import type { AttendanceSummary, Attendee, AuthUser, CventSyncStatus, MinimalScannedAttendee, ScanMode, ScanResult } from './types'

type AppView = 'scanner' | 'admin'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const initialScanResult: ScanResult = {
  type: 'idle',
  message: 'Sign in, load attendees from the secure database, then start scanning badges.',
}
const logoSrc = `${import.meta.env.BASE_URL}nct.png`

const scanHoldMs = 5000

function ticketStatusClass(value: string) {
  const normalizedValue = value.trim().toLowerCase()

  if (normalizedValue === 'canceled' || normalizedValue === 'cancelled') {
    return 'canceled'
  }

  if (normalizedValue === 'accepted') {
    return 'accepted'
  }

  return ''
}

function ticketTypeLabel(value: string) {
  if (ticketStatusClass(value) === 'canceled') {
    return 'Status: Invitation canceled by attendee.'
  }

  const trimmedValue = value.trim()

  return trimmedValue ? `Status: ${trimmedValue}` : 'Ticket type not specified'
}

function scanVisualState(result: ScanResult) {
  if (result.type === 'not-found' || result.type === 'not_checked_in_for_goodie_bag') {
    return 'invalid'
  }

  if (result.type === 'goodie_bag_collected') {
    return 'goodie-bag-success'
  }

  if (result.type === 'goodie_bag_duplicate') {
    return 'goodie-bag-duplicate'
  }

  if (
    (result.type === 'success' || result.type === 'duplicate') &&
    ticketStatusClass(result.attendee.ticketType) === 'canceled'
  ) {
    return 'canceled'
  }

  return result.type
}

function scanStatusLabel(result: ScanResult) {
  if (result.type === 'success') {
    return 'Check-In Intrare Efectuat'
  }

  if (result.type === 'duplicate') {
    return 'Bilet Scanat Deja'
  }

  if (result.type === 'goodie_bag_collected') {
    return 'Goodie Bag Acordat'
  }

  if (result.type === 'goodie_bag_duplicate') {
    return 'Goodie Bag Deja Ridicat'
  }

  if (result.type === 'not_checked_in_for_goodie_bag') {
    return 'Check-In Intrare Lipsă'
  }

  if (result.type === 'not-found') {
    return 'Cod Invalid / Negăsit'
  }

  if (result.type === 'rate-limited') {
    return 'Prea multe încercări'
  }

  return 'Gata de scanare'
}

function cameraHelpMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : ''

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera access is blocked. In the browser settings for this site, set Camera to Allow, then tap Start Camera.'
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. Connect a camera or switch to a phone, then tap Start Camera.'
  }

  if (!window.isSecureContext) {
    return 'The camera only works on a secure page. Open this app with HTTPS, allow camera access, then tap Start Camera.'
  }

  return 'The camera could not start. Allow camera access for this site in the browser settings, then tap Start Camera.'
}

function ScannedDetails({ attendee }: { attendee: MinimalScannedAttendee }) {
  return (
    <>
      {attendee.admissionItem ? (
        <p className="scan-value scan-direct-value">{attendee.admissionItem}</p>
      ) : null}
      {attendee.sessions ? (
        <p className="scan-value scan-direct-value">{attendee.sessions}</p>
      ) : null}
      {attendee.photo ? (
        <p className="scan-value scan-photo-value">Prelucrare foto: {attendee.photo}</p>
      ) : null}
      {attendee.checkInTime ? (
        <p className="scan-value scan-meta-time">Check-In Intrare: {formatDateTime(attendee.checkInTime)}</p>
      ) : null}
      {attendee.goodieBagTime ? (
        <p className="scan-value scan-meta-time goodie-highlight">
          <GiftIcon size={14} />
          <span>Goodie Bag: {formatDateTime(attendee.goodieBagTime)}</span>
        </p>
      ) : null}
    </>
  )
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '-'
  }

  return dateFormatter.format(date)
}

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  const saved = localStorage.getItem('nct_theme')
  if (saved === 'dark') return 'dark'
  return 'light'
}

function TicketIcon({ className = '', size = 18 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </svg>
  )
}

function GiftIcon({ className = '', size = 18 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13" />
      <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
    </svg>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={onToggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Comută la modul luminos' : 'Comută la modul întunecat'}
    >
      {theme === 'dark' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  )
}

function ModalScanDetails({
  scanResult,
  onQuickGoodieBag,
  onResume,
}: {
  scanResult: ScanResult
  onQuickGoodieBag: (attendee: MinimalScannedAttendee) => void
  onResume: () => void
}) {
  const isPerson =
    scanResult.type === 'success' ||
    scanResult.type === 'duplicate' ||
    scanResult.type === 'goodie_bag_collected' ||
    scanResult.type === 'goodie_bag_duplicate' ||
    scanResult.type === 'not_checked_in_for_goodie_bag'

  if (scanResult.type === 'idle') {
    return (
      <div className="modal-result-card idle-card">
        <div className="modal-idle-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M7 7h.01M17 7h.01M7 17h.01M17 17h.01" />
            <path d="M7 12h10M12 7v10" />
          </svg>
        </div>
        <div className="modal-idle-text">
          <h3>Gata de scanare</h3>
          <p>Îndreaptă camera către codul QR al ecusonului</p>
        </div>
      </div>
    )
  }

  if (scanResult.type === 'not-found' || scanResult.type === 'rate-limited') {
    return (
      <div className="modal-result-card error-card">
        <div className="modal-status-pill error-pill">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span>{scanStatusLabel(scanResult)}</span>
        </div>
        <p className="modal-error-msg">{scanResult.message}</p>
        <code className="modal-scanned-code">{scanResult.scannedCode}</code>
        <button type="button" className="modal-resume-btn" onClick={onResume}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Scanează următorul</span>
        </button>
      </div>
    )
  }

  if (!isPerson) {
    return null
  }

  const { attendee } = scanResult
  const isGoodieEligible = !attendee.goodieBag && !attendee.goodieBagTime

  let pillClass = 'success-pill'
  if (scanResult.type === 'duplicate') pillClass = 'warning-pill'
  else if (scanResult.type === 'goodie_bag_collected') pillClass = 'goodie-pill'
  else if (scanResult.type === 'goodie_bag_duplicate') pillClass = 'warning-pill'
  else if (scanResult.type === 'not_checked_in_for_goodie_bag') pillClass = 'error-pill'

  return (
    <div className={`modal-result-card person-card ${scanVisualState(scanResult)}`}>
      <div className="modal-card-header">
        <div className={`modal-status-pill ${pillClass}`}>
          {scanResult.type === 'goodie_bag_collected' ? (
            <GiftIcon size={14} />
          ) : scanResult.type === 'success' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <TicketIcon size={14} />
          )}
          <span>{scanStatusLabel(scanResult)}</span>
        </div>
        {attendee.ticketType ? (
          <span className={`modal-ticket-chip ${ticketStatusClass(attendee.ticketType)}`}>
            {attendee.ticketType}
          </span>
        ) : null}
      </div>

      <h2 className="modal-attendee-name">{attendee.name}</h2>

      <div className="modal-details-grid">
        {attendee.admissionItem ? (
          <div className="modal-info-item">
            <span className="modal-info-label">Interval Orar:</span>
            <span className="modal-info-val highlight">{attendee.admissionItem}</span>
          </div>
        ) : null}
        {attendee.sessions ? (
          <div className="modal-info-item">
            <span className="modal-info-label">Programare:</span>
            <span className="modal-info-val">{attendee.sessions}</span>
          </div>
        ) : null}
        {attendee.photo ? (
          <div className="modal-info-item">
            <span className="modal-info-label">Prelucrare Foto:</span>
            <span className="modal-info-val">{attendee.photo}</span>
          </div>
        ) : null}
        <div className="modal-info-item">
          <span className="modal-info-label">Check-In:</span>
          <span className="modal-info-val">{formatDateTime(attendee.checkInTime)}</span>
        </div>
        <div className="modal-info-item">
          <span className="modal-info-label">Goodie Bag:</span>
          <span className={`modal-info-val ${attendee.goodieBagTime ? 'goodie-text' : ''}`}>
            {attendee.goodieBagTime ? formatDateTime(attendee.goodieBagTime) : 'Neacordat'}
          </span>
        </div>
      </div>

      <p className="modal-feedback-msg">{scanResult.message}</p>

      <div className="modal-actions-row">
        {isGoodieEligible ? (
          <button
            type="button"
            className="modal-goodie-action-btn"
            onClick={() => onQuickGoodieBag(attendee)}
          >
            <GiftIcon size={16} />
            <span>Acordă Goodie Bag acum</span>
          </button>
        ) : null}

        <button
          type="button"
          className="modal-resume-btn"
          onClick={onResume}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Scanează următorul</span>
        </button>
      </div>
    </div>
  )
}

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [view, setView] = useState<AppView>('scanner')
  const scanMode: ScanMode = 'checkin'
  const [adminFilter, setAdminFilter] = useState<'all' | 'checked_in' | 'not_checked_in' | 'goodie_bag_collected' | 'goodie_bag_pending'>('all')
  const [attendees, setAttendees] = useState<Attendee[]>([])
  const [eventName, setEventName] = useState('Event Check-In')
  const [scanResult, setScanResult] = useState<ScanResult>(initialScanResult)
  const [scannerModalOpen, setScannerModalOpen] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [manualCode, setManualCode] = useState('')
  const [search, setSearch] = useState('')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [eventNameStatus, setEventNameStatus] = useState('')
  const [summary, setSummary] = useState<AttendanceSummary>({
    total: 0,
    checkedIn: 0,
    notCheckedIn: 0,
    goodieBagCollected: 0,
    goodieBagRemaining: 0,
  })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const lastScanRef = useRef({ code: '', scannedAt: 0 })
  const scanHoldUntilRef = useRef(0)
  const scanPendingRef = useRef(false)
  const suppressCodeRef = useRef('')
  const holdTimerRef = useRef<number | null>(null)
  const [scanHoldUntil, setScanHoldUntil] = useState(0)
  const dataRequestIdRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importSuccess, setImportSuccess] = useState('')
  const [importError, setImportError] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [cventStatus, setCventStatus] = useState<CventSyncStatus | null>(null)
  const [cventSyncing, setCventSyncing] = useState(false)
  const [cventSyncMsg, setCventSyncMsg] = useState('')

  const isAdmin = user?.role === 'admin'

  const attendeesCount = attendees.length
  const attendeesCheckedInCount = useMemo(
    () => attendees.filter((a) => a.checkedIn || Boolean(a.checkInTime)).length,
    [attendees],
  )
  const attendeesGoodieBagCount = useMemo(
    () => attendees.filter((a) => a.goodieBag || Boolean(a.goodieBagTime)).length,
    [attendees],
  )
  const attendeesEligibleGoodieBagCount = useMemo(
    () =>
      attendees.filter(
        (a) => (a.checkedIn || Boolean(a.checkInTime)) && !a.goodieBag && !a.goodieBagTime,
      ).length,
    [attendees],
  )

  const totalCount =
    attendeesCount > 0
      ? attendeesCount
      : typeof summary.total === 'number' && !Number.isNaN(summary.total) && summary.total > 0
        ? summary.total
        : 0

  const checkedInCount =
    attendeesCount > 0
      ? attendeesCheckedInCount
      : typeof summary.checkedIn === 'number' && !Number.isNaN(summary.checkedIn)
        ? summary.checkedIn
        : 0

  const notCheckedInCount = Math.max(totalCount - checkedInCount, 0)

  const goodieBagCollectedCount =
    attendeesCount > 0
      ? attendeesGoodieBagCount
      : typeof summary.goodieBagCollected === 'number' && !Number.isNaN(summary.goodieBagCollected)
        ? summary.goodieBagCollected
        : 0

  const goodieBagRemainingCount =
    attendeesCount > 0
      ? attendeesEligibleGoodieBagCount
      : typeof summary.goodieBagRemaining === 'number' && !Number.isNaN(summary.goodieBagRemaining)
        ? summary.goodieBagRemaining
        : 0

  const filteredAttendees = useMemo(() => {
    const term = search.trim().toLowerCase()

    return attendees.filter((attendee) => {
      const isCheckedIn = Boolean(attendee.checkedIn || attendee.checkInTime)
      const isGoodie = Boolean(attendee.goodieBag || attendee.goodieBagTime)

      if (adminFilter === 'checked_in' && !isCheckedIn) return false
      if (adminFilter === 'not_checked_in' && isCheckedIn) return false
      if (adminFilter === 'goodie_bag_collected' && !isGoodie) return false
      if (adminFilter === 'goodie_bag_pending' && (!isCheckedIn || isGoodie)) return false

      if (!term) return true

      return [
        attendee.name,
        attendee.email,
        attendee.uniqueId,
        attendee.qrCode,
        attendee.company,
        attendee.ticketType,
        attendee.admissionItem,
        attendee.sessions,
        attendee.photo,
        attendee.checkedIn ? 'checked in prezent' : 'not checked in neprezentat',
        attendee.goodieBag ? 'goodie bag ridicat' : 'fara goodie bag',
        formatDateTime(attendee.checkInTime),
        formatDateTime(attendee.goodieBagTime),
      ]
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
  }, [adminFilter, attendees, search])

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    setCameraOn(false)
  }, [])

  const refreshData = useCallback(async () => {
    if (!user) {
      setAttendees([])
      return
    }

    const requestId = dataRequestIdRef.current + 1
    dataRequestIdRef.current = requestId
    const activeUserId = user.id

    setDataLoading(true)
    setDataError('')

    try {
      const [nextEventName, nextSummary, nextAttendees, nextCventStatus] = await Promise.all([
        loadEventName(),
        loadAttendanceSummary(),
        loadAttendees(),
        loadCventStatus().catch(() => ({ configured: false })),
      ])

      if (dataRequestIdRef.current !== requestId || user.id !== activeUserId) {
        return
      }

      setEventName(nextEventName)
      setSummary(nextSummary)
      setAttendees(nextAttendees)
      setCventStatus(nextCventStatus)
      setScanResult((currentResult) =>
        currentResult.type === 'idle'
          ? {
              type: 'idle',
              message:
                nextSummary.total > 0
                  ? 'Attendee list loaded. Start camera scanning when ready.'
                  : 'No attendees found in the database. Add attendee rows before scanning.',
            }
          : currentResult,
      )
    } catch (error) {
      if (dataRequestIdRef.current !== requestId) {
        return
      }

      setDataError(error instanceof Error ? error.message : 'Could not load database data.')
    } finally {
      if (dataRequestIdRef.current === requestId) {
        setDataLoading(false)
      }
    }
  }, [user])

  const handleQuickCheckIn = useCallback(
    async (attendee: Attendee) => {
      const nowIso = new Date().toISOString()
      // 1. Optimistic immediate local state update
      setAttendees((prev) =>
        prev.map((a) => (a.id === attendee.id ? { ...a, checkedIn: true, checkInTime: a.checkInTime || nowIso } : a)),
      )
      setSummary((prev) => ({
        ...prev,
        checkedIn: prev.checkedIn + 1,
        notCheckedIn: Math.max(prev.notCheckedIn - 1, 0),
        goodieBagRemaining: (prev.goodieBagRemaining ?? 0) + 1,
      }))
      setScanResult({
        type: 'success',
        attendee: {
          id: attendee.id,
          name: attendee.name,
          ticketType: attendee.ticketType,
          admissionItem: attendee.admissionItem,
          sessions: attendee.sessions,
          photo: attendee.photo,
          checkedIn: true,
          checkInTime: attendee.checkInTime || nowIso,
          goodieBag: attendee.goodieBag,
          goodieBagTime: attendee.goodieBagTime,
          qrCode: attendee.qrCode,
        },
        message: `Check-in intrare efectuat la ${formatDateTime(nowIso)}.`,
      })

      // 2. Direct Backend API update
      try {
        const response = await markAttendeeCheckIn(attendee.id, attendee.qrCode)
        if (response.status === 'checked_in' || response.status === 'duplicate') {
          const finalTime = response.attendee.checkInTime || nowIso
          setAttendees((prev) =>
            prev.map((a) => (a.id === attendee.id ? { ...a, checkedIn: true, checkInTime: finalTime } : a)),
          )
        }
        loadAttendanceSummary().then(setSummary).catch(() => undefined)
      } catch (err) {
        console.error('Check-in error:', err)
      }
    },
    [],
  )

  const handleQuickGoodieBag = useCallback(
    async (attendee: Attendee) => {
      const nowIso = new Date().toISOString()
      // 1. Optimistic immediate local state update
      setAttendees((prev) =>
        prev.map((a) =>
          a.id === attendee.id
            ? {
                ...a,
                goodieBag: true,
                goodieBagTime: a.goodieBagTime || nowIso,
                checkedIn: true,
                checkInTime: a.checkInTime || nowIso,
              }
            : a,
        ),
      )
      setSummary((prev) => ({
        ...prev,
        goodieBagCollected: (prev.goodieBagCollected ?? 0) + 1,
        goodieBagRemaining: Math.max((prev.goodieBagRemaining ?? 0) - 1, 0),
      }))
      setScanResult({
        type: 'goodie_bag_collected',
        attendee: {
          id: attendee.id,
          name: attendee.name,
          ticketType: attendee.ticketType,
          admissionItem: attendee.admissionItem,
          sessions: attendee.sessions,
          photo: attendee.photo,
          checkedIn: true,
          checkInTime: attendee.checkInTime || nowIso,
          goodieBag: true,
          goodieBagTime: attendee.goodieBagTime || nowIso,
          qrCode: attendee.qrCode,
        },
        message: `Goodie Bag acordat cu succes la ${formatDateTime(nowIso)}!`,
      })

      // 2. Direct Backend API update
      try {
        const response = await markAttendeeGoodieBag(attendee.id, attendee.qrCode)
        if (response.status === 'goodie_bag_collected' || response.status === 'goodie_bag_duplicate') {
          const finalTime = response.attendee.goodieBagTime || nowIso
          setAttendees((prev) =>
            prev.map((a) =>
              a.id === attendee.id
                ? {
                    ...a,
                    goodieBag: true,
                    goodieBagTime: finalTime,
                    checkedIn: true,
                    checkInTime: a.checkInTime || response.attendee.checkInTime || nowIso,
                  }
                : a,
            ),
          )
        }
        loadAttendanceSummary().then(setSummary).catch(() => undefined)
      } catch (err) {
        console.error('Goodie bag error:', err)
      }
    },
    [],
  )


  async function exportLatest(kind: 'csv' | 'xlsx') {
    try {
      const latestAttendees = await loadAttendees()
      setAttendees(latestAttendees)

      if (kind === 'csv') {
        exportAttendeesAsCsv(latestAttendees)
        return
      }

      exportAttendeesAsXlsx(latestAttendees)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not export attendees.')
    }
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('nct_theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))
  }, [])

  useEffect(() => {
    let mounted = true

    loadCurrentUser().then((currentUser) => {
      if (!mounted) {
        return
      }

      setUser(currentUser)
      setAuthLoading(false)
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    function handleUnauthorized() {
      dataRequestIdRef.current += 1
      stopCamera()
      setUser(null)
      setAuthError('Your session expired. Please sign in again.')
    }

    window.addEventListener('event-checkin:unauthorized', handleUnauthorized)

    return () => {
      window.removeEventListener('event-checkin:unauthorized', handleUnauthorized)
    }
  }, [stopCamera])

  useEffect(() => {
    if (user) {
      refreshData()
    } else {
      dataRequestIdRef.current += 1
      stopCamera()
      setAttendees([])
      setSummary({
        total: 0,
        checkedIn: 0,
        notCheckedIn: 0,
        goodieBagCollected: 0,
        goodieBagRemaining: 0,
      })
      setScanResult(initialScanResult)
    }
  }, [refreshData, stopCamera, user])

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authSubmitting) {
      return
    }

    setAuthError('')
    setAuthSubmitting(true)

    try {
      const signedInUser = await signIn(authEmail.trim(), authPassword)
      setUser(signedInUser)
      setAuthPassword('')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to sign in.')
    } finally {
      setAuthSubmitting(false)
    }
  }

  async function handleSignOut() {
    try {
      stopCamera()
      await signOut()
      dataRequestIdRef.current += 1
      setUser(null)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not log out. Please try again.')
    }
  }

  async function handleEventNameBlur() {
    if (!user) {
      return
    }

    setEventNameStatus('Saving...')

    try {
      await saveEventName(eventName.trim() || 'Event Check-In')
      setEventNameStatus('Saved')
      window.setTimeout(() => setEventNameStatus(''), 1800)
    } catch (error) {
      setEventNameStatus(error instanceof Error ? error.message : 'Could not save event name.')
    }
  }

  const releaseScanHold = useCallback(() => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    scanHoldUntilRef.current = 0
    setScanHoldUntil(0)
  }, [])

  const beginScanHold = useCallback(
    (normalizedCode: string) => {
      const until = Date.now() + scanHoldMs
      scanHoldUntilRef.current = until
      suppressCodeRef.current = normalizedCode
      setScanHoldUntil(until)

      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current)
      }

      holdTimerRef.current = window.setTimeout(() => {
        scanHoldUntilRef.current = 0
        setScanHoldUntil(0)
        holdTimerRef.current = null
      }, scanHoldMs)
    },
    [],
  )

  const resumeScanning = useCallback(() => {
    lastScanRef.current = { code: '', scannedAt: 0 }
    suppressCodeRef.current = ''
    scanPendingRef.current = false
    releaseScanHold()
    setScanResult({
      type: 'idle',
      message: 'Îndreaptă camera către codul QR al ecusonului.',
    })
  }, [releaseScanHold])

  const openScannerModal = useCallback(() => {
    setScannerModalOpen(true)
    setCameraOn(true)
    resumeScanning()
  }, [resumeScanning])

  const closeScannerModal = useCallback(() => {
    setScannerModalOpen(false)
    stopCamera()
  }, [stopCamera])

  useEffect(() => {
    if (!scannerModalOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeScannerModal()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [scannerModalOpen, closeScannerModal])

  useEffect(() => {
    if (scannerModalOpen) {
      document.body.classList.add('modal-open')
    } else {
      document.body.classList.remove('modal-open')
    }
    return () => {
      document.body.classList.remove('modal-open')
    }
  }, [scannerModalOpen])

  useEffect(
    () => () => {
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current)
      }
    },
    [],
  )

  const handleQrScan = useCallback(
    async (rawCode: string, source: 'camera' | 'manual' = 'camera', explicitMode?: ScanMode) => {
      const mode = explicitMode ?? scanMode
      const scannedCode = rawCode.trim()
      const normalizedScannedCode = normalizeCode(scannedCode)

      if (!normalizedScannedCode || !user) {
        return
      }

      const now = Date.now()

      if (scanPendingRef.current || now < scanHoldUntilRef.current) {
        return
      }

      if (source === 'camera' && suppressCodeRef.current === normalizedScannedCode) {
        return
      }

      if (
        lastScanRef.current.code === normalizedScannedCode &&
        now - lastScanRef.current.scannedAt < 2500
      ) {
        return
      }

      lastScanRef.current = {
        code: normalizedScannedCode,
        scannedAt: now,
      }
      suppressCodeRef.current = ''

      scanPendingRef.current = true

      try {
        const response = await verifyScan(scannedCode, mode)

        if (response.status === 'not_found') {
          setScanResult({
            type: 'not-found',
            scannedCode,
            message: 'Acest cod QR nu a fost găsit în baza de date a evenimentului.',
          })
          beginScanHold(normalizedScannedCode)
          return
        }

        if (response.status === 'rate_limited') {
          setScanResult({
            type: 'rate-limited',
            scannedCode,
            message: `Prea multe încercări. Reîncearcă în ${response.retryAfterSeconds} secunde.`,
          })
          beginScanHold(normalizedScannedCode)
          return
        }

        if (response.status === 'not_checked_in_for_goodie_bag') {
          setScanResult({
            type: 'not_checked_in_for_goodie_bag',
            attendee: response.attendee,
            message: 'NU POATE PRIMI GOODIE BAG! Participantul nu este scanat la intrare (Check-In lipsă).',
          })
          beginScanHold(normalizedScannedCode)
          return
        }


        if (response.status === 'goodie_bag_collected') {
          setScanResult({
            type: 'goodie_bag_collected',
            attendee: response.attendee,
            message: `Goodie Bag acordat cu succes la ${formatDateTime(response.attendee.goodieBagTime)}!`,
          })
          beginScanHold(normalizedScannedCode)
          const targetId = response.attendee.id
          const targetQr = response.attendee.qrCode ? normalizeCode(response.attendee.qrCode) : ''
          setAttendees((prev) =>
            prev.map((a) =>
              (targetId && a.id === targetId) ||
              (targetQr && normalizeCode(a.qrCode) === targetQr) ||
              normalizeCode(a.qrCode) === normalizedScannedCode
                ? {
                    ...a,
                    goodieBag: true,
                    goodieBagTime: response.attendee.goodieBagTime || new Date().toISOString(),
                    checkedIn: true,
                    checkInTime: a.checkInTime || response.attendee.checkInTime || new Date().toISOString(),
                  }
                : a,
            ),
          )
          const scanRequestId = dataRequestIdRef.current
          loadAttendanceSummary()
            .then((nextSummary) => {
              if (dataRequestIdRef.current === scanRequestId) {
                setSummary(nextSummary)
              }
            })
            .catch(() => undefined)
          return
        }

        if (response.status === 'goodie_bag_duplicate') {
          setScanResult({
            type: 'goodie_bag_duplicate',
            attendee: response.attendee,
            message: `Goodie Bag deja ridicat la ${formatDateTime(response.attendee.goodieBagTime)}.`,
          })
          beginScanHold(normalizedScannedCode)
          const targetId = response.attendee.id
          const targetQr = response.attendee.qrCode ? normalizeCode(response.attendee.qrCode) : ''
          setAttendees((prev) =>
            prev.map((a) =>
              (targetId && a.id === targetId) ||
              (targetQr && normalizeCode(a.qrCode) === targetQr) ||
              normalizeCode(a.qrCode) === normalizedScannedCode
                ? {
                    ...a,
                    goodieBag: true,
                    goodieBagTime: response.attendee.goodieBagTime || a.goodieBagTime || new Date().toISOString(),
                    checkedIn: true,
                    checkInTime: a.checkInTime || response.attendee.checkInTime || new Date().toISOString(),
                  }
                : a,
            ),
          )
          const scanRequestId = dataRequestIdRef.current
          loadAttendanceSummary()
            .then((nextSummary) => {
              if (dataRequestIdRef.current === scanRequestId) {
                setSummary(nextSummary)
              }
            })
            .catch(() => undefined)
          return
        }

        if (response.status === 'duplicate') {
          const isGoodie = Boolean(response.attendee.goodieBag || response.attendee.goodieBagTime)
          setScanResult({
            type: 'duplicate',
            attendee: response.attendee,
            message: isGoodie
              ? `Bilet scanat deja la ${formatDateTime(response.attendee.checkInTime)}. Goodie Bag deja ridicat.`
              : `Bilet scanat deja la ${formatDateTime(response.attendee.checkInTime)}.`,
          })
          beginScanHold(normalizedScannedCode)
          const targetId = response.attendee.id
          const targetQr = response.attendee.qrCode ? normalizeCode(response.attendee.qrCode) : ''
          setAttendees((prev) =>
            prev.map((a) =>
              (targetId && a.id === targetId) ||
              (targetQr && normalizeCode(a.qrCode) === targetQr) ||
              normalizeCode(a.qrCode) === normalizedScannedCode
                ? {
                    ...a,
                    checkedIn: true,
                    checkInTime: response.attendee.checkInTime || a.checkInTime,
                    goodieBag: response.attendee.goodieBag || a.goodieBag,
                    goodieBagTime: response.attendee.goodieBagTime || a.goodieBagTime,
                  }
                : a,
            ),
          )
          const scanRequestId = dataRequestIdRef.current
          loadAttendanceSummary()
            .then((nextSummary) => {
              if (dataRequestIdRef.current === scanRequestId) {
                setSummary(nextSummary)
              }
            })
            .catch(() => undefined)
          return
        }

        setScanResult({
          type: 'success',
          attendee: response.attendee,
          message: `Check-in intrare efectuat la ${formatDateTime(response.attendee.checkInTime)}.`,
        })
        beginScanHold(normalizedScannedCode)
        const targetId = response.attendee.id
        const targetQr = response.attendee.qrCode ? normalizeCode(response.attendee.qrCode) : ''
        setAttendees((prev) =>
          prev.map((a) =>
            (targetId && a.id === targetId) ||
            (targetQr && normalizeCode(a.qrCode) === targetQr) ||
            normalizeCode(a.qrCode) === normalizedScannedCode
              ? { ...a, checkedIn: true, checkInTime: response.attendee.checkInTime || new Date().toISOString() }
              : a,
          ),
        )
        const scanRequestId = dataRequestIdRef.current
        loadAttendanceSummary()
          .then((nextSummary) => {
            if (dataRequestIdRef.current === scanRequestId) {
              setSummary(nextSummary)
            }
          })
          .catch(() => undefined)
      } catch (error) {
        setScanResult({
          type: 'not-found',
          scannedCode,
          message: error instanceof Error ? error.message : 'Eroare la procesarea codului.',
        })
        beginScanHold(normalizedScannedCode)
      } finally {
        scanPendingRef.current = false
      }
    },
    [beginScanHold, scanMode, user],
  )

  useEffect(() => {
    if (!cameraOn || !scannerModalOpen) {
      return undefined
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        'This browser cannot open the camera. Use Chrome or Safari, allow camera access, and open the page with HTTPS.',
      )
      setCameraOn(false)
      return undefined
    }

    let cancelled = false
    const codeReader = new BrowserQRCodeReader()

    async function startCamera() {
      try {
        setCameraError('')
        const controls = await codeReader.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          },
          videoRef.current ?? undefined,
          (result) => {
            if (result) {
              handleQrScan(result.getText())
            }
          },
        )

        if (cancelled) {
          controls.stop()
          return
        }

        controlsRef.current = controls
      } catch (error) {
        setCameraError(cameraHelpMessage(error))
        setCameraOn(false)
      }
    }

    startCamera()

    return () => {
      cancelled = true
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [cameraOn, handleQrScan, scannerModalOpen])

  function handleManualSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    handleQrScan(manualCode, 'manual')
    setManualCode('')
  }

  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    setImportLoading(true)
    setImportSuccess('')
    setImportError('')
    setImportWarnings([])

    try {
      const parsed = await parseAttendeeWorkbook(file)
      setImportWarnings(parsed.warnings)

      if (parsed.attendees.length === 0) {
        setImportError(
          'No valid attendees found in the file. Ensure your file contains a QR Code column and attendee rows.',
        )
        return
      }

      const response = await importAttendees(parsed.attendees)
      setImportSuccess(
        response.message || `Successfully imported ${response.count} attendee${response.count === 1 ? '' : 's'}.`,
      )
      await refreshData()
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Failed to import attendee file.')
    } finally {
      setImportLoading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  async function handleCventSync() {
    setCventSyncing(true)
    setCventSyncMsg('')
    try {
      const result = await triggerCventSync()
      if (result.success) {
        setCventSyncMsg(
          `Sincronizare Cvent reușită: ${result.imported} adăugați, ${result.updated} actualizați (total ${result.total}).`,
        )
        await refreshData()
      } else {
        setCventSyncMsg(`Eroare sincronizare Cvent: ${result.error || 'Verificați configurarea.'}`)
      }
    } catch (err) {
      setCventSyncMsg(err instanceof Error ? err.message : 'Eroare la sincronizarea cu Cvent.')
    } finally {
      setCventSyncing(false)
    }
  }

  async function handleClearData() {
    const confirmed = window.confirm('Clear all imported attendees and check-in status?')

    if (!confirmed) {
      return
    }

    try {
      stopCamera()
      await clearAttendees()
      setAttendees([])
      setSummary({
        total: 0,
        checkedIn: 0,
        notCheckedIn: 0,
        goodieBagCollected: 0,
        goodieBagRemaining: 0,
      })
      setScanResult(initialScanResult)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not clear attendees.')
    }
  }

  if (authLoading) {
    return (
      <div className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Loading</p>
          <h1>Checking staff session...</h1>
        </section>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="auth-shell">
        <div className="auth-theme-bar">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
        <form className="auth-card" onSubmit={handleSignIn} aria-busy={authSubmitting}>
          <div className="auth-header">
            <div className="auth-badge-icon" aria-hidden="true">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2" />
                <path d="M17 3h2a2 2 0 0 1 2 2v2" />
                <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
                <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                <rect x="7" y="7" width="10" height="10" rx="1.5" />
              </svg>
            </div>
            <p className="eyebrow">Staff Portal</p>
            <h1>Welcome to Check-In</h1>
            <p className="auth-subtitle">Sign in to scan attendee badges and track live check-ins.</p>
          </div>

          <label>
            Email
            <input
              type="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {authError ? <p className="alert error">{authError}</p> : null}

          <button type="submit" className="primary-button" disabled={authSubmitting}>
            {authSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <img
            className="brand-logo"
            src={logoSrc}
            alt="NCT"
            onError={(event) => {
              const currentTarget = event.currentTarget
              if (!currentTarget.dataset.retried) {
                currentTarget.dataset.retried = 'true'
                currentTarget.src = 'nct.png'
              } else {
                currentTarget.style.display = 'none'
              }
            }}
          />
          <div className="brand-title-wrap">
            {isAdmin ? (
              <input
                id="event-name"
                className="event-name-input"
                value={eventName}
                onChange={(event) => setEventName(event.target.value)}
                onBlur={handleEventNameBlur}
                aria-label="Event name"
                placeholder="Event Check-In"
              />
            ) : (
              <span className="event-name-input" role="heading" aria-level={1}>
                {eventName || 'Event Check-In'}
              </span>
            )}
            {eventNameStatus ? <span className="save-status">{eventNameStatus}</span> : null}
          </div>
        </div>

        <div className="header-actions">
          <nav className={`top-tabs ${view === 'admin' ? 'tab-admin-active' : 'tab-scanner-active'}`} aria-label="Main navigation">
            <span className="tab-liquid-pill" aria-hidden="true" />
            <button
              type="button"
              className={view === 'scanner' ? 'active' : ''}
              aria-current={view === 'scanner' ? 'page' : undefined}
              onClick={() => setView('scanner')}
            >
              Check-In
            </button>
            <button
              type="button"
              className={view === 'admin' ? 'active' : ''}
              aria-current={view === 'admin' ? 'page' : undefined}
              onClick={() => setView('admin')}
            >
              {isAdmin ? 'Admin' : 'Attendees'}
            </button>
          </nav>
          <div className="staff-row">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <div className="staff-chip">
              <span>{user.email}</span>
              <button type="button" onClick={handleSignOut}>
                Log out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main aria-busy={dataLoading}>
        {dataError ? <p className="alert error">{dataError}</p> : null}
        {dataLoading ? <p className="alert info">Loading shared attendee data...</p> : null}

        <section className="stats-grid" aria-label="Attendance summary">
          <div className="stat-card">
            <span>Total</span>
            <strong>{totalCount}</strong>
          </div>
          <div className="stat-card checked">
            <span>Check-In Intrare</span>
            <strong>{checkedInCount}</strong>
          </div>
          <div className="stat-card waiting">
            <span>Not Checked In</span>
            <strong>{notCheckedInCount}</strong>
          </div>
          <div className="stat-card goodie-collected">
            <span>Goodie Bags Predate</span>
            <strong>{goodieBagCollectedCount}</strong>
          </div>
        </section>

        {view === 'scanner' ? (
          <section className="scanner-layout view-transition" key="scanner">
            <div className="panel scanner-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">QR CHECK-IN</p>
                  <h2>Scanare Badge Acces</h2>
                </div>
              </div>

              <div className="scanner-launch-card">
                <div className="launch-icon-ring" aria-hidden="true">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </div>

                <div className="scanner-launch-actions">
                  <button
                    type="button"
                    className="primary-button open-scanner-btn"
                    disabled={summary.total === 0 || dataLoading}
                    onClick={openScannerModal}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    <span>Deschide Camera</span>
                  </button>
                  <button
                    type="button"
                    className="launch-refresh-btn"
                    disabled={dataLoading}
                    onClick={refreshData}
                    title="Actualizează datele"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                    <span>Actualizează date</span>
                  </button>
                </div>
              </div>
            </div>

            <div
              className={`scan-result ${scanVisualState(scanResult)}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <p className="result-status">{scanStatusLabel(scanResult)}</p>
              {scanResult.type === 'success' ||
              scanResult.type === 'duplicate' ||
              scanResult.type === 'goodie_bag_collected' ||
              scanResult.type === 'goodie_bag_duplicate' ||
              scanResult.type === 'not_checked_in_for_goodie_bag' ? (
                <div className="attendee-focus">
                  <h2>{scanResult.attendee.name}</h2>
                  <ScannedDetails attendee={scanResult.attendee} />
                  <p className="result-detail-message">{scanResult.message}</p>
                  <span className={`ticket-chip ${ticketStatusClass(scanResult.attendee.ticketType)}`}>
                    {ticketTypeLabel(scanResult.attendee.ticketType)}
                  </span>
                </div>
              ) : (
                <div className="attendee-focus">
                  <h2>{scanResult.type === 'idle' ? 'Ready to scan' : 'Check the badge'}</h2>
                  <p>{scanResult.message}</p>
                </div>
              )}
              {scanResult.type === 'not-found' || scanResult.type === 'rate-limited' ? (
                <code className="scanned-code">{scanResult.scannedCode}</code>
              ) : null}
              {scanHoldUntil > Date.now() ? (
                <button type="button" className="scan-again-button" onClick={resumeScanning}>
                  Scan Again
                </button>
              ) : null}
            </div>

            <div className="panel manual-panel">
              <div className="manual-panel-header">
                <div className="manual-badge-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M7 15h10M7 9h2M11 9h2M15 9h2" />
                  </svg>
                </div>
                <div>
                  <h3 className="manual-title">Introducere Manuală Cod QR</h3>
                  <p className="manual-subtitle">
                    Introdu codul biletului dacă nu poți scana cu camera
                  </p>
                </div>
              </div>

              <form className="manual-form" onSubmit={handleManualSubmit}>
                <div className="manual-input-row">
                  <input
                    id="manual-code"
                    value={manualCode}
                    onChange={(event) => setManualCode(event.target.value)}
                    placeholder="Introdu codul sau link-ul biletului"
                    autoComplete="off"
                  />
                  <button type="submit" disabled={!manualCode.trim() || summary.total === 0 || dataLoading}>
                    Check In
                  </button>
                </div>
              </form>
            </div>
          </section>
        ) : (
          <section className={isAdmin ? 'admin-layout view-transition' : 'admin-layout attendees-only view-transition'} key="admin">
            {isAdmin ? (
            <div className="panel upload-panel">
              <div>
                <p className="eyebrow">Back Office</p>
                <h1>Import Attendee List</h1>
                <p>
                  Upload an Excel (.xlsx, .xls) or CSV file with attendee badges. New attendees will be added
                  and existing attendees will have their details updated while preserving their check-in status.
                </p>
              </div>

              <label className="file-upload">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  disabled={importLoading}
                  onChange={handleFileSelect}
                />
                <span>{importLoading ? 'Importing attendees...' : 'Upload Excel or CSV File'}</span>
              </label>

              {importSuccess ? <div className="alert success">{importSuccess}</div> : null}
              {importError ? <div className="alert error">{importError}</div> : null}
              {importWarnings.length > 0 ? (
                <div className="alert warning">
                  <strong>Import Warnings:</strong>
                  <ul>
                    {importWarnings.slice(0, 8).map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                    {importWarnings.length > 8 ? (
                      <li>...and {importWarnings.length - 8} more warning(s).</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              <div className="alert warning">
                Recognized columns: Name (or First/Last Name) and QR Code (or Badge Code, Barcode).
                Optional columns: Email, Attendee ID, Company, Ticket Type.
              </div>

              <div className="cvent-sync-card">
                <div className="cvent-sync-header">
                  <div className="cvent-sync-title-wrap">
                    <div className="cvent-sync-badge-row">
                      <span className="eyebrow">Integrare Cvent</span>
                      <span
                        className={`cvent-status-pill ${
                          cventStatus?.configured ? 'cvent-pill-active' : 'cvent-pill-inactive'
                        }`}
                      >
                        <span className="cvent-status-dot" />
                        {cventStatus?.syncInProgress
                          ? 'Sincronizare...'
                          : cventStatus?.configured
                            ? `Live Sync Activ (${cventStatus.syncIntervalSec || 60}s)`
                            : 'Neconfigurat'}
                      </span>
                    </div>
                    <h3>Înregistrări pe loc (On-Site)</h3>
                    <p className="cvent-sync-desc">
                      Participanții înregistrați pe loc în Cvent sunt recunoscuți instant la scanarea biletului la intrare, iar lista este actualizată periodic în fundal.
                    </p>
                  </div>
                </div>

                {cventStatus?.configured ? (
                  <div className="cvent-sync-meta">
                    <div className="cvent-meta-item">
                      <span className="cvent-meta-label">Ultimul sync:</span>
                      <span className="cvent-meta-value">
                        {cventStatus.lastSyncTimestamp ? formatDateTime(cventStatus.lastSyncTimestamp) : 'În curând...'}
                      </span>
                    </div>
                    {cventStatus.lastResult && cventStatus.lastResult.total > 0 ? (
                      <div className="cvent-meta-item">
                        <span className="cvent-meta-label">Cvent Total:</span>
                        <span className="cvent-meta-value">
                          {cventStatus.lastResult.total} ({cventStatus.lastResult.imported} noi, {cventStatus.lastResult.updated} actualizați)
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="alert warning cvent-alert-compact">
                    Pentru sincronizare automată Cvent, adăugați credențialele în <code>.env</code> pe server (<code>CVENT_CLIENT_ID</code>, <code>CVENT_CLIENT_SECRET</code>, <code>CVENT_EVENT_ID</code>).
                  </div>
                )}

                {cventSyncMsg ? (
                  <div className={`alert ${cventSyncMsg.includes('Eroare') ? 'error' : 'success'}`}>
                    {cventSyncMsg}
                  </div>
                ) : null}

                <div className="cvent-sync-actions">
                  <button
                    type="button"
                    className="secondary-button cvent-sync-btn"
                    disabled={cventSyncing || dataLoading || !cventStatus?.configured}
                    onClick={handleCventSync}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={cventSyncing ? 'spin-icon' : ''}
                    >
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                    <span>{cventSyncing ? 'Se sincronizează...' : 'Sincronizează Cvent Acum'}</span>
                  </button>
                </div>
              </div>

              <button type="button" className="secondary-button" disabled={dataLoading} onClick={refreshData}>
                Reload Database Attendees
              </button>
            </div>
            ) : null}

            <div className="panel list-panel">
              <div className="list-toolbar">
                <div>
                  <p className="eyebrow">Attendees</p>
                  <h2>{isAdmin ? 'Search and export' : 'Search'}</h2>
                </div>
                <div className="export-actions">
                  <button type="button" className="secondary-button" disabled={dataLoading} onClick={refreshData}>
                    Refresh
                  </button>
                  {isAdmin ? (
                    <>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={dataLoading}
                        onClick={() => exportLatest('csv')}
                      >
                        Export CSV
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={dataLoading}
                        onClick={() => exportLatest('xlsx')}
                      >
                        Export Excel
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="admin-search-wrap">
                <input
                  className="search-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Caută după nume, bilet, interval, sesiune, foto sau status..."
                />
              </div>

              <div className="admin-filter-bar" role="group" aria-label="Filtrare listă participanți">
                <button
                  type="button"
                  className={`filter-pill ${adminFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setAdminFilter('all')}
                >
                  Toți ({totalCount})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${adminFilter === 'checked_in' ? 'active checkin' : ''}`}
                  onClick={() => setAdminFilter('checked_in')}
                >
                  Checked In ({checkedInCount})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${adminFilter === 'not_checked_in' ? 'active waiting' : ''}`}
                  onClick={() => setAdminFilter('not_checked_in')}
                >
                  Fără Check-In ({notCheckedInCount})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${adminFilter === 'goodie_bag_collected' ? 'active goodie' : ''}`}
                  onClick={() => setAdminFilter('goodie_bag_collected')}
                >
                  Goodie Bag ({goodieBagCollectedCount})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${adminFilter === 'goodie_bag_pending' ? 'active eligible' : ''}`}
                  onClick={() => setAdminFilter('goodie_bag_pending')}
                >
                  Eligibili Goodie Bag ({goodieBagRemainingCount})
                </button>
              </div>

              <div className="attendee-list" aria-live="polite">
                {filteredAttendees.length > 0 ? (
                  filteredAttendees.map((attendee) => {
                    const isAttendeeCheckedIn = Boolean(attendee.checkedIn || attendee.checkInTime)
                    const isAttendeeGoodie = Boolean(attendee.goodieBag || attendee.goodieBagTime)

                    return (
                      <article className="attendee-card" key={attendee.id}>
                        <div className="attendee-card-top">
                          <div className="attendee-title-group">
                            <div className="attendee-card-icon" aria-hidden="true">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                              </svg>
                            </div>
                            <div className="attendee-headings">
                              <strong className="attendee-name">{attendee.name}</strong>
                              {attendee.email ? <span className="attendee-email">{attendee.email}</span> : null}
                            </div>
                          </div>

                          <div className="attendee-badges">
                            <span className={isAttendeeCheckedIn ? 'status checked' : 'status'}>
                              {isAttendeeCheckedIn ? 'Checked In' : 'Not Checked In'}
                            </span>
                            <span
                              className={
                                isAttendeeGoodie
                                  ? 'status goodie-collected'
                                  : isAttendeeCheckedIn
                                    ? 'status goodie-eligible'
                                    : 'status goodie-ineligible'
                              }
                            >
                              <GiftIcon size={12} className="status-inline-icon" />
                              {isAttendeeGoodie
                                ? 'Goodie Bag: Ridicat'
                                : isAttendeeCheckedIn
                                  ? 'Goodie Bag: În așteptare'
                                  : 'Neeligibil'}
                            </span>
                          </div>
                        </div>

                        <div className="attendee-details-grid">
                          {attendee.ticketType ? (
                            <div className="detail-item">
                              <span className="detail-label">Ticket</span>
                              <span className={`detail-value tag ${ticketStatusClass(attendee.ticketType)}`}>{attendee.ticketType}</span>
                            </div>
                          ) : null}

                          {attendee.company ? (
                            <div className="detail-item">
                              <span className="detail-label">Companie</span>
                              <span className="detail-value">{attendee.company}</span>
                            </div>
                          ) : null}

                          <div className="detail-item checkin-time-item">
                            <span className="detail-label">Check-In</span>
                            <span className={`detail-value ${isAttendeeCheckedIn ? 'checked-time-val' : 'unchecked-time-val'}`}>
                              {isAttendeeCheckedIn ? formatDateTime(attendee.checkInTime) : 'Neprezentat'}
                            </span>
                          </div>

                          <div className="detail-item direct-item">
                            <span className="detail-label">Interval</span>
                            <span className="detail-value direct-value">{attendee.admissionItem || '-'}</span>
                          </div>

                          <div className="detail-item direct-item">
                            <span className="detail-label">Sessions</span>
                            <span className="detail-value direct-value">{attendee.sessions || '-'}</span>
                          </div>

                          <div className="detail-item photo-item">
                            <span className="detail-label">Prelucrare foto</span>
                            <span className="detail-value photo-value">
                              {attendee.photo ? attendee.photo.replace(/^prelucrare\s*foto\s*:\s*/i, '') : '-'}
                            </span>
                          </div>
                        </div>

                        {!isAttendeeCheckedIn || (isAttendeeCheckedIn && !isAttendeeGoodie) ? (
                          <div className="attendee-card-footer">
                            <div className="attendee-actions-row">
                              {!isAttendeeCheckedIn ? (
                                <button
                                  type="button"
                                  className="card-quick-checkin-btn"
                                  disabled={dataLoading}
                                  onClick={() => handleQuickCheckIn(attendee)}
                                >
                                  <TicketIcon size={14} />
                                  <span>Check In Manual</span>
                                </button>
                              ) : null}

                              {isAttendeeCheckedIn && !isAttendeeGoodie ? (
                                <button
                                  type="button"
                                  className="card-quick-goodie-btn"
                                  disabled={dataLoading}
                                  onClick={() => handleQuickGoodieBag(attendee)}
                                >
                                  <GiftIcon size={14} />
                                  <span>Acordă Goodie Bag</span>
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </article>
                    )
                  })
                ) : (
                  <p className="empty-state">
                    {attendees.length === 0
                      ? 'No attendees have been imported yet.'
                      : 'No attendees match this search or filter.'}
                  </p>
                )}
              </div>

              {isAdmin ? (
                <button
                  type="button"
                  className="danger-button"
                  disabled={attendees.length === 0}
                  onClick={handleClearData}
                >
                  Clear Shared Data
                </button>
              ) : null}
            </div>
          </section>
        )}
      </main>

      {/* Fullscreen Scanner Modal Popup */}
      {scannerModalOpen ? (
        <div className="scanner-modal-overlay" role="dialog" aria-modal="true" aria-label="Scanner Cod QR">
          <div className="scanner-modal-container">
            {/* Top Bar with Mode Switcher & ✕ Close Button */}
            <div className="scanner-modal-topbar">
              <div className="scanner-modal-header-badge">
                <TicketIcon size={16} />
                <span>Scanare Check-In</span>
              </div>

              <button
                type="button"
                className="scanner-modal-close-btn"
                onClick={closeScannerModal}
                aria-label="Închide scanner"
                title="Închide scanner"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Camera Viewport (Top half) */}
            <div className="scanner-modal-camera-section">
              <div className="scanner-modal-video-shell">
                <video ref={videoRef} muted playsInline aria-label="Camera preview" />
                {cameraError ? (
                  <div className="scanner-modal-cam-error">
                    <p>{cameraError}</p>
                    <button type="button" className="retry-cam-btn" onClick={() => setCameraOn(true)}>
                      Reîncearcă Camera
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="scanner-modal-reticle" aria-hidden="true">
                      <span className="reticle-corner top-left" />
                      <span className="reticle-corner top-right" />
                      <span className="reticle-corner bottom-left" />
                      <span className="reticle-corner bottom-right" />
                      <span className="scan-laser" />
                    </div>
                    <div className="scanner-modal-cam-badge">
                      <span className="live-dot" />
                      <span>Scanner Activ</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Scanned Details (Bottom half - fits on screen without scrolling!) */}
            <div className="scanner-modal-details-section">
              <ModalScanDetails
                scanResult={scanResult}
                onQuickGoodieBag={(scannedAttendee) => {
                  const fullAttendee = attendees.find(
                    (a) =>
                      (scannedAttendee.id && a.id === scannedAttendee.id) ||
                      (scannedAttendee.qrCode && normalizeCode(a.qrCode) === normalizeCode(scannedAttendee.qrCode)) ||
                      (scannedAttendee.name && a.name.toLowerCase() === scannedAttendee.name.toLowerCase()),
                  )
                  if (fullAttendee) {
                    handleQuickGoodieBag(fullAttendee)
                  } else {
                    handleQuickGoodieBag({
                      id: scannedAttendee.id || `att-${Date.now()}`,
                      name: scannedAttendee.name,
                      email: '',
                      uniqueId: '',
                      qrCode: scannedAttendee.qrCode || '',
                      company: '',
                      ticketType: scannedAttendee.ticketType || '',
                      admissionItem: scannedAttendee.admissionItem || '',
                      sessions: scannedAttendee.sessions || '',
                      photo: scannedAttendee.photo || '',
                      checkedIn: true,
                      checkInTime: scannedAttendee.checkInTime || new Date().toISOString(),
                      goodieBag: false,
                      goodieBagTime: null,
                      importedAt: new Date().toISOString(),
                      sourceRow: 0,
                      original: {},
                    })
                  }
                }}
                onResume={resumeScanning}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
