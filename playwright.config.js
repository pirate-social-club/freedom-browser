// Playwright config for renderer E2E tests.
//
// Two projects:
//   - `harness` (default `npm run test:e2e`): fixture-driven specs that run
//     against the in-process test harness. No actual Ant, IPFS, ENS, or
//     network. Fast, deterministic, safe in CI.
//   - `live` (`npm run test:e2e:live`): drives the full app against live
//     services — actual antd node, live ENS resolution, real bzz:// /
//     ipfs:// protocol handlers. Requires `npm run ant:download` first
//     and is slow (Swarm cold-start can take several minutes). Skipped
//     automatically if the antd binary for the current platform isn't
//     present.
//
// Layout:
//   - `test-e2e/live/**/*.spec.js`  → `live` project
//   - `test-e2e/*.spec.js`          → `harness` project (everything else)

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test-e2e',
  // Sequential runs only — Electron launches multiple processes per app
  // instance and parallel runs would fight over the privileged-protocol
  // scheme cache and (in live mode) over Bee's default-port detection.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'harness',
      testMatch: /^(?!.*[\\/]live[\\/])(?!.*hns-electron\.spec\.js$).*\.spec\.js$/,
      // Bee/IPFS startup is stubbed in test mode, but Electron + first-
      // window ready can still take 10–15s on cold cache. 30s gives
      // headroom without hiding genuine hangs.
      timeout: 30_000,
      expect: { timeout: 7_500 },
      retries: process.env.CI ? 2 : 0,
    },
    {
      name: 'hns',
      testMatch: /hns-electron\.spec\.js$/,
      timeout: 2 * 60_000,
      expect: { timeout: 45_000 },
      retries: 0,
    },
    {
      name: 'live',
      testMatch: /[\\/]live[\\/].*\.spec\.js$/,
      // Live Swarm cold-start to a useful peer count typically takes
      // 30–120s, ENS resolution adds 1–5s, and the navigation probe
      // adds another few seconds. 10 min covers worst-case startup +
      // single-test work without inviting infinite hangs.
      timeout: 10 * 60_000,
      expect: { timeout: 30_000 },
    },
  ],
});
