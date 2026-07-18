# Electron 43 bridge and dApp boundary audit

Baseline: upstream `076e0d8`, audited on `resync/0.8` against Pirate hardening
commits `4f13e2e` and `a41b979`.

## Trust boundaries

- The main chrome window is a trusted local renderer with broad IPC bridges.
  It must remain sandboxed and must never navigate or open a popup.
- Every browsing webview is hostile content. Its preload path and security
  preferences are fixed by main at attachment time, regardless of attributes
  supplied by the renderer.
- `freedomAPI` is callable only by allowlisted local internal pages. Upstream's
  protocol/path guards and automatic subscription cleanup satisfy this rule.
- Wallet connection approval in the renderer is a UX boundary, not an
  authorization boundary. Main must independently match the permission key and
  wallet index before any transaction or signature can reach private-key code.

## Findings and disposition

1. **Fixed: privileged chrome navigation.** The Electron 43 window retained
   `contextIsolation` and disabled Node integration, but did not explicitly
   enable the sandbox or deny top-level navigation/popups. The port now does
   all three.
2. **Fixed: renderer-controlled webview preferences.** There was no
   `will-attach-webview` policy. Main now pins the audited preload and forces
   sandbox, context isolation, Node isolation, web security, and mixed-content
   rejection.
3. **Fixed: main-process dApp authorization.** Upstream checked permissions in
   the chrome renderer, but its transaction and signing handlers accepted a
   caller-selected wallet index. Main now rejects transactions and signatures
   unless the persisted permission key maps to that wallet index.
4. **Superseded: `dapp-permission-key.js`.** Upstream now has mirrored,
   tested `origin-utils.js` modules with support for `.eth`, `.box`, `.wei`,
   `.gwei`, IPFS/IPNS/Swarm roots, and Radicle IDs. Reintroducing the old module
   would create a second security-critical normalization implementation.
5. **Deferred to the HNS slice: `browser-state-sanitizer.js`.** Its unknown
   single-label classification imports Pirate's HNS host registry and its
   startup cleanup exists to prevent stale HNS request replay. Port it with the
   HNS registry and startup readiness wiring in Phase 3, not as an incomplete
   HNS-free copy here.

## Verification

- Focused Jest coverage exercises webview preference pinning, wallet permission
  matching, preload wrappers, and existing origin normalization.
- Focused ESLint and `git diff --check` pass for all touched runtime and test
  files.

