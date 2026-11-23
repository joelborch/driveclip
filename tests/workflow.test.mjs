import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function createFakeEnv({ fetchHandlers = [], folderId = 'folder-1', authTokens = ['tok-1'] } = {}) {
  const local = folderId ? { folderId } : {};
  const session = {};
  const offscreenMessages = [];
  const captureCalls = { tab: 0, desktop: 0, createOffscreen: 0, closeOffscreen: 0 };
  let offscreenOpen = false;
  let messageListener = null;
  let tokenIdx = 0;

  const origChrome = globalThis.chrome;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const next = fetchHandlers.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((k) => [k, local[k]]));
        },
        async set(obj) { Object.assign(local, obj); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k]; }
      },
      session: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((k) => [k, session[k]]));
        },
        async set(obj) { Object.assign(session, obj); }
      }
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {}
    },
    identity: {
      getAuthToken(_opts, cb) {
        const tok = authTokens[Math.min(tokenIdx++, authTokens.length - 1)];
        cb(tok);
      },
      removeCachedAuthToken(_opts, cb) { cb(); },
      clearAllCachedAuthTokens(cb) { cb(); }
    },
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://fake/${p}`,
      async getContexts() { return offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { messageListener = fn; } },
      async sendMessage(msg) {
        if (msg.target === 'offscreen') {
          offscreenMessages.push(msg);
          return { ok: true };
        }
        return { ok: true };
      }
    },
    offscreen: {
      async createDocument() { captureCalls.createOffscreen += 1; offscreenOpen = true; },
      async closeDocument() { captureCalls.closeOffscreen += 1; offscreenOpen = false; }
    },
    tabs: { async query() { return [{ id: 1, width: 1280, height: 720 }]; } },
    tabCapture: { async getMediaStreamId() { captureCalls.tab += 1; return 'stream-tab-1'; } },
    desktopCapture: { chooseDesktopMedia(_s, cb) { captureCalls.desktop += 1; cb('stream-desk-1'); } }
  };

  const send = (type, payload = {}) => new Promise((resolve) => {
    messageListener({ type, target: 'background', payload }, {}, resolve);
  });

  return {
    local,
    session,
    offscreenMessages,
    captureCalls,
    send,
    restore() {
      globalThis.chrome = origChrome;
      globalThis.fetch = origFetch;
    }
  };
}

const jsonRes = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => data,
  text: async () => JSON.stringify(data)
});

let importCounter = 0;
async function loadWorker() {
  importCounter += 1;
  await import(`../extension/background/service-worker.js?test=${importCounter}`);
}

test('start-recording fails BEFORE capture when target folder is trashed or token is invalid', async () => {
  const env = createFakeEnv({
    fetchHandlers: [jsonRes(200, { id: 'folder-1', trashed: true })]
  });
  try {
    await loadWorker();
    const res = await env.send('start-recording', { mode: 'tab', mic: false });
    assert.equal(res.ok, false);
    assert.match(res.error, /Trash/i);
    assert.equal(env.captureCalls.tab, 0, 'must fail before capturing tab');
    assert.equal(env.captureCalls.createOffscreen, 0, 'must fail before creating offscreen doc');
  } finally { env.restore(); }

  const env401 = createFakeEnv({
    authTokens: ['bad-1', 'bad-2'],
    fetchHandlers: [
      jsonRes(401, { error: { message: 'Invalid Credentials' } }),
      jsonRes(401, { error: { message: 'Invalid Credentials' } })
    ]
  });
  try {
    await loadWorker();
    const res = await env401.send('start-recording', { mode: 'tab', mic: false });
    assert.equal(res.ok, false);
    assert.match(res.error, /HTTP 401/);
    assert.equal(env401.captureCalls.tab, 0);
  } finally { env401.restore(); }
});

test('failed upload keeps pendingRecording, Try again retries upload with sessionUrl, and Discard clears it', async () => {
  const env = createFakeEnv({
    fetchHandlers: [
      jsonRes(200, { id: 'folder-1', trashed: false }), // verify on start
      jsonRes(200, { id: 'folder-1', trashed: false })  // verify on retry-upload
    ]
  });
  try {
    await loadWorker();
    const started = await env.send('start-recording', { mode: 'tab', mic: false });
    assert.equal(started.ok, true);

    // Offscreen saves file to disk before upload starts: uploadedBytes MUST start at 0, not totalBytes
    await env.send('recording-saved', { fileName: 'DriveClip test.webm', folderId: 'folder-1', totalBytes: 10_000_000 });
    let state = await env.send('get-state');
    assert.equal(state.uploadedBytes, 0);
    assert.equal(state.totalBytes, 10_000_000);
    assert.equal(state.hasPendingRecording, true);

    await env.send('upload-session', { sessionUrl: 'https://upload.example/resumable-9' });
    await env.send('upload-progress', { uploadedBytes: 4_194_304, totalBytes: 10_000_000 });

    // Upload fails mid-way -> recording is KEPT, not thrown away
    await env.send('recording-error', {
      message: 'Drive upload failed (HTTP 503)',
      hasPendingRecording: true,
      sessionUrl: 'https://upload.example/resumable-9',
      uploadedBytes: 4_194_304,
      totalBytes: 10_000_000
    });
    state = await env.send('get-state');
    assert.equal(state.status, 'error');
    assert.equal(state.hasPendingRecording, true);
    assert.equal(env.local.pendingRecording.sessionUrl, 'https://upload.example/resumable-9');
    assert.equal(env.local.pendingRecording.uploadedBytes, 4_194_304);

    // Try again -> retries upload from saved sessionUrl
    const retried = await env.send('retry-upload');
    assert.equal(retried.ok, true);
    const retryMsg = env.offscreenMessages.find((m) => m.type === 'offscreen-retry-upload');
    assert.ok(retryMsg);
    assert.equal(retryMsg.payload.sessionUrl, 'https://upload.example/resumable-9');
    assert.equal(retryMsg.payload.fileName, 'DriveClip test.webm');

    // Discard clears pendingRecording and returns to idle
    await env.send('discard-recording');
    state = await env.send('get-state');
    assert.equal(state.status, 'idle');
    assert.equal(state.hasPendingRecording, false);
    assert.equal(env.local.pendingRecording, undefined);
  } finally { env.restore(); }
});

test('docs and dashboard no longer claim chunks upload while you record', () => {
  for (const rel of ['../README.md', '../SPEC.md', '../AGENTS.md', '../dashboard/index.html']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /while you (are )?record(ing)?|chunks upload while you record|streams (the recording |it )?into (the user's |your own )?Google Drive/i, rel);
  }
});
