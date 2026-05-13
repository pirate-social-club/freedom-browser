# dVPN Runtime Validation — Remaining Tasks

> Extracted from `dvpn-runtime-handoff.md`.

The task is done when ALL of these are true:

- [ ] `getV2RayPath()` dev-mode paths are correct — no stale `js-sdk/bin` reference, includes repo-local `dvpn-bin/` path
- [ ] `dvpn-bin/linux-x64/v2ray` exists and is executable
- [ ] `dvpn-bin/linux-x64/geoip.dat` and `geosite.dat` exist
- [ ] Freedom launches cleanly with the current local SDK dependency
- [ ] User can create a dVPN wallet from settings
- [ ] User can fund and see balance from settings
- [ ] User can connect/disconnect dVPN from settings
- [ ] Ordinary web traffic routes through dVPN when connected (verified via ipify)
- [ ] HNS single-label browsing still works with dVPN on (verified via shakestation/ in same session)
- [ ] Loopback and local services bypass proxy correctly
- [ ] Low-balance auto-disconnect works
- [ ] Max-duration auto-disconnect works
- [ ] Quit-while-connected triggers disconnect (or persists REMOTE_PENDING)
- [ ] Relaunch after crash reconciles stale session state
- [ ] `dvpn-manager.test.js` exists and passes
- [ ] `network-manager.test.js` exists and passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] Packaged build would find V2Ray under `process.resourcesPath/dvpn-bin/`
