import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecordingWriter,
  readPendingRecording,
  deletePendingRecording
} from '../extension/lib/recording-store.js';

function fakeOpfs() {
  const files = new Map();
  const dir = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) {
          const err = new Error('NotFound');
          err.name = 'NotFoundError';
          throw err;
        }
        files.set(name, []);
      }
      return {
        async createWritable() {
          const chunks = [];
          return {
            async write(chunk) { chunks.push(chunk); },
            async close() { files.set(name, chunks); },
            async abort() { files.delete(name); }
          };
        },
        async getFile() {
          if (!files.has(name)) {
            const err = new Error('NotFound');
            err.name = 'NotFoundError';
            throw err;
          }
          return new Blob(files.get(name), { type: 'video/webm' });
        }
      };
    },
    async removeEntry(name) {
      if (!files.has(name)) {
        const err = new Error('NotFound');
        err.name = 'NotFoundError';
        throw err;
      }
      files.delete(name);
    }
  };
  return { getDirectory: async () => dir, files };
}

test('recording-store streams chunks to OPFS, keeps file for retry/local save, and deletes only on discard/success', async () => {
  const opfs = fakeOpfs();
  const writer = await createRecordingWriter({ getDirectory: opfs.getDirectory });
  await writer.append(new Blob(['chunk-1-']));
  await writer.append(new Blob(['chunk-2']));
  const { totalBytes } = await writer.close();
  assert.equal(totalBytes, 15);

  const file = await readPendingRecording({ getDirectory: opfs.getDirectory });
  assert.ok(file);
  assert.equal(file.size, 15);
  assert.equal(await file.slice(0, 8).text(), 'chunk-1-');
  assert.equal(await file.slice(8, 15).text(), 'chunk-2');

  // File stays on disk across reads until explicitly deleted
  assert.ok(await readPendingRecording({ getDirectory: opfs.getDirectory }));
  await deletePendingRecording({ getDirectory: opfs.getDirectory });
  assert.equal(await readPendingRecording({ getDirectory: opfs.getDirectory }), null);
});
