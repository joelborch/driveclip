// DriveClip — pure-fetch Google Drive v3 client (no chrome.* APIs).
import { FOLDER_NAME, APP_PROPERTY } from './config.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const RETRY_DELAYS_MS = [1000, 2500];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driveError(context, res) {
  let detail = '';
  try {
    const body = await res.text();
    try { detail = JSON.parse(body)?.error?.message || body; } catch { detail = body; }
  } catch {}
  return new Error(`${context} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
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

async function fetchWithRetry(context, buildReq, getFreshToken) {
  let token = await getFreshToken(false);
  let refreshed = false;
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(...buildReq(token));
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error(`${context} failed: ${err.message}`);
    }
    if (res.ok) return res;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getFreshToken(true);
      continue;
    }
    if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw await driveError(context, res);
  }
}

/** Uploads a completed recording blob to Drive in a single resumable session (supports files > 5 MB). */
export async function uploadRecording({ blob, name, mimeType = 'video/webm', folderId, getFreshToken }) {
  const init = await fetchWithRetry(
    'Drive upload session',
    (token) => [`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size)
      },
      body: JSON.stringify({ name, mimeType, parents: [folderId] })
    }],
    getFreshToken
  );
  const sessionUrl = init.headers.get('Location') || init.headers.get('location');
  if (!sessionUrl) throw new Error('Drive upload session returned no Location header');

  const put = await fetchWithRetry(
    'Drive upload',
    (token) => [sessionUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
      body: blob
    }],
    getFreshToken
  );
  const fileId = (await put.json())?.id;
  if (!fileId) throw new Error('Drive upload completed without returning a file id');
  return { fileId };
}
