/**
 * Electron-hosted probe for `hns-namespace-discovery.test.js`.
 *
 * Namespace discovery (`network-manager.js`: `fetchHnsNamespaces`,
 * `setImportedHnsRoots`) decides which names Chromium sends to the Handshake
 * guard instead of ordinary DNS. The unit suites pin the PAC text and the fetch
 * options on fakes; only a real main process shows what Chromium does with
 * them: which proxy its own PAC engine picks, which names its resolver is
 * actually asked for, and what `session.fetch` puts on the wire. This probe
 * drives the real fetch, list parser, session routing and startup Blink
 * settings (`blink-settings.js`, applied here exactly as `src/main/index.js`
 * applies it, before the app is ready). With
 * FREEDOM_PROBE_WITHOUT_BLINK_SETTINGS=1 it leaves them out instead: that run
 * is the control which shows the page's prefetch hints do reach the resolver
 * when nothing stops them.
 *
 * Nothing leaves the machine:
 *   - Chromium's resolver runs in secure mode against one local
 *     DNS-over-HTTPS server (`app.configureHostResolver`), so every name it
 *     looks up, the PAC's `isResolvable` and any prefetch included, arrives
 *     there and is recorded in order. Secure mode never falls back to the
 *     system resolver. The server's name, `doh.certprobe.test`, is mapped to
 *     127.0.0.1 by `--host-resolver-rules` and is the only name trusted, with
 *     the throwaway certificate in `test/fixtures/cert-verify-concurrency-tls/`.
 *     It answers either as an ordinary resolver (a fixed set of names exist,
 *     everything else is NXDOMAIN) or as one that fabricates an address for
 *     every name. Every address it gives is 127.0.0.1;
 *   - a fake discovery server on 127.0.0.1 serves api-next's list shape, plus
 *     a redirect, a stalled body and an oversized one;
 *   - a page server on 127.0.0.1 serves a host page with two <webview>
 *     guests, one on the default session and one on an in-memory
 *     `private-<uuid>` partition like a private window's, and the page each
 *     guest loads, with dns-prefetch hints in its HTML and in a `Link:`
 *     response header;
 *   - the HNS guard runs with no helper behind it, so it refuses every name it
 *     is sent.
 *
 * Roots: `hnsprobe` is listed by the first refresh, `laterprobe` only by a
 * later one, `extraprobe` by the routing loop, and `unlistedprobe` never.
 * `pirate` is built in. None of them is an ICANN TLD or otherwise reserved.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, session, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const WITHOUT_BLINK_SETTINGS = process.env.FREEDOM_PROBE_WITHOUT_BLINK_SETTINGS === '1';
if (!WITHOUT_BLINK_SETTINGS) require('../../blink-settings').applyBlinkSettings(app);

const DOH_HOST = 'doh.certprobe.test';
const LISTED = 'hnsprobe';
const LATER = 'laterprobe';
const EXTRA = 'extraprobe';
const UNLISTED = 'unlistedprobe';
const PIRATE = 'pirate';
// The names that exist while the resolver answers as an ordinary one.
const ORDINARY_NAMES = new Set([`www.${LISTED}`, `app.${LATER}`, `app.${LISTED}`, `www.${UNLISTED}`]);
const DISCOVERY_PATH = '/public/hns/namespaces/v1';
const GUESTS = ['default', 'private'];
const ROUTING_ROUNDS = 20;

app.commandLine.appendSwitch('host-resolver-rules', `MAP ${DOH_HOST} 127.0.0.1`);
// The probe's one window closes half way through; the app must outlive it.
app.on('window-all-closed', () => {});
// The Jest wrapper owns the profile directory and removes it when this process
// and its GPU and Crashpad children are gone; a direct run makes its own.
const OWN_USER_DATA = !process.env.FREEDOM_PROBE_USER_DATA;
const PROBE_USER_DATA =
  process.env.FREEDOM_PROBE_USER_DATA ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-discovery-probe-'));
app.setPath('userData', PROBE_USER_DATA);
// logger.js writes beside a test profile, never to the default logs path.
process.env.FREEDOM_TEST_USER_DATA = PROBE_USER_DATA;
process.on('exit', () => {
  if (!OWN_USER_DATA) return;
  try {
    fs.rmSync(PROBE_USER_DATA, { recursive: true, force: true });
  } catch {
    /* cleaned up with the temp dir */
  }
});

const { record, response } = require('../../../../test/helpers/hns-dns-fixtures');

// ---- The resolver -----------------------------------------------------------

const dnsQueries = [];
let fabricate = false;

function questionOf(message) {
  let offset = 12;
  const labels = [];
  while (message[offset]) {
    labels.push(message.subarray(offset + 1, offset + 1 + message[offset]).toString('latin1'));
    offset += message[offset] + 1;
  }
  return { name: labels.join('.').toLowerCase(), type: message.readUInt16BE(offset + 1) };
}

function answerDns(message) {
  const { name, type } = questionOf(message);
  dnsQueries.push(name);
  if (!fabricate && !ORDINARY_NAMES.has(name)) return response(message, [[], [], []], 0x8183);
  const answers = type === 1 ? [record(name, 1, Buffer.from([127, 0, 0, 1]))] : [];
  return response(message, [answers, [], []], 0x8180);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startResolver() {
  const fixtures = path.join(__dirname, '../../../../test/fixtures/cert-verify-concurrency-tls');
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(fixtures, 'cert-verify-test.key')),
      cert: fs.readFileSync(path.join(fixtures, 'cert-verify-test.crt')),
    },
    (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const message = req.method === 'GET'
          ? Buffer.from(new URL(req.url, `https://${DOH_HOST}`).searchParams.get('dns') || '', 'base64url')
          : Buffer.concat(chunks);
        if (message.length < 17) {
          res.writeHead(400);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/dns-message' });
        res.end(answerDns(message));
      });
    }
  );
  return listen(server);
}

// ---- The discovery server ---------------------------------------------------

let listedRoots = [LISTED];
const discoveryRequests = [];

function listBody() {
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    generated_at: new Date(now).toISOString(),
    roots: listedRoots.map((root) => ({ root, expires_at: new Date(now + 3 * 24 * 3600 * 1000).toISOString() })),
  });
}

function startDiscovery() {
  const server = http.createServer((req, res) => {
    discoveryRequests.push({ path: req.url, headers: { ...req.headers } });
    if (req.url === DISCOVERY_PATH) {
      // Cacheable, so only `cache: 'no-store'` makes a second request reach here.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      res.end(listBody());
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: DISCOVERY_PATH });
      res.end();
    } else if (req.url === '/stall') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"version":1,');
    } else if (req.url === '/oversized') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const body = listBody().padEnd(70 * 1024, ' ');
      for (let at = 0; at < body.length; at += 4096) res.write(body.slice(at, at + 4096));
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return listen(server);
}

// ---- The page server --------------------------------------------------------

// The hinted names each guest's page carries, by hint form. `img` names are
// fetched, after every hint: the unlisted one is the control that reaches the
// resolver whether or not prefetching is on.
function hintedNames(guest) {
  return {
    header: [LISTED, PIRATE, UNLISTED].map((root) => `header-${guest}.${root}`),
    html: [LISTED, PIRATE, UNLISTED].map((root) => `html-${guest}.${root}`),
    img: [LISTED, PIRATE, UNLISTED].map((root) => `img-${guest}.${root}`),
  };
}

function startPages(closedPortNumber, privatePartition) {
  const server = http.createServer((req, res) => {
    const [, kind, guest] = req.url.split('/');
    if (kind === 'host') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>host</title>' +
          `<webview id="default" src="/hints/default"></webview>` +
          `<webview id="private" partition="${privatePartition}" src="/hints/private"></webview>`
      );
      return;
    }
    if (kind !== 'hints' || !GUESTS.includes(guest)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const names = hintedNames(guest);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      link: names.header.map((name) => `<//${name}>; rel=dns-prefetch`).join(', '),
    });
    res.end(
      `<!doctype html><title>hints ${guest}</title>` +
        names.html.map((name) => `<link rel="dns-prefetch" href="//${name}">`).join('') +
        names.img.map((name) => `<img src="https://${name}:${closedPortNumber}/x.png">`).join('')
    );
  });
  return listen(server);
}

// A port nothing listens on: bound once, then released.
function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function within(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ value }), (err) => ({ error: String(err && err.message).slice(0, 200) })),
    settle(ms).then(() => ({ timedOut: true })),
  ]);
}

// Resolves once `predicate()` holds, or after `ms`; reports which, and when.
async function until(predicate, ms) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= ms) return { met: false, ms: Date.now() - started };
    await settle(25);
  }
  return { met: true, ms: Date.now() - started };
}

async function main() {
  const resolverPort = await startResolver();
  const discoveryPort = await startDiscovery();
  const closed = await closedPort();
  const privatePartition = `private-${crypto.randomUUID()}`;
  const pagePort = await startPages(closed, privatePartition);
  const discoveryOrigin = `http://127.0.0.1:${discoveryPort}`;

  const ses = session.defaultSession;
  const privateSession = session.fromPartition(privatePartition);
  for (const target of [ses, privateSession]) {
    target.setSpellCheckerLanguages([]);
    target.setCertificateVerifyProc((request, callback) => callback(request.hostname === DOH_HOST ? 0 : -3));
  }
  app.configureHostResolver({
    secureDnsMode: 'secure',
    secureDnsServers: [`https://${DOH_HOST}:${resolverPort}/dns-query`],
  });

  // Loaded only now: the logger reads the probe's own profile.
  const networkManager = require('../../network-manager');
  let fatal = null;
  networkManager.initializeSessionRouting((code) => { fatal = code; });
  networkManager.setHnsProtectionRequired(true);
  await networkManager.rebuild();

  const route = (host, target = ses) => target.resolveProxy(`https://${host}/`);
  const refresh = async () => {
    const list = await networkManager.fetchHnsNamespaces({ url: `${discoveryOrigin}${DISCOVERY_PATH}` });
    networkManager.setImportedHnsRoots([...list.roots.keys()]);
    await networkManager.rebuild();
    return [...list.roots.keys()];
  };
  // Every name the resolver was asked for while `run` ran.
  const observe = async (run) => {
    dnsQueries.length = 0;
    const value = await run();
    await settle(200);
    return { ...value, queried: [...new Set(dnsQueries)] };
  };

  const results = {
    electron: process.versions.electron,
    blinkSettings: app.commandLine.getSwitchValue('blink-settings'),
    guard: `PROXY ${networkManager.getHnsProxyAddr()}`,
  };

  // ---- 1. Before any list: a dotted name is asked of ordinary DNS first ----
  results.beforeDiscovery = await observe(async () => ({ existing: await route(`app.${LISTED}`) }));

  results.firstRefresh = await refresh();

  // ---- 2. A listed root whose names also resolve in ordinary DNS ----------
  results.ordinaryDns = await observe(async () => ({
    listed: await route(`www.${LISTED}`),
    unlisted: await route(`www.${UNLISTED}`),
  }));

  // ---- 3. A resolver that fabricates answers for missing names -----------
  results.honestResolver = await observe(async () => ({ unlistedMissing: await route(`gone.${UNLISTED}`) }));
  fabricate = true;
  results.fabricatingResolver = await observe(async () => ({
    listedMissing: await route(`missing.${LISTED}`),
    unlistedMissing: await route(`missing.${UNLISTED}`),
  }));
  fabricate = false;

  // ---- 4. Fetches from the main process ------------------------------------
  results.fetches = await observe(async () => ({
    listed: await within(ses.fetch(`https://fetch.${LISTED}/`), 10_000),
    pirate: await within(ses.fetch(`https://fetch.${PIRATE}/`), 10_000),
    unlisted: await within(ses.fetch(`https://fetch.${UNLISTED}:${closed}/`), 10_000),
  }));

  // ---- 5. Pages in a normal and a private-window <webview> ------------------
  // The private guest's partition is enrolled in routing the way a private
  // window's is, before anything loads on it.
  await networkManager.registerProxySession(privateSession);
  dnsQueries.length = 0;
  const guests = new Map();
  const host = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } });
  host.webContents.on('did-attach-webview', (_event, guest) => {
    guests.set(guest.session === privateSession ? 'private' : 'default', guest);
  });
  const hostLoad = await within(host.loadURL(`http://127.0.0.1:${pagePort}/host`), 10_000);
  // Each page's hints come before its images, and the control run shows their
  // lookups arriving first, so once the unlisted image has been looked up for
  // both guests every hint has been acted on. The control run also waits for
  // the default guest's unlisted hints themselves. An in-memory partition
  // makes no prefetch lookup even with prefetching on (measured on Electron
  // 44.9.3), so it waits for none from the private guest.
  const awaited = [
    ...GUESTS.map((guest) => `img-${guest}.${UNLISTED}`),
    ...(WITHOUT_BLINK_SETTINGS ? [`html-default.${UNLISTED}`, `header-default.${UNLISTED}`] : []),
  ];
  const pagesSeen = await until(() => awaited.every((name) => dnsQueries.includes(name)), 15_000);
  const navigated = {};
  for (const guest of GUESTS) {
    const contents = guests.get(guest);
    navigated[guest] = contents
      ? await within(contents.loadURL(`https://nav-${guest}.${LISTED}/`), 10_000)
      : { missing: true };
  }
  await settle(200);
  results.pages = {
    hostLoad,
    pagesSeen,
    guestSessions: Object.fromEntries([...guests].map(([guest, contents]) => [guest, contents.session === privateSession ? 'private' : 'default'])),
    navigated,
    queriedInOrder: [...dnsQueries],
  };
  host.destroy();

  // ---- 6. What the discovery request itself sends -------------------------
  await ses.cookies.set({ url: discoveryOrigin, name: 'probe-session', value: 'probe-cookie' });
  discoveryRequests.length = 0;
  // The control: the same session's default fetch does send the cookie.
  await within(ses.fetch(`${discoveryOrigin}${DISCOVERY_PATH}`).then((res) => res.text()), 10_000);
  const control = discoveryRequests.splice(0);
  const twice = [await refresh(), await refresh()];
  results.request = {
    controlCookie: control.map((entry) => entry.headers.cookie ?? null),
    lists: twice,
    paths: discoveryRequests.map((entry) => entry.path),
    cookies: discoveryRequests.map((entry) => entry.headers.cookie ?? null),
    headerNames: discoveryRequests.map((entry) => Object.keys(entry.headers).sort()),
  };
  discoveryRequests.length = 0;
  results.redirect = await within(networkManager.fetchHnsNamespaces({ url: `${discoveryOrigin}/redirect` }), 10_000);
  results.redirect.paths = discoveryRequests.map((entry) => entry.path);
  const stallStarted = Date.now();
  results.stall = await within(networkManager.fetchHnsNamespaces({ url: `${discoveryOrigin}/stall` }), 10_000);
  results.stall.ms = Date.now() - stallStarted;
  results.oversized = await within(networkManager.fetchHnsNamespaces({ url: `${discoveryOrigin}/oversized` }), 10_000);

  // ---- 7. A root added after the last refresh -----------------------------
  // Read straight after the refresh, with no wait: once a rebuild resolves,
  // every session's routing must already answer.
  const enrolled = session.fromPartition(`probe-enrolled-${crypto.randomUUID()}`);
  enrolled.setSpellCheckerLanguages([]);
  await networkManager.registerProxySession(enrolled);
  const sessions = { defaultSession: ses, enrolled, privateSession };
  const routeAll = async (name) => Object.fromEntries(await Promise.all(
    Object.entries(sessions).map(async ([label, target]) => [label, await route(name, target)])
  ));
  results.addedRoot = { before: await route(`app.${LATER}`) };
  listedRoots = [LISTED, LATER];
  results.addedRoot.refresh = await refresh();
  results.addedRoot.after = await observe(async () => routeAll(`app.${LATER}`));

  // ---- 8. Repeated root-set changes, read straight after each one ---------
  // Each change rebuilds and reloads every session's PAC; a lookup that fails
  // right after one is a session left without its routing.
  const failures = [];
  for (let round = 0; round < ROUTING_ROUNDS; round += 1) {
    networkManager.setImportedHnsRoots(round % 2 ? [LISTED, LATER] : [LISTED, LATER, EXTRA]);
    await networkManager.rebuild();
    for (const [label, answer] of Object.entries(await routeAll(`app.${LISTED}`))) {
      if (answer !== results.guard) failures.push({ round, session: label, answer });
    }
  }
  results.routingRounds = { rounds: ROUTING_ROUNDS, sessions: Object.keys(sessions), failures };

  results.fatal = fatal;
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
