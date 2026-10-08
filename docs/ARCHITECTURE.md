# Architecture

`extension/` is the complete unpacked extension. No build output or test dependency is loaded at runtime.

- `background.js`: MV3 service-worker events, initialization barrier, panel-only message routing, context-menu capture, tab lifecycle, scoped network downloads, and requested script execution. It accepts messages only from this extension's exact panel URL; there is no external messaging or content-script bridge.
- `storage.js`: IndexedDB schema and atomic operations. Stores: `sessions` (names and tab IDs), `files` (temporary Blobs indexed by session), `keptFiles` (Blobs with no session owner), `meta` (pending links). No URLs or Blob bytes appear in snapshot messages except pending-link URLs explicitly requested by the panel.
- `lifecycle.js`: browser-run detection with `chrome.storage.session`; clears temporary data before allowing operations on a new run. Reconciles live tab IDs when initialized.
- `download.js`: validates the chosen direct URL, uses credentialless GET, refuses redirects, enforces streamed and declared size limits, cancels rejected bodies, and derives safe display/download names.
- `attach.js`: scans only top-level native file fields with a form, stores random target tokens in the isolated world, checks document/field identity and compatibility, and assigns a constructed FileList. No synthetic events or form submission. File bytes are base64 serialized for Chrome's JSON-based script arguments; the 20 MiB file limit bounds memory and IPC size.
- `panel.*`: local interface, ordinary file picker, explicit trust acknowledgement, Blob export with a revoked object URL, and asynchronous dialogs. Untrusted filenames, URLs, and labels are rendered with textContent, never innerHTML.

## Transactions and races

Keep atomically copies the record into `keptFiles` and deletes it from `files`. Ending a session atomically deletes its temporary records and session metadata; it does not transact over `keptFiles`. Concurrent IndexedDB transactions with overlapping stores serialize. If Keep wins, the file survives; if cleanup wins, Keep reports that the file is gone. A download that finishes after its session ends cannot save because `addFile` checks that the session exists inside its write transaction.

Tab linking is idempotent and exclusive: a tab can belong to one session, while each session can have multiple tabs. Closing one linked tab removes only that link. Removing the last link deletes the session. Tab replacement transfers the link. Sessions cannot be created with zero linked tabs. Creation/linking rechecks the live-tab set to cover a close that occurs during the operation.

The run marker survives worker suspension but is cleared by browser restart/reload. Startup first deletes all temporary session data, then writes a new marker. A failed deletion cannot mark initialization as successful. The panel waits for initialization before opening its own IndexedDB connection for local file imports. Kept-file storage is never part of startup deletion.

## Access and data flow

A context-menu gesture stores one pending link per browser window and opens the side panel; it does not start a download. The panel explains the origin and requests that origin's optional permission synchronously from the user's save click. The worker checks the pending-link ID, expiration, and permission before downloading. Both worker and panel attempt to release the grant, with startup recovery and a manual release button. One download executes in the worker at a time. Pending URLs can contain query tokens, are local-only, and are cleared on the next run.

Files stay in extension-origin IndexedDB until explicit selection and attachment/export. Attachment requires a linked destination tab, temporary access from a toolbar gesture, a scanned document ID, a still-connected field token, and a stored file belonging to the current session or kept collection. Content-script injection stays in the isolated world, top frame only. There are no remote scripts or public web-accessible resources.

The normal device picker imports a file into the extension. **Save copy** exports to a normal user download without the downloads permission, allowing the website's independent file picker to be used. Neither operation can remove the original file or any exported disk copy.

## Platform references

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome runtime optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome scripting and document targeting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Microsoft Edge sidebar extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar)
