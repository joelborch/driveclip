// DriveClip — pure-fetch Google Drive v3 client (no chrome.* APIs).
import { FOLDER_NAME, APP_PROPERTY, UPLOAD_GRANULARITY, UPLOAD_SLICE_BYTES } from './config.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_BACKOFF_MS = 32_000;
const DEFAULT_MAX_RETRIES = 6;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => Math.min(1000 * (2 ** attempt), MAX_BACKOFF_MS);

async function driveError(context, res) {
  let detail = '';
  try {
    const body = await res.text();
    try { detail = JSON.parse(body)?.error?.message || body; } catch { detail = body; }
  } catch {}
  const err = new Error(`${context} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  err.status = res.status;
  return err;
}

export async function ensureRecordingsFolder(token) {
  const q = Object.entries(APP_PROPERTY).map(([k, v]) => `appProperties has { key='${k}' and value='${v}' }`).join(' and ');
  const params = new URLSearchParams({ q: `${q} and trashed=false`, spaces: 'drive', fields: 'files(id)', pageSize: '1' });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };

  const list = await fetch(`${DRIVE_FILES}?${params}`, { headers: { Authorization: headers.Authorization } });
  if (!list.ok) throw await driveError('Drive folder lookup', list);
  const existing = (await list.json()).files?.[0]?.id;
  if (existing) return existing;

  const created = await fetch(`${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { ...APP_PROPERTY } })
  });
  if (!created.ok) throw await driveError('Drive folder creation', created);
  const folderId = (await created.json()).id;
  if (!folderId) throw new Error('Drive folder creation returned no id');

  const perm = await fetch(`${DRIVE_FILES}/${encodeURIComponent(folderId)}/permissions?fields=id`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'anyone', role: 'reader' })
  });
  if (!perm.ok) throw await driveError('Drive folder sharing', perm);
  return folderId;
}

/** Verifies the OAuth token is accepted and the target recordings folder exists and is not trashed. */
export async function verifyRecordingsFolder(token, folderId) {
  if (!token) {
    const err = new Error('Missing Google access token. Connect Google Drive before recording.');
    err.status = 401;
    throw err;
  }
  if (!folderId) throw new Error('Connect Google Drive before recording.');

  const res = await fetch(`${DRIVE_FILES}/${encodeURIComponent(folderId)}?fields=id,trashed,mimeType`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) {
    const err = new Error('DriveClip Recordings folder was deleted. Reconnect Google Drive.');
    err.status = 404;
    err.folderMissing = true;
    throw err;
  }
  if (!res.ok) throw await driveError('Drive folder check', res);
  const file = await res.json();
  if (file.trashed) {
    const err = new Error('DriveClip Recordings folder is in Trash. Restore it or reconnect Google Drive.');
    err.folderMissing = true;
    throw err;
  }
  return file.id;
}

export async function createResumableSession(token, { name, mimeType = 'video/webm', folderId, totalBytes }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType
  };
  if (Number.isFinite(totalBytes)) headers['X-Upload-Content-Length'] = String(totalBytes);

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, mimeType, parents: [folderId] })
  });
  if (!res.ok) throw await driveError('Drive upload session', res);
  const sessionUrl = res.headers.get('Location') || res.headers.get('location');
  if (!sessionUrl) throw new Error('Drive upload session returned no Location header');
  return sessionUrl;
}

function parseCommittedOffset(res) {
  const range = res.headers.get('Range') || res.headers.get('range');
  const match = range && /bytes=0-(\d+)/.exec(range);
  return match ? Number(match[1]) + 1 : 0;
}

/** Queries Drive for how many bytes a resumable session has already committed. */
export async function queryUploadOffset(sessionUrl, totalBytes, token) {
  const res = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Range': `bytes */${totalBytes}`
    }
  });
  if (res.status === 308) return { committed: parseCommittedOffset(res), file: null };
  if (res.ok) return { committed: totalBytes, file: await res.json() };
  if (res.status === 404 || res.status === 410) {
    const err = await driveError('Drive upload status query', res);
    err.sessionExpired = true;
    throw err;
  }
  throw await driveError('Drive upload status query', res);
}

/**
 * Uploads a recording Blob/File using Drive's resumable upload protocol in
 * 256 KiB-aligned chunks. Handles HTTP 308 Resume Incomplete, queries Drive for
 * committed bytes after 429/5xx/network errors with exponential backoff so
 * already-uploaded bytes are not resent, refreshes expired tokens on 401, and
 * can resume an existing sessionUrl on retry.
 */
export async function uploadRecording({
  blob,
  name,
  mimeType = 'video/webm',
  folderId,
  sessionUrl = null,
  getFreshToken,
  onProgress = () => {},
  onSession = () => {},
  sliceBytes = UPLOAD_SLICE_BYTES,
  sleep = defaultSleep,
  maxRetries = DEFAULT_MAX_RETRIES
}) {
  if (!blob) throw new Error('Missing recording blob');
  if (typeof getFreshToken !== 'function') throw new Error('uploadRecording requires getFreshToken');
  if (sliceBytes < UPLOAD_GRANULARITY || sliceBytes % UPLOAD_GRANULARITY !== 0) {
    throw new Error(`sliceBytes must be a positive multiple of ${UPLOAD_GRANULARITY}`);
  }

  const total = blob.size;
  let token = await getFreshToken(false);
  let offset = 0;
  let activeSession = sessionUrl;
  onProgress(0);

  const runSessionCreate = async () => {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const url = await createResumableSession(token, { name, mimeType, folderId, totalBytes: total });
        activeSession = url;
        onSession(url);
        return url;
      } catch (err) {
        if (err?.status === 401 && !refreshed) {
          refreshed = true;
          token = await getFreshToken(true);
          continue;
        }
        const retryable = !err?.status || err.status === 429 || err.status >= 500;
        if (retryable && attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  };

  const queryWithRefresh = async () => {
    let refreshed = false;
    for (;;) {
      try {
        return await queryUploadOffset(activeSession, total, token);
      } catch (err) {
        if (err?.status === 401 && !refreshed) {
          refreshed = true;
          token = await getFreshToken(true);
          continue;
        }
        throw err;
      }
    }
  };

  // If retrying an earlier failed upload, ask Drive how many bytes it already has.
  if (activeSession) {
    try {
      const status = await queryWithRefresh();
      if (status.file?.id) {
        onProgress(total);
        return { fileId: status.file.id };
      }
      offset = Math.min(status.committed, total);
      onProgress(offset);
    } catch (err) {
      if (err?.sessionExpired) {
        activeSession = null;
        offset = 0;
      } else {
        err.sessionUrl = activeSession;
        err.uploadedBytes = offset;
        throw err;
      }
    }
  }

  if (!activeSession) await runSessionCreate();

  let retries = 0;
  let refreshedForChunk = false;

  const attachContext = (err) => {
    err.sessionUrl = activeSession;
    err.uploadedBytes = offset;
    return err;
  };

  while (offset < total || total === 0) {
    const chunkSize = Math.min(sliceBytes, total - offset);
    const chunk = chunkSize > 0 ? blob.slice(offset, offset + chunkSize) : new Blob([]);
    const contentRange = chunkSize > 0
      ? `bytes ${offset}-${offset + chunkSize - 1}/${total}`
      : `bytes */${total}`;

    let res;
    try {
      res = await fetch(activeSession, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mimeType,
          'Content-Range': contentRange
        },
        body: chunk
      });
    } catch (networkErr) {
      if (retries < maxRetries) {
        await sleep(backoffMs(retries));
        retries += 1;
        const status = await queryWithRefresh().catch((qErr) => { throw attachContext(qErr); });
        if (status.file?.id) { onProgress(total); return { fileId: status.file.id }; }
        offset = Math.min(status.committed, total);
        onProgress(offset);
        continue;
      }
      throw attachContext(new Error(`Drive upload failed: ${networkErr.message}`));
    }

    if (res.status === 308) {
      const next = parseCommittedOffset(res);
      offset = next > offset ? Math.min(next, total) : Math.min(offset + chunkSize, total);
      retries = 0;
      refreshedForChunk = false;
      onProgress(offset);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      if (!data?.id) throw attachContext(new Error('Drive upload completed without returning a file id'));
      offset = total;
      onProgress(total);
      return { fileId: data.id };
    }

    if (res.status === 401 && !refreshedForChunk) {
      refreshedForChunk = true;
      token = await getFreshToken(true);
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && retries < maxRetries) {
      await sleep(backoffMs(retries));
      retries += 1;
      const status = await queryWithRefresh().catch((qErr) => { throw attachContext(qErr); });
      if (status.file?.id) { onProgress(total); return { fileId: status.file.id }; }
      offset = Math.min(status.committed, total);
      onProgress(offset);
      continue;
    }

    const err = await driveError('Drive upload', res);
    if (res.status === 404 || res.status === 410) err.sessionExpired = true;
    throw attachContext(err);
  }

  throw attachContext(new Error('Drive upload ended without returning a file id'));
}
