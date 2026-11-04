# YubiKey passkey implementation status

This source candidate adds trusted PIN and account dialogs, using Chromium for
WebAuthn validation and USB/FIDO2 transport. It does not replace the installed
browser or include a patched Electron build.

Account selection uses the existing `select-webauthn-account` event and works
on official Electron 44.10.0. PIN collection requires additional native support:
the declared Electron 44.10.0 cannot collect security-key PINs.
Electron PR https://github.com/electron/electron/pull/55426 at
48d0bdf9e591ea4d75ad93142f29cb15c2739ce4 proposes collect-webauthn-pin.
This candidate implements that proposed API. It must stay a draft until the API
and exact runtime artifact are reviewed and the PIN-based hardware journey succeeds.
No dependency was added or upgraded. An upstream runtime containing the change,
or a separately reviewed build/backport, remains required.

Scope: a USB FIDO2 key with an existing PIN, top-level HTTPS requests in normal
and private browser tabs. This does not set/change/reset a key PIN, implement
phone pairing, or provide a software passkey store. All PIN checks, RP validation,
credential selection validation and signatures remain Chromium/authenticator work.

The browser derives the requester from Electron's frame, verifies it belongs to
the session and an owned browser window, and cancels on a new main-frame document, destruction,
crash, window close or timeout. Subframe navigations and same-document history
changes retain the prompt, while frame identity and origin are rechecked on reply.
The isolated modals share one nonpersistent trusted-UI session and each receives
a separate private transferred MessagePort; no PIN-handling ipcMain channel
or webview preload API is exposed. PINs are never logged or persisted. Incorrect
PINs consume device retries: there are no automatic retries, and the dialog shows
the native remaining-attempt count. The user explicitly submits each attempt.

Before release, test with the exact candidate runtime in a scratch browser profile:

1. Verify packaged native identity and that the proposed native event is present.
2. At news.web3, verify DANE trust and WebAuthn origin acceptance without TLS bypass.
3. Open `https://news.web3/_hnsblog/claim`, claim with the setup token, and
   create the owner credential using PIN and touch. The HNS Blog template and
   deployment copy already implement this route; it is independent of OAuth.
4. Sign out, restart, then sign in with the same YubiKey.
5. Check cancellation, unplugging the key, tab navigation and stale prompt replies.
6. Check private-window isolation and that page/subframe IPC cannot answer a prompt.
7. Verify no PIN or credential secret appears in logs or renderer page contexts.

A real wrong-PIN hardware attempt is optional and requires explicit consent;
use the native virtual-key tests for retry/lockout behavior first. Never reset
the device or change its PIN as part of browser testing.

## Current validation (2026-11-03)

The exact-lock hosted full-suite job on initial PR head `2b92f5dd` passed:
385 suites / 9,076 tests (36 skipped), followed by its separate dependency
contracts run. All application/build/smoke checks passed. Overall CI remained
red because dependency-audit reported `exception_expired_or_clock_before_approval`;
that exception has not been renewed or bypassed by this feature branch.
These results describe that head; the revised head must run CI again.

A real account-picker smoke test also passed on official Electron 44.10.0.
The release ZIP was checked against its published SHASUMS256.txt (SHA256
`62df9375ef035f2835a18cd7f9bff1959a185da22f2ecba1daa37cd9caee1dc5`).
`scripts/webauthn-account-smoke.js` uses a scratch profile, loopback-only TLS
fixture and two virtual resident credentials. It exercises the real native
frame/session binding, dialog preload, private MessagePort and account response.
It checks that the requested credential is returned, subframe reload and
pushState keep the chooser open, and a main-frame reload cancels it. The TLS
fixture is accepted only for localhost in the scratch session. This is not
HNS/DANE trust, PIN entry or physical YubiKey acceptance.

Run it with the declared official runtime (no installed-browser replacement):

```sh
/path/to/electron --no-sandbox --headless --ozone-platform=headless scripts/webauthn-account-smoke.js
```

Initial local cache results, retained for comparison:

- `npm run lint`: passed.
- Focused prompt, preload, renderer, shared styling and changelog suites:
  6 suites / 105 tests passed after the navigation/session/copy review fixes
  (43 added tests across the three feature suites).
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

## Native CI timeout follow-up

At head `85660e90` the existing six native suites passed, but the new smoke test
hit its outer 30-second deadline in CI. Stage-only diagnostic head `c22cf65f` then
passed the same native job. That pass does not establish the original cause.
The follow-up probe observes the native `did-start-navigation` events directly
instead of awaiting a DOM iframe-load Promise while the parent has a modal.
It passes locally; restoring the old blanket navigation cancellation makes it
fail at `child-navigated`. New-head CI is still required.
