import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import type { User } from '@supabase/supabase-js'
import './App.css'
import {
  buildCodeCandidates,
  exportAttendeesAsCsv,
  exportAttendeesAsXlsx,
  normalizeCode,
  parseAttendeeWorkbook,
} from './excel'
import {
  checkInAttendee,
  clearAttendees,
  loadAttendees,
  loadEventName,
  replaceAttendees,
  saveEventName,
} from './storage'
import { isSupabaseConfigured, supabase } from './supabase'
import type { Attendee, ScanResult } from './types'

type AppView = 'scanner' | 'admin'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const initialScanResult: ScanResult = {
  type: 'idle',
  message: 'Sign in, upload your attendee Excel file, then start scanning badges.',
}

function formatDateTime(value: string | null) {
  if (!value) {
    return '-'
  }

  return dateFormatter.format(new Date(value))
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
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importMessage, setImportMessage] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [eventNameStatus, setEventNameStatus] = useState('')
  const attendeesRef = useRef(attendees)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const lastScanRef = useRef({ code: '', scannedAt: 0 })

  const checkedInCount = attendees.filter((attendee) => attendee.checkedIn).length
  const notCheckedInCount = attendees.length - checkedInCount

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

  useEffect(() => {
    attendeesRef.current = attendees
  }, [attendees])

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

    setDataLoading(true)
    setDataError('')

    try {
      const [nextEventName, nextAttendees] = await Promise.all([loadEventName(), loadAttendees()])
      setEventName(nextEventName)
      setAttendees(nextAttendees)
      setScanResult((currentResult) =>
        currentResult.type === 'idle'
          ? {
              type: 'idle',
              message:
                nextAttendees.length > 0
                  ? 'Attendee list loaded. Start camera scanning when ready.'
                  : 'Upload your attendee Excel file before scanning.',
            }
          : currentResult,
      )
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not load Supabase data.')
    } finally {
      setDataLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAuthLoading(false)
      return undefined
    }

    let mounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) {
        return
      }

      setUser(data.session?.user ?? null)
      setAuthLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setAuthLoading(false)
      setAuthError('')
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (user) {
      refreshData()
    } else {
      stopCamera()
      setAttendees([])
      setScanResult(initialScanResult)
    }
  }, [refreshData, stopCamera, user])

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')

    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    })

    if (error) {
      setAuthError(error.message)
      return
    }

    setAuthPassword('')
  }

  async function handleSignOut() {
    stopCamera()
    await supabase.auth.signOut()
  }

  async function handleEventNameBlur() {
    if (!user) {
      return
    }

    setEventNameStatus('Saving...')

    try {
      await saveEventName(eventName.trim() || 'Event Check-In', user.id)
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

      const currentAttendees = attendeesRef.current
      const scannedCandidates = new Set(buildCodeCandidates(scannedCode))
      const match = currentAttendees.find((attendee) =>
        buildCodeCandidates(attendee.qrCode).some((candidate) => scannedCandidates.has(candidate)),
      )

      if (!match) {
        setScanResult({
          type: 'not-found',
          scannedCode,
          message: 'Attendee not found. Check the badge or scan again.',
        })
        return
      }

      if (match.checkedIn) {
        setScanResult({
          type: 'duplicate',
          attendee: match,
          message: `${match.name} was already checked in at ${formatDateTime(match.checkInTime)}.`,
        })
        return
      }

      try {
        const checkedInAttendee = await checkInAttendee(match.id, user.id)

        if (!checkedInAttendee) {
          const latestAttendees = await loadAttendees()
          const latestMatch = latestAttendees.find((attendee) => attendee.id === match.id) ?? match

          setAttendees(latestAttendees)
          setScanResult({
            type: 'duplicate',
            attendee: latestMatch,
            message: `${latestMatch.name} was already checked in at ${formatDateTime(
              latestMatch.checkInTime,
            )}.`,
          })
          return
        }

        const nextAttendees = currentAttendees.map((attendee) =>
          attendee.id === match.id ? checkedInAttendee : attendee,
        )

        attendeesRef.current = nextAttendees
        setAttendees(nextAttendees)
        setScanResult({
          type: 'success',
          attendee: checkedInAttendee,
          message: `${checkedInAttendee.name} is checked in.`,
        })
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

  async function handleFileUpload(file: File | undefined) {
    if (!file) {
      return
    }

    setIsImporting(true)
    setImportMessage('')
    setImportWarnings([])

    try {
      const summary = await parseAttendeeWorkbook(file)
      await replaceAttendees(summary.attendees)
      setAttendees(summary.attendees)
      setImportWarnings(summary.warnings)
      setImportMessage(`Imported ${summary.attendees.length} attendees from ${summary.fileName}.`)
      setScanResult({
        type: 'idle',
        message:
          summary.attendees.length > 0
            ? 'Attendee list loaded. Start camera scanning when ready.'
            : 'No attendees were imported. Check the Excel headers and QR code column.',
      })
    } catch (error) {
      setImportMessage(
        error instanceof Error ? error.message : 'The Excel file could not be imported.',
      )
    } finally {
      setIsImporting(false)
    }
  }

  function handleManualSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    handleQrScan(manualCode)
    setManualCode('')
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
      setImportWarnings([])
      setImportMessage('')
      setScanResult(initialScanResult)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not clear attendees.')
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Setup Required</p>
          <h1>Connect Supabase</h1>
          <p>
            Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to your local `.env` file and to
            Vercel environment variables.
          </p>
        </section>
      </div>
    )
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
        <form className="auth-card" onSubmit={handleSignIn}>
          <div>
            <p className="eyebrow">Staff Login</p>
            <h1>Sign in to check in attendees</h1>
            <p>Use a staff account created in Supabase Auth.</p>
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

          <button type="submit" className="primary-button">
            Sign In
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <label className="eyebrow" htmlFor="event-name">
            Event
          </label>
          <input
            id="event-name"
            className="event-name-input"
            value={eventName}
            onChange={(event) => setEventName(event.target.value)}
            onBlur={handleEventNameBlur}
            aria-label="Event name"
          />
          {eventNameStatus ? <span className="save-status">{eventNameStatus}</span> : null}
        </div>

        <div className="header-actions">
          <nav className="top-tabs" aria-label="Main navigation">
            <button
              type="button"
              className={view === 'scanner' ? 'active' : ''}
              onClick={() => setView('scanner')}
            >
              Check-In
            </button>
            <button
              type="button"
              className={view === 'admin' ? 'active' : ''}
              onClick={() => setView('admin')}
            >
              Admin
            </button>
          </nav>
          <div className="staff-chip">
            <span>{user.email}</span>
            <button type="button" onClick={handleSignOut}>
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main>
        {dataError ? <p className="alert error">{dataError}</p> : null}
        {dataLoading ? <p className="alert success">Loading shared attendee data...</p> : null}

        <section className="stats-grid" aria-label="Attendance summary">
          <div className="stat-card">
            <span>Total</span>
            <strong>{attendees.length}</strong>
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
                  <h1>Scan attendee QR codes</h1>
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
                  disabled={attendees.length === 0 || cameraOn}
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
                <button type="button" className="secondary-button" onClick={refreshData}>
                  Refresh
                </button>
              </div>

              <p className="helper-text">
                Mobile browsers require HTTPS or localhost for camera access. The scanner prefers the
                rear camera when the device supports it.
              </p>
            </div>

            <div className={`scan-result ${scanResult.type}`}>
              <p className="eyebrow">Latest Scan</p>
              <h2>{scanResult.message}</h2>
              {scanResult.type === 'success' || scanResult.type === 'duplicate' ? (
                <div className="attendee-focus">
                  <strong>{scanResult.attendee.name}</strong>
                  <span>{scanResult.attendee.email || scanResult.attendee.uniqueId || 'No email or ID'}</span>
                  <span>{scanResult.attendee.company}</span>
                  <span>Checked in: {formatDateTime(scanResult.attendee.checkInTime)}</span>
                </div>
              ) : null}
              {scanResult.type === 'not-found' ? (
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
                <button type="submit" disabled={!manualCode.trim() || attendees.length === 0}>
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
                <h1>Upload attendee Excel</h1>
                <p>
                  Import a Cvent export with attendee name, email or ID, and a QR code value column.
                  Uploading replaces the current shared attendee list.
                </p>
              </div>

              <label className="file-upload">
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(event) => {
                    handleFileUpload(event.target.files?.[0])
                    event.currentTarget.value = ''
                  }}
                />
                <span>{isImporting ? 'Importing...' : 'Choose Excel or CSV file'}</span>
              </label>

              {importMessage ? <p className="alert success">{importMessage}</p> : null}
              {importWarnings.length > 0 ? (
                <div className="alert warning">
                  <strong>Import warnings</strong>
                  <ul>
                    {importWarnings.slice(0, 6).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  {importWarnings.length > 6 ? (
                    <span>{importWarnings.length - 6} more warnings hidden.</span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="panel list-panel">
              <div className="list-toolbar">
                <div>
                  <p className="eyebrow">Attendees</p>
                  <h2>Search and export</h2>
                </div>
                <div className="export-actions">
                  <button type="button" className="secondary-button" onClick={refreshData}>
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
                  <p className="empty-state">No attendees match this search.</p>
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
