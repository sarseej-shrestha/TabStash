# Attachment feasibility

Verified on 2026-10-08 with Chrome for Testing (local Playwright Chromium build 1234) using `scripts/browser-check.mjs`.

The test fetches a direct HTTP download from a loopback server in an extension page, writes its Blob to IndexedDB, reads it back, and compares the bytes. It serializes the bytes through `chrome.scripting.executeScript`, constructs a File and DataTransfer in the isolated world, and assigns the FileList to a native upload input. The server receives no form submission until the test explicitly clicks the form's Submit button; the resulting multipart body contains the original bytes.

The automated test uses a disposable extension copy with access only to the loopback fixture. Browser permission dialogs and toolbar-based activeTab grants require manual checks. No such host access is present in the shipped manifest.

Native file inputs are feasible. This does not establish compatibility with JavaScript uploaders, frames, shadow DOM, authenticated downloads, redirect chains, or restricted browser pages. Assignment deliberately does not dispatch input/change events: some widgets need those events, but they can also trigger automatic uploads.

There is an unavoidable boundary: after assignment, the website can read the File immediately, exactly as after a normal file selection. An extension cannot guarantee that arbitrary site code waits for the user's Submit click. Upload Session never submits forms, dispatches synthetic change/input events, or sends file bytes to a remote endpoint itself. Use only trusted, manual-submit forms; use the website's normal picker for unsupported pages. Ending a session deletes the extension's stored copy, not any File already assigned to a page or any copy submitted to a website.
