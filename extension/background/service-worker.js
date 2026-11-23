import { ensureRecordingsFolder, verifyRecordingsFolder } from '../lib/drive.js';
import { deletePendingRecording } from '../lib/recording-store.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_KEY = 'currentToken';
const PENDING_KEY = 'pendingRecording';

const freshState = () => ({
  status: 'idle',
  startedAt: null,
  uploadedBytes: 0,
  totalBytes: 0,
  fileId: null,
  shareLink: null,
  driveLink: null,
  error: null,
  onboarded: false,
  hasPendingRecording: false,
  pendingFileName: null
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

async function readPending() {
  return (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || null;
}

async function writePending(pending) {
  if (pending) await chrome.storage.local.set({ [PENDING_KEY]: pending });
  else await chrome.storage.local.remove(PENDING_KEY);
}

// Reset stale recording/uploading state only when no offscreen document is alive.
// Never discard an un-uploaded pendingRecording saved on disk.
const ready = (async () => {
  const { folderId, [PENDING_KEY]: pending } = await chrome.storage.local.get(['folderId', PENDING_KEY]);
  const stored = (await chrome.storage.session.get('state')).state;
  state = { ...freshState(), ...(stored || {}) };
  if (state.status !== 'idle' && state.status !== 'done' && state.status !== 'error' && !(await hasOffscreen())) {
    state = freshState();
    await closeOffscreen();
  }
  if (pending && state.status !== 'recording' && state.status !== 'uploading') {
    state = {
      ...state,
      status: 'error',
      error: state.error || 'Previous upload did not finish. Try again or save locally.',
      hasPendingRecording: true,
      pendingFileName: pending.fileName || 'DriveClip recording.webm',
      totalBytes: pending.totalBytes || 0,
      uploadedBytes: pending.uploadedBytes || 0
    };
  }
  state.onboarded = Boolean(folderId);
  await setState({});
})();

chrome.runtime.onStartup.addListener(() => {
  ready.then(async () => {
    await closeOffscreen();
    const pending = await readPending();
    if (pending) {
      await setState({
        ...freshState(),
        onboarded: state.onboarded,
        status: 'error',
        error: 'Previous upload did not finish. Try again or save locally.',
        hasPendingRecording: true,
        pendingFileName: pending.fileName || 'DriveClip recording.webm',
        totalBytes: pending.totalBytes || 0,
        uploadedBytes: pending.uploadedBytes || 0
      });
    } else {
      await setState({ ...freshState(), onboarded: state.onboarded });
    }
  });
});

// --- auth & folder verification ---

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

async function evictAndRefreshToken() {
  const bad = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY];
  if (bad) await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: bad }, r));
  else await new Promise((r) => chrome.identity.clearAllCachedAuthTokens(r));
  return freshToken(false);
}

/** Verifies sign-in token and recordings folder before starting capture or retrying upload. */
async function verifyTokenAndFolder(folderId) {
  let token = await freshToken(false);
  try {
    await verifyRecordingsFolder(token, folderId);
    return token;
  } catch (err) {
    if (err?.status !== 401) throw err;
  }
  token = await evictAndRefreshToken();
  await verifyRecordingsFolder(token, folderId);
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
  if (await readPending()) {
    throw new Error('A previous recording is still waiting to upload. Retry, save locally, or discard it first.');
  }
  const { folderId } = await chrome.storage.local.get('folderId');
  if (!folderId) throw new Error('Connect Google Drive before recording.');

  // Verify OAuth token and target folder BEFORE capturing so bad sign-in or a trashed folder fails immediately.
  let token;
  try {
    token = await verifyTokenAndFolder(folderId);
  } catch (err) {
    if (err?.folderMissing) {
      await chrome.storage.local.remove('folderId');
      await setState({ onboarded: false, error: err.message });
    }
    throw err;
  }

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
  await setState({
    status: 'recording',
    startedAt: Date.now(),
    uploadedBytes: 0,
    totalBytes: 0,
    fileId: null,
    shareLink: null,
    driveLink: null,
    error: null,
    hasPendingRecording: false,
    pendingFileName: null
  });
}

async function handleRetryUpload() {
  const pending = await readPending();
  if (!pending) throw new Error('No saved recording found to retry.');
  const folderId = pending.folderId || (await chrome.storage.local.get('folderId')).folderId;
  if (!folderId) throw new Error('Connect Google Drive before retrying upload.');

  const token = await verifyTokenAndFolder(folderId);
  await ensureOffscreen();
  await setState({
    status: 'uploading',
    error: null,
    uploadedBytes: pending.uploadedBytes || 0,
    totalBytes: pending.totalBytes || 0,
    hasPendingRecording: true,
    pendingFileName: pending.fileName
  });

  const response = await sendToOffscreen('offscreen-retry-upload', {
    token,
    folderId,
    fileName: pending.fileName,
    sessionUrl: pending.sessionUrl || null
  }, 5);
  if (!response?.ok) {
    await failRecording(response?.error || 'Could not restart upload.', true);
    throw new Error(response?.error || 'Could not restart upload.');
  }
}

async function handleDiscardRecording() {
  try {
    if (await hasOffscreen()) await sendToOffscreen('offscreen-discard-recording').catch(() => {});
  } finally {
    await deletePendingRecording().catch(() => {});
    await writePending(null);
    await closeOffscreen();
  }
  await setState({ ...freshState(), onboarded: state.onboarded });
}

async function failRecording(message, keepPending = false, details = null) {
  await closeOffscreen();
  let pending = await readPending();
  if (keepPending && pending) {
    pending = {
      ...pending,
      sessionUrl: details && 'sessionUrl' in details ? details.sessionUrl : pending.sessionUrl,
      uploadedBytes: Number.isFinite(details?.uploadedBytes) ? details.uploadedBytes : (pending.uploadedBytes || 0),
      totalBytes: Number.isFinite(details?.totalBytes) ? details.totalBytes : (pending.totalBytes || 0)
    };
    await writePending(pending);
  }
  await setState({
    status: 'error',
    error: message,
    startedAt: null,
    hasPendingRecording: Boolean(pending),
    pendingFileName: pending?.fileName || null,
    uploadedBytes: pending?.uploadedBytes || 0,
    totalBytes: pending?.totalBytes || 0
  });
}

// --- message router ---

const handlers = {
  'sign-in': async () => {
    const token = await freshToken(true);
    const folderId = await ensureRecordingsFolder(token);
    await chrome.storage.local.set({ folderId });
    const pending = await readPending();
    if (pending && !pending.folderId) {
      await writePending({ ...pending, folderId });
    }
    await setState({ onboarded: true, error: null });
    return { ok: true, folderId };
  },
  'get-state': async () => state,
  'start-recording': async (p) => { await handleStartRecording(p || {}); return { ok: true }; },
  'stop-recording': async () => {
    await setState({ status: 'uploading', uploadedBytes: 0 });
    try { await sendToOffscreen('offscreen-stop'); }
    catch (err) { await failRecording(err?.message || 'Lost contact with the recorder.', Boolean(await readPending())); }
    return { ok: true };
  },
  'retry-upload': async () => {
    await handleRetryUpload();
    return { ok: true };
  },
  'discard-recording': async () => {
    await handleDiscardRecording();
    return { ok: true };
  },
  reset: async () => {
    const pending = await readPending();
    if (pending) {
      await setState({
        status: 'error',
        error: state.error || 'Previous upload did not finish. Try again, save locally, or discard.',
        hasPendingRecording: true,
        pendingFileName: pending.fileName,
        totalBytes: pending.totalBytes || 0,
        uploadedBytes: pending.uploadedBytes || 0
      });
      return { ok: true };
    }
    await setState({ ...freshState(), onboarded: state.onboarded });
    return { ok: true };
  },
  'recording-started': async () => {
    if (state.status !== 'recording') await setState({ status: 'recording', startedAt: state.startedAt || Date.now(), error: null });
    return { ok: true };
  },
  'recording-saved': async (p) => {
    const pending = {
      fileName: p?.fileName || buildFileName(),
      folderId: p?.folderId || (await chrome.storage.local.get('folderId')).folderId,
      totalBytes: p?.totalBytes || 0,
      sessionUrl: null,
      uploadedBytes: 0
    };
    await writePending(pending);
    await setState({
      status: 'uploading',
      uploadedBytes: 0,
      totalBytes: pending.totalBytes,
      hasPendingRecording: true,
      pendingFileName: pending.fileName
    });
    return { ok: true };
  },
  'upload-session': async (p) => {
    const pending = await readPending();
    if (pending && p?.sessionUrl) await writePending({ ...pending, sessionUrl: p.sessionUrl });
    return { ok: true };
  },
  'upload-progress': async (p) => {
    const uploadedBytes = p?.uploadedBytes ?? state.uploadedBytes;
    const totalBytes = p?.totalBytes ?? state.totalBytes;
    const pending = await readPending();
    if (pending) await writePending({ ...pending, uploadedBytes, totalBytes });
    await setState({ uploadedBytes, totalBytes });
    return { ok: true };
  },
  'recording-complete': async (p) => {
    await writePending(null);
    await closeOffscreen();
    await setState({
      status: 'done',
      startedAt: null,
      fileId: p?.fileId ?? null,
      shareLink: p?.shareLink ?? null,
      driveLink: p?.driveLink ?? null,
      error: null,
      hasPendingRecording: false,
      pendingFileName: null
    });
    return { ok: true };
  },
  'recording-error': async (p) => {
    await failRecording(p?.message || 'Recording failed.', Boolean(p?.hasPendingRecording), p);
    return { ok: true };
  },
  'need-token': async () => ({ token: await evictAndRefreshToken() })
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
