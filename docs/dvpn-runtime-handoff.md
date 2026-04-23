# dVPN Runtime Validation — Handoff Document

## Summary

Freedom-browser has a complete dVPN integration implementation. The SDK packaging bug that blocked runtime is fixed locally and an upstream PR is open. The remaining work is: (1) fix the stale V2Ray path resolution in `getV2RayPath()`, (2) get the V2Ray binary on disk and prove the runtime actually works end-to-end, (3) package the V2Ray binary for dev and packaged modes, (4) add automated tests for the two new managers.

Runtime is currently blocked by both path resolution AND binary absence — fixing paths first means the SDK setup.js output becomes immediately usable.

---

## Repos and Ownership

| Repo | Path | Role |
|---|---|---|
| freedom-browser | `/home/t42/Documents/pirate-workspace/freedom-browser` | Main work target |
| blue-ai-connect | `/home/t42/Documents/blue-ai-connect` | SDK — only if a new blocker forces it |

Do not touch pirate-api, pirate-web, pirate-tui, or pirate-contracts for this task.

---

## What Is Done

- `dvpn-manager.js` wraps the SDK (wallet, balance, connect, disconnect, lifecycle, state persistence)
- `network-manager.js` owns composed PAC / `session.setProxy()`
- `settings-store.js` has `showDvpnControls`, `dvpnMaxSpendP2P`, `dvpnLowBalanceStop`, `dvpnMaxDurationMinutes`
- `settings-ui.js` has full dVPN section (wallet, QR, copy, balance, connect/disconnect, budget fields)
- `preload.js` exposes `window.dvpn` with `start`, `stop`, `getStatus`, `onStatusUpdate`, `getBalance`, `createWallet`, `getWalletAddress`
- `ipc-channels.js` defines all dVPN IPC channels
- `service-registry.js` tracks dVPN state
- `index.js` bootstraps dVPN (`initDvpn`, `registerDvpnIpc`, `stopDvpn` in before-quit)
- `package.json` has `sentinel-ai-connect` as `file:../../blue-ai-connect` (local dep)
- `package.json` build config has `dvpn-bin/${os}-${arch}` in extraResources (both mac and linux)
- `settings-ui.test.js` covers the settings payload including dVPN fields
- blue-ai-connect packaging PR: https://github.com/Sentinel-Autonomybuilder/blue-ai-connect/pull/1

## What Is NOT Done

1. **`dvpn-manager.js:getV2RayPath()` line 303 has stale dev-mode paths** — checks `node_modules/sentinel-ai-connect/js-sdk/bin/v2ray` which no longer exists after the SDK import fix. The code will fail even after the V2Ray binary is on disk unless this function is fixed first. This is the first fix to make.
2. **V2Ray binary is not on disk** — `dvpn-bin/` directory does not exist, no v2ray binary anywhere. Even after running the SDK's setup.js, `getV2RayPath()` won't find it unless the function is fixed (see #1). Runtime is blocked by both path resolution AND binary absence — fixing paths first means setup.js output becomes immediately usable.
3. **No runtime test has been done** — the connect/disconnect flow has never been run in the browser
4. **No dvpn-manager.test.js** exists
5. **No network-manager.test.js** exists

---

## Files To Read First

Read these in order before making any changes:

| File | Why |
|---|---|
| `src/main/dvpn-manager.js` | Core dVPN logic — wallet, connect, disconnect, lifecycle |
| `src/main/network-manager.js` | PAC composition, proxy management |
| `src/main/hns-manager.js` | Reference pattern for binary resolution (getHelperBinaryPath, getHnsdBinaryPath) |
| `src/main/index.js` | Bootstrap sequence, before-quit cleanup |
| `src/main/preload.js` | window.dvpn IPC bridge |
| `src/main/settings-store.js` | Settings defaults and persistence |
| `src/main/service-registry.js` | dVPN state in registry |
| `src/shared/ipc-channels.js` | All dVPN IPC channel names |
| `src/renderer/lib/settings-ui.js` | dVPN UI rendering and event wiring |
| `src/renderer/index.html` | DOM element IDs for dVPN controls |
| `package.json` | Dependency on sentinel-ai-connect, build config for dvpn-bin |
| `AGENTS.md` | Mandatory constraints (lint, test, no comments, no deleted files, etc.) |

SDK reference (read-only):
- `/home/t42/Documents/blue-ai-connect/connect.js` — connect flow
- `/home/t42/Documents/blue-ai-connect/environment.js` — setup/preflight
- `/home/t42/Documents/blue-ai-connect/pricing.js` — cost estimation

---

## Priority 1: Prove Runtime Actually Works

### Step 1: Get V2Ray Available for Dev Mode

The SDK has a setup script that downloads V2Ray. Run it:

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
node node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/setup.js
```

This downloads V2Ray v5.2.1 to `node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/`.

After running, verify the full asset set — V2Ray runtime needs all three files:

```bash
ls -la node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/v2ray
ls -la node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/geoip.dat
ls -la node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/geosite.dat
```

All three must exist. If geoip.dat or geosite.dat are missing, V2Ray will start but fail to route correctly. Expected behavior: `connect()` should fail with a clear surfaced error in settings UI, not hang or silently misroute. If you see a connection that succeeds but traffic doesn't flow, check for missing .dat files first.

### Step 2: Fix getV2RayPath()

**This is the first code change to make.** `dvpn-manager.js:295-313` — the dev-mode search paths are wrong. Currently:

```js
const devPaths = [
  path.join(__dirname, '..', '..', 'node_modules', 'sentinel-ai-connect', 'bin', binary),
  path.join(__dirname, '..', '..', 'node_modules', 'sentinel-ai-connect', 'js-sdk', 'bin', binary),
];
```

The `js-sdk/bin` path is from before the SDK packaging fix. The actual V2Ray binary lives at:

```
node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/v2ray
```

Fix `getV2RayPath()` to search these dev-mode paths in order:

1. `dvpn-bin/${platform}-${arch}/${binary}` — repo-local binary, mirrors the HNS pattern (see `hns-manager.js:56-71`). This path is what packaging will use and what dev mode should prefer once you populate it.
2. `node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/{binary}` — SDK's bundled binary after running setup.js (immediate fallback before dvpn-bin is populated)
3. `node_modules/sentinel-dvpn-sdk/bin/{binary}` — if the SDK is installed at top level (unlikely but harmless)
4. Keep the packaged path: `process.resourcesPath/dvpn-bin/{binary}` — this is already correct and does NOT need changing

### Step 3: Verify SDK Import Chain

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
node -e "import('sentinel-ai-connect').then(m => console.log('OK:', Object.keys(m).length, 'exports')).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK: 20 exports`

If this fails, the local `file:../../blue-ai-connect` dependency is broken — fix before proceeding.

### Step 4: Launch Freedom and Run the Real User Flow

Start the browser:

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
npm start
```

Then execute this test sequence manually:

| Step | Action | Expected |
|---|---|---|
| 1 | Open Settings (gear icon or menu) | Settings modal opens |
| 2 | Check "Show private browsing controls" | dVPN section becomes visible |
| 3 | Click "Create Wallet" | Wallet address appears, QR renders |
| 4 | Click copy button next to address | Address copied to clipboard |
| 5 | Click refresh balance | Balance shows (probably 0 if unfunded) |
| 6 | Fund the wallet externally (use another device to send DVPN tokens to the address) | — |
| 7 | Click refresh balance again | Balance updates, funded=true |
| 8 | Click Connect | Status changes to "Connecting..." then "Connected" |
| 9 | Browse to https://api.ipify.org | Shows VPN IP (not your real IP) |
| 10 | Browse to a shakestation/ URL (e.g. `nameweb.shakestation/`) | Still resolves via HNS proxy — proves composed PAC works, not just SOCKS5 |
| 11 | Browse to http://127.0.0.1:1633 | Still DIRECT (loopback bypass) |
| 12 | Check Bee/IPFS/Radicle services still work | No regression |
| 13 | Click Disconnect | Status returns to "Stopped — user" |
| 14 | Browse to https://api.ipify.org | Shows your real IP again — proves PAC rebuild on disconnect removed SOCKS5 |
| 15 | Browse to a shakestation/ URL | Still resolves via HNS proxy — proves PAC rebuild preserved HNS routing after dVPN disconnect |

### Step 5: Classify Any Failures Precisely

If runtime fails, identify the exact failure category:

| Failure Category | Diagnostic |
|---|---|
| SDK import failure | `node -e "import('sentinel-ai-connect')..."` fails or Electron can't load ESM |
| V2Ray binary missing | `getV2RayPath()` returns null, settings shows "V2Ray binary not found" |
| Wallet/balance issue | `createWallet` or `getBalance` throws, check Electron console logs |
| PAC composition issue | Traffic doesn't route through SOCKS5 but V2Ray is running — check `buildPacScript()` output |
| HNS regression | HNS single-label names stop resolving when dVPN is on — PAC ordering bug |
| Disconnect lifecycle | After disconnect, IP doesn't return to normal — `clearDvpnProxy` not called or `rebuild()` failed |

For each failure, check the Electron main process console for `[dVPN]` and `[Network]` log lines.

---

## Priority 2: Package V2Ray Properly

### Current State

- `package.json` already has `dvpn-bin/${os}-${arch}` in extraResources for both mac and linux targets
- But `dvpn-bin/` directory does not exist
- No V2Ray binary is bundled in the repo

### How HNS Does It (Reference Pattern)

See `hns-manager.js:56-71` (`getHelperBinaryPath`):

```js
function getHelperBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'hns-bin', binName);
  }
  return path.join(__dirname, '..', '..', 'hns-bin', `${platform}-${process.arch}`, binName);
}
```

The `hns-bin/linux-x64/fingertipd` binary exists in the repo. Packaged builds copy it to `resources/hns-bin/`. Dev mode reads directly from the repo tree.

### What To Build

1. **Create `dvpn-bin/linux-x64/`** (Linux is the dev machine)
2. **Run the SDK's `setup.js`** to download V2Ray for the current platform
3. **Copy the V2Ray assets** (v2ray, geoip.dat, geosite.dat — all three required) to `dvpn-bin/linux-x64/`
4. **Make the binary executable**: `chmod +x dvpn-bin/linux-x64/v2ray`
5. **Update `getV2RayPath()`** dev mode to also check `dvpn-bin/${platform}-${arch}/${binary}` — this mirrors the HNS pattern exactly
6. **For macOS**: create `dvpn-bin/mac-arm64/` (or `mac-x64`) with the same files when testing on macOS

### Acceptance Criteria

- `dvpn-bin/linux-x64/v2ray` exists and is executable
- `dvpn-bin/linux-x64/geoip.dat` and `geosite.dat` exist
- Dev mode: `getV2RayPath()` finds the binary
- Packaged mode: `getV2RayPath()` finds the binary under `process.resourcesPath/dvpn-bin/`
- Missing binary produces clear error in settings UI ("V2Ray binary not found. Reinstall Freedom.")
- No first-run download — all binaries are bundled

### V2Ray Version

The SDK uses V2Ray v5.2.1 (defined in `sentinel-dvpn-sdk/defaults.js`). Use the same version. The SDK's `setup.js` has SHA256 checksums for verification.

### Decision Point: Linux-Only for First Pass?

Yes. The dev machine is Linux. Ship Linux first, add macOS when someone tests on it. The `dvpn-bin/mac-arm64/` directory can be empty initially — `getV2RayPath()` will return null and show a clear error.

---

## Priority 3: Add Automated Tests

### dvpn-manager.test.js

Create `src/main/dvpn-manager.test.js`. Follow the existing test patterns (see `bee-manager.test.js`, `hns-manager.js` doesn't have tests but bee-manager does).

Key mocks needed:
- `electron` (ipcMain, app, safeStorage, BrowserWindow)
- `sentinel-ai-connect` SDK module (createWallet, importWallet, getBalance, connect, disconnect, estimateCost)
- `./network-manager` (setDvpnProxy, clearDvpnProxy, rebuild)
- `./settings-store` (loadSettings)
- `./service-registry` (updateService, setErrorState, clearErrorState, setStatusMessage)
- `fs` (for wallet file, state file operations)

Test cases:

| Test | What It Verifies |
|---|---|
| init with no wallet | State is OFF, no wallet address |
| wallet creation | createWallet called, mnemonic saved, address set, state is WALLET_READY |
| wallet rehydration from encrypted secret | On init with existing wallet, importWallet called (not createWallet), address recovered |
| start with insufficient balance | getBalance returns funded=false, connect rejected with "Insufficient balance" |
| spend-cap derives session size correctly | estimateCost called, gigabytes = floor(maxSpendUdVpn / pricePerGbUdVpn) |
| low-balance auto-disconnect | Balance poll fires, udvpn < threshold, stopDvpn called with reason 'low_balance' |
| max-duration auto-disconnect | Duration timer fires, stopDvpn called with reason 'max_duration' |
| disconnect failure → remote-pending | sdk.disconnect throws, state transitions to REMOTE_PENDING, persisted |
| startup recovery retries pending disconnect | initDvpn reads persisted REMOTE_PENDING state, calls sdk.disconnect |
| getStatus includes error, balance, funded | getStatus() returns all fields including lastError and cached values |
| getV2RayPath dev mode | Returns path under node_modules or dvpn-bin |
| getV2RayPath packaged mode | app.isPackaged=true, returns path under process.resourcesPath |

### network-manager.test.js

Create `src/main/network-manager.test.js`.

Key mocks needed:
- `electron` (session)
- `http` (createServer for PAC server)

Test cases:

| Test | What It Verifies |
|---|---|
| HNS-only PAC | setHnsProxy set, no dVPN → single-label hosts go PROXY, others go DIRECT |
| HNS + dVPN PAC composition | Both set → single-label hosts go PROXY, others go SOCKS5 |
| loopback always DIRECT | 127.0.0.1, localhost, ::1 → DIRECT regardless of proxy config |
| single-label hosts → HNS proxy | dnsDomainLevels(host)===0 returns PROXY when HNS set |
| ordinary hosts → SOCKS5 when dVPN connected | Multi-label hosts return SOCKS5 when dvpnProxy set |
| ordinary hosts → DIRECT when dVPN off | Multi-label hosts return DIRECT when no dvpnProxy |
| proxy updates on connect/disconnect | setDvpnProxy + rebuild applies new PAC; clearDvpnProxy + rebuild removes SOCKS5 |
| HNS not regressed by dVPN | With both active, single-label still goes to HNS PROXY (not SOCKS5) |
| clearProxy stops PAC server | After clearProxy, no PAC server running |
| rebuild with no proxies clears everything | No HNS, no dVPN → clearProxy called |

### Test Execution

After writing tests, run:

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
npm test
```

Then:

```bash
npm run lint
```

Fix any lint errors.

---

## Priority 4: Harden Lifecycle and UX

After runtime is proven, verify these behaviors:

### Quit While Connected

1. Connect dVPN
2. Quit the browser (Cmd+Q / Ctrl+Q)
3. Check Electron console for `[App] Waiting for Bee, IPFS, Radicle, HNS, and dVPN to stop...`
4. `stopDvpn()` should be called in `before-quit` (see `index.js:244`)
5. If disconnect fails, state should be REMOTE_PENDING and persisted

### Relaunch After Crash

1. Connect dVPN
2. Force-kill the process (`kill -9`)
3. Relaunch
4. `initDvpn()` should read `state.json`, find pending session, attempt `sdk.disconnect()`
5. State should settle to WALLET_READY (if cleanup succeeds) or REMOTE_PENDING (if it fails)

### Low-Balance Stop

1. Connect with a wallet that has very low balance
2. Wait for the balance poll (60-second interval)
3. When `udvpn < lowBalanceStopUdVpn`, disconnect should trigger
4. `lastDisconnectReason` should be `'low_balance'`
5. Settings UI should show "Stopped — low balance"

### Max-Duration Stop

1. Set `dvpnMaxDurationMinutes` to 1 in settings
2. Connect
3. After 1 minute, disconnect should trigger
4. `lastDisconnectReason` should be `'max_duration'`
5. Settings UI should show "Stopped — max duration"

### Error Surfacing

1. Settings UI should show `status.error` in the error row when state is ERROR
2. The error should be the actual error string from the SDK, not just "Error"

If any of these are broken, fix in `dvpn-manager.js` and/or `settings-ui.js`.

---

## Priority 5: Dependency Strategy Until PR Merges

The upstream PR is at https://github.com/Sentinel-Autonomybuilder/blue-ai-connect/pull/1

Until it merges:

- Keep `sentinel-ai-connect: "file:../../blue-ai-connect"` in freedom-browser's `package.json`
- Do not switch to `sentinel-ai-connect` from the npm registry — the published version still has the broken `../js-sdk/` imports
- If the PR merges and a new version is published, update the dependency to `"sentinel-ai-connect": "^1.2.3"` (or whatever the new version is)
- Do not commit `node_modules/` — the local file dependency is resolved at `npm install` time

---

## Exact Shell Commands

### Check for existing processes before starting anything

```bash
rtk ps -ef
```

Look for existing `electron`, `freedom`, `v2ray`, or `bee` processes. Do not stack a second copy.

### Verify SDK import chain

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
node -e "import('sentinel-ai-connect').then(m => console.log('OK:', Object.keys(m).length, 'exports')).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK: 20 exports`

### Download V2Ray via SDK setup

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
node node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/setup.js
```

### Verify V2Ray downloaded (all three files required)

```bash
ls -la /home/t42/Documents/pirate-workspace/freedom-browser/node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/
```

Expected: `v2ray`, `geoip.dat`, `geosite.dat` — all three must be present.

### Check V2Ray works

```bash
/home/t42/Documents/pirate-workspace/freedom-browser/node_modules/sentinel-ai-connect/node_modules/sentinel-dvpn-sdk/bin/v2ray version
```

Expected: `V2Ray 5.2.1` or similar

### Start Freedom for manual testing

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
npm start
```

### Run lint

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
npm run lint
```

### Run existing tests

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
npm test
```

### Run specific test file

```bash
cd /home/t42/Documents/pirate-workspace/freedom-browser
npx jest src/main/dvpn-manager.test.js --no-coverage
```

---

## Definition of Done

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

---

## Things Not To Re-open

These decisions are final:

- Self-funded SDK model for v1
- V2Ray only (no WireGuard in Freedom for v1)
- `systemProxy: false` — Freedom sets its own PAC, not the OS proxy
- `fullTunnel: false` — SOCKS5 only, no TUN
- Composed PAC via `network-manager.js` — single PAC handles HNS + dVPN
- No operator/backend entitlement path for v1
- No wallet import for v1 (only create) unless a new blocker forces it
- Commit directly to `main` in freedom-browser (no feature branches per AGENTS.md)
