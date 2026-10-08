# Upload Session

A local-first Manifest V3 Chrome/Edge extension for temporary file sessions across tabs. **Upload Session** is the neutral working title; the repository remains **TabStash**.

Create a named session, add files, link the tabs involved in your task, and attach a selected file to a compatible native upload field. You review and submit the website's form. End the session or close its last linked tab to delete its temporary files. **Keep** moves an individual file into a separate local store that session cleanup cannot delete.

No product server, account, analytics, cloud sync, remote scripts, or automatic form submission. Runtime files are plain HTML, CSS, and JavaScript in `extension/`; there is no build step and no runtime npm dependency.

## Load the unpacked extension

The complete MVP is on **`docs/mvp-guide`**. Every implementation branch is chained from the previous branch; none were merged. Because this repository was initially empty, GitHub automatically designated the first pushed branch, `feature/attachment-proof`, as its default. That branch contains only the initial proof. Select `docs/mvp-guide` when cloning or browsing the complete app; the default-branch setting has not been changed.

```sh
git clone --branch docs/mvp-guide https://github.com/sarseej-shrestha/TabStash.git
cd TabStash
```

For this existing checkout, the extension directory is:

```text
/Users/userselu/Downloads/TabStash/extension
```

**Chrome (desktop, 116+; use a current stable release):**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the **`extension` subdirectory**, which contains `manifest.json`.
4. Open the Extensions puzzle menu and pin **Upload Session**.
5. Visit a normal HTTP(S) page and click the Upload Session toolbar icon. Its side panel opens and the click grants temporary access to that tab.

**Microsoft Edge (current desktop release):**

1. Open `edge://extensions`.
2. Enable **Developer mode** in the left sidebar.
3. Click **Load unpacked** and select the same **`extension` subdirectory**.
4. Open the Extensions menu and choose **Show in toolbar** for Upload Session.
5. Visit a normal HTTP(S) page and click its toolbar icon to open the sidebar and grant temporary tab access.

No npm command is needed to load the extension. After editing runtime files, click **Reload** on the extension's card, then reopen the panel. Reloading clears temporary sessions; kept files survive. Removing the extension deletes its local storage, including kept files.

## Use a session

1. On a tab for your task, enter a name and click **Create**. The session starts linked to that tab. Each tab belongs to at most one session; use another tab to create another session.
2. Use **Add files from your device**, or right-click a direct HTTP(S) download link and choose **Add link to Upload Session**. Select a session, review the displayed origin, and click **Allow origin & save to session**. Accept the browser prompt if you want that download. Declining leaves the normal picker available.
3. On another task tab, click the toolbar icon, select the same session, and click **Link current tab**. Repeat for more tabs, including tabs in another browser window.
4. Select a temporary or kept file, click **Find upload fields**, choose the field, and acknowledge that you trust the page. Click **Attach selected file**. Review the form and click its own Submit button yourself.
5. If attachment is unsupported or rejected, click **Save copy**, then select that disk copy with the website's normal file picker. The website's picker is never intercepted or disabled.
6. Click **Keep** on files you want to retain. They move out of Temporary files and into Kept files. End the session when finished, or close all its linked tabs. Kept files remain until explicitly deleted.

## Privacy and compatibility boundaries

**A website can read a file immediately after it is selected or attached.** The extension never submits forms or dispatches input/change events, but arbitrary website code can poll a field or upload on selection. It is not possible to guarantee that every website waits for Submit. Use trusted forms that submit manually. This limitation also applies to the website's normal file picker. The MVP does not attempt to intercept or block website traffic.

- Attachment supports native `input[type=file]` elements belonging to forms in the top-level document. It uses a temporary `activeTab` grant, an isolated script, and the exact scanned document and field. It refuses occupied, disabled, directory, stale, and accept-incompatible fields. Selecting a file does not notify JavaScript upload widgets; use their own picker if they do not recognize it.
- Iframes, shadow DOM, custom/drop-zone uploaders, browser settings pages, web stores, local `file:` pages, and directory uploads are unsupported. Multiple files can be stored, but attachment selects one file at a time and never overwrites an existing field selection.
- Direct download capture supports public HTTP(S) GET URLs without redirects. It omits cookies and credentials, sends no referrer, rejects HTML pages, and times out after 25 seconds. Login-dependent links, JavaScript downloads, POST flows, redirects, `blob:`/`data:` URLs, and expiring links may require downloading normally and using Add files. Captured pending links expire from the UI after ten minutes and are removed when dismissed, successfully downloaded, or at the next browser-run cleanup.
- Limits: **20 MiB per file, 100 MiB of temporary files per session**. Browser storage quotas still apply to kept files. Keep is local retention, not a backup or encrypted vault.
- Closing the last linked tab or explicitly ending a session removes its temporary Blobs and metadata in one IndexedDB transaction. Kept files live in a separate object store.
- Browser restart, extension reload/update, or disable/re-enable clears **all** previous temporary sessions on the next worker initialization. Restored browser tabs do not restore temporary files. Worker suspension alone does not clear active sessions. Missed tab-close events are reconciled when the worker wakes or the panel refreshes.
- Cleanup affects extension storage only. It cannot erase files already assigned to a page, copies saved to Downloads, files uploaded to a website, or OS/browser backups. Clear the website's field or close the page to release attached copies. Deletion is logical removal, not forensic secure erasure. If the browser crashes, cleanup runs when the extension next starts.

## Permissions

| Permission | Purpose and fallback |
| --- | --- |
| `sidePanel` | Hosts the session UI in the browser side panel. |
| `activeTab` | Temporary access after a toolbar/context-menu gesture. Click the icon on each destination tab. Navigation can revoke access; click again or use the website's picker. |
| `scripting` | Scans native fields and attaches the selected file on request, in the granted tab only. No always-running content script. |
| `contextMenus` | Adds the direct-link capture action. The normal file picker works independently. |
| `storage` | Uses `chrome.storage.session` for the browser-run marker. File contents and session data are in IndexedDB, never `storage.sync`. |
| Optional HTTP(S) origins | The manifest declares eligible schemes, but requests only the individual download origin after a click. Access is released after the attempt and recovered on worker startup if interrupted. Browser host grants are origin/site-level, not URL-path restrictions. Decline and use Add files; **Release download site access** is also available. |

There is no required website host access, `<all_urls>` grant, `tabs` permission, `downloads` permission, `cookies` access, `webRequest`, or `unlimitedStorage`. Without access, linked tabs may display an ID instead of a page title.

## Verification and local test form

Use Node.js 22+ for developer checks:

```sh
npm ci
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

The browser test uses an isolated temporary browser profile, a loopback-only fixture server, and a disposable extension copy with access to that fixture origin. It does not broaden the shipped manifest. It verifies file bytes, UI actions, attachment guards, no automatic submission, real tab-close events, and browser restart cleanup. Screenshots are written under ignored `artifacts/`. Browser-native permission prompts, toolbar gestures, context menus, and Edge still require the manual checks below. To use an existing compatible Chromium executable, set `CHROMIUM_PATH` to its absolute path.

For manual testing, run this in the repository root (no npm dependencies required):

```sh
npm run fixture
```

Open **`http://127.0.0.1:8787`** in Chrome or Edge. This local development server exists only for testing; it is not part of the extension. Stop it with Ctrl+C afterward.

1. Open the extension with its toolbar icon, create **Application**, and rename it **Application test**. Confirm the current tab appears under Linked tabs.
2. Right-click **Download sample.txt** → **Add link to Upload Session**. Review the origin and click **Allow origin & save to session**. First **decline** the permission prompt: confirm a fallback message and that the device picker still works. If the origin is already granted or the browser skips that prompt, use **Download sample.txt from another origin** under Manual fallback checks. Repeat and **allow**. Confirm `sample.txt` appears under Temporary files. Inspect the extension's site access to confirm the grant was released.
3. Click the link normally to save a local copy. Add that file with the device picker. Select a file and use **Save copy**; verify its contents match. This copy is intentionally outside cleanup.
4. Open `http://127.0.0.1:8787/second` in a second tab. Click the extension toolbar icon there, select Application test, and click **Link current tab**. Confirm two linked tabs.
5. Select `sample.txt`, click **Find upload fields**, choose **Document**, check the trust acknowledgement, and click **Attach selected file**. Confirm the website's input lists the file and the page has **not** navigated to `/submit`.
6. Click the website's **Submit myself** button. The response should include `Upload Session local attachment proof.` in the multipart body. This fixture echoes data only to your browser.
7. Keep one stored file and leave another temporary. Close one linked tab: temporary files must remain. Close the last linked tab, open another normal page and the panel: the session and temporary files must be gone, while the kept file remains.
8. Create another session, add a temporary file, and click **End session**. Test Cancel first, then Confirm. Confirm temporary deletion and kept-file survival. Delete a kept file explicitly and confirm it disappears.
9. Create a session with one temporary and one kept file. Fully **quit** the browser (on macOS use Cmd+Q), restart it, and open the panel. The previous temporary session must be gone; the kept file must remain. A browser running in the background has not fully restarted. Extension Reload is another cleanup boundary.
10. Test a browser settings page or custom/embedded uploader: attachment must fail with picker guidance. Test a filled field: its existing selection must remain unchanged. Scan a form, navigate away, and try attaching: it must require a fresh scan.
11. Right-click each of the fixture's **Redirected download**, **Oversized download**, and **HTML page instead of a file** links and try capturing them. Expect redirect, size, or HTML rejection. No file should be stored. Repeat the core workflow in Edge.

See [verification results](docs/QA.md), [feasibility and platform limits](docs/FEASIBILITY.md), and [architecture](docs/ARCHITECTURE.md).

## Reviewable branch chain

| Branch | Completed commit |
| --- | --- |
| `feature/attachment-proof` | `8b6798174c7b8047ab13a1ad0f51689fffdc3519` |
| `feature/session-storage` | `fb0cfa129d875d68faeda8af45e0b6d2df6a832d` |
| `feature/session-lifecycle` | `6088f262e1f19c2be7daf785697dc1cc7a7d033a` |
| `feature/file-transfer` | `206d1d2b54dfbaf24c6018e0d82a21c47d09f521` |
| `feature/session-panel` | `f0105c3e2e0db9cae5459ba3b991ece7b3b9655b` |
| `test/session-safety` | `019e3deb2b4970b48d54ae2238d7fe51fb887e1c` |
| `fix/download-resource-cleanup` | `fc5daf0de47147e08154341ef8869ec81ce86eb7` |
| `docs/mvp-guide` | Complete MVP and handoff; current branch |

All commits use Sarseej Shrestha and the existing verified GitHub email, configured only in this repository. Nothing has been merged or published to an extension store.
