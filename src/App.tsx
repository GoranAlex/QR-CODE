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
  loadEventName,
  saveEventName,
  signIn,
  signOut,
  verifyScan,
} from './storage'
import type { AttendanceSummary, Attendee, AuthUser, MinimalScannedAttendee, ScanResult } from './types'

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

function formatDateTime(value: string | null) {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '-'
  }

  return dateFormatter.format(date)
}

function App() {
  const [view, setView] = useState<AppView>('scanner')
  const [attendees, setAttendees] = useState<Attendee[]>([])
  const [eventName, setEventName] = useState('Event Check-In')
  const [scanResult, setScanResult] = useState<ScanResult>(initialScanResult)
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
  })
  const [checkInToast, setCheckInToast] = useState<MinimalScannedAttendee | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const lastScanRef = useRef({ code: '', scannedAt: 0 })
  const dataRequestIdRef = useRef(0)
  const toastTimeoutRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importSuccess, setImportSuccess] = useState('')
  const [importError, setImportError] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])

  const isAdmin = user?.role === 'admin'
  const checkedInCount = summary.checkedIn
  const notCheckedInCount = summary.notCheckedIn

  const filteredAttendees = useMemo(() => {
    const term = search.trim().toLowerCase()

    if (!term) {
      return attendees
    }

    return attendees.filter((attendee) =>
      [
        attendee.name,
        attendee.email,
        attendee.uniqueId,
        attendee.qrCode,
        attendee.company,
        attendee.ticketType,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [attendees, search])

  useEffect(
    () => () => {
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current)
      }
    },
    [],
  )

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
      const [nextEventName, nextSummary, nextAttendees] = await Promise.all([
        loadEventName(),
        loadAttendanceSummary(),
        user.role === 'admin' ? loadAttendees() : Promise.resolve([]),
      ])

      if (dataRequestIdRef.current !== requestId || user.id !== activeUserId) {
        return
      }

      if (user.role !== 'admin') {
        setView('scanner')
      }

      setEventName(nextEventName)
      setSummary(nextSummary)
      setAttendees(nextAttendees)
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

  const handleQrScan = useCallback(
    async (rawCode: string) => {
      const scannedCode = rawCode.trim()
      const normalizedScannedCode = normalizeCode(scannedCode)

      if (!normalizedScannedCode || !user) {
        return
      }

      const now = Date.now()

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

      try {
        const response = await verifyScan(scannedCode)

        if (response.status === 'not_found') {
          setScanResult({
            type: 'not-found',
            scannedCode,
            message: 'Attendee not found. Check the badge or scan again.',
          })
          return
        }

        if (response.status === 'rate_limited') {
          setScanResult({
            type: 'rate-limited',
            scannedCode,
            message: `Too many scan attempts. Try again in ${response.retryAfterSeconds} seconds.`,
          })
          return
        }

        if (response.status === 'duplicate') {
          setScanResult({
            type: 'duplicate',
            attendee: response.attendee,
            message: `${response.attendee.name} was already checked in at ${formatDateTime(
              response.attendee.checkInTime,
            )}.`,
          })
          return
        }

        setScanResult({
          type: 'success',
          attendee: response.attendee,
          message: `${response.attendee.name} is checked in.`,
        })
        setCheckInToast(response.attendee)
        const scanRequestId = dataRequestIdRef.current
        loadAttendanceSummary()
          .then((nextSummary) => {
            if (dataRequestIdRef.current === scanRequestId) {
              setSummary(nextSummary)
            }
          })
          .catch(() => undefined)

        if (toastTimeoutRef.current) {
          window.clearTimeout(toastTimeoutRef.current)
        }

        toastTimeoutRef.current = window.setTimeout(() => {
          setCheckInToast(null)
          toastTimeoutRef.current = null
        }, 2600)
      } catch (error) {
        setScanResult({
          type: 'not-found',
          scannedCode,
          message: error instanceof Error ? error.message : 'Could not save this check-in.',
        })
      }
    },
    [user],
  )

  useEffect(() => {
    if (!cameraOn) {
      return undefined
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is not available in this browser.')
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
        setCameraError(
          error instanceof Error
            ? error.message
            : 'Unable to start camera. Use HTTPS or localhost and allow camera permissions.',
        )
        setCameraOn(false)
      }
    }

    startCamera()

    return () => {
      cancelled = true
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [cameraOn, handleQrScan])

  function handleManualSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    handleQrScan(manualCode)
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
        <form className="auth-card" onSubmit={handleSignIn} aria-busy={authSubmitting}>
          <div>
            <img
              className="brand-logo auth-logo"
              src={logoSrc}
              alt="NCT"
              onError={(event) => {
                event.currentTarget.style.display = 'none'
              }}
            />
            <p className="eyebrow">Staff Login</p>
            <h1>Sign in to check in attendees</h1>
            <p>Use your staff account for this event.</p>
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
      {checkInToast ? (
        <div className="checkin-toast" role="status" aria-live="polite">
          <span>Checked in</span>
          <strong>{checkInToast.name}</strong>
        </div>
      ) : null}

      <header className="app-header">
        <div className="brand-block">
          <img
            className="brand-logo"
            src={logoSrc}
            alt="NCT"
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
          />
          <div>
            {isAdmin ? (
              <input
                id="event-name"
                className="event-name-input"
                value={eventName}
                onChange={(event) => setEventName(event.target.value)}
                onBlur={handleEventNameBlur}
                aria-label="Event name"
              />
            ) : (
              <span className="event-name-input" role="heading" aria-level={1}>
                {eventName}
              </span>
            )}
            {eventNameStatus ? <span className="save-status">{eventNameStatus}</span> : null}
          </div>
        </div>

        <div className="header-actions">
          <nav className={isAdmin ? 'top-tabs' : 'top-tabs single'} aria-label="Main navigation">
            <button
              type="button"
              className={view === 'scanner' ? 'active' : ''}
              aria-current={view === 'scanner' ? 'page' : undefined}
              onClick={() => setView('scanner')}
            >
              Check-In
            </button>
            {isAdmin ? (
              <button
                type="button"
                className={view === 'admin' ? 'active' : ''}
                aria-current={view === 'admin' ? 'page' : undefined}
                onClick={() => setView('admin')}
              >
                Admin
              </button>
            ) : null}
          </nav>
          <div className="staff-chip">
            <span>{user.email}</span>
            <button type="button" onClick={handleSignOut}>
              Log out
            </button>
          </div>
        </div>
      </header>

      <main aria-busy={dataLoading}>
        {dataError ? <p className="alert error">{dataError}</p> : null}
        {dataLoading ? <p className="alert info">Loading shared attendee data...</p> : null}

        <section className="stats-grid" aria-label="Attendance summary">
          <div className="stat-card">
            <span>Total</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="stat-card checked">
            <span>Checked In</span>
            <strong>{checkedInCount}</strong>
          </div>
          <div className="stat-card waiting">
            <span>Not Checked In</span>
            <strong>{notCheckedInCount}</strong>
          </div>
        </section>

        {view === 'scanner' ? (
          <section className="scanner-layout">
            <div className="panel scanner-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Badge Scanner</p>
                  <h2>Scan attendee QR codes</h2>
                </div>
                <span className={cameraOn ? 'pill live' : 'pill'}>{cameraOn ? 'Live' : 'Off'}</span>
              </div>

              <div className="video-shell">
                <video ref={videoRef} muted playsInline aria-label="Camera preview" />
                {!cameraOn ? (
                  <div className="video-placeholder">
                    <strong>Camera preview</strong>
                    <span>Use a phone browser and allow camera access.</span>
                  </div>
                ) : null}
                <div className="scan-frame" aria-hidden="true" />
              </div>

              {cameraError ? <p className="alert error">{cameraError}</p> : null}

              <div className="button-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={summary.total === 0 || cameraOn || dataLoading}
                  onClick={() => setCameraOn(true)}
                >
                  Start Camera
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!cameraOn}
                  onClick={stopCamera}
                >
                  Stop
                </button>
                <button type="button" className="secondary-button" disabled={dataLoading} onClick={refreshData}>
                  Refresh
                </button>
              </div>

              <p className="helper-text">
                Mobile browsers require HTTPS or localhost for camera access. The scanner prefers the
                rear camera when the device supports it.
              </p>
            </div>

            <div className={`scan-result ${scanResult.type}`} role="status" aria-live="polite" aria-atomic="true">
              <p className="eyebrow">Latest Scan</p>
              <h2>{scanResult.message}</h2>
              {scanResult.type === 'success' || scanResult.type === 'duplicate' ? (
                <div className="attendee-focus">
                  <strong>{scanResult.attendee.name}</strong>
                  <span>Checked in: {formatDateTime(scanResult.attendee.checkInTime)}</span>
                </div>
              ) : null}
              {scanResult.type === 'not-found' || scanResult.type === 'rate-limited' ? (
                <code className="scanned-code">{scanResult.scannedCode}</code>
              ) : null}
            </div>

            <form className="manual-form" onSubmit={handleManualSubmit}>
              <label htmlFor="manual-code">Manual QR code entry</label>
              <div>
                <input
                  id="manual-code"
                  value={manualCode}
                  onChange={(event) => setManualCode(event.target.value)}
                  placeholder="Paste or type a QR code value"
                />
                <button type="submit" disabled={!manualCode.trim() || summary.total === 0 || dataLoading}>
                  Check In
                </button>
              </div>
            </form>
          </section>
        ) : (
          <section className="admin-layout">
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

              <button type="button" className="secondary-button" disabled={dataLoading} onClick={refreshData}>
                Reload Database Attendees
              </button>
            </div>

            <div className="panel list-panel">
              <div className="list-toolbar">
                <div>
                  <p className="eyebrow">Attendees</p>
                  <h2>Search and export</h2>
                </div>
                <div className="export-actions">
                  <button type="button" className="secondary-button" disabled={dataLoading} onClick={refreshData}>
                    Refresh
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={attendees.length === 0}
                    onClick={() => exportAttendeesAsCsv(attendees)}
                  >
                    Export CSV
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={attendees.length === 0}
                    onClick={() => exportAttendeesAsXlsx(attendees)}
                  >
                    Export Excel
                  </button>
                </div>
              </div>

              <input
                className="search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, email, ID, QR code, company, or ticket"
              />

              <div className="attendee-list" aria-live="polite">
                {filteredAttendees.length > 0 ? (
                  filteredAttendees.map((attendee) => (
                    <article className="attendee-card" key={attendee.id}>
                      <div>
                        <strong>{attendee.name}</strong>
                        <span>{attendee.email || attendee.uniqueId || 'No email or ID'}</span>
                        <span>{attendee.company}</span>
                      </div>
                      <div>
                        <span className={attendee.checkedIn ? 'status checked' : 'status'}>
                          {attendee.checkedIn ? 'Checked In' : 'Not Checked In'}
                        </span>
                        <small>{formatDateTime(attendee.checkInTime)}</small>
                        <code>{attendee.qrCode}</code>
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="empty-state">
                    {attendees.length === 0
                      ? 'No attendees have been imported yet.'
                      : 'No attendees match this search.'}
                  </p>
                )}
              </div>

              <button
                type="button"
                className="danger-button"
                disabled={attendees.length === 0}
                onClick={handleClearData}
              >
                Clear Shared Data
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
