import { ensureRecordingsFolder } from '../lib/drive.js'

const OFFSCREEN_URL = 'offscreen/offscreen.html'
const SCOPES = ['https://www.googleapis.com/auth/drive.file']

/** Canonical in-memory state; mirrored to chrome.storage.session under `state`. */
let state = freshState()

/**
 * Last token handed out, so `need-token` knows which one to evict from the cache.
 * Mirrored to storage.session because the worker can be recycled mid-recording
 * and an eviction with no token is a silent no-op that re-hands the dead token.
 */
const TOKEN_KEY = 'currentToken'

async function rememberToken (token) {
  await chrome.storage.session.set({ [TOKEN_KEY]: token })
}

async function lastToken () {
  const stored = await chrome.storage.session.get(TOKEN_KEY)
  return stored[TOKEN_KEY] || null
}

/** Serializes offscreen document creation so two starts can't race into a duplicate. */
let creatingOffscreen = null

function freshState () {
  return {
    status: 'idle',
    startedAt: null,
    uploadedBytes: 0,
    fileId: null,
    shareLink: null,
    driveLink: null,
    error: null,
    onboarded: false
  }
}

async function setState (patch) {
  state = { ...state, ...patch }
  await chrome.storage.session.set({ state })
  await syncBadge()
  return state
}

async function syncBadge () {
  if (state.status === 'recording' || state.status === 'uploading') {
    await chrome.action.setBadgeBackgroundColor({ color: '#e5322d' })
    await chrome.action.setBadgeText({ text: 'REC' })
  } else {
    await chrome.action.setBadgeText({ text: '' })
  }
}

/**
 * Runs on every service-worker wake, not just browser startup. MV3 recycles an
 * idle worker after ~30s while the offscreen document keeps recording, so a
 * persisted `recording`/`uploading` status is only stale when no offscreen
 * document is alive — otherwise the document is the source of truth and will
 * send `recording-complete`/`recording-error` when it is done.
 */
const ready = (async () => {
  const { folderId } = await chrome.storage.local.get('folderId')
  const stored = (await chrome.storage.session.get('state')).state
  state = { ...freshState(), ...(stored || {}) }
  if (state.status !== 'idle' && state.status !== 'done' && state.status !== 'error') {
    if (!(await hasOffscreen())) {
      state = { ...freshState() }
      await closeOffscreen()
    }
  }
  state.onboarded = Boolean(folderId)
  await chrome.storage.session.set({ state })
  await syncBadge()
})()

// A browser restart really does tear down the offscreen document, so this is the
// only place a hard reset is unconditionally correct.
chrome.runtime.onStartup.addListener(() => {
  ready.then(async () => {
    await closeOffscreen()
    await setState({ ...freshState(), onboarded: state.onboarded })
  })
})

// --- auth ---------------------------------------------------------------

function getAuthToken (interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive, scopes: SCOPES }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Could not get a Google access token.'))
        return
      }
      resolve(token)
    })
  })
}

function removeCachedToken (token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve()
      return
    }
    chrome.identity.removeCachedAuthToken({ token }, () => resolve())
  })
}

function clearAllCachedTokens () {
  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => resolve())
  })
}

async function freshToken () {
  const token = await getAuthToken(false)
  await rememberToken(token)
  return token
}

// --- offscreen lifecycle ------------------------------------------------

async function hasOffscreen () {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  })
  return contexts.length > 0
}

async function ensureOffscreen () {
  if (await hasOffscreen()) return
  // createDocument rejects if a document already exists or is mid-creation, so
  // funnel every caller through the same in-flight promise.
  if (creatingOffscreen) {
    await creatingOffscreen
    return
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: 'Screen recording and upload'
  })
  try {
    await creatingOffscreen
  } finally {
    creatingOffscreen = null
  }
}

async function closeOffscreen () {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument()
  } catch (err) {
    console.error('DriveClip: failed to close offscreen document', err)
  }
}

function sendToOffscreen (type, payload = {}) {
  return chrome.runtime.sendMessage({ type, target: 'offscreen', payload })
}

/**
 * createDocument can resolve before offscreen.js (a deferred module) has run and
 * registered its onMessage listener, which surfaces as "Receiving end does not
 * exist". Retry briefly rather than failing the whole start.
 */
async function sendToOffscreenWithRetry (type, payload, attempts = 5) {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await sendToOffscreen(type, payload)
    } catch (err) {
      lastError = err
      if (!/Receiving end does not exist|Could not establish connection/i.test(err?.message || '')) throw err
      await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)))
    }
  }
  throw lastError
}

// --- recording orchestration -------------------------------------------

function pad (n) {
  return String(n).padStart(2, '0')
}

function buildFileName (date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}`
  return `DriveClip ${stamp}.webm`
}

function chooseDesktopStreamId () {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab', 'audio'], (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (!streamId) {
        reject(new Error('Screen capture was cancelled.'))
        return
      }
      resolve(streamId)
    })
  })
}

async function handleSignIn () {
  const token = await getAuthToken(true)
  await rememberToken(token)
  const folderId = await ensureRecordingsFolder(token)
  await chrome.storage.local.set({ folderId })
  await setState({ onboarded: true, error: null })
  return folderId
}

async function handleStartRecording ({ mode, mic, devicePixelRatio }) {
  const { folderId } = await chrome.storage.local.get('folderId')
  if (!folderId) throw new Error('Connect Google Drive before recording.')

  const token = await freshToken()

  let streamId = null
  let captureSize = null
  if (mode === 'tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('No active tab to record.')
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })
    // Tab capture delivers CSS-pixel frames unless a min floor asks for device
    // pixels, so request viewport × density (the offscreen doc drops the floor
    // and retries if Chrome rejects it).
    const scale = Math.min(Math.max(devicePixelRatio || 1, 1), 3)
    if (tab.width && tab.height) {
      captureSize = {
        minWidth: Math.min(3840, Math.round(tab.width * scale)),
        minHeight: Math.min(2160, Math.round(tab.height * scale))
      }
    }
  } else {
    // The source picker must be summoned from here: an offscreen document has
    // no user activation and the display-capture permissions policy disabled,
    // so getDisplayMedia() inside it always rejects.
    streamId = await chooseDesktopStreamId()
  }

  await ensureOffscreen()

  let response
  try {
    response = await sendToOffscreenWithRetry('offscreen-start', {
      mode,
      mic: Boolean(mic),
      streamId,
      captureSize,
      token,
      folderId,
      fileName: buildFileName()
    })
  } catch (err) {
    await closeOffscreen()
    throw new Error(err?.message || 'The recorder did not respond.')
  }

  if (!response?.ok) {
    await closeOffscreen()
    throw new Error(response?.error || 'The recorder could not start.')
  }

  await setState({
    status: 'recording',
    startedAt: Date.now(),
    uploadedBytes: 0,
    fileId: null,
    shareLink: null,
    driveLink: null,
    error: null
  })
}

async function handleStopRecording () {
  await setState({ status: 'uploading' })
  try {
    await sendToOffscreen('offscreen-stop', {})
  } catch (err) {
    console.error('DriveClip: offscreen-stop failed', err)
    await failRecording(err?.message || 'Lost contact with the recorder.')
  }
}

async function failRecording (message) {
  await closeOffscreen()
  await setState({ status: 'error', error: message, startedAt: null })
}

// --- message router -----------------------------------------------------

const handlers = {
  'sign-in': async () => {
    const folderId = await handleSignIn()
    return { ok: true, folderId }
  },
  'get-state': async () => state,
  'start-recording': async (payload) => {
    await handleStartRecording(payload || {})
    return { ok: true }
  },
  'stop-recording': async () => {
    await handleStopRecording()
    return { ok: true }
  },
  reset: async () => {
    await setState({
      status: 'idle',
      startedAt: null,
      uploadedBytes: 0,
      fileId: null,
      shareLink: null,
      driveLink: null,
      error: null
    })
    return { ok: true }
  },
  'recording-started': async () => {
    if (state.status !== 'recording') {
      await setState({ status: 'recording', startedAt: state.startedAt || Date.now(), error: null })
    }
    return { ok: true }
  },
  'upload-progress': async (payload) => {
    await setState({ uploadedBytes: payload?.uploadedBytes ?? state.uploadedBytes })
    return { ok: true }
  },
  'recording-complete': async (payload) => {
    await closeOffscreen()
    await setState({
      status: 'done',
      startedAt: null,
      fileId: payload?.fileId ?? null,
      shareLink: payload?.shareLink ?? null,
      driveLink: payload?.driveLink ?? null,
      error: null
    })
    return { ok: true }
  },
  'recording-error': async (payload) => {
    await failRecording(payload?.message || 'Recording failed.')
    return { ok: true }
  },
  'need-token': async () => {
    const bad = await lastToken()
    if (bad) {
      await removeCachedToken(bad)
    } else {
      // Worker was recycled before we could record which token was handed out;
      // without this, getAuthToken would just hand back the same dead token.
      await clearAllCachedTokens()
    }
    const token = await freshToken()
    return { token }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'background') return
  const handler = handlers[message.type]
  if (!handler) return

  ;(async () => {
    await ready
    try {
      sendResponse(await handler(message.payload))
    } catch (err) {
      console.error(`DriveClip: ${message.type} failed`, err)
      const error = err?.message || String(err)
      // A failed start leaves the state at 'idle' on purpose: the popup shows the
      // error inline on the Ready view so the user can just press Record again.
      sendResponse({ ok: false, error })
    }
  })()

  return true
})
