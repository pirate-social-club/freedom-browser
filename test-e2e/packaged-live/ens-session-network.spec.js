// Installed ENS network attribution (release-readiness acceptance).
//
// PR 46 moved ENS, Colibri and RPC traffic off Node's own networking and onto
// the requesting window's Electron session. This spec checks that in the
// installed artifact:
//   1. a lookup from a normal window reaches the ENS endpoints through
//      Chromium's network stack, while the main process (where Node's fetch
//      would dial from) opens no connection to them;
//   2. the same lookup from a private window is answered afresh, not from the
//      normal window's cache, again only through Chromium;
//   3. closing a private window while one of its lookups is held at the
//      prover ends that request (second test: the prover is a local server
//      that never answers, so the request cannot finish first).
// It does not, and cannot from the installed product's settings, show that
// two sessions take two different proxies: the shipped routing gives every
// session the same policy. That is session-transport-proxy.test.js's job,
// which proves it with the same modules in real Electron.
//
// Evidence: Chromium's own NetLog (--log-net-log, written at quit) for what
// went through Chromium, and `ss` samples of the main process's sockets for
// what did not.
//
//   FREEDOM_E2E_ENS_SESSION_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//   FREEDOM_E2E_EVIDENCE_DIR=<dir> \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/ens-session-network.spec.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget, isPackagedRun } = require('../packaged-launch');
const { closeApp } = require('../close-app');

const ENABLED = process.env.FREEDOM_E2E_ENS_SESSION_LIVE === '1';
const FIRST_NAME = 'vitalik.eth';
const CLOSE_NAME = 'nick.eth';
const LOOKUP_SETTLE_MS = 25_000;

// The hosts an ENS lookup reaches: the configured mainnet prover and RPCs,
// plus the Colibri SDK's own default beacon and checkpoint endpoints, which
// the verifier fetches through the same bridge.
const COLIBRI_SDK_HOSTS = ['mainnet.colibri-proof.tech', 'sync-mainnet.beaconcha.in'];

function ensHosts(repoRoot) {
  const sources = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'src/shared/endpoint-sources.json'), 'utf8')
  );
  const entries = Object.values(sources.sources || sources);
  return new Set([
    ...entries
      .filter((source) => ['prover', 'rpc'].includes(source.role) && !source.keyed)
      .map((source) => source.coverage?.['1'])
      .filter(Boolean)
      .map((url) => new URL(url).hostname),
    ...COLIBRI_SDK_HOSTS,
  ]);
}

// The only remote peer the main process may hold: the HNS encrypted DNS relay
// it runs itself. Anything else would be a request made outside Chromium.
async function allowedMainProcessPeers() {
  const answer = await fetch('https://dns.google/resolve?name=dns.pirate.sc&type=A').then((r) => r.json());
  return new Set((answer.Answer || []).map((record) => `${record.data}:443`));
}

const isLoopbackPeer = (peer) => /^(127\.|\[::1\]|::1)/.test(peer);

// The main process's established TCP peers, as `ip:port` strings.
function mainProcessPeers(pid) {
  let out;
  try {
    out = execFileSync('ss', ['-tnpH', 'state', 'established'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((line) => line.includes(`pid=${pid},`))
    .map((line) => line.trim().split(/\s+/)[3])
    .filter(Boolean);
}

async function chromePage(app, predicate, timeout = 30_000) {
  let page;
  await expect
    .poll(
      () => {
        page = app.windows().find((candidate) => predicate(candidate.url()));
        return Boolean(page);
      },
      { timeout }
    )
    .toBe(true);
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible', timeout });
  return page;
}

async function navigate(window, value) {
  const address = window.locator('[data-test="address-input"]');
  await address.fill(value);
  await address.press('Enter');
}

// NetLog events for URL requests to the ENS hosts: start time and outcome.
function ensRequests(netlogFile, hosts) {
  const log = JSON.parse(fs.readFileSync(netlogFile, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const tickOffset = Number(log.constants.timeTickOffset);
  const bySource = new Map();
  for (const event of log.events) {
    const type = types[event.type];
    const id = event.source?.id;
    if (type === 'URL_REQUEST_START_JOB' && event.phase === 1 && event.params?.url) {
      let host;
      try { host = new URL(event.params.url).hostname; } catch { continue; }
      if (!hosts.has(host)) continue;
      if (!bySource.has(id)) bySource.set(id, { host, startedAt: tickOffset + Number(event.time) });
    }
    if (type === 'REQUEST_ALIVE' && event.phase === 2 && bySource.has(id)) {
      bySource.get(id).endedAt = tickOffset + Number(event.time);
      bySource.get(id).netError = event.params?.net_error ?? 0;
    }
  }
  return [...bySource.values()];
}

test.describe('installed ENS network attribution', () => {
  test.skip(!ENABLED, 'set FREEDOM_E2E_ENS_SESSION_LIVE=1 to resolve ENS names over the network');
  test.skip(ENABLED && !isPackagedRun(), 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary');

  test('normal and private windows resolve through Chromium, each afresh', async () => {
    test.setTimeout(8 * 60_000);
    const repoRoot = path.resolve(__dirname, '..', '..');
    const hosts = ensHosts(repoRoot);
    const evidenceDir = process.env.FREEDOM_E2E_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ens-session-'));
    fs.mkdirSync(evidenceDir, { recursive: true });
    const netlog = path.join(evidenceDir, 'netlog.json');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ens-session-profile-'));
    const dirs = {
      userData: path.join(root, 'userData'),
      ant: path.join(root, 'ant-data'),
      ipfs: path.join(root, 'ipfs-data'),
      identity: path.join(root, 'identity'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dirs.userData, 'settings.json'),
      JSON.stringify({
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableTorIntegration: false,
        startTorAtLaunch: false,
      })
    );

    const target = packagedLaunchTarget();
    const app = await launchApp({
      ...target,
      args: [...target.args, `--log-net-log=${netlog}`],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_USER_DATA: dirs.userData,
        FREEDOM_ANT_DATA: dirs.ant,
        FREEDOM_IPFS_DATA: dirs.ipfs,
        FREEDOM_IDENTITY_DATA: dirs.identity,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 90_000,
    });
    const mainPid = app.process().pid;
    const peers = new Set();
    const sampler = setInterval(() => {
      for (const peer of mainProcessPeers(mainPid)) peers.add(peer);
    }, 200);
    const phases = {};
    try {
      const normal = await chromePage(app, (url) => url.includes('index.html') && !url.includes('privatePartition='), 90_000);

      phases.normalStart = Date.now();
      await navigate(normal, FIRST_NAME);
      await normal.waitForTimeout(LOOKUP_SETTLE_MS);
      phases.normalEnd = Date.now();

      await normal.evaluate(() => window.electronAPI.newPrivateWindow());
      const privateWindow = await chromePage(app, (url) => url.includes('privatePartition=private-'));
      phases.privateStart = Date.now();
      await navigate(privateWindow, FIRST_NAME);
      await privateWindow.waitForTimeout(LOOKUP_SETTLE_MS);
      phases.privateEnd = Date.now();

      await navigate(privateWindow, CLOSE_NAME);
      await privateWindow.waitForTimeout(400);
      phases.closeAt = Date.now();
      await privateWindow.evaluate(() => window.close()).catch(() => {});
      await normal.waitForTimeout(5_000);
    } finally {
      clearInterval(sampler);
      await closeApp(app, { timeout: 100_000 }).catch(() => {});
    }

    const requests = ensRequests(netlog, hosts);
    const within = (from, to) => requests.filter((r) => r.startedAt >= from && r.startedAt < to);
    const normalRequests = within(phases.normalStart, phases.normalEnd);
    const privateRequests = within(phases.privateStart, phases.privateEnd);
    const closeRequests = within(phases.privateEnd, phases.closeAt + 1_000);
    const abortedAtClose = closeRequests.filter((r) => r.netError === -3 && r.endedAt >= phases.closeAt);
    // Chromium's own peer addresses for the ENS hosts, from the same NetLog,
    // compared with every peer the main process held during the run.
    const summary = {
      phases,
      ensHosts: [...hosts],
      normal: normalRequests.length,
      private: privateRequests.length,
      duringClose: closeRequests.length,
      abortedAtClose: abortedAtClose.length,
      mainProcessPeers: [...peers],
    };
    fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify({ summary, requests }, null, 2));
    test.info().annotations.push({ type: 'summary', description: JSON.stringify(summary) });

    expect(normalRequests.length, 'the normal window resolves through Chromium').toBeGreaterThan(0);
    expect(privateRequests.length, 'the private window is not served the normal window\'s cache').toBeGreaterThan(0);
    const allowed = await allowedMainProcessPeers();
    const unexpected = [...peers].filter((peer) => !isLoopbackPeer(peer) && !allowed.has(peer));
    expect(unexpected, 'the main process opens no connection but the HNS relay while resolving').toEqual([]);
  });

  test('closing a private window ends its lookup that is still waiting on the prover', async () => {
    test.setTimeout(5 * 60_000);
    const http = require('http');
    const held = [];
    let closed = 0;
    const server = http.createServer((req, res) => {
      // Never answers: the verifier's request stays open until the client ends it.
      held.push(Date.now());
      res.on('close', () => {
        if (!res.writableEnded) closed += 1;
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const repoRoot = path.resolve(__dirname, '..', '..');
    const evidenceDir = process.env.FREEDOM_E2E_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ens-session-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ens-close-profile-'));
    const dirs = {
      userData: path.join(root, 'userData'),
      ant: path.join(root, 'ant-data'),
      ipfs: path.join(root, 'ipfs-data'),
      identity: path.join(root, 'identity'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dirs.userData, 'settings.json'),
      JSON.stringify({
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableTorIntegration: false,
        startTorAtLaunch: false,
      })
    );
    // The mainnet prover is replaced by the local server that never answers.
    fs.writeFileSync(
      path.join(dirs.userData, 'network-config.json'),
      JSON.stringify({
        networks: {},
        endpointSources: {
          'acceptance-hanging-prover': {
            role: 'prover',
            name: 'Acceptance prover that never answers',
            coverage: { 1: `http://127.0.0.1:${port}/prover` },
          },
        },
        removedSources: ['colibri-corpus'],
      })
    );
    const target = packagedLaunchTarget();
    const app = await launchApp({
      ...target,
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_USER_DATA: dirs.userData,
        FREEDOM_ANT_DATA: dirs.ant,
        FREEDOM_IPFS_DATA: dirs.ipfs,
        FREEDOM_IDENTITY_DATA: dirs.identity,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 90_000,
    });
    const result = {};
    try {
      const normal = await chromePage(app, (url) => url.includes('index.html') && !url.includes('privatePartition='), 90_000);
      await normal.evaluate(() => window.electronAPI.newPrivateWindow());
      const privateWindow = await chromePage(app, (url) => url.includes('privatePartition=private-'));
      await navigate(privateWindow, CLOSE_NAME);
      await expect.poll(() => held.length, { message: 'the lookup reaches the prover', timeout: 120_000 }).toBeGreaterThan(0);
      await privateWindow.waitForTimeout(500);
      result.heldBeforeClose = held.length - closed;
      result.closeAt = Date.now();
      await privateWindow.evaluate(() => window.close()).catch(() => {});
      await expect
        .poll(() => closed, { message: 'closing the window ends the held requests', timeout: 10_000 })
        .toBeGreaterThanOrEqual(result.heldBeforeClose);
      result.closeMs = Date.now() - result.closeAt;
      result.held = held.length;
      result.closed = closed;
    } finally {
      await closeApp(app, { timeout: 100_000 }).catch(() => {});
      server.close();
    }
    fs.writeFileSync(path.join(evidenceDir, 'close-cancellation.json'), JSON.stringify(result, null, 2));
    test.info().annotations.push({ type: 'close-cancellation', description: JSON.stringify(result) });
    expect(result.heldBeforeClose).toBeGreaterThan(0);
    expect(result.closeMs).toBeLessThan(10_000);
  });
});
