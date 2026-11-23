import { SHARE_BASE, TIMESLICE_MS } from '../lib/config.js';
import { uploadRecording } from '../lib/drive.js';
import { createRecordingWriter, readPendingRecording, deletePendingRecording } from '../lib/recording-store.js';

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
let session = null;
let uploading = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;

  if (message.type === 'offscreen-start') {
    const incumbent = session;
    start(message.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[DriveClip] start failed', err);
        if (session && session !== incumbent) teardown(session, true);
        sendResponse({ ok: false, error: readableError(err) });
      });
    return true;
  }

  if (message.type === 'offscreen-stop') {
    stop();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'offscreen-retry-upload') {
    retryPendingUpload(message.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: readableError(err) }));
    return true;
  }

  if (message.type === 'offscreen-discard-recording') {
    deletePendingRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: readableError(err) }));
    return true;
  }
});

function computeVideoBitrate(videoTrack) {
  const s = videoTrack?.getSettings?.();
  const pixels = (s?.width || 1920) * (s?.height || 1080);
  return Math.max(8_000_000, Math.min(25_000_000, Math.round((pixels / (1920 * 1080)) * 10_000_000)));
}

async function start(payload) {
  if (session || uploading) throw new Error('A recording or upload is already in progress');
  const { mode, mic, streamId, captureSize, token, folderId, fileName } = payload;
  if (mode !== 'tab' && mode !== 'desktop') throw new Error(`Unknown capture mode: ${mode}`);
  if (!streamId || !token || !folderId) throw new Error('Missing recording start parameters');

  const s = {
    mode, folderId, fileName, token,
    captureStream: null, micStream: null, audioContext: null, recorder: null, recordedStream: null,
    writer: null, stopping: false, finished: false, onStopped: null
  };
  session = s;

  s.captureStream = await capture(mode, streamId, captureSize);
  if (s !== session) throw new Error('Recording was cancelled');

  if (mic) {
    try {
      s.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 }
      });
    } catch (err) {
      console.warn('[DriveClip] microphone unavailable, recording without it', err);
    }
  }

  s.recordedStream = await buildRecordedStream(s);
  if (s !== session) throw new Error('Recording was cancelled');

  // Stream chunks straight to disk-backed OPFS instead of buffering in RAM.
  s.writer = await createRecordingWriter();
  if (s !== session) { await s.writer.abort(); throw new Error('Recording was cancelled'); }

  const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  const recorder = new MediaRecorder(s.recordedStream, {
    mimeType,
    videoBitsPerSecond: computeVideoBitrate(s.recordedStream.getVideoTracks()[0]),
    audioBitsPerSecond: 192_000
  });
  s.recorder = recorder;
  recorder.ondataavailable = (e) => {
    if (e.data?.size) s.writer.append(e.data).catch((err) => fail(s, err, false));
  };
  recorder.onerror = (e) => fail(s, e.error || new Error('MediaRecorder error'), false);
  recorder.onstop = () => { if (s.onStopped) s.onStopped(); };

  // Chrome's built-in "Stop sharing" button ends the video track directly.
  for (const track of s.captureStream.getTracks()) {
    track.addEventListener('ended', () => { if (track.kind === 'video') stop(); });
  }

  recorder.start(TIMESLICE_MS);
  notify('recording-started', {});
}

async function capture(mode, streamId, captureSize) {
  const hasFloor = Boolean(captureSize?.minWidth && captureSize?.minHeight);
  const video = (withFloor) => {
    const mandatory = { chromeMediaSource: mode, chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 };
    if (withFloor && hasFloor) {
      mandatory.minWidth = Math.min(captureSize.minWidth, 3840);
      mandatory.minHeight = Math.min(captureSize.minHeight, 2160);
    }
    return { mandatory };
  };
  if (mode === 'tab') {
    const audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
    try { return await navigator.mediaDevices.getUserMedia({ audio, video: video(true) }); }
    catch (err) {
      if (!hasFloor) throw err;
      return navigator.mediaDevices.getUserMedia({ audio, video: video(false) });
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
      video: video(false)
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: video(false) });
  }
}

async function buildRecordedStream(s) {
  const tracks = [];
  const videoTrack = s.captureStream.getVideoTracks()[0];
  if (videoTrack) {
    if ('contentHint' in videoTrack) videoTrack.contentHint = 'detail';
    tracks.push(videoTrack);
  }
  const captureAudio = s.captureStream.getAudioTracks();
  const micAudio = s.micStream ? s.micStream.getAudioTracks() : [];

  if (captureAudio.length || micAudio.length) {
    const audioContext = new AudioContext();
    s.audioContext = audioContext;
    if (audioContext.state === 'suspended') await audioContext.resume().catch(() => {});
    if (audioContext.state !== 'running') throw new Error('Audio could not be started (audio context is suspended)');
    const mixed = audioContext.createMediaStreamDestination();
    if (captureAudio.length) {
      const src = audioContext.createMediaStreamSource(new MediaStream(captureAudio));
      src.connect(mixed);
      // Tab capture mutes the tab; route back to speakers in tab mode only (desktop would echo).
      if (s.mode === 'tab') src.connect(audioContext.destination);
    }
    if (micAudio.length) {
      audioContext.createMediaStreamSource(new MediaStream(micAudio)).connect(mixed);
    }
    tracks.push(mixed.stream.getAudioTracks()[0]);
  }
  if (!tracks.length) throw new Error('Capture produced no audio or video tracks');
  return new MediaStream(tracks);
}

function stop() {
  const s = session;
  if (!s || s.stopping) return;
  s.stopping = true;
  finish(s).catch((err) => fail(s, err, false));
}

async function finish(s) {
  if (s.recorder && s.recorder.state !== 'inactive') {
    await new Promise((resolve) => { s.onStopped = resolve; s.recorder.stop(); });
  }
  stopTracks(s);
  await closeAudio(s);
  await s.writer.close();
  if (s.finished) return;

  const file = await readPendingRecording();
  if (!file) throw new Error('No video data was captured.');

  const { fileName, folderId, token } = s;
  s.finished = true;
  if (session === s) session = null;

  await notifyAsync('recording-saved', { fileName, folderId, totalBytes: file.size });
  await performUpload({ file, fileName, folderId, sessionUrl: null, token });
}

async function retryPendingUpload({ token, folderId, fileName, sessionUrl = null }) {
  if (session || uploading) throw new Error('A recording or upload is already in progress');
  const file = await readPendingRecording();
  if (!file) throw new Error('Saved recording could not be found on disk.');
  // Run asynchronously after acknowledging retry start so the worker isn't blocked.
  performUpload({ file, fileName, folderId, sessionUrl, token }).catch(() => {});
}

async function performUpload({ file, fileName, folderId, sessionUrl, token }) {
  uploading = true;
  let currentToken = token;
  let lastSessionUrl = sessionUrl;
  let lastUploaded = 0;

  try {
    // Report 0 bytes uploaded at start (never report file.size before Drive acknowledges bytes).
    notify('upload-progress', { uploadedBytes: 0, totalBytes: file.size });

    const { fileId } = await uploadRecording({
      blob: file,
      name: fileName,
      mimeType: 'video/webm',
      folderId,
      sessionUrl,
      getFreshToken: async (forceRefresh) => {
        if (!forceRefresh && currentToken) return currentToken;
        const res = await chrome.runtime.sendMessage({ type: 'need-token', target: 'background' });
        if (!res?.token) throw new Error('Could not refresh the Google access token');
        currentToken = res.token;
        return currentToken;
      },
      onSession: (url) => {
        lastSessionUrl = url;
        notify('upload-session', { sessionUrl: url });
      },
      onProgress: (uploadedBytes) => {
        lastUploaded = uploadedBytes;
        notify('upload-progress', { uploadedBytes, totalBytes: file.size });
      }
    });

    // Only delete the disk-backed recording after Drive confirms the upload succeeded.
    await deletePendingRecording();
    notify('recording-complete', {
      fileId,
      shareLink: SHARE_BASE + fileId,
      driveLink: `https://drive.google.com/file/d/${fileId}/view`
    });
  } catch (err) {
    console.error('[DriveClip] upload failed (recording kept on disk)', err);
    notify('recording-error', {
      message: readableError(err),
      hasPendingRecording: true,
      fileName,
      sessionUrl: err?.sessionExpired ? null : (err?.sessionUrl || lastSessionUrl),
      uploadedBytes: Number.isFinite(err?.uploadedBytes) ? err.uploadedBytes : lastUploaded,
      totalBytes: file.size
    });
  } finally {
    uploading = false;
  }
}

function fail(s, err, abortFile) {
  if (s.finished) return;
  s.finished = true;
  console.error('[DriveClip] recording failed', err);
  teardown(s, abortFile);
  notify('recording-error', { message: readableError(err), hasPendingRecording: false });
}

function teardown(s = session, abortFile = false) {
  if (!s) return;
  try { if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop(); } catch {}
  stopTracks(s);
  closeAudio(s);
  if (abortFile && s.writer) s.writer.abort().catch(() => {});
  if (session === s) session = null;
}

function stopTracks(s) {
  for (const stream of [s.captureStream, s.micStream, s.recordedStream]) {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
}

async function closeAudio(s) {
  const ctx = s.audioContext;
  s.audioContext = null;
  if (ctx) await ctx.close().catch(() => {});
}

function notify(type, payload) {
  chrome.runtime.sendMessage({ type, target: 'background', payload }).catch(() => {});
}

async function notifyAsync(type, payload) {
  await chrome.runtime.sendMessage({ type, target: 'background', payload }).catch(() => {});
}

function readableError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'NotAllowedError') return 'Screen capture permission was denied';
  if (err.name === 'NotFoundError') return 'No capture source was available';
  return err.message || String(err);
}
