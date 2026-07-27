const el = {
  requestBtn: document.getElementById('btn-request'),
  granted: document.getElementById('note-granted'),
  denied: document.getElementById('note-denied'),
  deniedTitle: document.getElementById('denied-title'),
  deniedMessage: document.getElementById('denied-message'),
  settingsBtn: document.getElementById('btn-settings'),
  settingsUrl: document.getElementById('settings-url')
}

// chrome://settings pages can't be linked to from an extension page, so the URL is
// both offered as a tabs.create click and shown as copyable text.
const SITE_SETTINGS_URL =
  `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}`

el.settingsUrl.value = SITE_SETTINGS_URL

function showGranted() {
  el.granted.hidden = false
  el.denied.hidden = true
  el.requestBtn.disabled = true
  el.requestBtn.textContent = 'Microphone allowed'
}

function showDenied(title, message) {
  el.granted.hidden = true
  el.denied.hidden = false
  el.deniedTitle.textContent = title
  el.deniedMessage.textContent = message
  el.requestBtn.disabled = false
  el.requestBtn.textContent = 'Try again'
}

async function requestMic() {
  el.requestBtn.disabled = true
  el.requestBtn.textContent = 'Waiting for Chrome…'
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    showGranted()
  } catch (error) {
    console.error('mic: getUserMedia failed', error)
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      showDenied('Microphone blocked.', 'Chrome denied the request for this extension.')
    } else if (error && error.name === 'NotFoundError') {
      showDenied('No microphone found.', 'Chrome could not find a microphone on this device.')
    } else {
      showDenied('Microphone unavailable.', (error && error.message) || String(error))
    }
  }
}

el.requestBtn.addEventListener('click', requestMic)

el.settingsBtn.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: SITE_SETTINGS_URL })
  } catch (error) {
    console.error('mic: could not open site settings', error)
    el.settingsUrl.select()
  }
})

el.settingsUrl.addEventListener('focus', () => el.settingsUrl.select())

async function init() {
  if (!navigator.permissions || !navigator.permissions.query) return
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    if (status.state === 'granted') showGranted()
    status.addEventListener('change', () => {
      if (status.state === 'granted') showGranted()
    })
  } catch (error) {
    console.warn('mic: permission query unavailable', error)
  }
}

init()
