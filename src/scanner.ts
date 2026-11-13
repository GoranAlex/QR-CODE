import { BrowserQRCodeReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats: string[] }): {
        detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string; format?: string }>>
      }
      getSupportedFormats(): Promise<string[]>
    }
  }
}

export type FastScannerControls = {
  stop: () => void
  toggleTorch: () => Promise<boolean>
  hasTorch: boolean
  isTorchOn: () => boolean
}

/**
 * Audio beep feedback using Web Audio API (works offline, zero external assets).
 */
export function playScanChirp() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    // Crisp pleasant two-tone chirp: 900Hz -> 1400Hz in 65ms
    osc.frequency.setValueAtTime(900, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1400, ctx.currentTime + 0.065)

    gain.gain.setValueAtTime(0.18, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.065)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.075)
  } catch {
    // Ignore audio policy restrictions
  }
}

/**
 * Mobile vibration haptic feedback.
 */
export function triggerScanHaptic() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(45)
    }
  } catch {
    // Ignore
  }
}

/**
 * Starts high-performance QR code scanner:
 * 1. Tries native hardware-accelerated BarcodeDetector (Chrome, Edge, Android) at 60 FPS.
 * 2. Falls back to ZXing with TRY_HARDER and 35ms scan intervals (was 500ms!).
 * 3. Enforces 1080p stream resolution and continuous autofocus.
 * 4. Enables torch (flashlight) controls when supported by hardware.
 */
export async function startFastQrScanner(
  videoElement: HTMLVideoElement,
  onScan: (code: string) => void,
  onError?: (err: unknown) => void,
): Promise<FastScannerControls> {
  // Best constraints: Full HD ideal, minimum 720p, continuous autofocus, 60fps ideal
  const primaryConstraints: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      frameRate: { ideal: 60, min: 30 },
    },
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(primaryConstraints)
  } catch {
    // Fallback for older phones or webcams that don't support 1080p
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })
    } catch (fallbackError) {
      if (onError) onError(fallbackError)
      throw fallbackError
    }
  }

  videoElement.srcObject = stream
  videoElement.setAttribute('playsinline', 'true')
  videoElement.muted = true
  await videoElement.play().catch(() => {})

  const track = stream.getVideoTracks()[0]
  const capabilities = track?.getCapabilities?.() as
    | (MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] })
    | undefined

  const hasTorch = Boolean(capabilities?.torch)
  let torchOn = false

  // Apply continuous autofocus if hardware supports it
  if (capabilities?.focusMode && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
      })
    } catch {
      // Non-critical, continue
    }
  }

  let stopped = false

  // Check for native BarcodeDetector API (Google Chrome, Edge, Android native ML Kit)
  let useNative = false
  let nativeDetector: { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } | null = null

  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector!.getSupportedFormats()
      if (supported && supported.includes('qr_code')) {
        nativeDetector = new window.BarcodeDetector!({ formats: ['qr_code'] })
        useNative = true
      }
    } catch {
      useNative = false
    }
  }

  // --- ENGINE 1: NATIVE HARDWARE ACCELERATED (60 FPS) ---
  if (useNative && nativeDetector) {
    let isDetecting = false
    let animId: number | null = null

    const detectLoop = async () => {
      if (stopped) return

      if (videoElement.readyState >= 2 && !isDetecting) {
        isDetecting = true
        try {
          const barcodes = await nativeDetector!.detect(videoElement)
          if (barcodes && barcodes.length > 0 && !stopped) {
            for (const b of barcodes) {
              if (b.rawValue) {
                onScan(b.rawValue)
                break
              }
            }
          }
        } catch {
          // Frame error, proceed to next frame
        } finally {
          isDetecting = false
        }
      }

      if (!stopped) {
        animId = requestAnimationFrame(detectLoop)
      }
    }

    animId = requestAnimationFrame(detectLoop)

    const stop = () => {
      stopped = true
      if (animId !== null) {
        cancelAnimationFrame(animId)
      }
      stream.getTracks().forEach((t) => t.stop())
      videoElement.srcObject = null
    }

    const toggleTorch = async () => {
      if (!hasTorch || !track) return false
      try {
        torchOn = !torchOn
        await track.applyConstraints({
          advanced: [{ torch: torchOn } as MediaTrackConstraintSet],
        })
        return torchOn
      } catch {
        torchOn = false
        return false
      }
    }

    return {
      stop,
      toggleTorch,
      hasTorch,
      isTorchOn: () => torchOn,
    }
  }

  // --- ENGINE 2: OPTIMIZED ZXING FALLBACK (Fast 35ms polling + TRY_HARDER) ---
  const hints = new Map<DecodeHintType, unknown>()
  hints.set(DecodeHintType.TRY_HARDER, true)
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE])

  const codeReader = new BrowserQRCodeReader(hints, {
    delayBetweenScanAttempts: 35, // ~28 FPS scanning instead of default 500ms!
    delayBetweenScanSuccess: 500,
    tryPlayVideoTimeout: 5000,
  })

  let zxingControls: { stop: () => void } | null = null

  try {
    zxingControls = await codeReader.decodeFromStream(
      stream,
      videoElement,
      (result) => {
        if (result && !stopped) {
          onScan(result.getText())
        }
      },
    )
  } catch (err) {
    if (onError) onError(err)
  }

  const stop = () => {
    stopped = true
    zxingControls?.stop()
    stream.getTracks().forEach((t) => t.stop())
    videoElement.srcObject = null
  }

  const toggleTorch = async () => {
    if (!hasTorch || !track) return false
    try {
      torchOn = !torchOn
      await track.applyConstraints({
        advanced: [{ torch: torchOn } as MediaTrackConstraintSet],
      })
      return torchOn
    } catch {
      torchOn = false
      return false
    }
  }

  return {
    stop,
    toggleTorch,
    hasTorch,
    isTorchOn: () => torchOn,
  }
}
