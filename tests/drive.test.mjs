import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureRecordingsFolder,
  verifyRecordingsFolder,
  uploadRecording
} from '../extension/lib/drive.js';
import { UPLOAD_GRANULARITY } from '../extension/lib/config.js';

function stubFetch(handlers) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const next = handlers.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const jsonRes = (status, data, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => data,
  text: async () => JSON.stringify(data)
});

const noSleep = async () => {};

test('ensureRecordingsFolder returns existing folder id when found', async () => {
  const { calls, restore } = stubFetch([jsonRes(200, { files: [{ id: 'folder-existing' }] })]);
  try {
    const id = await ensureRecordingsFolder('tok');
    assert.equal(id, 'folder-existing');
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('ensureRecordingsFolder creates and shares folder when missing', async () => {
  const { calls, restore } = stubFetch([
    jsonRes(200, { files: [] }),
    jsonRes(200, { id: 'folder-new' }),
    jsonRes(200, { id: 'perm-1' })
  ]);
  try {
    const id = await ensureRecordingsFolder('tok');
    assert.equal(id, 'folder-new');
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /folder-new\/permissions/);
  } finally { restore(); }
});

test('verifyRecordingsFolder rejects 401 bad token, 404 deleted folder, and trashed folder', async () => {
  const { restore } = stubFetch([
    jsonRes(200, { id: 'folder-ok', trashed: false }),
    jsonRes(401, { error: { message: 'Invalid Credentials' } }),
    jsonRes(404, { error: { message: 'File not found' } }),
    jsonRes(200, { id: 'folder-trashed', trashed: true })
  ]);
  try {
    assert.equal(await verifyRecordingsFolder('good-tok', 'folder-ok'), 'folder-ok');
    await assert.rejects(() => verifyRecordingsFolder('bad-tok', 'folder-ok'), (e) => e.status === 401);
    await assert.rejects(() => verifyRecordingsFolder('good-tok', 'folder-gone'), (e) => e.folderMissing === true);
    await assert.rejects(() => verifyRecordingsFolder('good-tok', 'folder-trashed'), (e) => e.folderMissing === true);
  } finally { restore(); }
});

test('uploadRecording sends 256 KiB-aligned chunks, handles HTTP 308, and reports progress starting at 0', async () => {
  const total = UPLOAD_GRANULARITY * 2 + 1000; // 525,288 bytes -> 3 chunks
  const blob = new Blob([new Uint8Array(total)], { type: 'video/webm' });
  const progress = [];
  const sessions = [];

  const { calls, restore } = stubFetch([
    jsonRes(200, {}, { Location: 'https://upload.example/s1' }),
    jsonRes(308, {}, { Range: `bytes=0-${UPLOAD_GRANULARITY - 1}` }),
    jsonRes(308, {}, { Range: `bytes=0-${UPLOAD_GRANULARITY * 2 - 1}` }),
    jsonRes(200, { id: 'file-chunked-1' })
  ]);
  try {
    const result = await uploadRecording({
      blob,
      name: 'clip.webm',
      folderId: 'folder-1',
      getFreshToken: async () => 'tok-1',
      onProgress: (b) => progress.push(b),
      onSession: (u) => sessions.push(u),
      sliceBytes: UPLOAD_GRANULARITY,
      sleep: noSleep
    });
    assert.deepEqual(result, { fileId: 'file-chunked-1' });
    assert.deepEqual(sessions, ['https://upload.example/s1']);
    assert.deepEqual(progress, [0, UPLOAD_GRANULARITY, UPLOAD_GRANULARITY * 2, total]);
    assert.equal(calls[1].headers['Content-Range'], `bytes 0-${UPLOAD_GRANULARITY - 1}/${total}`);
    assert.equal(calls[2].headers['Content-Range'], `bytes ${UPLOAD_GRANULARITY}-${UPLOAD_GRANULARITY * 2 - 1}/${total}`);
    assert.equal(calls[3].headers['Content-Range'], `bytes ${UPLOAD_GRANULARITY * 2}-${total - 1}/${total}`);
  } finally { restore(); }
});

test('uploadRecording queries Drive offset after 5xx/429/network errors with backoff and resumes without resending committed bytes', async () => {
  const total = UPLOAD_GRANULARITY * 3 + 512;
  const blob = new Blob([new Uint8Array(total)], { type: 'video/webm' });
  const waits = [];
  const partialCommit = UPLOAD_GRANULARITY + 65536;

  const { calls, restore } = stubFetch([
    jsonRes(200, {}, { Location: 'https://upload.example/s2' }),
    // Chunk 1 succeeds
    jsonRes(308, {}, { Range: `bytes=0-${UPLOAD_GRANULARITY - 1}` }),
    // Chunk 2 fails 4 times (> 3 tries) with 503, 429, network error, 502; Drive partially commits 64 KiB on the first retry
    jsonRes(503, { error: { message: 'unavailable' } }),
    jsonRes(308, {}, { Range: `bytes=0-${partialCommit - 1}` }),
    jsonRes(429, { error: { message: 'rate limit' } }),
    jsonRes(308, {}, { Range: `bytes=0-${partialCommit - 1}` }),
    () => { throw new Error('network reset'); },
    jsonRes(308, {}, { Range: `bytes=0-${partialCommit - 1}` }),
    jsonRes(502, { error: { message: 'bad gateway' } }),
    jsonRes(308, {}, { Range: `bytes=0-${partialCommit - 1}` }),
    // Resumed chunk from committed offset succeeds (still non-final -> 308)
    jsonRes(308, {}, { Range: `bytes=0-${partialCommit + UPLOAD_GRANULARITY - 1}` }),
    // Final remaining tail completes -> 200
    jsonRes(200, { id: 'file-resumed-1' })
  ]);
  try {
    const result = await uploadRecording({
      blob,
      name: 'clip.webm',
      folderId: 'folder-1',
      getFreshToken: async () => 'tok-1',
      sliceBytes: UPLOAD_GRANULARITY,
      sleep: async (ms) => { waits.push(ms); }
    });
    assert.deepEqual(result, { fileId: 'file-resumed-1' });
    assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
    // Status query asked Drive for committed bytes
    assert.equal(calls[3].headers['Content-Range'], `bytes */${total}`);
    // Next PUT started at the committed offset (UPLOAD_GRANULARITY + 65536), NOT byte 0
    assert.equal(calls[4].headers['Content-Range'], `bytes ${partialCommit}-${partialCommit + UPLOAD_GRANULARITY - 1}/${total}`);
    // Final PUT sent only the remaining tail
    assert.equal(calls[11].headers['Content-Range'], `bytes ${partialCommit + UPLOAD_GRANULARITY}-${total - 1}/${total}`);
  } finally { restore(); }
});

test('uploadRecording resumes an existing sessionUrl on retry and refreshes expired 401 tokens', async () => {
  const total = UPLOAD_GRANULARITY + 128;
  const blob = new Blob([new Uint8Array(total)], { type: 'video/webm' });
  let tokens = 0;
  const getFreshToken = async (force) => (force ? `tok-${++tokens}` : `tok-${tokens || ++tokens}`);

  const { calls, restore } = stubFetch([
    // Initial status query hits 401 -> token refreshes -> Drive reports first chunk already committed
    jsonRes(401, { error: { message: 'expired' } }),
    jsonRes(308, {}, { Range: `bytes=0-${UPLOAD_GRANULARITY - 1}` }),
    // Only the final 128-byte tail is sent
    jsonRes(200, { id: 'file-retry-ok' })
  ]);
  try {
    const result = await uploadRecording({
      blob,
      name: 'clip.webm',
      folderId: 'folder-1',
      sessionUrl: 'https://upload.example/existing',
      getFreshToken,
      sliceBytes: UPLOAD_GRANULARITY,
      sleep: noSleep
    });
    assert.deepEqual(result, { fileId: 'file-retry-ok' });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].headers.Authorization, 'Bearer tok-2');
    assert.equal(calls[2].headers['Content-Range'], `bytes ${UPLOAD_GRANULARITY}-${total - 1}/${total}`);
  } finally { restore(); }
});
