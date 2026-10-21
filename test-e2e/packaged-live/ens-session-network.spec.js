// Installed ENS network attribution (release-readiness acceptance).
//
// PR 46 moved ENS, Colibri and RPC traffic off Node's own networking and onto
// the requesting window's Electron session. This spec checks that in the
// installed artifact:
//   1. a lookup from a normal window reaches the ENS endpoints through
//      Chromium's network stack, and the main process (where Node's fetch
//      would dial from) is not seen holding any peer but the HNS relay;
//   2. the same lookup from a private window is answered afresh, in a network
//      context of its own: its prover request opens a new HTTP/2 session
//      while the normal window's session to the same host is still open,
//      which Chromium would have reused within one session. The private
//      window's lookups, of that name and of one the normal window never
//      resolved, leave the default session's verifier store as it was, and
//      nothing in the profile records the second name (the verifier's call
//      cache keys entries by slots derived from the name;
//      colibri-worker-host.js, STORAGE);
//   3. closing a private window retires its session, which ends a lookup
//      held at the prover (second test: a local prover that never answers,
//      reached on the loopback branch, so the request cannot finish first).
// The main-process check samples sockets every 50 ms (every TCP state and
// UDP), so a connection that opens and closes between two samples can be
// missed; it is a guard, not a trace.
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

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget, isPackagedRun } = require('../packaged-launch');
const { closeApp } = require('../close-app');

const ENABLED = process.env.FREEDOM_E2E_ENS_SESSION_LIVE === '1';
const FIRST_NAME = 'vitalik.eth';
const CLOSE_NAME = 'nick.eth';
// Resolved by the private window only.
const PRIVATE_ONLY_NAME = 'nick.eth';
const LOOKUP_SETTLE_MS = 25_000;

// The hosts an ENS lookup reaches: the configured mainnet prover and RPCs,
// plus the Colibri SDK's own default beacon and checkpoint endpoints, which
// the verifier fetches through the same bridge.
const COLIBRI_SDK_HOSTS = ['mainnet.colibri-proof.tech', 'sync-mainnet.beaconcha.in'];

function endpointHosts(repoRoot, roles) {
  const sources = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'src/shared/endpoint-sources.json'), 'utf8')
  );
  return Object.values(sources.sources || sources)
    .filter((source) => roles.includes(source.role) && !source.keyed)
    .map((source) => source.coverage?.['1'])
    .filter(Boolean)
    .map((url) => new URL(url).hostname);
}

function ensHosts(repoRoot) {
  return new Set([...endpointHosts(repoRoot, ['prover', 'rpc']), ...COLIBRI_SDK_HOSTS]);
}

// The configured Colibri prover, which only the verifier reaches, and only
// once it has synced: the call it answers is what the verifier caches.
function proverHosts(repoRoot) {
  return new Set(endpointHosts(repoRoot, ['prover']));
}

// The only remote peer the main process may hold: the HNS encrypted DNS relay
// it runs itself. Anything else would be a request made outside Chromium.
async function allowedMainProcessPeers() {
  const answer = await fetch('https://dns.google/resolve?name=dns.pirate.sc&type=A').then((r) => r.json());
  return new Set((answer.Answer || []).map((record) => `${record.data}:443`));
}

const isLoopbackPeer = (peer) => /^(127\.|\[::1\]|::1)/.test(peer);

// Samples the main process's TCP (any state, connecting included) and UDP
// peers every 50 ms from a separate shell loop, so the sampling never blocks
// this process (and with it Playwright's own connection to the app).
function sampleMainProcessPeers(pid) {
  const peers = new Set();
  const loop = spawn('sh', ['-c', `while :; do ss -tuanpH 2>/dev/null | grep 'pid=${pid},'; sleep 0.05; done`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let pending = '';
  loop.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const peer = line.trim().split(/\s+/)[5];
      if (peer && !/^(\*|0\.0\.0\.0|\[::\]):\*$/.test(peer)) peers.add(peer);
    }
  });
  return { peers, stop: () => loop.kill('SIGKILL') };
}

// Names, sizes and modification times of the default session's verifier
// store (`<userData>/colibri`), or null when there is none.
function storeSnapshot(dir) {
  try {
    return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return [name, `${stat.size}:${stat.mtimeMs}`];
    }));
  } catch {
    return null;
  }
}

// What a lookup of `name` could leave on disk: the name (UTF-8 and UTF-16),
// its namehash, and the ENS registry storage slots derived from it, as raw
// bytes and as lowercase hex. Every ENS lookup reads the registry; a
// resolver's own slots depend on its storage layout and are not searched.
function nameTraces(name) {
  const { ethers } = require('ethers');
  const node = ethers.namehash(name);
  const records = BigInt(ethers.keccak256(ethers.concat([node, ethers.zeroPadValue('0x00', 32)])));
  const words = [node, ethers.toBeHex(records, 32), ethers.toBeHex(records + 1n, 32)]
    .map((hex) => hex.slice(2));
  return [
    Buffer.from(name, 'utf8'),
    Buffer.from(name, 'utf16le'),
    ...words.map((hex) => Buffer.from(hex, 'hex')),
    ...words.map((hex) => Buffer.from(hex, 'utf8')),
  ];
}

// Every regular file under `dir` whose bytes contain any of `needles`.
function filesContaining(dir, needles) {
  const hits = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && needles.some((needle) => fs.readFileSync(file).includes(needle))) {
        hits.push(path.relative(dir, file));
      }
    }
  };
  walk(dir);
  return hits;
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

// NetLog events for URL requests to the ENS hosts: start time, outcome, HTTP
// status, and the session each one rode, with each session's open interval:
// an HTTP/2 session through the stream job that opened or found it, or a QUIC
// session bound to the request directly.
function ensRequests(netlogFile, hosts) {
  const log = JSON.parse(fs.readFileSync(netlogFile, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const tickOffset = Number(log.constants.timeTickOffset);
  const at = (event) => tickOffset + Number(event.time);
  const bySource = new Map();
  const jobOfRequest = new Map();
  const sessionOfJob = new Map();
  const quicOfRequest = new Map();
  const sessionSpan = new Map();
  for (const event of log.events) {
    const type = types[event.type];
    const id = event.source?.id;
    const dependency = event.params?.source_dependency?.id;
    if (type === 'URL_REQUEST_START_JOB' && event.phase === 1 && event.params?.url) {
      let host;
      try { host = new URL(event.params.url).hostname; } catch { continue; }
      if (hosts.has(host) && !bySource.has(id)) bySource.set(id, { host, startedAt: at(event) });
    }
    if (type === 'REQUEST_ALIVE' && event.phase === 2 && bySource.has(id)) {
      bySource.get(id).endedAt = at(event);
      bySource.get(id).netError = event.params?.net_error ?? 0;
    }
    if (type === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS' && bySource.has(id)) {
      const status = /^HTTP\/\S+ (\d{3})/.exec(event.params?.headers?.[0] || '');
      if (status) bySource.get(id).status = Number(status[1]);
    }
    if (type === 'HTTP_STREAM_REQUEST_BOUND_TO_JOB' && dependency !== undefined) jobOfRequest.set(id, dependency);
    if (type === 'HTTP_STREAM_REQUEST_BOUND_TO_QUIC_SESSION' && dependency !== undefined) quicOfRequest.set(id, dependency);
    if (/^HTTP2_SESSION_POOL_(IMPORTED_SESSION_FROM_SOCKET|FOUND_EXISTING_SESSION)/.test(type) && dependency !== undefined) {
      sessionOfJob.set(id, dependency);
    }
    if (type === 'HTTP2_SESSION' || type === 'QUIC_SESSION') {
      const span = sessionSpan.get(id) || { openedAt: at(event), closedAt: Infinity };
      if (event.phase === 1) span.openedAt = at(event);
      if (event.phase === 2) span.closedAt = at(event);
      sessionSpan.set(id, span);
    }
  }
  return [...bySource.entries()].map(([id, request]) => {
    const session = quicOfRequest.get(id) ?? sessionOfJob.get(jobOfRequest.get(id));
    return { ...request, session, sessionSpan: sessionSpan.get(session) };
  });
}

test.describe('installed ENS network attribution', () => {
  test.skip(!ENABLED, 'set FREEDOM_E2E_ENS_SESSION_LIVE=1 to resolve ENS names over the network');
  test.skip(ENABLED && !isPackagedRun(), 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary');

  test('normal and private windows resolve through Chromium, each afresh', async () => {
    test.setTimeout(8 * 60_000);
    const repoRoot = path.resolve(__dirname, '..', '..');
    const hosts = ensHosts(repoRoot);
    const provers = proverHosts(repoRoot);
    const evidenceDir = process.env.FREEDOM_E2E_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ens-session-'));
    fs.mkdirSync(evidenceDir, { recursive: true });
    const netlog = path.join(evidenceDir, 'netlog.json');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ens-session-profile-'));
    const dirs = {
      userData: path.join(root, 'userData'),
      ant: path.join(root, 'ant-data'),
      ipfs: path.join(root, 'ipfs-data'),
      identity: path.join(root, 'identity'),
      // The app's working directory, where the SDK's own default storage
      // would write; inside the profile, so the trace search covers it.
      cwd: path.join(root, 'cwd'),
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
      cwd: dirs.cwd,
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
    const sampler = sampleMainProcessPeers(app.process().pid);
    const { peers } = sampler;
    const phases = {};
    const store = path.join(dirs.userData, 'colibri');
    const stores = {};
    try {
      const normal = await chromePage(app, (url) => url.includes('index.html') && !url.includes('privatePartition='), 90_000);

      phases.normalStart = Date.now();
      await navigate(normal, FIRST_NAME);
      await normal.waitForTimeout(LOOKUP_SETTLE_MS);
      phases.normalEnd = Date.now();

      await normal.evaluate(() => window.electronAPI.newPrivateWindow());
      const privateWindow = await chromePage(app, (url) => url.includes('privatePartition=private-'));
      stores.beforePrivate = storeSnapshot(store);
      phases.privateStart = Date.now();
      await navigate(privateWindow, FIRST_NAME);
      await privateWindow.waitForTimeout(LOOKUP_SETTLE_MS);
      phases.privateOnlyStart = Date.now();
      await navigate(privateWindow, PRIVATE_ONLY_NAME);
      await privateWindow.waitForTimeout(LOOKUP_SETTLE_MS);
      phases.privateEnd = Date.now();
      stores.afterPrivate = storeSnapshot(store);
    } finally {
      sampler.stop();
      await closeApp(app, { timeout: 100_000 }).catch(() => {});
    }

    const requests = ensRequests(netlog, hosts);
    const within = (from, to) => requests.filter((r) => r.startedAt >= from && r.startedAt < to);
    const normalRequests = within(phases.normalStart, phases.normalEnd);
    const privateRequests = within(phases.privateStart, phases.privateOnlyStart);
    const privateOnlyRequests = within(phases.privateOnlyStart, phases.privateEnd);
    // Prover calls the private window made and was answered: the store checks
    // below mean nothing if its own lookup never reached the prover (a cold
    // sync alone, or a quorum-RPC answer), and a call on a session the normal
    // window used could be the normal window's.
    const normalSessions = new Set(normalRequests.map((request) => request.session).filter((id) => id !== undefined));
    const privateOnlyVerified = privateOnlyRequests.filter(
      (request) =>
        provers.has(request.host) &&
        request.netError === 0 &&
        request.status >= 200 && request.status < 300 &&
        request.session !== undefined &&
        !normalSessions.has(request.session)
    );
    // Read after quit, once everything the app keeps on disk is written.
    const traces = filesContaining(root, nameTraces(PRIVATE_ONLY_NAME));
    // A private request to a host the normal window still held an open
    // HTTP/2 session to, carried on a session of its own: one network context
    // would have reused the open session.
    const separateContext = privateRequests.filter((privateRequest) =>
      privateRequest.session !== undefined &&
      normalRequests.some(
        (normalRequest) =>
          normalRequest.host === privateRequest.host &&
          normalRequest.session !== undefined &&
          normalRequest.session !== privateRequest.session &&
          normalRequest.sessionSpan?.closedAt > privateRequest.startedAt
      )
    );
    const summary = {
      phases,
      ensHosts: [...hosts],
      normal: normalRequests.length,
      private: privateRequests.length,
      privateOnSeparateSession: separateContext.length,
      privateOnly: privateOnlyRequests.length,
      privateOnlyVerified: privateOnlyVerified.length,
      storeEntriesBeforePrivate: Object.keys(stores.beforePrivate || {}).length,
      storeUnchangedByPrivate: JSON.stringify(stores.afterPrivate) === JSON.stringify(stores.beforePrivate),
      privateOnlyNameTraces: traces,
      mainProcessPeers: [...peers],
    };
    fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify({ summary, stores, requests }, null, 2));
    test.info().annotations.push({ type: 'summary', description: JSON.stringify(summary) });

    expect(normalRequests.length, 'the normal window resolves through Chromium').toBeGreaterThan(0);
    expect(privateRequests.length, 'the private window resolves afresh, through Chromium').toBeGreaterThan(0);
    expect(separateContext.length, 'the private window dials in a network context of its own').toBeGreaterThan(0);
    expect(privateOnlyVerified.length, "the private window's own lookup is answered by the Colibri prover")
      .toBeGreaterThan(0);
    expect(summary.storeEntriesBeforePrivate, "the normal window's lookup fills the default session's verifier store")
      .toBeGreaterThan(0);
    expect(stores.afterPrivate, "the private window's lookups leave the default session's verifier store as it was")
      .toEqual(stores.beforePrivate);
    expect(traces, 'nothing in the profile records the name only the private window resolved').toEqual([]);
    const allowed = await allowedMainProcessPeers();
    const unexpected = [...peers].filter((peer) => !isLoopbackPeer(peer) && !allowed.has(peer));
    expect(unexpected, 'no main-process peer but the HNS relay was seen in 50 ms samples').toEqual([]);
  });

  // The prover here is on loopback, so the held request runs on the gateway
  // transport's loopback branch (Node fetch in the main process). What this
  // shows is the window-close retirement reaching a request in flight.
  test('closing a private window retires its session and ends a lookup held at the prover', async () => {
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
