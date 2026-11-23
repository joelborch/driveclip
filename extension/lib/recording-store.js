// Disk-backed recording storage using Chrome's Origin Private File System (OPFS).
// Streams MediaRecorder chunks straight to disk so long recordings (multiple GB)
// are not held in RAM, and keeps the file across failed uploads until upload
// succeeds or the user discards it.
import { PENDING_FILE_NAME } from './config.js';

const defaultGetDirectory = () => navigator.storage.getDirectory();

export async function createRecordingWriter({
  getDirectory = defaultGetDirectory,
  fileName = PENDING_FILE_NAME
} = {}) {
  const dir = await getDirectory();
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  let chain = Promise.resolve();
  let totalBytes = 0;
  let closed = false;

  return {
    append(chunk) {
      if (closed || !chunk || chunk.size === 0) return chain;
      totalBytes += chunk.size;
      const run = chain.then(() => writable.write(chunk));
      chain = run.catch(() => {});
      return run;
    },
    async close() {
      if (closed) return { totalBytes };
      closed = true;
      await chain;
      await writable.close();
      return { totalBytes };
    },
    async abort() {
      if (closed) return;
      closed = true;
      await chain.catch(() => {});
      await writable.abort?.().catch(() => writable.close?.().catch(() => {}));
      await deletePendingRecording({ getDirectory, fileName });
    },
    get totalBytes() {
      return totalBytes;
    }
  };
}

export async function readPendingRecording({
  getDirectory = defaultGetDirectory,
  fileName = PENDING_FILE_NAME
} = {}) {
  try {
    const dir = await getDirectory();
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return file && file.size > 0 ? file : null;
  } catch (err) {
    if (err?.name === 'NotFoundError') return null;
    throw err;
  }
}

export async function deletePendingRecording({
  getDirectory = defaultGetDirectory,
  fileName = PENDING_FILE_NAME
} = {}) {
  try {
    const dir = await getDirectory();
    await dir.removeEntry(fileName);
  } catch (err) {
    if (err?.name !== 'NotFoundError') throw err;
  }
}
