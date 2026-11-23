import { ensureRecordingsFolder } from '../lib/drive.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_KEY = 'currentToken';

const freshState = () => ({
  status: 'idle', startedAt: null, uploadedBytes: 0,
  fileId: null, shareLink: null, driveLink: null, error: null, onboarded: false
});

let state = freshState();
let creatingOffscreen = null;

async function setState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.session.set({ state });
  const active = state.status === 'recording' || state.status === 'uploading';
  if (active) await chrome.action.setBadgeBackgroundColor({ color: '#e5322d' });
  await chrome.action.setBadgeText({ text: active ? 'REC' : '' });
  return state;
}

// Reset stale recording/uploading state only when no offscreen document is alive.
const ready = (async () => {
  const { folderId } = await chrome.storage.local.get('folderId');
  const stored = (await chrome.storage.session.get('state')).state;
  state = { ...freshState(), ...(stored || {}) };
  if (state.status !== 'idle' && state.status !== 'done' && state.status !== 'error' && !(await hasOffscreen())) {
    state = freshState();
    await closeOffscreen();
  }
  state.onboarded = Boolean(folderId);
  await setState({});
})();

chrome.runtime.onStartup.addListener(() => {
  ready.then(async () => {
    await closeOffscreen();
    await setState({ ...freshState(), onboarded: state.onboarded });
  });
});

// --- auth ---

const getAuthToken = (interactive) => new Promise((resolve, reject) => {
  chrome.identity.getAuthToken({ interactive, scopes: SCOPES }, (token) => {
    if (chrome.runtime.lastError || !token) reject(new Error(chrome.runtime.lastError?.message || 'Could not get a Google access token.'));
    else resolve(token);
  });
});

async function freshToken(interactive = false) {
  const token = await getAuthToken(interactive);
  await chrome.storage.session.set({ [TOKEN_KEY]: token });
  return token;
}

// --- offscreen lifecycle ---

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ||= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL, reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'], justification: 'Screen recording and upload'
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch {}
}

async function sendToOffscreen(type, payload = {}, attempts = 1) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try { return await chrome.runtime.sendMessage({ type, target: 'offscreen', payload }); }
    catch (err) {
      lastError = err;
      if (i + 1 >= attempts || !/Receiving end does not exist|Could not establish connection/i.test(err?.message || '')) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastError;
}

// --- recording ---

const pad = (n) => String(n).padStart(2, '0');
const buildFileName = (d = new Date()) =>
  `DriveClip ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.webm`;

const chooseDesktopStreamId = () => new Promise((resolve, reject) => {
  chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab', 'audio'], (id) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!id) reject(new Error('Screen capture was cancelled.'));
    else resolve(id);
  });
});

async function handleStartRecording({ mode, mic, devicePixelRatio }) {
  const { folderId } = await chrome.storage.local.get('folderId');
  if (!folderId) throw new Error('Connect Google Drive before recording.');
  const token = await freshToken(false);

  let streamId;
  let captureSize = null;
  if (mode === 'tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab to record.');
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const scale = Math.min(Math.max(devicePixelRatio || 1, 1), 3);
    if (tab.width && tab.height) {
      captureSize = { minWidth: Math.min(3840, Math.round(tab.width * scale)), minHeight: Math.min(2160, Math.round(tab.height * scale)) };
    }
  } else {
    streamId = await chooseDesktopStreamId();
  }

  await ensureOffscreen();
  let response;
  try {
    response = await sendToOffscreen('offscreen-start', {
      mode, mic: Boolean(mic), streamId, captureSize, token, folderId, fileName: buildFileName()
    }, 5);
  } catch (err) {
    await closeOffscreen();
    throw new Error(err?.message || 'The recorder did not respond.');
  }
  if (!response?.ok) {
    await closeOffscreen();
    throw new Error(response?.error || 'The recorder could not start.');
  }
  await setState({ status: 'recording', startedAt: Date.now(), uploadedBytes: 0, fileId: null, shareLink: null, driveLink: null, error: null });
}

async function failRecording(message) {
  await closeOffscreen();
  await setState({ status: 'error', error: message, startedAt: null });
}

// --- message router ---

const handlers = {
  'sign-in': async () => {
    const token = await freshToken(true);
    const folderId = await ensureRecordingsFolder(token);
    await chrome.storage.local.set({ folderId });
    await setState({ onboarded: true, error: null });
    return { ok: true, folderId };
  },
  'get-state': async () => state,
  'start-recording': async (p) => { await handleStartRecording(p || {}); return { ok: true }; },
  'stop-recording': async () => {
    await setState({ status: 'uploading' });
    try { await sendToOffscreen('offscreen-stop'); }
    catch (err) { await failRecording(err?.message || 'Lost contact with the recorder.'); }
    return { ok: true };
  },
  reset: async () => {
    await setState({ status: 'idle', startedAt: null, uploadedBytes: 0, fileId: null, shareLink: null, driveLink: null, error: null });
    return { ok: true };
  },
  'recording-started': async () => {
    if (state.status !== 'recording') await setState({ status: 'recording', startedAt: state.startedAt || Date.now(), error: null });
    return { ok: true };
  },
  'upload-progress': async (p) => {
    await setState({ uploadedBytes: p?.uploadedBytes ?? state.uploadedBytes });
    return { ok: true };
  },
  'recording-complete': async (p) => {
    await closeOffscreen();
    await setState({ status: 'done', startedAt: null, fileId: p?.fileId ?? null, shareLink: p?.shareLink ?? null, driveLink: p?.driveLink ?? null, error: null });
    return { ok: true };
  },
  'recording-error': async (p) => { await failRecording(p?.message || 'Recording failed.'); return { ok: true }; },
  'need-token': async () => {
    const bad = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY];
    if (bad) await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: bad }, r));
    else await new Promise((r) => chrome.identity.clearAllCachedAuthTokens(r));
    return { token: await freshToken(false) };
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'background') return;
  const handler = handlers[message.type];
  if (!handler) return;
  (async () => {
    await ready;
    try { sendResponse(await handler(message.payload)); }
    catch (err) {
      console.error(`DriveClip: ${message.type} failed`, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
