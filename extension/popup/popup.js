import { readPendingRecording } from '../lib/recording-store.js';

const $ = (id) => document.getElementById(id);
const views = ['onboarding', 'ready', 'recording', 'uploading', 'done', 'error'];
const modeButtons = [...document.querySelectorAll('.seg')];

let settings = { mode: 'tab', mic: true };
let state = null;
let micPermission = 'unknown';
let micStatus = null;
let starting = false;
let startingSince = 0;
let stopping = false;
let signingIn = false;
let copyTimer = null;

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, target: 'background', payload });
  if (res === undefined) throw new Error('No response from DriveClip background.');
  return res;
}

const showView = (name) => views.forEach((v) => { $(`view-${v}`).hidden = v !== name; });
const showError = (id, msg) => { $(id).textContent = msg || ''; $(id).hidden = !msg; };
const pad = (n) => String(n).padStart(2, '0');
const fmtMb = (bytes) => ((bytes || 0) / (1024 * 1024)).toFixed(1);
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

function renderSettings() {
  modeButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
  $('mic-toggle').checked = settings.mic;
}

function renderMicNotice(view) {
  const show = settings.mic && micPermission !== 'granted' && micPermission !== 'unknown';
  $('mic-notice-onboarding').hidden = !(show && view === 'onboarding');
  $('mic-notice-ready').hidden = !(show && view === 'ready');
}

function updateTimer() {
  if (state?.status === 'recording') $('timer').textContent = fmtTime(Date.now() - (state.startedAt || Date.now()));
}

function formatUploadProgress(s) {
  if (s.totalBytes > 0) return `${fmtMb(s.uploadedBytes)} / ${fmtMb(s.totalBytes)} MB uploaded`;
  return `${fmtMb(s.uploadedBytes)} MB uploaded`;
}

function render() {
  if (!state) return;
  if (starting && Date.now() - startingSince > 20000) { starting = false; showError('ready-error', 'Recording did not start. Try again.'); }
  if (state.status !== 'idle') starting = false;
  if (state.status !== 'recording') stopping = false;

  if (!state.onboarded && !state.hasPendingRecording) {
    showView('onboarding');
    renderMicNotice('onboarding');
    $('btn-signin').disabled = signingIn;
    $('signin-status').hidden = !signingIn;
    if (signingIn) $('signin-status').textContent = 'Waiting for Google…';
    if (state.error) showError('signin-error', state.error);
    return;
  }
  const effective = state.status === 'recording' && stopping ? 'uploading' : state.status;
  if (effective === 'recording') {
    showView('recording');
    $('btn-stop').disabled = false;
    updateTimer();
  } else if (effective === 'uploading') {
    showView('uploading');
    $('uploaded-bytes').textContent = formatUploadProgress(state);
  } else if (effective === 'done') {
    showView('done');
    $('share-link').value = state.shareLink || '';
    $('drive-link').href = state.driveLink || '#';
    $('drive-link').hidden = !state.driveLink;
  } else if (effective === 'error') {
    showView('error');
    $('error-message').textContent = state.error || 'Something went wrong.';
    const hasPending = Boolean(state.hasPendingRecording);
    $('pending-note').hidden = !hasPending;
    $('pending-actions').hidden = !hasPending;
    $('btn-retry').textContent = hasPending ? 'Try again' : 'Back';
  } else {
    showView('ready');
    renderSettings();
    renderMicNotice('ready');
    $('btn-record').disabled = starting;
    $('record-label').textContent = starting ? 'Starting…' : 'Start recording';
  }
}

async function refreshMic() {
  try {
    const status = await navigator.permissions?.query?.({ name: 'microphone' });
    if (!status) return;
    micPermission = status.state;
    if (status !== micStatus) {
      micStatus = status;
      status.addEventListener('change', () => { micPermission = status.state; render(); });
    }
  } catch { micPermission = 'unknown'; }
}

async function refresh() {
  try {
    const next = await send('get-state');
    if (next?.status) { state = next; render(); }
  } catch (err) {
    state ||= { status: 'error', error: err.message, onboarded: true };
    render();
  }
}

$('btn-signin').addEventListener('click', async () => {
  signingIn = true; showError('signin-error', ''); render();
  try {
    const res = await send('sign-in');
    if (!res.ok) showError('signin-error', res.error || 'Could not connect to Google Drive.');
  } catch (err) { showError('signin-error', err.message); }
  finally { signingIn = false; await refresh(); }
});

modeButtons.forEach((b) => b.addEventListener('click', async () => {
  settings.mode = b.dataset.mode === 'desktop' ? 'desktop' : 'tab';
  renderSettings();
  await chrome.storage.local.set({ settings });
}));

$('mic-toggle').addEventListener('change', async () => {
  settings.mic = $('mic-toggle').checked;
  await chrome.storage.local.set({ settings });
  await refreshMic();
  render();
});

document.querySelectorAll('[data-mic-enable]').forEach((b) => b.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('permissions/mic.html') }).catch(() => {});
  window.close();
}));

$('btn-record').addEventListener('click', async () => {
  starting = true; startingSince = Date.now(); showError('ready-error', ''); render();
  try {
    const res = await send('start-recording', { mode: settings.mode, mic: settings.mic, devicePixelRatio: window.devicePixelRatio || 1 });
    if (!res.ok) { starting = false; showError('ready-error', res.error || 'Could not start recording.'); }
  } catch (err) { starting = false; showError('ready-error', err.message); }
  await refresh();
});

$('btn-stop').addEventListener('click', async () => {
  stopping = true; $('btn-stop').disabled = true; render();
  await send('stop-recording').catch(() => {});
  await refresh();
});

$('btn-copy').addEventListener('click', async () => {
  const link = $('share-link').value;
  if (!link) return;
  try { await navigator.clipboard.writeText(link); }
  catch { $('share-link').select(); return; }
  $('btn-copy').textContent = 'Copied';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { $('btn-copy').textContent = 'Copy link'; }, 1500);
});

$('share-link').addEventListener('focus', () => $('share-link').select());

$('btn-new').addEventListener('click', async () => {
  $('btn-new').disabled = true;
  await send('reset').catch(() => {});
  $('btn-new').disabled = false;
  await refresh();
});

$('btn-retry').addEventListener('click', async () => {
  $('btn-retry').disabled = true;
  try {
    if (state?.hasPendingRecording) {
      const res = await send('retry-upload');
      if (!res?.ok) $('error-message').textContent = res?.error || 'Could not restart upload.';
    } else {
      await send('reset');
    }
  } catch (err) {
    $('error-message').textContent = err.message;
  } finally {
    $('btn-retry').disabled = false;
    await refresh();
  }
});

$('btn-save-local').addEventListener('click', async () => {
  $('btn-save-local').disabled = true;
  try {
    const file = await readPendingRecording();
    if (!file) throw new Error('Saved recording was not found on disk.');
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = state?.pendingFileName || 'DriveClip recording.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    $('error-message').textContent = err.message;
  } finally {
    $('btn-save-local').disabled = false;
  }
});

$('btn-discard').addEventListener('click', async () => {
  $('btn-discard').disabled = true;
  await send('discard-recording').catch(() => {});
  $('btn-discard').disabled = false;
  await refresh();
});

(async () => {
  const saved = (await chrome.storage.local.get('settings')).settings || {};
  settings = { mode: saved.mode === 'desktop' ? 'desktop' : 'tab', mic: typeof saved.mic === 'boolean' ? saved.mic : true };
  renderSettings();
  await refreshMic();
  await refresh();
  const pollTimer = setInterval(refresh, 1000);
  const tickTimer = setInterval(updateTimer, 250);
  window.addEventListener('unload', () => { clearInterval(pollTimer); clearInterval(tickTimer); });
})();
