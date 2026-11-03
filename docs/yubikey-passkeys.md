# YubiKey passkey implementation status

This source candidate adds trusted PIN and account dialogs, using Chromium for
WebAuthn validation and USB/FIDO2 transport. It does not replace the installed
browser or include a patched Electron build.

The installed/declared Electron 44.10.0 cannot collect security-key PINs.
Electron PR https://github.com/electron/electron/pull/55426 at
48d0bdf9e591ea4d75ad93142f29cb15c2739ce4 proposes collect-webauthn-pin.
This candidate implements that proposed API. It must stay a draft until the API
and exact runtime artifact are reviewed and the hardware journey succeeds.
No dependency was added or upgraded. An upstream runtime containing the change,
or a separately reviewed build/backport, remains required.

Scope: a USB FIDO2 key with an existing PIN, top-level HTTPS requests in normal
and private browser tabs. This does not set/change/reset a key PIN, implement
phone pairing, or provide a software passkey store. All PIN checks, RP validation,
credential selection validation and signatures remain Chromium/authenticator work.

The browser derives the requester from Electron's frame, verifies it belongs to
the session and an owned browser window, and cancels on navigation, destruction,
crash, window close or timeout. Each isolated modal gets a fresh nonpersistent
session and a private transferred MessagePort; no PIN-handling ipcMain channel
or webview preload API is exposed. PINs are never logged or persisted. Incorrect
PINs consume device retries: there are no automatic retries, and the dialog shows
the native remaining-attempt count. The user explicitly submits each attempt.

Before release, test with the exact candidate runtime in a scratch browser profile:

1. Verify packaged native identity and that the proposed native event is present.
2. At news.web3, verify DANE trust and WebAuthn origin acceptance without TLS bypass.
3. Claim with the setup token and create the owner credential using PIN and touch.
4. Sign out, restart, then sign in with the same YubiKey.
5. Check cancellation, unplugging the key, tab navigation and stale prompt replies.
6. Check private-window isolation and that page/subframe IPC cannot answer a prompt.
7. Verify no PIN or credential secret appears in logs or renderer page contexts.

A real wrong-PIN hardware attempt is optional and requires explicit consent;
use the native virtual-key tests for retry/lockout behavior first. Never reset
the device or change its PIN as part of browser testing.

## Source validation (2026-11-03)

- `npm run lint`: passed.
- Focused prompt, preload, renderer, shared styling and changelog suites:
  6 suites / 95 tests passed (33 newly added tests).
- Full `npm test -- --runInBand`: 47 suites failed, 345 passed, 6 skipped;
  125 tests failed, 7,976 passed, 29 skipped. It is not a green full-suite result.
- The unchanged 56722f47 baseline with the same local dependency cache failed
  46 suites / 124 tests. The candidate's additional failing suite was
  `myotis-manager.test.js`, reporting missing temporary worker fixtures from
  another suite. All 93 tests in that suite passed in isolation on both trees.
  Exact-lock hosted CI is still required; local cache failures are not waived.
- The standalone dialog was visually checked in light and dark themes with
  simulated request metadata. This was a UI preview, not native WebAuthn,
  browser-origin verification, DANE verification or a hardware ceremony.
- No real PIN was entered or stored. Device inspection used only libfido2
  manifest/GetInfo queries; it confirmed FIDO2, resident keys and an existing
  PIN without creating a credential or changing the key.

The proposed native event does not notify JavaScript when a page aborts a
request. The dialog is closed on document lifecycle changes, response or its
bounded timer; immediate dismissal on a same-document AbortController abort
needs further native lifecycle support. Native callbacks use request lifetime
and prompt generation guards, but hardware/candidate acceptance must verify it.
