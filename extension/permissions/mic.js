const $ = (id) => document.getElementById(id);
const SITE_SETTINGS_URL = `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}`;
$('settings-url').value = SITE_SETTINGS_URL;

function showGranted() {
  $('note-granted').hidden = false;
  $('note-denied').hidden = true;
  $('btn-request').disabled = true;
  $('btn-request').textContent = 'Microphone allowed';
}

function showDenied(title, message) {
  $('note-granted').hidden = true;
  $('note-denied').hidden = false;
  $('denied-title').textContent = title;
  $('denied-message').textContent = message;
  $('btn-request').disabled = false;
  $('btn-request').textContent = 'Try again';
}

$('btn-request').addEventListener('click', async () => {
  $('btn-request').disabled = true;
  $('btn-request').textContent = 'Waiting for Chrome…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    showGranted();
  } catch (err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') showDenied('Microphone blocked.', 'Chrome denied the request for this extension.');
    else if (err?.name === 'NotFoundError') showDenied('No microphone found.', 'Chrome could not find a microphone on this device.');
    else showDenied('Microphone unavailable.', err?.message || String(err));
  }
});

$('btn-settings').addEventListener('click', () => chrome.tabs.create({ url: SITE_SETTINGS_URL }).catch(() => $('settings-url').select()));
$('settings-url').addEventListener('focus', () => $('settings-url').select());

navigator.permissions?.query?.({ name: 'microphone' }).then((status) => {
  if (status.state === 'granted') showGranted();
  status.addEventListener('change', () => { if (status.state === 'granted') showGranted(); });
}).catch(() => {});
