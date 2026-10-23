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
 *     `private-<uuid>` partition like a private window's, and the pages each
 *     guest loads, before and after a theme change, with dns-prefetch hints
 *     in their HTML and in a `Link:` response header;
 *   - the HNS guard runs with no helper behind it, so it refuses every name it
 *     is sent.
 *
 * Roots: `hnsprobe` is listed by the first refresh, `laterprobe` only by a
 * later one, `extraprobe` by the routing loop, and `unlistedprobe` never.
 * `pirate` is built in. None of them is an ICANN TLD or otherwise reserved.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, session, BrowserWindow, nativeTheme, netLog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const WITHOUT_BLINK_SETTINGS = process.env.FREEDOM_PROBE_WITHOUT_BLINK_SETTINGS === '1';
const NET_LOG_PATH = process.env.FREEDOM_HNS_PROBE_NET_LOG_PATH;
const NET_LOG_MAX_BYTES = 8 * 1024 * 1024;
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
// Lookups may arrive with a search suffix appended (see this module).
const { expectedNameOf } = require('./hns-discovery-probe-names');

// ---- The resolver -----------------------------------------------------------

const dnsQueries = [];
// Every lookup of the whole run, never reset, with its time since start.
const allDnsQueries = [];
const started = Date.now();
const phaseTimings = [];
const phase = (name) => {
  const entry = { name, ms: Date.now() - started };
  phaseTimings.push(entry);
  process.stdout.write(`PROBE-PHASE ${JSON.stringify(entry)}\n`);
};
process.stdout.write(`PROBE-START ${JSON.stringify({ versions: process.versions, platform: process.platform,
  arch: process.arch, withoutBlinkSettings: WITHOUT_BLINK_SETTINGS })}\n`);
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
  allDnsQueries.push({ name, ms: Date.now() - started });
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
// resolver whether or not prefetching is on. `round` tells the first page
// from the second, loaded after a web preferences update.
function hintedNames(guest, round = '') {
  return {
    header: [LISTED, PIRATE, UNLISTED].map((root) => `header-${guest}${round}.${root}`),
    html: [LISTED, PIRATE, UNLISTED].map((root) => `html-${guest}${round}.${root}`),
    img: [LISTED, PIRATE, UNLISTED].map((root) => `img-${guest}${round}.${root}`),
  };
}

function startPages(closedPortNumber, privatePartition) {
  const server = http.createServer((req, res) => {
    const [, kind, guest, round = ''] = req.url.split('/');
    if (kind === 'host') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>host</title>' +
          `<webview id="default" src="/hints/default"></webview>` +
          `<webview id="private" partition="${privatePartition}" src="/hints/private"></webview>`
      );
      return;
    }
    if (kind !== 'hints' || !GUESTS.includes(guest) || !['', 'r2'].includes(round)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const names = hintedNames(guest, round && `-${round}`);
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
// `refresh` updates what the predicate reads, before each check.
async function until(predicate, ms, refresh = async () => {}) {
  const since = Date.now();
  for (;;) {
    await refresh();
    if (predicate()) return { met: true, ms: Date.now() - since };
    if (Date.now() - since >= ms) return { met: false, ms: Date.now() - since };
    await settle(25);
  }
}

async function main() {
  phase('ready');
  if (NET_LOG_PATH) {
    if (!path.isAbsolute(NET_LOG_PATH)) throw new Error('Network log path must be absolute');
    await netLog.startLogging(NET_LOG_PATH, { captureMode: 'default', maxFileSize: NET_LOG_MAX_BYTES });
  }
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
    versions: { ...process.versions },
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
  phase('pages-start');
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
  const seen = (name) => dnsQueries.some((queried) => expectedNameOf(queried, [name]) !== null);
  // Each round is read once both guests' unlisted images, fetched after the
  // page's hints, have been looked up. The control run also waits for every
  // hint of the default guest, which it requires. The private guest's
  // prefetching is intermittent even with prefetching on (all of its hints or
  // none, about half the runs each, on Electron 44.9.3), so nothing waits for
  // those.
  const awaitRound = (round) => until(() => [
    ...GUESTS.map((guest) => hintedNames(guest, round).img[2]),
    ...(WITHOUT_BLINK_SETTINGS ? [...hintedNames('default', round).header, ...hintedNames('default', round).html] : []),
  ].every(seen), 15_000);
  const pagesSeen = await awaitRound('');
  phase('first-round-observed');

  // A theme change sends every renderer a web preferences update, so this
  // shows whether the startup prefetch setting survives one: each guest must
  // first report the new colour scheme, then load a second page of hints.
  const prefersDark = async (contents) => {
    try {
      return await contents.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches");
    } catch {
      return null;
    }
  };
  // Light first, then dark, each observed in both guests, so at least one
  // update is seen to change what the pages report.
  const themeTo = async (source) => {
    nativeTheme.themeSource = source;
    let reported = [];
    return until(() => reported.length === GUESTS.length && reported.every((dark) => dark === (source === 'dark')), 10_000,
      async () => {
        reported = await Promise.all(GUESTS.map((guest) => (guests.get(guest) ? prefersDark(guests.get(guest)) : null)));
      });
  };
  const themeApplied = { light: await themeTo('light'), dark: await themeTo('dark') };
  phase('theme-observed');
  const secondLoads = {};
  for (const guest of GUESTS) {
    const contents = guests.get(guest);
    secondLoads[guest] = contents
      ? await within(contents.loadURL(`http://127.0.0.1:${pagePort}/hints/${guest}/r2`), 10_000)
      : { missing: true };
  }
  const secondPagesSeen = await awaitRound('-r2');
  phase('second-round-observed');
  nativeTheme.themeSource = 'system';
  const loadedAtMs = Date.now() - started;

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
    themeApplied,
    secondLoads,
    secondPagesSeen,
    loadedAtMs,
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

  // Prefetch hint lookups over the whole run. The sections after the pages
  // keep the run going for several more seconds, so a hint acted on late is
  // still seen here; the control run shows how late that can be.
  results.hintLookups = allDnsQueries
    .filter(({ name }) => /^(header|html)-/.test(name))
    .map(({ name, ms }) => ({ name, afterPagesMs: ms - results.pages.loadedAtMs }));
  results.dnsLookups = allDnsQueries;
  results.runMs = Date.now() - started;
  phase('complete');
  results.phaseTimings = phaseTimings;
  results.fatal = fatal;
  if (NET_LOG_PATH) {
    await netLog.stopLogging();
    results.networkLog = { stopped: true, captureMode: 'default', maxFileSize: NET_LOG_MAX_BYTES };
  }
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch(async (err) => {
    if (NET_LOG_PATH && netLog.currentlyLogging) {
      try { await netLog.stopLogging(); } catch (error) {
        process.stderr.write(`PROBE-NET-LOG-FAILED ${error.message}\n`);
      }
    }
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
