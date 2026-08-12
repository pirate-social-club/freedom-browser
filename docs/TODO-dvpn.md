# dVPN Runtime Validation — Remaining Tasks

> Extracted from `dvpn-runtime-handoff.md`.
>
> Platform status for `0.7.12`: Sentinel dVPN is supported on Linux x64 only.
> Other release targets disable the runtime and controls through the shared
> platform capability manifest.

The task is done when ALL of these are true:

- [x] `getV2RayPath()` dev-mode paths are correct — no stale `js-sdk/bin` reference, includes repo-local `dvpn-bin/` path
- [x] `dvpn-bin/linux-x64/v2ray` exists and is executable
- [x] `dvpn-bin/linux-x64/geoip.dat` and `geosite.dat` exist
- [ ] Freedom launches cleanly with the current local SDK dependency
- [ ] User can create a dVPN wallet from settings
- [ ] User can fund and see balance from settings
- [ ] User can connect/disconnect dVPN from settings
- [ ] Ordinary web traffic routes through dVPN when connected (verified via ipify)
- [ ] HNS allowlisted roots and `.pirate` browsing still work with dVPN on (verified via `pirate/` and `app.pirate/` in same session)
- [ ] Loopback and local services bypass proxy correctly
- [ ] Low-balance auto-disconnect works
- [ ] Max-duration auto-disconnect works
- [ ] Quit-while-connected triggers disconnect (or persists REMOTE_PENDING)
- [ ] Relaunch after crash reconciles stale session state
- [x] `dvpn-manager.test.js` exists and passes
- [x] `network-manager.test.js` exists and passes
- [x] `npm run lint` passes
- [x] `npm test` passes
- [x] Packaged build would find V2Ray under `process.resourcesPath/dvpn-bin/`
