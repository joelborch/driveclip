// DriveClip — Google Drive REST client.
//
// Pure fetch: no chrome.* APIs live here so this module stays testable and usable
// from any context (service worker, offscreen document, plain page). Every entry
// point takes an OAuth access token explicitly; refreshing a token that Drive
// rejected is the caller's job, supplied to ChunkedUploader as `getFreshToken`.

import { FOLDER_NAME, APP_PROPERTY, UPLOAD_SLICE_BYTES } from './config.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Turns a failed Drive response into an Error carrying whatever the API said.
async function driveError(context, response) {
  let detail = '';
  try {
    const body = await response.text();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message || body;
      } catch {
        detail = body;
      }
    }
  } catch {
    detail = '';
  }
  const suffix = detail ? `: ${detail}` : '';
  return new Error(`${context} failed (HTTP ${response.status})${suffix}`);
}

// appProperties queries use Drive's `has { key='..' and value='..' }` form.
function appPropertyQuery(property) {
  return Object.entries(property)
    .map(([key, value]) => `appProperties has { key='${key}' and value='${value}' }`)
    .join(' and ');
}

/**
 * Finds (or creates) the single DriveClip recordings folder for this user and
 * makes sure it is link-readable, so uploaded recordings inherit that visibility.
 * @param {string} token OAuth access token with the drive.file scope.
 * @returns {Promise<string>} the folder id.
 */
export async function ensureRecordingsFolder(token) {
  const params = new URLSearchParams({
    q: `${appPropertyQuery(APP_PROPERTY)} and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '1'
  });

  const listResponse = await fetch(`${DRIVE_FILES}?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!listResponse.ok) {
    throw await driveError('Drive folder lookup', listResponse);
  }
  const listed = await listResponse.json();
  if (listed.files && listed.files.length > 0) {
    return listed.files[0].id;
  }

  const createResponse = await fetch(`${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { ...APP_PROPERTY }
    })
  });
  if (!createResponse.ok) {
    throw await driveError('Drive folder creation', createResponse);
  }
  const folder = await createResponse.json();
  if (!folder.id) {
    throw new Error('Drive folder creation returned no id');
  }

  // Only the freshly created folder needs the sharing permission; existing
  // folders were granted it when they were created.
  const permissionResponse = await fetch(
    `${DRIVE_FILES}/${encodeURIComponent(folder.id)}/permissions?fields=id`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({ type: 'anyone', role: 'reader' })
    }
  );
  if (!permissionResponse.ok) {
    throw await driveError('Drive folder sharing', permissionResponse);
  }

  return folder.id;
}

/**
 * Opens a resumable upload session for a new file.
 * @param {string} token OAuth access token.
 * @param {{ name: string, mimeType: string, folderId: string }} metadata
 * @returns {Promise<string>} the session URL to PUT slices at.
 */
export async function createResumableSession(token, { name, mimeType, folderId }) {
  const response = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType
    },
    body: JSON.stringify({ name, mimeType, parents: [folderId] })
  });
  if (!response.ok) {
    throw await driveError('Drive resumable session creation', response);
  }
  const sessionUrl = response.headers.get('Location') || response.headers.get('location');
  if (!sessionUrl) {
    throw new Error('Drive resumable session creation returned no Location header');
  }
  return sessionUrl;
}

/**
 * Streams MediaRecorder blobs into an open resumable session.
 *
 * Blobs are appended to an in-memory queue and flushed as 256 KiB-aligned slices,
 * one PUT in flight at a time (Drive requires strictly sequential ranges). Bytes
 * stay queued until the slice containing them is acknowledged.
 */
export class ChunkedUploader {
  constructor({ sessionUrl, getFreshToken }) {
    if (!sessionUrl) {
      throw new Error('ChunkedUploader requires a sessionUrl');
    }
    if (typeof getFreshToken !== 'function') {
      throw new Error('ChunkedUploader requires a getFreshToken callback');
    }
    this.sessionUrl = sessionUrl;
    this.getFreshToken = getFreshToken;
    this.onprogress = () => {};

    this._queue = [];
    this._queuedBytes = 0;
    this._uploadedBytes = 0;
    this._token = null;
    this._finalized = false;
    this._fileId = null;
    // Serializes drain()/finalize() callers so only one PUT is ever in flight.
    this._lock = Promise.resolve();
  }

  get uploadedBytes() {
    return this._uploadedBytes;
  }

  /** Bytes accepted but not yet acknowledged by Drive. */
  get pendingBytes() {
    return this._queuedBytes;
  }

  append(blob) {
    if (this._finalized) {
      throw new Error('ChunkedUploader has already been finalized');
    }
    if (!blob || blob.size === 0) {
      return;
    }
    this._queue.push(blob);
    this._queuedBytes += blob.size;
  }

  /** Uploads every complete UPLOAD_SLICE_BYTES slice currently queued. */
  async drain() {
    return this._exclusive(async () => {
      if (this._finalized) {
        return;
      }
      while (this._queuedBytes >= UPLOAD_SLICE_BYTES) {
        await this._sendSlice(UPLOAD_SLICE_BYTES, null);
      }
    });
  }

  /**
   * Flushes whatever remains, declaring the real total size on the last slice.
   * @returns {Promise<{ fileId: string }>}
   */
  async finalize() {
    return this._exclusive(async () => {
      if (this._finalized) {
        return { fileId: this._fileId };
      }
      const total = this._uploadedBytes + this._queuedBytes;

      // Everything but the last slice still has to be granularity-aligned, so
      // drain full slices first even though the total is now known.
      while (this._queuedBytes > UPLOAD_SLICE_BYTES) {
        await this._sendSlice(UPLOAD_SLICE_BYTES, total);
      }
      const result = await this._sendSlice(this._queuedBytes, total);
      const fileId = result && result.id;
      if (!fileId) {
        throw new Error('Drive upload completed without returning a file id');
      }
      this._finalized = true;
      this._fileId = fileId;
      return { fileId };
    });
  }

  _exclusive(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _currentToken() {
    if (!this._token) {
      this._token = await this.getFreshToken();
    }
    return this._token;
  }

  // Pulls exactly `size` bytes off the front of the queue without copying the
  // untouched tail of a partially consumed blob.
  _takeBytes(size) {
    const parts = [];
    let remaining = size;
    while (remaining > 0) {
      const head = this._queue[0];
      if (head.size <= remaining) {
        parts.push(head);
        remaining -= head.size;
        this._queue.shift();
      } else {
        parts.push(head.slice(0, remaining));
        this._queue[0] = head.slice(remaining);
        remaining = 0;
      }
    }
    this._queuedBytes -= size;
    return new Blob(parts);
  }

  /**
   * PUTs one slice. `total` is null while the final size is unknown, which makes
   * the range open-ended (`/*`) and Drive answer 308 Resume Incomplete.
   */
  async _sendSlice(size, total) {
    const body = size > 0 ? this._takeBytes(size) : new Blob([]);
    try {
      return await this._putSlice(body, size, total);
    } catch (error) {
      // Put back whatever Drive has not acknowledged. A retry may have committed
      // part of the slice before failing, in which case only the tail returns.
      const remaining = error && error.driveRemaining ? error.driveRemaining : body;
      if (remaining.size > 0) {
        this._queue.unshift(remaining);
        this._queuedBytes += remaining.size;
      }
      throw error;
    }
  }

  /**
   * Asks Drive how much of the session it has actually committed. Returns the
   * parsed file resource when the upload is already complete, otherwise the
   * committed byte count.
   */
  async _queryStatus(total) {
    const token = await this._currentToken();
    const response = await fetch(this.sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes */${total === null ? '*' : total}`,
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 308) {
      // `Range: bytes=0-<lastByte>`; the header is absent when nothing landed.
      const range = response.headers.get('Range') || response.headers.get('range');
      const match = range && /bytes=0-(\d+)/.exec(range);
      return { committed: match ? Number(match[1]) + 1 : 0, file: null };
    }
    if (response.ok) {
      return { committed: null, file: await response.json() };
    }
    throw await driveError('Drive upload status query', response);
  }

  async _putSlice(body, size, total) {
    let pending = body;
    let start = this._uploadedBytes;

    let refreshed = false;
    let serverAttempt = 0;
    // After the first failure the server may hold bytes we already sent, so the
    // offset has to be re-derived from Drive rather than assumed.
    let resync = false;

    for (;;) {
      if (resync) {
        resync = false;
        let status;
        try {
          status = await this._queryStatus(total);
        } catch (queryError) {
          throw this._sliceFailure(queryError, pending);
        }
        if (status.file) {
          this._uploadedBytes = start + pending.size;
          this.onprogress(this._uploadedBytes);
          return status.file;
        }
        const committed = status.committed;
        const consumed = committed - start;
        if (consumed >= pending.size) {
          // The whole slice landed despite the error response.
          this._uploadedBytes = committed;
          this.onprogress(this._uploadedBytes);
          return null;
        }
        if (consumed > 0) {
          pending = pending.slice(consumed);
          start = committed;
          this._uploadedBytes = committed;
        }
      }

      const headers = {};
      if (pending.size === 0) {
        // Nothing left to send but the upload is complete — the status-query form
        // makes Drive close the session and return the file resource. With
        // total === 0 this yields the documented `bytes */0` empty-file form.
        headers['Content-Range'] = `bytes */${total === null ? '*' : total}`;
      } else {
        const end = start + pending.size - 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${total === null ? '*' : total}`;
      }

      const token = await this._currentToken();
      let response;
      try {
        response = await fetch(this.sessionUrl, {
          method: 'PUT',
          headers: { ...headers, Authorization: `Bearer ${token}` },
          body: pending
        });
      } catch (networkError) {
        if (serverAttempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[serverAttempt]);
          serverAttempt += 1;
          resync = true;
          continue;
        }
        throw this._sliceFailure(new Error(`Drive upload slice failed: ${networkError.message}`), pending);
      }

      // 308 = Resume Incomplete: the expected answer for every non-final slice.
      if (response.status === 308) {
        this._uploadedBytes = start + pending.size;
        this.onprogress(this._uploadedBytes);
        return null;
      }

      if (response.ok) {
        this._uploadedBytes = start + pending.size;
        this.onprogress(this._uploadedBytes);
        return await response.json();
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this._token = null;
        continue;
      }

      if (response.status >= 500 && serverAttempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[serverAttempt]);
        serverAttempt += 1;
        resync = true;
        continue;
      }

      throw this._sliceFailure(await driveError('Drive upload slice', response), pending);
    }
  }

  // Attaches the still-unacknowledged tail so _sendSlice re-queues exactly that.
  _sliceFailure(error, pending) {
    error.driveRemaining = pending;
    return error;
  }
}
