# MVP verification

Date: 2026-10-08. Platform: macOS arm64, Node.js 23.10.0. Browser: Chrome for Testing **151.0.7922.34** (installed Playwright Chromium build 1234). Test library: Playwright 1.61.1.

## Automated results

| Check | Result |
| --- | --- |
| `npm test` | 17/17 unit tests passed |
| `npm run check` | JavaScript syntax, MV3 manifest, permission constraints, and basic unsafe-pattern checks passed |
| `npm run test:browser` with the installed Chromium path | All integration assertions passed |
| `git diff --check` | Passed |
| npm install audit | 0 known vulnerabilities reported during installation |
| Panel screenshots | Captured and inspected at 390 px; narrow 320 px layout also checked for horizontal overflow |

The browser command used on this machine was:

```sh
CHROMIUM_PATH='/Users/userselu/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' node scripts/browser-check.mjs
```

Unit coverage includes last-tab cleanup, multi-tab linking, exclusive tab ownership, kept-file survival and deletion, independent sessions, post-cleanup download completion, add/end races, Keep/end races, tab replacement, stale-tab reconciliation, browser-run cleanup versus worker suspension, pending-URL cleanup, naming, byte limits, safe request flags, filename handling, and cancellation of rejected response bodies.

Browser integration covers:

1. Session creation/rename, ordinary picker import, Keep, and a byte-checked Save copy download through the panel UI.
2. Missing-origin permission failure, rejected redirects/HTML/oversized responses, and a successful direct link saved byte-for-byte to actual IndexedDB through the production download handler.
3. The production attachment message flow, stale-document rejection, linked-session checks, disabled-fieldset exclusion, accepted-type and occupied-field checks, zero input/change events, and zero submissions before an explicit test click on the native Submit button. Multipart output contains the original file bytes.
4. Responsive panel layout and screenshots at 390 and 320 px.
5. Real browser tab-close events preserving a session until its last linked tab closes, then deleting temporary data and preserving kept files.
6. A full browser-process restart clearing seeded stale temporary data and pending-link metadata while retaining kept files, with no uncaught panel errors.

## Limits of this verification

The extension UI is opened as a normal extension page in headless tests. A disposable manifest copy receives **only the local test origin** as an install-time host permission, because native browser permission prompts are not approved by this automation. This does not change the shipped manifest. Pending context-menu links are seeded into the same local queue to exercise the production download code.

The actual browser side-panel surface, toolbar-granted `activeTab`, right-click menu, grant/decline prompts, revocation UI, authenticated real-world sites, and Microsoft Edge have **not** been manually verified here. Edge is not installed in this environment. Follow the Chrome/Edge manual checklist in the README. This is an unpacked MVP, not an extension-store or universal website compatibility certification.

The extension never invokes submit or dispatches synthetic field events. It cannot prevent website scripts from reading or sending a file after attachment. The interface and README explain this limitation; the fixture verifies a native manual-submit form only.
