const POLL_MS = 1000
const TIMER_MS = 250
const START_TIMEOUT_MS = 20000

const DEFAULT_SETTINGS = { mode: 'tab', mic: true }
const MIC_PAGE = 'permissions/mic.html'

const el = {
  views: {
    onboarding: document.getElementById('view-onboarding'),
    ready: document.getElementById('view-ready'),
    recording: document.getElementById('view-recording'),
    uploading: document.getElementById('view-uploading'),
    done: document.getElementById('view-done'),
    error: document.getElementById('view-error')
  },
  signInBtn: document.getElementById('btn-signin'),
  signInStatus: document.getElementById('signin-status'),
  signInError: document.getElementById('signin-error'),
  modeButtons: Array.from(document.querySelectorAll('.seg')),
  micToggle: document.getElementById('mic-toggle'),
  recordBtn: document.getElementById('btn-record'),
  recordLabel: document.getElementById('record-label'),
  readyError: document.getElementById('ready-error'),
  timer: document.getElementById('timer'),
  stopBtn: document.getElementById('btn-stop'),
  uploadedBytes: document.getElementById('uploaded-bytes'),
  shareLink: document.getElementById('share-link'),
  copyBtn: document.getElementById('btn-copy'),
  driveLink: document.getElementById('drive-link'),
  newBtn: document.getElementById('btn-new'),
  errorMessage: document.getElementById('error-message'),
  retryBtn: document.getElementById('btn-retry'),
  micNotices: {
    onboarding: document.getElementById('mic-notice-onboarding'),
    ready: document.getElementById('mic-notice-ready')
  },
  micEnableButtons: Array.from(document.querySelectorAll('[data-mic-enable]'))
}

let settings = { ...DEFAULT_SETTINGS }
let state = null
// 'unknown' when the Permissions API can't answer — we stay quiet rather than warn wrongly.
let micPermission = 'unknown'
let micStatus = null
let starting = false
let startingSince = 0
let stopping = false
let signingIn = false
let copyFlashTimer = null
let pollTimer = null
let tickTimer = null

async function send(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, target: 'background', payload })
    if (response === undefined) {
      throw new Error('No response from the DriveClip background service.')
    }
    return response
  } catch (error) {
    console.error('popup: message failed', type, error)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings')
  const saved = stored && stored.settings ? stored.settings : {}
  settings = {
    mode: saved.mode === 'desktop' ? 'desktop' : 'tab',
    mic: typeof saved.mic === 'boolean' ? saved.mic : DEFAULT_SETTINGS.mic
  }
}

async function saveSettings() {
  await chrome.storage.local.set({ settings })
}

async function refreshMicPermission() {
  if (!navigator.permissions || !navigator.permissions.query) {
    micPermission = 'unknown'
    return
  }
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    micPermission = status.state
    if (status !== micStatus) {
      micStatus = status
      // The grant usually happens in the mic tab, not here, so react to it live.
      status.addEventListener('change', () => {
        micPermission = status.state
        render()
      })
    }
  } catch (error) {
    console.warn('popup: microphone permission query unavailable', error)
    micPermission = 'unknown'
  }
}

function renderMicNotice(view) {
  const needsMic = settings.mic && micPermission !== 'granted' && micPermission !== 'unknown'
  for (const [key, node] of Object.entries(el.micNotices)) {
    node.hidden = !(needsMic && key === view)
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function formatMegabytes(bytes) {
  return `${((bytes || 0) / (1024 * 1024)).toFixed(1)} MB uploaded`
}

function showView(name) {
  for (const [key, node] of Object.entries(el.views)) {
    node.hidden = key !== name
  }
}

function showInlineError(node, message) {
  if (message) {
    node.textContent = message
    node.hidden = false
  } else {
    node.textContent = ''
    node.hidden = true
  }
}

function renderSettings() {
  for (const button of el.modeButtons) {
    button.setAttribute('aria-checked', String(button.dataset.mode === settings.mode))
  }
  el.micToggle.checked = settings.mic
}

function updateTimer() {
  if (!state || state.status !== 'recording') return
  const startedAt = state.startedAt || Date.now()
  el.timer.textContent = formatDuration(Date.now() - startedAt)
}

function render() {
  if (!state) return

  if (starting && Date.now() - startingSince > START_TIMEOUT_MS) {
    starting = false
    showInlineError(el.readyError, 'Recording did not start. Try again.')
  }
  if (state.status !== 'idle') starting = false
  if (state.status !== 'recording') stopping = false

  if (!state.onboarded) {
    showView('onboarding')
    renderMicNotice('onboarding')
    el.signInBtn.disabled = signingIn
    el.signInStatus.hidden = !signingIn
    if (signingIn) el.signInStatus.textContent = 'Waiting for Google…'
    return
  }

  if (state.status === 'recording' && stopping) {
    showView('uploading')
    el.uploadedBytes.textContent = formatMegabytes(state.uploadedBytes)
    return
  }

  switch (state.status) {
    case 'recording': {
      showView('recording')
      el.stopBtn.disabled = false
      updateTimer()
      return
    }
    case 'uploading': {
      showView('uploading')
      el.uploadedBytes.textContent = formatMegabytes(state.uploadedBytes)
      return
    }
    case 'done': {
      showView('done')
      el.shareLink.value = state.shareLink || ''
      el.driveLink.href = state.driveLink || '#'
      el.driveLink.hidden = !state.driveLink
      return
    }
    case 'error': {
      showView('error')
      el.errorMessage.textContent = state.error || 'Something went wrong.'
      return
    }
    default: {
      showView('ready')
      renderSettings()
      renderMicNotice('ready')
      el.recordBtn.disabled = starting
      el.recordLabel.textContent = starting ? 'Starting…' : 'Start recording'
      return
    }
  }
}

async function refresh() {
  try {
    const next = await send('get-state')
    if (next && typeof next.status === 'string') {
      state = next
      render()
    }
  } catch (error) {
    state = state || {
      status: 'error',
      startedAt: null,
      uploadedBytes: 0,
      fileId: null,
      shareLink: null,
      driveLink: null,
      error: error.message,
      onboarded: true
    }
    render()
  }
}

/* Handlers */

el.signInBtn.addEventListener('click', async () => {
  signingIn = true
  showInlineError(el.signInError, '')
  render()
  try {
    const response = await send('sign-in')
    if (!response.ok) showInlineError(el.signInError, response.error || 'Could not connect to Google Drive.')
  } catch (error) {
    showInlineError(el.signInError, error.message)
  } finally {
    signingIn = false
    await refresh()
  }
})

for (const button of el.modeButtons) {
  button.addEventListener('click', async () => {
    settings.mode = button.dataset.mode === 'desktop' ? 'desktop' : 'tab'
    renderSettings()
    await saveSettings()
  })
}

el.micToggle.addEventListener('change', async () => {
  settings.mic = el.micToggle.checked
  await saveSettings()
  await refreshMicPermission()
  render()
})

for (const button of el.micEnableButtons) {
  button.addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(MIC_PAGE) })
    } catch (error) {
      console.error('popup: could not open the microphone page', error)
    }
    window.close()
  })
}

el.recordBtn.addEventListener('click', async () => {
  starting = true
  startingSince = Date.now()
  showInlineError(el.readyError, '')
  render()
  try {
    const response = await send('start-recording', {
      mode: settings.mode,
      mic: settings.mic,
      // The service worker has no window, so the popup reports the display's
      // pixel density; it shares a display with the tab being captured.
      devicePixelRatio: window.devicePixelRatio || 1
    })
    if (!response.ok) {
      starting = false
      showInlineError(el.readyError, response.error || 'Could not start recording.')
    }
  } catch (error) {
    starting = false
    showInlineError(el.readyError, error.message)
  }
  await refresh()
})

el.stopBtn.addEventListener('click', async () => {
  stopping = true
  el.stopBtn.disabled = true
  render()
  try {
    await send('stop-recording')
  } catch (error) {
    console.error('popup: stop failed', error)
  }
  await refresh()
})

el.copyBtn.addEventListener('click', async () => {
  const link = el.shareLink.value
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
  } catch (error) {
    console.error('popup: clipboard write failed', error)
    el.shareLink.select()
    return
  }
  el.copyBtn.textContent = 'Copied'
  clearTimeout(copyFlashTimer)
  copyFlashTimer = setTimeout(() => {
    el.copyBtn.textContent = 'Copy link'
  }, 1500)
})

el.shareLink.addEventListener('focus', () => el.shareLink.select())

for (const button of [el.newBtn, el.retryBtn]) {
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      await send('reset')
    } catch (error) {
      console.error('popup: reset failed', error)
    }
    button.disabled = false
    await refresh()
  })
}

/* Boot */

async function init() {
  await loadSettings()
  renderSettings()
  await refreshMicPermission()
  await refresh()
  pollTimer = setInterval(refresh, POLL_MS)
  tickTimer = setInterval(updateTimer, TIMER_MS)
}

window.addEventListener('unload', () => {
  clearInterval(pollTimer)
  clearInterval(tickTimer)
})

init()
