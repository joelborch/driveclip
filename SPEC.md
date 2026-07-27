# DriveClip — Build Spec (v1)

A minimal open-source Loom alternative: Chrome extension (MV3) that records a tab or
desktop/window with mic narration, streams the recording into the user's Google Drive
while recording, and yields a share link served by a static dashboard page that embeds
the Drive player.

This spec is the single source of truth for interfaces. Build agents own disjoint
files and MUST match the contracts here exactly. Vanilla JS only (ES2022), no
frameworks, no bundler, no build step. Chrome 116+ assumed.

## Repository layout

```
driveclip/
  SPEC.md
  README.md                    ← agent F
  docs/SETUP.md                ← agent F (Google Cloud OAuth client setup walkthrough)
  extension/
    manifest.json              ← agent A
    icons/icon{16,32,48,128}.png ← agent F
    popup/popup.html           ← agent A
    popup/popup.css            ← agent A
    popup/popup.js             ← agent A
    background/service-worker.js ← agent B
    offscreen/offscreen.html   ← agent C
    offscreen/offscreen.js     ← agent C
    lib/config.js              ← agent D
    lib/drive.js               ← agent D
  dashboard/
    index.html                 ← agent E  (landing page)
    v.html                     ← agent E  (viewer page, also copied to 404.html)
    404.html                   ← agent E  (SPA fallback = viewer)
    style.css                  ← agent E
```

## Global decisions

- **Working name:** DriveClip. MIT license intent (write all code from scratch; do
  not copy from GPL projects like Screenity).
- **OAuth:** `chrome.identity.getAuthToken` with manifest `oauth2` block.
  Client ID placeholder literal: `"YOUR_CLIENT_ID.apps.googleusercontent.com"`.
  Scope: exactly one — `https://www.googleapis.com/auth/drive.file`.
- **Folder model:** one Drive folder per user, created at onboarding, with an
  `anyone`/`reader` permission set on the folder once. Files inherit link-visibility.
- **Streaming upload:** MediaRecorder produces chunks every 3000 ms (`timeslice`).
  Chunks are appended to an in-memory queue and streamed into a Drive resumable
  upload session during recording in 256 KiB-multiple slices. On stop, the final
  slice is sent with the true total size. We do NOT patch WebM duration metadata in
  v1 — Drive's transcode provides seekable playback; document this in README.
- **Recording format:** `video/webm;codecs=vp9,opus` if
  `MediaRecorder.isTypeSupported` says so, else `video/webm;codecs=vp8,opus`, else
  `video/webm`. `videoBitsPerSecond: 8_000_000`.
- **Crash safety (v1):** chunks stay in the in-memory queue until their upload slice
  is acknowledged (2xx/308). No IndexedDB in v1.
- **Share link:** `SHARE_BASE + fileId` (see config.js). Fallback link (shown as
  secondary "Open in Drive"): `https://drive.google.com/file/d/<fileId>/view`.
- **Errors:** all user-visible errors flow to popup via state (below). Never
  `alert()`. Log details with `console.error`.

## lib/config.js  (agent D)

```js
export const SHARE_BASE = 'https://driveclip.pages.dev/v/'; // dashboard base URL
export const FOLDER_NAME = 'DriveClip Recordings';
export const APP_PROPERTY = { driveclip: 'root-folder' };    // marks our folder
export const TIMESLICE_MS = 3000;
export const UPLOAD_GRANULARITY = 256 * 1024;                // Drive chunk multiple
export const UPLOAD_SLICE_BYTES = UPLOAD_GRANULARITY * 16;   // 4 MiB per PUT
```

## Message protocol

All messages via `chrome.runtime.sendMessage` with shape
`{ type: string, target: 'background' | 'offscreen' | 'popup', payload?: object }`.
Every listener MUST ignore messages whose `target` isn't its own. Responses use
`sendResponse` (listeners `return true` when async).

### popup → background (`target:'background'`)
- `sign-in` `{}` → response `{ ok: true, folderId } | { ok: false, error }`.
  Interactive getAuthToken + `ensureRecordingsFolder`; stores `folderId`.
- `get-state` `{}` → response: the State object (below).
- `start-recording` `{ mode: 'tab'|'desktop', mic: boolean }` → response `{ ok }`.
- `stop-recording` `{}` → response `{ ok }` (forwarded to offscreen).
- `reset` `{}` → response `{ ok }` (clears a 'done'/'error' state back to 'idle').

### background → offscreen (`target:'offscreen'`)
- `offscreen-start` `{ mode, mic, streamId, token, folderId, fileName }` →
  response `{ ok } | { ok:false, error }`. `streamId` is non-null only for
  `mode:'tab'` (from `chrome.tabCapture.getMediaStreamId`).
- `offscreen-stop` `{}` → response `{ ok }`. Stops tracks + finalizes upload.

### offscreen → background (`target:'background'`)
- `recording-started` `{}`
- `upload-progress` `{ uploadedBytes, elapsedMs }`
- `recording-complete` `{ fileId, shareLink, driveLink }`
- `recording-error` `{ message }`
- `need-token` `{}` → response `{ token }` — background calls
  `getAuthToken({ interactive: false })` after removing the cached bad token with
  `chrome.identity.removeCachedAuthToken`.

### State object (owned by background, held in memory + mirrored to
`chrome.storage.session` key `state`)

```js
{
  status: 'idle'|'recording'|'uploading'|'done'|'error',
  startedAt: number|null,      // epoch ms when recording began
  uploadedBytes: number,
  fileId: string|null,
  shareLink: string|null,
  driveLink: string|null,
  error: string|null,
  onboarded: boolean           // folderId exists in chrome.storage.local
}
```

`status` meanings: `recording` from recording-started until stop requested;
`uploading` between stop and recording-complete; `done` shows link until `reset`
or next start.

## chrome.storage keys

- `chrome.storage.local`: `folderId: string`, `settings: { mode:'tab'|'desktop', mic: boolean }`
  (popup persists settings on change; defaults `{ mode:'tab', mic:true }`).
- `chrome.storage.session`: `state` (State object above).

## manifest.json (agent A)

- `manifest_version: 3`, name "DriveClip", version "0.1.0".
- Permissions: `offscreen`, `tabCapture`, `identity`, `storage`, `activeTab`,
  `clipboardWrite`.
- `host_permissions`: `https://www.googleapis.com/*`.
- `background.service_worker: "background/service-worker.js"`, `"type": "module"`.
- `action.default_popup: "popup/popup.html"`, default icons.
- `oauth2`: `{ client_id: "YOUR_CLIENT_ID.apps.googleusercontent.com", scopes: ["https://www.googleapis.com/auth/drive.file"] }`.
- `icons` map to `icons/icon*.png`.
- NO content scripts, NO web_accessible_resources.

## Popup (agent A)

Plain HTML/CSS/JS, dark theme, ~320 px wide. Views by state:

1. **Onboarding** (`!state.onboarded`): short pitch line + "Connect Google Drive"
   button → `sign-in`. Show spinner/error inline.
2. **Ready** (`idle`): segmented control Tab | Desktop, mic toggle (checkbox styled
   as switch), big Record button. Persist settings to storage on change.
3. **Recording** (`recording`): red dot + running timer (from `startedAt`), Stop
   button. Poll `get-state` every 1000 ms while open (popup may be reopened
   mid-recording; render from state, not local assumptions).
4. **Uploading** (`uploading`): spinner + "Finishing upload…" + uploadedBytes in MB.
5. **Done** (`done`): the share link in a readonly input, "Copy link" button
   (`navigator.clipboard.writeText`, flash "Copied"), secondary "Open in Drive"
   anchor (driveLink, `target="_blank"`), "New recording" button → `reset`.
6. **Error** (`error`): message + "Try again" → `reset`.

## Service worker (agent B)

ES module. Responsibilities:

- Message router per protocol above; maintains State; mirrors to storage.session.
- `sign-in`: `getAuthToken({interactive:true})` → `ensureRecordingsFolder(token)`
  from `lib/drive.js` → store folderId → `{ok:true, folderId}`.
- `start-recording`:
  1. Read folderId (error if missing), get fresh token (non-interactive).
  2. If `mode:'tab'`: `chrome.tabs.query({active:true, currentWindow:true})` →
     `chrome.tabCapture.getMediaStreamId({ targetTabId })`.
  3. Ensure offscreen document exists:
     `chrome.offscreen.createDocument({ url:'offscreen/offscreen.html', reasons:['USER_MEDIA','DISPLAY_MEDIA'], justification:'Screen recording and upload' })`
     — guard against "already exists" (use `chrome.runtime.getContexts`).
  4. Send `offscreen-start` with fileName `DriveClip <YYYY-MM-DD HH.mm>.webm`
     (local time).
  5. On ok: status→'recording', startedAt=now. Badge: text "REC", red background;
     clear badge when leaving recording/uploading.
- `stop-recording`: forward `offscreen-stop`; status→'uploading'.
- Handle offscreen events: update state; on `recording-complete` also
  close the offscreen document (`chrome.offscreen.closeDocument`) and clear badge;
  on `recording-error` set error state and close offscreen doc.
- `need-token`: removeCachedAuthToken(current) then getAuthToken non-interactive,
  respond `{token}`.
- On startup (`onStartup`/top-level), reset any stale non-idle state to idle
  (recording can't survive SW restart + offscreen teardown; keep it simple).

## Offscreen document (agent C)

`offscreen.html` loads `offscreen.js` as module. Responsibilities:

- On `offscreen-start`:
  - `mode:'tab'`: `navigator.mediaDevices.getUserMedia` with
    `{ audio: { mandatory: { chromeMediaSource:'tab', chromeMediaSourceId:streamId } }, video: { mandatory: { chromeMediaSource:'tab', chromeMediaSourceId:streamId } } }`.
  - `mode:'desktop'`: `navigator.mediaDevices.getDisplayMedia({ video:true, audio:true })`.
  - If `mic`: `getUserMedia({ audio:true })` separately; if mic acquisition fails,
    continue without mic but include a console.warn (do not abort the recording).
  - **Audio graph (AudioContext):** display/tab audio source → destination node AND
    → `audioContext.destination` (so tab-capture audio stays audible to the user);
    mic source → destination node only. Recorded stream = video track + destination
    node's audio track. Handle streams with no audio track (desktop share without
    audio) gracefully — record video-only or mic-only-audio as available.
  - Create Drive resumable session via `lib/drive.js` (name=fileName, mimeType
    'video/webm', parent folderId), then start MediaRecorder with TIMESLICE_MS.
  - `ondataavailable` → push blob into the uploader queue (drive.js
    ChunkedUploader) which uploads UPLOAD_SLICE_BYTES-aligned slices sequentially
    (one in-flight PUT at a time), reporting `upload-progress` (throttle: at most
    one message per slice).
  - Send `recording-started` once recorder starts.
  - If the user ends the share via Chrome's native UI (video track `onended`),
    treat as stop.
- On `offscreen-stop` (or track-ended): `recorder.stop()`, await final
  `ondataavailable`, stop all tracks, close AudioContext, flush the queue with
  final Content-Range including total size, read `id` from the Drive completion
  response, then send `recording-complete` with
  `shareLink = SHARE_BASE + fileId`, `driveLink = https://drive.google.com/file/d/<id>/view`.
- On upload 401: message `need-token`, retry the failed slice once with new token.
- Any fatal error → `recording-error` + full local cleanup.

## lib/drive.js (agent D)

ES module, no deps. All functions take `token` explicitly; no chrome.* calls except
none at all (pure fetch) — token refresh is the CALLER's job via a
`getFreshToken: async () => string` callback passed into ChunkedUploader.

```js
export async function ensureRecordingsFolder(token)
// 1. files.list q: appProperties has key 'driveclip' value 'root-folder',
//    trashed=false, spaces='drive' → return existing id if found.
// 2. else files.create {name: FOLDER_NAME, mimeType:'application/vnd.google-apps.folder',
//    appProperties:{driveclip:'root-folder'}}
// 3. permissions.create on folder {type:'anyone', role:'reader'} — idempotent enough;
//    only on newly created folder.
// returns folderId. Throws Error with readable message on failure.

export async function createResumableSession(token, { name, mimeType, folderId })
// POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable
// body { name, mimeType, parents:[folderId] } → returns Location header URL.

export class ChunkedUploader {
  constructor({ sessionUrl, getFreshToken })   // note: resumable session PUTs
  append(blob)                                  // add MediaRecorder chunk
  async drain()                                 // upload all complete slices (serialized)
  async finalize()                              // upload remainder w/ total size; returns {fileId}
  get uploadedBytes()
  onprogress = (uploadedBytes) => {}            // assignable callback
}
// Slice rules: PUT sessionUrl, headers Content-Range: bytes start-end/* (or /total
// on final). Non-final slices MUST be multiples of UPLOAD_GRANULARITY. Expect 308
// (Resume Incomplete) for non-final, 200/201 with JSON {id} for final. On 401 call
// getFreshToken() once and retry slice. On 5xx retry with 1s/2s/4s backoff (3 tries).
// Auth header on every PUT: Authorization: Bearer <token>.
```

Note: resumable-session PUTs technically don't require the Authorization header,
include it anyway — harmless and future-proof.

## Dashboard (agent E)

Static site for Cloudflare Pages, no build step, no JS frameworks, dark theme.

- **Viewer** (`v.html`, copied verbatim to `404.html` — CF Pages serves 404.html for
  unknown paths like `/v/<FILE_ID>`): JS parses `location.pathname` for
  `/v/<id>` (id = `[A-Za-z0-9_-]{10,}`); if absent, checks `?id=` param. Renders a
  centered, responsive 16:9 `<iframe src="https://drive.google.com/file/d/<ID>/preview" allow="autoplay; fullscreen" allowfullscreen>`.
  Header: small DriveClip wordmark. Under the player: "Copy link" button and
  "Open in Drive" link. Invalid/missing id → friendly "Recording not found" card.
  Escape/validate the id strictly (regex above) before templating into the iframe URL.
- **Landing** (`index.html`): one-screen explanation of DriveClip + GitHub link
  placeholder + install note. Shares style.css.
- README section (agent F) documents: deploy by pointing Cloudflare Pages at
  `dashboard/` with no build command; then set SHARE_BASE in lib/config.js.

## README.md + docs/SETUP.md + icons (agent F)

- README: what it is, features, architecture sketch (popup / SW / offscreen /
  drive.js / dashboard), install-unpacked steps, dashboard deploy, known
  limitations (WebM duration metadata unpatched — Drive playback is fine after
  transcode; Drive per-file traffic throttling; recording dies if Chrome closes),
  license MIT, "not affiliated with Google/Loom".
- docs/SETUP.md: step-by-step Google Cloud setup — create project, enable Drive
  API, OAuth consent screen (External, Testing mode, add self as test user),
  create OAuth client id of type **Chrome Extension** with the extension ID,
  where to find the extension ID (load unpacked first), paste client_id into
  manifest.json. Mention: keys stay in manifest; drive.file is a sensitive scope,
  verification only needed for public distribution.
- Icons: generate real PNGs (16/32/48/128) — simple rounded red square with white
  record dot is fine. Generate via any locally available tool (Python/Pillow,
  ImageMagick, or hand-write a tiny PNG via script). No external downloads.

## Addendum: microphone permission onboarding (post-review)

Offscreen documents cannot show permission prompts, so mic capture only works once
the extension origin has a persistent mic grant. Therefore:

- New page `extension/permissions/mic.html` + `mic.js`: opened in a normal tab;
  on a button click calls `getUserMedia({audio:true})`, immediately stops tracks,
  shows success ("You can close this tab") or a denial explanation with a link to
  chrome's site-settings for the extension origin.
- Popup: in onboarding AND in the ready view (when the mic toggle is on), check
  `navigator.permissions.query({ name: 'microphone' })`; if state !== 'granted',
  show an inline "Enable microphone" affordance that opens the page via
  `chrome.tabs.create`. Recording is not blocked — it's a warning, not a gate.
- No message-protocol changes.

## Coding standards (all agents)

- Vanilla JS ES modules, `const`/`let`, async/await, no semicolonless style.
- Comments only where Chrome API quirks demand explanation (tab-audio re-routing,
  308 handling, offscreen singleton guard).
- No TODOs for spec'd behavior; no placeholder logic besides the OAuth client id
  and SHARE_BASE.
- Files outside your ownership: read freely, never write.
