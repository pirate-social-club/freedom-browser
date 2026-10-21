// Installed unavailable-proxy refusal (release-readiness acceptance).
//
// `.onion` is the one destination the shipped routing sends to a proxy with no
// DIRECT fallback: with Tor configured, the PAC (network-manager.js
// buildPacScript) returns only Tor's SOCKS endpoint for it, and a Tor endpoint
// that stops answering is marked unhealthy without its route being dropped
// (tor-manager.js, applyOnionRouting). This spec checks that in the installed
// artifact, against an external Tor endpoint it controls (named through
// FREEDOM_TEST_TOR_EXTERNAL_SOCKS, which only the scratch test profile honours;
// Linux packages bundle no Arti):
//   1. while the endpoint answers, a `.onion` name reaches it as a name (the
//      SOCKS request carries the hostname, so nothing resolved it locally);
//   2. once the endpoint is gone and Tor has marked it unhealthy, `.onion` loads
//      from a normal window and from a private one are refused: each request
//      still resolves to that endpoint only and fails connecting to it
//      (ERR_PROXY_CONNECTION_FAILED, which a DIRECT retry could not produce:
//      Chromium refuses to resolve `.onion` itself), and lands on the error
//      page naming that failure;
//   3. no `.onion` name is looked up at any point: Chromium's resolver turns
//      any request for one away (RFC 7686) without starting a lookup.
// The dVPN proxy is not covered: its PAC ends in "; DIRECT", so an unreachable
// dVPN falls back to direct connections by design.
//
// Evidence: Chromium's NetLog (--log-net-log, written at quit) for proxy
// resolution, host resolution and each request's outcome; the stand-in
// endpoint's own record of the SOCKS requests it was sent.
//
//   FREEDOM_E2E_TOR_REFUSAL_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//   FREEDOM_E2E_EVIDENCE_DIR=<dir> \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/tor-proxy-refusal.spec.js

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget, isPackagedRun } = require('../packaged-launch');
const { closeApp } = require('../close-app');

const ENABLED = process.env.FREEDOM_E2E_TOR_REFUSAL_LIVE === '1';
// Any syntactically valid v3 onion name will do: nothing here reaches Tor.
const ONION_HOST = 'duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion';
const PAGE_TIMEOUT_MS = 60_000;
// tor-manager's external-endpoint health check runs every 5 s.
const UNHEALTHY_TIMEOUT_MS = 20_000;
const ERR_PROXY_CONNECTION_FAILED = -130;

// A SOCKS5 endpoint standing in for external Tor. It accepts the no-auth
// greeting, records the destination of every CONNECT it is sent, and refuses
// each one.
function startSocksEndpoint() {
  const connects = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let greeted = false;
    socket.on('data', (chunk) => {
      let request = chunk;
      if (!greeted) {
        greeted = true;
        socket.write(Buffer.from([0x05, 0x00]));
        request = chunk.subarray(2 + (chunk[1] || 0));
        if (request.length === 0) return;
      }
      if (request[0] === 0x05 && request[1] === 0x01) {
        const host = request[3] === 0x03
          ? request.subarray(5, 5 + request[4]).toString('latin1')
          : `address-type-${request[3]}`;
        connects.push({ host, at: Date.now() });
      }
      // General SOCKS server failure.
      socket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        connects,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
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

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (source) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    try {
      return await webview.executeJavaScript(source);
    } catch {
      return null;
    }
  }, snippet);

// A window's first tab loads its start page (home.html, or private.html in a
// private window) after the address bar is already visible, and that load
// clears the bar, so typing too early can submit nothing. For a window's first
// navigation: wait for the start page to finish loading, navigate, and type
// again once if the tab is still on it.
const START_PAGE = /\/pages\/(home|private)\.html(?:$|[?#])/;

async function navigateFromStartPage(window, value) {
  const href = () => evalInActiveWebview(window, 'location.href').then(String);
  await expect
    .poll(
      async () => START_PAGE.test(await href()) &&
        (await evalInActiveWebview(window, 'document.readyState')) === 'complete',
      { message: 'the window must finish loading its start page', timeout: PAGE_TIMEOUT_MS }
    )
    .toBe(true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await navigate(window, value);
    try {
      await expect.poll(async () => START_PAGE.test(await href()), { timeout: 10_000 }).toBe(false);
      return;
    } catch {
      // Still on the start page: the keystrokes were lost to its load.
    }
  }
}

// Waits for the active tab to land on Freedom's error page for `url` (naming
// `error`, when given), and returns the error it names.
async function errorPageFor(window, url, error = null) {
  let shown = null;
  let last = null;
  await expect
    .poll(
      async () => {
        const href = await evalInActiveWebview(window, 'location.href');
        last = href;
        if (!href || !/\/pages\/error\.html\?/.test(href)) return false;
        const params = new URL(href).searchParams;
        if (params.get('url') !== url) return false;
        if (error && params.get('error') !== error) return false;
        shown = { href, error: params.get('error') };
        return true;
      },
      { message: `${url} must end on the error page${error ? ` for ${error}` : ''} (last: ${last})`, timeout: PAGE_TIMEOUT_MS }
    )
    .toBe(true);
  return shown;
}

// From the NetLog: every URL request to a `.onion` host (start time, outcome,
// and the proxy its stream controller resolved); every host-resolver request
// for a `.onion` name, with its outcome (a refusal settles in the same step,
// so the next end event on its source is its own); and every resolver job, task
// or DNS transaction that names one, which would be a lookup.
function onionTraffic(netlogFile) {
  const log = JSON.parse(fs.readFileSync(netlogFile, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const tickOffset = Number(log.constants.timeTickOffset);
  const at = (event) => tickOffset + Number(event.time);
  const requests = new Map();
  const controllerOf = new Map();
  const proxyOfController = new Map();
  const resolutions = [];
  const openResolution = new Map();
  const lookups = [];
  for (const event of log.events) {
    const type = types[event.type];
    const id = event.source?.id;
    const params = event.params || {};
    if (type === 'URL_REQUEST_START_JOB' && event.phase === 1 && params.url) {
      let host;
      try { host = new URL(params.url).hostname; } catch { continue; }
      if (host.endsWith('.onion') && !requests.has(id)) requests.set(id, { url: params.url, startedAt: at(event) });
    }
    if (type === 'REQUEST_ALIVE' && event.phase === 2 && requests.has(id)) {
      requests.get(id).netError = params.net_error ?? 0;
    }
    if (type === 'HTTP_STREAM_JOB_CONTROLLER_BOUND' && params.source_dependency) {
      controllerOf.set(id, params.source_dependency.id);
    }
    if (type === 'PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST' && params.proxy_info) {
      proxyOfController.set(id, params.proxy_info);
    }
    if (type === 'HOST_RESOLVER_MANAGER_REQUEST') {
      if (event.phase === 1 && /\.onion(:|\/|$)/i.test(String(params.host || ''))) {
        const resolution = { host: params.host, netError: null };
        resolutions.push(resolution);
        openResolution.set(id, resolution);
      } else if (event.phase === 2 && openResolution.has(id)) {
        openResolution.get(id).netError = params.net_error ?? 0;
        openResolution.delete(id);
      }
    } else if (/^(HOST_RESOLVER|DNS_)/.test(type) && /\.onion\b/i.test(JSON.stringify(params))) {
      lookups.push({ type, params });
    }
  }
  return {
    requests: [...requests.entries()].map(([id, request]) => ({
      ...request,
      proxy: proxyOfController.get(controllerOf.get(id)) ?? null,
    })),
    resolutions,
    lookups,
  };
}

test.describe('installed unavailable-proxy refusal', () => {
  test.skip(!ENABLED, 'set FREEDOM_E2E_TOR_REFUSAL_LIVE=1 to drive Tor routing in the installed browser');
  test.skip(ENABLED && !isPackagedRun(), 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary');

  test('a .onion name goes only to the Tor endpoint, and is refused in both windows once it is gone', async () => {
    test.setTimeout(6 * 60_000);
    const repoRoot = path.resolve(__dirname, '..', '..');
    const evidenceDir = process.env.FREEDOM_E2E_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-tor-refusal-'));
    fs.mkdirSync(evidenceDir, { recursive: true });
    const netlog = path.join(evidenceDir, 'netlog.json');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-tor-refusal-profile-'));
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
        enableTorIntegration: true,
        startTorAtLaunch: false,
      })
    );

    const socks = await startSocksEndpoint();
    const endpoint = `127.0.0.1:${socks.port}`;
    const target = packagedLaunchTarget();
    const app = await launchApp({
      ...target,
      args: [...target.args, `--log-net-log=${netlog}`],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_USER_DATA: dirs.userData,
        FREEDOM_TEST_TOR_EXTERNAL_SOCKS: endpoint,
        FREEDOM_ANT_DATA: dirs.ant,
        FREEDOM_IPFS_DATA: dirs.ipfs,
        FREEDOM_IDENTITY_DATA: dirs.identity,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 90_000,
    });
    const phases = {};
    const shown = {};
    let torStatus;
    try {
      const normal = await chromePage(app, (url) => url.includes('index.html') && !url.includes('privatePartition='), 90_000);

      await normal.evaluate(() => window.tor.start());
      await expect
        .poll(async () => (torStatus = await normal.evaluate(() => window.tor.getStatus()))?.status, {
          message: 'Tor must report running on the stand-in endpoint',
          timeout: PAGE_TIMEOUT_MS,
        })
        .toBe('running');

      phases.availableStart = Date.now();
      const firstUrl = `https://${ONION_HOST}/available`;
      await navigateFromStartPage(normal, firstUrl);
      await expect
        .poll(() => socks.connects.some((connect) => connect.host === ONION_HOST), {
          message: 'the .onion name must reach the Tor endpoint',
          timeout: PAGE_TIMEOUT_MS,
        })
        .toBe(true);
      shown.available = await errorPageFor(normal, firstUrl);
      phases.availableEnd = Date.now();

      await socks.close();
      // The route must outlive Tor noticing the endpoint is gone.
      await expect
        .poll(async () => (torStatus = await normal.evaluate(() => window.tor.getStatus()))?.status, {
          message: 'Tor must mark the gone endpoint unhealthy',
          timeout: UNHEALTHY_TIMEOUT_MS,
        })
        .toBe('error');
      phases.goneStart = Date.now();
      const normalUrl = `https://${ONION_HOST}/gone-normal`;
      await navigate(normal, normalUrl);
      shown.goneNormal = await errorPageFor(normal, normalUrl, 'ERR_PROXY_CONNECTION_FAILED');
      phases.goneNormalEnd = Date.now();

      await normal.evaluate(() => window.electronAPI.newPrivateWindow());
      const privateWindow = await chromePage(app, (url) => url.includes('privatePartition=private-'));
      phases.privateStart = Date.now();
      const privateUrl = `https://${ONION_HOST}/gone-private`;
      await navigateFromStartPage(privateWindow, privateUrl);
      shown.gonePrivate = await errorPageFor(privateWindow, privateUrl, 'ERR_PROXY_CONNECTION_FAILED');
      phases.goneEnd = Date.now();
    } finally {
      await socks.close().catch(() => {});
      await closeApp(app, { timeout: 100_000 }).catch(() => {});
    }

    const { requests, resolutions, lookups } = onionTraffic(netlog);
    const pathOf = (request) => new URL(request.url).pathname;
    const gone = requests.filter((request) => request.startedAt >= phases.goneStart);
    const goneNormal = gone.filter((request) => pathOf(request) === '/gone-normal');
    const gonePrivate = gone.filter((request) => pathOf(request) === '/gone-private');
    const viaEndpoint = (request) =>
      typeof request.proxy === 'string' && request.proxy.includes(endpoint) && !/DIRECT/i.test(request.proxy);
    const summary = {
      endpoint,
      torStatus,
      phases,
      shown,
      socksConnects: socks.connects,
      onionRequests: requests.length,
      goneNormal: goneNormal.length,
      gonePrivate: gonePrivate.length,
      onionResolutions: resolutions,
      onionLookups: lookups,
    };
    fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify({ summary, requests }, null, 2));
    test.info().annotations.push({ type: 'summary', description: JSON.stringify(summary) });

    expect(goneNormal.length, 'the normal window asks for the .onion page after the endpoint is gone').toBeGreaterThan(0);
    expect(gonePrivate.length, 'the private window asks for the .onion page after the endpoint is gone').toBeGreaterThan(0);
    for (const request of [...goneNormal, ...gonePrivate]) {
      expect(viaEndpoint(request), `${request.url} still resolves to the Tor endpoint only (${request.proxy})`).toBe(true);
      expect(request.netError, `${request.url} fails connecting to the Tor endpoint, not DIRECT`)
        .toBe(ERR_PROXY_CONNECTION_FAILED);
    }
    expect(requests.every(viaEndpoint), 'every .onion request resolves to the Tor endpoint, never DIRECT').toBe(true);
    // ERR_NAME_NOT_RESOLVED, with no job, task or DNS query behind it.
    expect(resolutions.every((resolution) => resolution.netError === -105), 'the resolver refuses every .onion name')
      .toBe(true);
    expect(lookups, 'no .onion name is looked up').toEqual([]);
  });
});
