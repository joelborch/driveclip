import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRecordingsFolder, uploadRecording } from '../extension/lib/drive.js';

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

test('uploadRecording handles 401 token refresh and 5xx retry', async () => {
  let tokenCount = 0;
  const getFreshToken = async (force) => (force ? `tok-${++tokenCount}` : `tok-${tokenCount || ++tokenCount}`);
  const { calls, restore } = stubFetch([
    jsonRes(401, { error: { message: 'expired' } }),
    jsonRes(200, {}, { Location: 'https://upload.example/session-1' }),
    jsonRes(503, { error: { message: 'busy' } }),
    jsonRes(200, { id: 'file-abc1234567' })
  ]);
  try {
    const blob = new Blob(['webm-bytes'], { type: 'video/webm' });
    const result = await uploadRecording({ blob, name: 'clip.webm', folderId: 'folder-1', getFreshToken });
    assert.deepEqual(result, { fileId: 'file-abc1234567' });
    assert.equal(calls.length, 4);
    assert.equal(calls[1].headers.Authorization, 'Bearer tok-2');
    assert.equal(calls[3].url, 'https://upload.example/session-1');
  } finally { restore(); }
});
