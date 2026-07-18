# Pirate Resync Integration Map

Baseline: upstream `main` at `bc831cec1570f018720a27c592956e3f043c745d` (Freedom `0.8.1-dev`).

This note records the integration boundaries to use while re-porting Pirate features. It does not change upstream module ownership: protocol and lifecycle logic remains in the main process, renderer code remains UI, and IPC contracts remain in `src/shared/`.

## Profiles and lifecycle

- Upstream uses one Electron process and one `app.getPath('userData')` root per active profile. Module-level managers and the service registry are therefore process-local and naturally profile-scoped.
- Put managed HNS state under `getProfileUserDataDir()/hns-data` via `src/main/profile-paths.js`; do not use the repository-root development directory used by the legacy fork.
- HNS and dVPN settings belong to the active profile. JackTrip additionally needs a machine-wide lock because audio hardware is shared across profile processes.
- Profile node configuration is persisted through `src/main/profile-resolver.js`; ordinary profile settings remain owned by `src/main/settings-store.js`. Do not add cross-process mutable state to the profile catalog.

## Service registry and Nodes UI

- `src/main/service-registry.js` is the endpoint/status authority. Its modes are `BUNDLED`, `REUSED`, `EXTERNAL`, `DISABLED`, and the internal unset state `NONE`.
- Extend the registry with an `hns` entry and accessors rather than keeping the fork's parallel registry shape. HNS lifecycle updates should use `updateService`, status-message helpers, and `clearService`, then expose the state through the existing registry IPC broadcast.
- Add the HNS toggle/status presentation beside Ant, native IPFS, and Radicle in the existing Nodes UI. Preserve the distinction between managed, external/shared, disabled, and not-yet-initialized states.
- Spaces is a stateless resolver and does not need a long-lived registry entry unless the UI later exposes health/status.

## Request and protocol routing

- Electron permits one `webRequest` listener per event. Register HNS/PAC consumers with `src/main/webrequest-dispatcher.js`; never attach a competing listener directly.
- `installRequestRewriter()` registers before `attachWebRequestDispatcher(session.defaultSession)` in `src/main/index.js`. Preserve this ordering.
- Upstream `bzz:`, `ipfs:`, and `ipns:` are privileged custom schemes owned by their protocol handlers. HNS HTTPS routing should not alter those origins or route them through legacy gateway rewriting.
- Re-derive the legacy PAC/HNS behavior against the dispatcher and current `request-rewriter.js`. Keep host admission fail-closed and retain the current log-redaction conventions.
- Treat the local HNS proxy certificate verifier as an explicit boundary: document which local CA/fingerprint is trusted, which host class may enter the proxy, and how rotation works.

## Internal pages

- `src/shared/internal-pages.json` is the canonical allowlist and route map. Add `space-browser.html` and `live-room.html` there in the appropriate `routable` or `other` category.
- All recognized `freedom://<page>` routes are singleton tabs through `openInNewTabWithTarget` / `openOrFocusInternalPage` in `src/renderer/lib/tabs.js`; no separate singleton mechanism is needed.
- Page-specific privileged APIs must be guarded in `webview-preload.js` using the canonical internal-page map, following the existing settings/profile page guards.

## Bundled binaries and cross-builds

- Extend `scripts/check-binaries.js` for HNS, dVPN, and JackTrip artifacts using its selected target platform/architecture, not the host platform.
- Extend `package.json` `extraResources` with target-aware binary directories. Keep native IPFS's `.node` staging and Ant's Bee-compatible identity/wire contract unchanged.
- Download scripts must pin versions, validate checksums, and stage the exact layout consumed by `check-binaries.js`. The Fingertip canary patch belongs in this download/staging path and needs a post-patch validation check.
- Validate first with `npm run build -- --linux --x64`; distribution packaging uses `npm run dist -- --linux --x64`. Other targets follow the same `scripts/build.js` `--target` parsing.

## Slice verification anchors

- Security: preload exposure inventory plus focused preload, webview-preload, wallet, and dapp-provider tests.
- HNS: cold-start readiness, `.pirate` navigation, disabled-node failure, and two concurrently active profiles.
- Spaces: normal WebPKI only; resolver failure must fail closed.
- Live rooms: cross-process lock plus real Linux audio routing.
- dVPN: verify PAC changes affect only the active profile process's session.
