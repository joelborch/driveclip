import { SHARE_BASE, TIMESLICE_MS } from '../lib/config.js'
import { createResumableSession, ChunkedUploader } from '../lib/drive.js'

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]

function computeVideoBitrate (videoTrack) {
  const settings = videoTrack && typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : null
  const width = (settings && settings.width) || 1920
  const height = (settings && settings.height) || 1080
  const pixels = width * height

  // 1080p (~2.07M px) -> 10 Mbps; 1440p (~3.68M px) -> ~17.8 Mbps; 4K (~8.29M px) -> 24-25 Mbps
  const targetBps = Math.round((pixels / (1920 * 1080)) * 10_000_000)
  return Math.max(8_000_000, Math.min(25_000_000, targetBps))
}

/**
 * The single in-flight recording. Null whenever we are idle, so a stray
 * `offscreen-stop` (or a second `offscreen-start`) can be rejected cleanly.
 */
let session = null

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return

  if (message.type === 'offscreen-start') {
    // Snapshot the live session (if any) so a rejected duplicate start can never
    // tear down the recording that is already running.
    const incumbent = session
    start(message.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[DriveClip] start failed', err)
        if (session && session !== incumbent) teardown(session)
        sendResponse({ ok: false, error: readableError(err) })
      })
    return true
  }

  if (message.type === 'offscreen-stop') {
    // Answer right away: finalizing the upload can take many seconds and the
    // background only needs to know the stop was accepted. Completion arrives
    // later as `recording-complete`.
    stop()
    sendResponse({ ok: true })
    return false
  }
})

async function start (payload) {
  if (session) throw new Error('A recording is already in progress')

  const { mode, mic, streamId, captureSize, token, folderId, fileName } = payload
  if (mode !== 'tab' && mode !== 'desktop') throw new Error(`Unknown capture mode: ${mode}`)
  if (!streamId) throw new Error('Missing capture stream id')
  if (!token) throw new Error('Missing Google access token')
  if (!folderId) throw new Error('Missing Drive folder id')

  session = {
    mode,
    captureStream: null,
    micStream: null,
    audioContext: null,
    recorder: null,
    recordedStream: null,
    uploader: null,
    startedAt: 0,
    pump: Promise.resolve(),
    stopping: false,
    finished: false,
    // The uploader only asks for a token when a PUT comes back 401; the first
    // ask is satisfied with the token the background already minted for us.
    initialToken: token
  }
  const s = session

  s.captureStream = await capture(mode, streamId, captureSize)
  if (s !== session) throw new Error('Recording was cancelled')

  if (mic) {
    try {
      s.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        }
      })
    } catch (err) {
      // A missing or denied microphone must not kill the recording.
      console.warn('[DriveClip] microphone unavailable, recording without it', err)
    }
  }

  s.recordedStream = await buildRecordedStream(s)
  if (s !== session) throw new Error('Recording was cancelled')

  const sessionUrl = await createResumableSession(token, {
    name: fileName,
    mimeType: 'video/webm',
    folderId
  })
  if (s !== session) throw new Error('Recording was cancelled')

  s.uploader = new ChunkedUploader({ sessionUrl, getFreshToken: () => freshToken(s) })
  s.uploader.onprogress = (uploadedBytes) => {
    notify('upload-progress', { uploadedBytes, elapsedMs: s.startedAt ? Date.now() - s.startedAt : 0 })
  }

  const videoTrack = s.recordedStream.getVideoTracks()[0]
  const videoBitsPerSecond = computeVideoBitrate(videoTrack)

  const recorder = new MediaRecorder(s.recordedStream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond,
    audioBitsPerSecond: 192_000
  })
  s.recorder = recorder

  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return
    s.uploader.append(event.data)
    // Serialize drains: ChunkedUploader keeps one PUT in flight, and chaining
    // here keeps timeslice callbacks from racing each other or the finalize.
    s.pump = s.pump.then(() => s.uploader.drain()).catch((err) => fail(s, err))
  }
  recorder.onerror = (event) => fail(s, event.error || new Error('MediaRecorder error'))
  recorder.onstop = () => {
    if (s.onStopped) s.onStopped()
  }

  // Chrome's own "Stop sharing" UI ends the track without telling us otherwise.
  for (const track of s.captureStream.getTracks()) {
    track.addEventListener('ended', () => {
      if (track.kind === 'video') stop()
    })
  }

  recorder.start(TIMESLICE_MS)
  s.startedAt = Date.now()
  notify('recording-started', {})
}

async function capture (mode, streamId, captureSize) {
  const hasFloor = Boolean(captureSize && captureSize.minWidth && captureSize.minHeight)
  const videoConstraints = (withFloor) => {
    const mandatory = {
      chromeMediaSource: mode,
      chromeMediaSourceId: streamId,
      maxWidth: 3840,
      maxHeight: 2160,
      maxFrameRate: 60
    }
    // max* only caps: tab capture stays at CSS-pixel size without a min floor
    // asking for the display's device pixels.
    if (withFloor && hasFloor) {
      mandatory.minWidth = Math.min(captureSize.minWidth, mandatory.maxWidth)
      mandatory.minHeight = Math.min(captureSize.minHeight, mandatory.maxHeight)
    }
    return { mandatory }
  }

  if (mode === 'tab') {
    const audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: videoConstraints(true) })
    } catch (err) {
      // A mandatory min the source can't satisfy rejects the whole request;
      // a CSS-pixel recording beats no recording.
      if (!hasFloor) throw err
      console.warn('[DriveClip] native-resolution tab capture rejected, retrying without the floor', err)
      return navigator.mediaDevices.getUserMedia({ audio, video: videoConstraints(false) })
    }
  }
  // Desktop sources arrive as a chooseDesktopMedia stream id picked in the
  // service worker; getDisplayMedia is unavailable to an offscreen document.
  // No min floor here: the picked source may be a small window, and desktop
  // capture already delivers device pixels for screens.
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
      video: videoConstraints(false)
    })
  } catch (err) {
    // System audio is only offered for some sources (and not on every platform);
    // asking for it against a source that has none rejects the whole request.
    console.warn('[DriveClip] desktop capture without system audio', err)
    return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints(false) })
  }
}

/**
 * Mixes capture audio and mic audio into one track via an AudioContext.
 * Returns a stream of [video track?, mixed audio track?] — either side may be
 * absent (a desktop share without audio, or a mic-less video-only capture).
 */
async function buildRecordedStream (s) {
  const tracks = []

  const videoTrack = s.captureStream.getVideoTracks()[0]
  if (videoTrack) {
    if ('contentHint' in videoTrack) {
      videoTrack.contentHint = 'detail'
    }
    tracks.push(videoTrack)
  }

  const captureAudio = s.captureStream.getAudioTracks()
  const micAudio = s.micStream ? s.micStream.getAudioTracks() : []

  if (captureAudio.length > 0 || micAudio.length > 0) {
    const audioContext = new AudioContext()
    s.audioContext = audioContext
    // With no user activation the context can come up suspended, and a suspended
    // context's destination node records pure silence.
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume()
      } catch (err) {
        console.error('[DriveClip] AudioContext resume failed', err)
      }
    }
    if (audioContext.state !== 'running') {
      throw new Error('Audio could not be started (audio context is suspended)')
    }
    const mixed = audioContext.createMediaStreamDestination()

    if (captureAudio.length > 0) {
      const source = audioContext.createMediaStreamSource(new MediaStream(captureAudio))
      source.connect(mixed)
      // chrome.tabCapture silently mutes the captured tab, so we have to play
      // its audio back through the speakers or the user hears nothing while
      // recording. Desktop capture does NOT mute the source, so re-routing
      // there would double every sound (and feed back into the capture).
      if (s.mode === 'tab') source.connect(audioContext.destination)
    }

    if (micAudio.length > 0) {
      const source = audioContext.createMediaStreamSource(new MediaStream(micAudio))
      source.connect(mixed)
    }

    tracks.push(mixed.stream.getAudioTracks()[0])
  }

  if (tracks.length === 0) throw new Error('Capture produced no audio or video tracks')
  return new MediaStream(tracks)
}

function pickMimeType () {
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return MIME_CANDIDATES[MIME_CANDIDATES.length - 1]
}

function stop () {
  const s = session
  if (!s || s.stopping) return
  s.stopping = true
  finish(s).catch((err) => fail(s, err))
}

async function finish (s) {
  if (s.recorder && s.recorder.state !== 'inactive') {
    // The final `dataavailable` always fires before `stop`, so awaiting the
    // stop event is enough to have every byte queued in the uploader.
    await new Promise((resolve) => {
      s.onStopped = resolve
      s.recorder.stop()
    })
  }

  stopTracks(s)
  await closeAudio(s)

  await s.pump
  if (s.finished) return

  const uploaded = await s.uploader.drain().then(() => s.uploader.finalize())
  const fileId = uploaded && uploaded.fileId
  if (!fileId) throw new Error('Drive did not return a file id')

  s.finished = true
  if (session === s) session = null

  notify('recording-complete', {
    fileId,
    shareLink: SHARE_BASE + fileId,
    driveLink: `https://drive.google.com/file/d/${fileId}/view`
  })
}

function fail (s, err) {
  if (s.finished) return
  s.finished = true
  console.error('[DriveClip] recording failed', err)
  teardown(s)
  notify('recording-error', { message: readableError(err) })
}

function teardown (s = session) {
  if (!s) return
  try {
    if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop()
  } catch (err) {
    console.error('[DriveClip] recorder stop during cleanup', err)
  }
  stopTracks(s)
  closeAudio(s)
  if (session === s) session = null
}

function stopTracks (s) {
  for (const stream of [s.captureStream, s.micStream, s.recordedStream]) {
    if (!stream) continue
    for (const track of stream.getTracks()) track.stop()
  }
}

async function closeAudio (s) {
  if (!s.audioContext) return
  const ctx = s.audioContext
  s.audioContext = null
  try {
    await ctx.close()
  } catch (err) {
    console.error('[DriveClip] AudioContext close failed', err)
  }
}

async function freshToken (s) {
  if (s.initialToken) {
    const token = s.initialToken
    s.initialToken = null
    return token
  }
  const response = await chrome.runtime.sendMessage({ type: 'need-token', target: 'background' })
  if (!response || !response.token) throw new Error('Could not refresh the Google access token')
  return response.token
}

function notify (type, payload) {
  chrome.runtime.sendMessage({ type, target: 'background', payload }).catch((err) => {
    // The service worker may be asleep or the popup closed; nothing to do.
    console.warn(`[DriveClip] message ${type} not delivered`, err)
  })
}

function readableError (err) {
  if (!err) return 'Unknown error'
  if (err.name === 'NotAllowedError') return 'Screen capture permission was denied'
  if (err.name === 'NotFoundError') return 'No capture source was available'
  return err.message || String(err)
}
