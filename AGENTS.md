# AGENTS.md — machine-followable runbook for DriveClip

You are an AI coding agent setting up, modifying, or debugging DriveClip. Everything you
need is in this file, [README.md](README.md) (architecture), [SPEC.md](SPEC.md) (message
contracts), [DESIGN.md](DESIGN.md) (visual system), and [docs/SETUP.md](docs/SETUP.md)
(Google Cloud walkthrough). Trust these files over your priors; the Chrome extension
APIs here have sharp edges that are already accounted for.

## Repo map

| Path | What it is | Owned invariants |
|---|---|---|
| `extension/manifest.json` | MV3 manifest | `key` pins the extension id; `oauth2.client_id` is per-deployment |
| `extension/popup/` | All UI. Stateless renderer of the worker's `State` object | ids/classes are load-bearing (see below) |
| `extension/background/service-worker.js` | State machine, OAuth, offscreen lifecycle | resets stale state only when no offscreen document is alive |
| `extension/offscreen/` | Capture, WebAudio mix graph, MediaRecorder, upload pump | the ONLY place media APIs may be called |
| `extension/lib/drive.js` | Pure-fetch Drive v3 client + ChunkedUploader | no `chrome.*` calls, ever |
| `extension/lib/config.js` | Constants incl. `SHARE_BASE` | `SHARE_BASE` ends with `/v/` |
| `extension/permissions/mic.html` | One-time mic grant page (offscreen docs cannot prompt) | opened via `chrome.tabs.create` |
| `dashboard/` | Static share site, no build step | `404.html` byte-identical to `v.html`; asset links root-absolute |
| `extension.pem` (untracked) | Private key for the pinned id | NEVER commit; gitignored |

## Setup runbook (fresh clone → working extension)

Follow docs/SETUP.md for the human-facing walkthrough. Condensed agent version:

1. **Google Cloud** (needs the user's browser; you cannot do OAuth consent for them):
   create a project, enable "Google Drive API", configure the OAuth consent screen
   (External + Testing, add the user as test user), register scope
   `https://www.googleapis.com/auth/drive.file`, create an OAuth client of type
   **Chrome Extension** with item id = the extension's id.
2. The extension id is stable across machines because `manifest.json` pins a public
   `key`. If the user forked and wants their own identity: generate a keypair, replace
   `key`, recompute the id (`SHA-256 of DER SPKI public key, first 16 bytes, hex mapped
   a–p`), and use that id in the OAuth client.
3. Paste the client id into `extension/manifest.json` → `oauth2.client_id`.
4. Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
5. Acceptance: popup opens → "Connect Google Drive" completes → a "DriveClip Recordings"
   folder exists in Drive with anyone-with-link viewer permission → a 5-second tab
   recording produces a share link whose page plays after Drive finishes processing.

## Dashboard deploy runbook

```
wrangler pages deploy dashboard --project-name <project> --branch main
```

- After ANY edit to `dashboard/v.html`: `cp dashboard/v.html dashboard/404.html` before
  deploying, then verify `cmp dashboard/v.html dashboard/404.html`.
- `dashboard/_headers` carries `X-Robots-Tag: noindex, nofollow` for `/*` and a 5-minute
  `Cache-Control` for `/style.css`. Do not remove either. If a style change doesn't
  appear on a custom domain, the zone cache is holding it — purge the file or wait out
  the TTL.
- Update `SHARE_BASE` in `extension/lib/config.js` if the domain changes, then reload
  the extension.

## Verification commands

```
node --check extension/background/service-worker.js
node --check extension/offscreen/offscreen.js
node --check extension/popup/popup.js
node --check extension/lib/drive.js
cmp dashboard/v.html dashboard/404.html
```

There is no test suite yet; `drive.js` is deliberately chrome-free so a stubbed-fetch
smoke test is the natural first one to add.

## Load-bearing contracts (break these and the app silently dies)

- **Message protocol** — exact shapes in SPEC.md. Every message is
  `{ type, target: 'background'|'offscreen'|'popup', payload }`; listeners ignore other
  targets; async handlers `return true`.
- **Popup DOM hooks** — `popup.js` looks up these ids at load:
  `view-{onboarding,ready,recording,uploading,done,error}`, `btn-{signin,record,stop,copy,new,retry}`,
  `signin-status`, `signin-error`, `mic-toggle`, `record-label`, `ready-error`, `timer`,
  `uploaded-bytes`, `share-link`, `drive-link`, `error-message`,
  `mic-notice-{onboarding,ready}`, plus `.seg[data-mode]` buttons and
  `[data-mic-enable]` buttons. Views are toggled via the `hidden` attribute.
- **Viewer id rule** — file ids must match `^[A-Za-z0-9_-]{10,}$` and be inserted with
  DOM APIs only (no HTML string templating).
- **Drive upload math** — non-final slices must be multiples of 256 KiB; expect `308`
  for non-final and `200/201 {id}` for final; on `5xx`/network failure, status-query
  with `Content-Range: bytes */<total|*>` and resume from the acknowledged offset
  (already implemented in `ChunkedUploader` — don't simplify it away).

## Sharp edges already handled (do not "fix" these into bugs)

- MV3 service workers die after ~30s idle. The offscreen document outlives them; the
  worker must NOT reset state or close the offscreen doc on wake if one is alive.
- `getDisplayMedia` cannot be called in an offscreen document (no user activation).
  Desktop capture goes through `chrome.desktopCapture.chooseDesktopMedia` in the worker,
  and the stream id is consumed with `chromeMediaSource: 'desktop'` constraints.
- Tab capture mutes the tab; the offscreen doc re-routes tab audio to
  `audioContext.destination` in tab mode only (doing it in desktop mode causes echo).
- `AudioContext` may start suspended in an offscreen doc; it is resumed before recording
  (a suspended context records pure silence).
- Mic permission cannot be prompted from an offscreen document —
  `extension/permissions/mic.html` exists solely to obtain the persistent grant.
- WebM duration metadata is intentionally not patched (streaming upload makes it
  impossible); Drive's transcode provides seekability. Not a bug.
- `chrome.identity` tokens are evicted via `chrome.storage.session`-persisted handles so
  a worker restart doesn't break the 401-refresh path.

## Style

Vanilla JS (ES modules), no frameworks, no build step, Chrome 116+. UI follows
DESIGN.md (light, Linear-inspired; red = recording only). Comments only where a Chrome
API quirk demands explanation. Sentence case in all UI copy.
