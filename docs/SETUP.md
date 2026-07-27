# Google Cloud setup

DriveClip talks to the Drive API as *you*, using a Chrome Extension OAuth client that you
own. There's no DriveClip backend and no shared client id, so you have to spend about ten
minutes in the Google Cloud console once. This walks through it.

There's a chicken-and-egg step in the middle: the OAuth client is bound to your
extension's id, and the extension id only exists after you load the extension once. So the
order is **load unpacked → copy the id → create the client → paste the client id back →
reload**.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Click the project picker in the top bar, then **New project**.
3. Name it something like `DriveClip`, leave the organization/location defaults, and click
   **Create**.
4. Make sure the picker now shows your new project before continuing — every step below
   applies to the selected project.

## 2. Enable the Google Drive API

1. Navigate to **APIs & Services → Library**.
2. Search for **Google Drive API** and open it.
3. Click **Enable**. (Nothing else needs enabling — DriveClip only calls Drive v3.)

## 3. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** as the user type and click **Create**. Internal is only available
   if you're on Google Workspace and want to restrict the app to your own domain, which
   also works fine.
3. Fill in the required fields: app name (`DriveClip`), user support email (yours), and
   developer contact email (yours). Everything else can stay empty.
4. On the **Scopes** step, click **Add or remove scopes** and add
   `https://www.googleapis.com/auth/drive.file`. That's the only scope the extension uses,
   and it's deliberately the narrow one: it grants access exclusively to files and folders
   your app created, not to the rest of your Drive.
5. On the **Test users** step, click **Add users** and add your own Google account. In
   Testing mode only listed test users can sign in, so if you skip this you'll get
   "access blocked" when you try to connect.
6. Save and go back to the dashboard. Leave the publishing status as **Testing**.

## 4. Load the extension to get its id

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` directory from this repo.
4. DriveClip appears in the list with an **ID** underneath the name — a 32-character
   lowercase string like `abcdefghijklmnopabcdefghijklmnop`. Copy it.

The extension will load and the popup will render even though the client id is still a
placeholder; only the "Connect Google Drive" button will fail until you finish the next
two steps.

> **Keep this id stable.** An unpacked extension's id is derived from the absolute path of
> its directory, so moving or renaming the folder gives you a new id and breaks the OAuth
> client. Pick the final location before you do step 5.

## 5. Create the OAuth client id

1. Back in the Cloud console, go to **APIs & Services → Credentials**.
2. Click **Create credentials → OAuth client ID**.
3. Set **Application type** to **Chrome Extension**.
4. Give it a name (`DriveClip extension`) and paste the extension id from step 4 into the
   **Item ID** field.
5. Click **Create**. Copy the generated client id — it looks like
   `123456789012-abc123def456.apps.googleusercontent.com`.

If **Chrome Extension** isn't in the application-type list, your console is showing the
older Credentials UI; choose **Chrome App** instead, which is the same thing under its
previous name.

## 6. Paste the client id into the manifest

Open `extension/manifest.json` and replace the placeholder in the `oauth2` block:

```json
"oauth2": {
  "client_id": "123456789012-abc123def456.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

Then go back to `chrome://extensions` and click the **reload** icon on the DriveClip card.
Manifest changes are not picked up without a reload.

## 7. Connect and verify

1. Open the DriveClip popup and click **Connect Google Drive**.
2. Approve the consent screen. You'll see an "unverified app" interstitial — click
   **Advanced → Go to DriveClip (unsafe)**. That warning is expected for an app in Testing
   mode and is about Google's verification status, not about anything being wrong.
3. On success the popup switches to the record view, and a folder named
   **DriveClip Recordings** now exists at the root of your Drive with link-sharing
   (`anyone with the link → viewer`) enabled on the folder itself.

Record a five-second clip to confirm the whole path works end to end.

## Troubleshooting

**"Error: bad client id" or `OAuth2 request failed`** — the extension id in the Cloud
console doesn't match the id in `chrome://extensions`. This almost always means the
extension folder moved after step 4. Re-copy the id and edit the OAuth client's Item ID.

**"Access blocked: DriveClip has not completed the Google verification process"** — your
Google account isn't in the test-users list from step 3.5. Add it and try again.

**Consent succeeds but the folder isn't created** — check that the Drive API from step 2
is actually enabled *in the same project* that owns the OAuth client.

**Nothing happens when you click Connect** — open the service worker console from the
DriveClip card in `chrome://extensions` (**Inspect views: service worker**) and read the
error there. Every failure is logged with `console.error`.

## Notes on keys and verification

The client id lives in `manifest.json` in plain text, and that's intentional and safe.
Chrome Extension OAuth clients are public clients — there is no client secret to leak, and
the id is bound to your specific extension id, so it can't be used by anyone else's
extension. Do not add a client secret; the flow doesn't use one.

`drive.file` is classified by Google as a **sensitive scope**. In Testing mode you can use
it immediately with up to 100 test users, tokens just expire every seven days and the
extension re-prompts. Verification is only required if you want to publish DriveClip
publicly so that arbitrary users can install it; for personal or team use, staying in
Testing mode indefinitely is a legitimate and common choice. If you do go through
verification, `drive.file` is the easiest sensitive scope to justify precisely because it
can only reach files your own app created.
