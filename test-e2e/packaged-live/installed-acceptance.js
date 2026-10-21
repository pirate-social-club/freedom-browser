// Shared helpers for the installed-browser acceptance specs in this directory
// (hns-browsing, nodes, swarm-retrieval, ipfs-retrieval, radicle-viewer).
//
// Packaged specs reach only the renderer, over CDP: there is no main-process
// evaluate against a packaged build (packaged-launch.js). Everything a spec
// knows about the processes behind it therefore comes from two places: the
// chrome window's own bridges (`window.serviceRegistry`, `window.ant`,
// `window.ipfs`, `window.radicle`), and Linux's /proc. The /proc readers here
// are Linux-only, like the installed .deb they exist to accept.
//
// Not a spec: playwright.config.js collects only `*.spec.js`, so this file is
// never run on its own. Its pure functions have unit tests in
// installed-acceptance.test.js.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget, CHROME_PAGE } = require('../packaged-launch');
const { closeApp } = require('../close-app');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// The installed package and its processes

// The installed package's resources directory, next to its executable.
function installedResourcesDir() {
  return fs.realpathSync(
    path.join(path.dirname(fs.realpathSync(packagedLaunchTarget().executablePath)), 'resources')
  );
}

// Linux process inventory from /proc: pid, parent pid, start time (clock
// ticks since boot, so a reused pid is told apart) and the executable path.
function processTable() {
  const table = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let exe = null;
      try {
        exe = fs.readlinkSync(`/proc/${name}/exe`);
      } catch {
        // Another user's process, or a kernel thread.
      }
      table.set(Number(name), { pid: Number(name), ppid: Number(fields[1]), start: fields[19], exe });
    } catch {
      // Exited while the table was read.
    }
  }
  return table;
}

// Every process the launched app started from the installed package's own
// resources (antd, the HNS and dVPN helpers), found by walking the app's tree.
function packagedHelpers(appPid, resourcesDir) {
  const table = processTable();
  const children = new Map();
  for (const proc of table.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  const helpers = [];
  const queue = [...(children.get(appPid) || [])];
  while (queue.length) {
    const proc = queue.shift();
    if (proc.exe && proc.exe.startsWith(`${resourcesDir}${path.sep}`)) helpers.push(proc);
    queue.push(...(children.get(proc.pid) || []));
  }
  return helpers;
}

// Every process anywhere on the machine running an executable from the
// installed package's resources. A helper that was reparented away from the
// app (a restarted fingertipd's hnsd, say) or left by an earlier run shows here.
function anyPackagedHelpers(resourcesDir) {
  return [...processTable().values()].filter((proc) => proc.exe && proc.exe.startsWith(`${resourcesDir}${path.sep}`));
}

// Quit the way a user does and require a clean shutdown: the app exits by
// itself with code 0 (never killed at the launcher's quit deadline), and no
// process from the package's resources is left anywhere. `requiredHelpers`
// names helpers that must have been running at quit, so the survivor check
// cannot pass vacuously for them. Returns the evidence.
async function quitCleanly(app, resourcesDir, phase, { requiredHelpers = [], label = 'the helpers' } = {}) {
  const helpers = packagedHelpers(app.process().pid, resourcesDir);
  if (requiredHelpers.length) {
    expect(helpers.map((proc) => path.basename(proc.exe)), `${label} were running (${phase})`).toEqual(
      expect.arrayContaining(requiredHelpers)
    );
  }
  await closeApp(app, { timeout: 100_000 });
  const exit = app.exitResult();
  expect(exit, `the app must quit by itself with code 0 (${phase})`).toEqual({ code: 0, signal: null, forced: false });
  let survivors = [];
  await expect
    .poll(
      () => {
        survivors = anyPackagedHelpers(resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));
        return survivors.length;
      },
      { message: `packaged helpers left running after quit (${phase})`, timeout: 15_000, intervals: [500] }
    )
    .toBe(0);
  return { exit, helpers: helpers.map((proc) => ({ pid: proc.pid, exe: proc.exe })), survivors };
}

// pid, parent pid, executable, command line and state of one process, or null.
function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let exe = null;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // Not ours, or exiting.
    }
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return { pid, ppid: Number(fields[1]), state: fields[0], exe, cmdline };
  } catch {
    return null;
  }
}

// Gone, or a zombie nobody has reaped yet: either way no longer running.
function isRunningPid(pid) {
  const info = processInfo(pid);
  return Boolean(info) && info.state !== 'Z' && info.state !== 'X';
}

// ---------------------------------------------------------------------------
// Sockets, from /proc/net/tcp and /proc/<pid>/fd

// One /proc/net/tcp{,6} table as rows: local address and port, state, inode.
function parseProcNetTcp(text, family) {
  return text
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 10)
    .map((cols) => {
      const [address, port] = cols[1].split(':');
      return { family, address, port: parseInt(port, 16), state: cols[3], inode: Number(cols[9]) };
    });
}

// Every TCP socket in the LISTEN state (0A) on `port`, any address, v4 or v6.
function tcpListeners(port) {
  const rows = [];
  for (const [file, family] of [['/proc/net/tcp', 4], ['/proc/net/tcp6', 6]]) {
    try {
      rows.push(...parseProcNetTcp(fs.readFileSync(file, 'utf8'), family));
    } catch {
      // No IPv6 table on this host.
    }
  }
  return rows.filter((row) => row.port === port && row.state === '0A');
}

// The pids whose open descriptors include socket `inode`. Only this user's
// processes are readable, which covers everything the launched app started.
function pidsHoldingSocket(inode) {
  const needle = `socket:[${inode}]`;
  const pids = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${name}/fd/${fd}`) === needle) {
          pids.push(Number(name));
          break;
        }
      } catch {
        // Closed while it was read.
      }
    }
  }
  return pids;
}

// The files a process holds open, as resolved paths.
function openFiles(pid) {
  const files = [];
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      files.push(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
    } catch {
      // Closed while it was read.
    }
  }
  return files;
}

// /proc/<pid>/maps entries for files whose path ends with `suffix`, with the
// device and inode the mapping was made from.
function mappedFiles(pid, suffix) {
  const seen = new Map();
  for (const line of fs.readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const file = cols.slice(5).join(' ');
    if (!file.endsWith(suffix)) continue;
    seen.set(`${cols[3]}:${cols[4]}:${file}`, { device: cols[3], inode: Number(cols[4]), path: file });
  }
  return [...seen.values()];
}

function canConnect(port, host = '127.0.0.1', timeout = 2_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Expected native digests: never literals in a spec

const INVENTORY_FILE = path.join(REPO_ROOT, 'scripts', 'linux-native-inventory.json');
const DIGESTS_VAR = 'FREEDOM_EXPECTED_NATIVE_DIGESTS';
const ANTD_PATH = 'resources/ant-bin/antd';
const IPFS_ADDON_PATH = 'resources/freedom-ipfs-node/freedom_ipfs_native.node';

// path → sha256 from either an inventory (`files: [{ path, sha256 }]`, the
// shape of scripts/linux-native-inventory.json) or a flat `{ path: sha256 }`
// object. Anything that is not a 64-hex digest is ignored.
function digestMap(data) {
  const entries = Array.isArray(data?.files)
    ? data.files.map((file) => [file.path, file.sha256])
    : Object.entries(data || {});
  return new Map(entries.filter(([, digest]) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)));
}

// The digests the installed antd and IPFS addon must have. They come from the
// inventory at the commit under test, or, when FREEDOM_EXPECTED_NATIVE_DIGESTS
// names a JSON file, from that inspection input instead (a baseline built
// before the inventory's pins moved has its own digests).
function expectedNativeDigests() {
  const named = (process.env[DIGESTS_VAR] || '').trim();
  const source = named ? path.resolve(named) : INVENTORY_FILE;
  const map = digestMap(JSON.parse(fs.readFileSync(source, 'utf8')));
  const result = { source, antd: map.get(ANTD_PATH) || null, ipfsAddon: map.get(IPFS_ADDON_PATH) || null };
  for (const [key, file] of [['antd', ANTD_PATH], ['ipfsAddon', IPFS_ADDON_PATH]]) {
    if (!result[key]) throw new Error(`${source} gives no sha256 for ${file}`);
  }
  return result;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

// ---------------------------------------------------------------------------
// Pinned references

const REFERENCES_FILE = path.join(__dirname, 'pinned-references.json');

function pinnedReferences() {
  return JSON.parse(fs.readFileSync(REFERENCES_FILE, 'utf8'));
}

// The binary form of a base32 CIDv1 (`b…`), which is how freedom-ipfs keys
// its `blocks` table. CIDv0 and other bases are refused rather than guessed.
function cidV1Bytes(cid) {
  if (typeof cid !== 'string' || !/^b[a-z2-7]+$/.test(cid)) {
    throw new Error(`not a base32 CIDv1: ${cid}`);
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cid.slice(1)) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Scratch profile and launch

// Every bundled node off. A spec turns on the one under test.
const NODES_OFF = {
  startAntAtLaunch: false,
  startIpfsAtLaunch: false,
  startRadicleAtLaunch: false,
  enableTorIntegration: false,
  startTorAtLaunch: false,
};

// One scratch root per run, holding the profile and every node's data
// directory, each created empty. The live fixtures use the same layout:
// ant-data and ipfs-data beside the profile, not inside it.
function makeScratchRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dirs = {
    root,
    userData: path.join(root, 'userData'),
    ant: path.join(root, 'ant-data'),
    ipfs: path.join(root, 'ipfs-data'),
    identity: path.join(root, 'identity'),
    radicle: path.join(root, 'rad'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function listScratch(dirs) {
  return Object.fromEntries(
    Object.entries(dirs)
      .filter(([key]) => key !== 'root')
      .map(([key, dir]) => [key, fs.readdirSync(dir).sort()])
  );
}

// Launch the installed browser on the scratch profile, through the packaged
// launcher, and wait for its chrome window's address bar.
async function launchInstalled(dirs, { settings, args = [], env = {} }) {
  fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify(settings));
  const target = packagedLaunchTarget();
  const app = await launchApp({
    ...target,
    args: [...target.args, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
      FREEDOM_TEST_USER_DATA: dirs.userData,
      FREEDOM_ANT_DATA: dirs.ant,
      FREEDOM_IPFS_DATA: dirs.ipfs,
      FREEDOM_IDENTITY_DATA: dirs.identity,
      FREEDOM_RADICLE_DATA: dirs.radicle,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    timeout: 90_000,
  });
  try {
    const window = await app.firstWindow({ timeout: 90_000 });
    await window.waitForLoadState('domcontentloaded', { timeout: 90_000 });
    await window.waitForSelector('[data-test="address-input"]', { state: 'visible', timeout: 90_000 });
    return { app, window };
  } catch (error) {
    await closeApp(app, { timeout: 100_000 }).catch(() => {});
    throw error;
  }
}

// FREEDOM_E2E_EVIDENCE_DIR, or a fresh temporary directory.
function evidenceDir(prefix) {
  const dir = process.env.FREEDOM_E2E_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Node managers, through the chrome window (from nodes.spec.js)

// Poll until the manager reaches a state it will not leave on its own —
// 'running' or 'error'. Waiting for 'running' directly would spend the whole
// budget on a node that already reported 'error' and then fail with a bare
// timeout instead of the manager's own message.
async function waitForNodeToSettle(window, api, { label, timeout }) {
  let last = null;

  await expect
    .poll(
      async () => {
        last = await window.evaluate((name) => window[name].getStatus(), api);
        return last.status === 'running' || last.status === 'error';
      },
      {
        message: `Waiting for the packaged ${label} node to finish starting`,
        timeout,
        intervals: [1_000, 2_000],
      }
    )
    .toBe(true);

  return last;
}

async function expectNodeRunning(window, api, { label, timeout }) {
  const status = await waitForNodeToSettle(window, api, { label, timeout });

  expect(status.status, `${label} did not start: ${status.error || 'no error reported'}`).toBe(
    'running'
  );

  return status;
}

// The address the app itself published for a service, e.g.
// 'http://127.0.0.1:1634' for Ant. Read from the registry rather than
// hardcoded: the configured port is per profile, and a busy port makes the
// manager fall back to the next free one (both true on a dev machine that
// already runs a node).
const registryEntry = (window, service) =>
  window.evaluate(async (name) => (await window.serviceRegistry.getRegistry())[name], service);

// One read of a node's registry entry and manager status, taken together.
async function readNodeState(window, service) {
  const state = await window.evaluate(async (name) => {
    const registry = (await window.serviceRegistry.getRegistry())[name];
    const { status, error } = await window[name].getStatus();
    return {
      mode: registry.mode,
      api: registry.api,
      gateway: registry.gateway,
      backend: registry.backend ?? null,
      status,
      error: error ?? null,
    };
  }, service);
  return { at: new Date().toISOString(), ...state };
}

// What clearService leaves behind (src/main/service-registry.js): mode none,
// with no API or gateway, and never an external or reused node.
function isClearedState(state) {
  return state.mode === 'none' && state.api === null && state.gateway === null;
}

// ---------------------------------------------------------------------------
// The active tab

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

const activeHref = (window) => evalInActiveWebview(window, 'location.href');

async function navigate(window, value) {
  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(value);
  await address.press('Enter');
}

// A window's first tab loads its start page after the address bar is already
// visible, and that load clears the bar, so typing too early can submit
// nothing. Wait for the start page, navigate, and type again once if the tab
// is still on it (the same handling as tor-proxy-refusal.spec.js).
const START_PAGE = /\/pages\/(home|private)\.html(?:$|[?#])/;

async function navigateFromStartPage(window, value, timeout = 60_000) {
  await expect
    .poll(
      async () =>
        START_PAGE.test(String(await activeHref(window))) &&
        (await evalInActiveWebview(window, 'document.readyState')) === 'complete',
      { message: 'the tab must finish loading its start page', timeout }
    )
    .toBe(true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await navigate(window, value);
    try {
      await expect.poll(async () => START_PAGE.test(String(await activeHref(window))), { timeout: 10_000 }).toBe(false);
      return;
    } catch {
      // Still on the start page: the keystrokes were lost to its load.
    }
  }
}

// A load the chrome itself starts in the active tab's webview, bypassing the
// address bar's own routing: the request goes straight to the scheme's
// protocol handler. Not awaited, since a refused load never resolves cleanly.
function loadInActiveWebview(window, url) {
  return window.evaluate((target) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview) return false;
    webview.loadURL(target).catch(() => {});
    return true;
  }, url);
}

// The query of Freedom's error page (renderer/pages/error.html), or null when
// `href` is not that page.
function errorPageParams(href) {
  if (typeof href !== 'string' || !/\/pages\/error\.html\?/.test(href)) return null;
  const params = new URL(href).searchParams;
  return {
    error: params.get('error'),
    url: params.get('url'),
    protocol: params.get('protocol'),
    retry: params.get('retry'),
  };
}

// Wait for the active tab to land on the error page and return its query.
async function waitForErrorPage(window, accept, { timeout = 60_000, message } = {}) {
  let shown = null;
  let last = null;
  await expect
    .poll(
      async () => {
        last = await activeHref(window);
        const params = errorPageParams(last);
        if (params && accept(params)) shown = { href: last, ...params };
        return Boolean(shown);
      },
      { message: `${message || 'the tab must show the error page'} (last: ${last})`, timeout, intervals: [250, 500] }
    )
    .toBe(true);
  return shown;
}

// Every main-frame document each tab webview loads whose URL `match`es, from
// the guests' own DevTools Network events: the status, MIME type and the
// response body Chromium received, whether or not the page then rendered it.
// Attach before the navigation; stop() detaches.
async function watchDocuments(app, match) {
  const documents = [];
  const sessions = [];
  for (const page of app.context().pages()) {
    if (CHROME_PAGE.test(page.url())) continue;
    const cdp = await page.context().newCDPSession(page);
    const byId = new Map();
    cdp.on('Network.requestWillBeSent', ({ requestId, request, type, redirectResponse }) => {
      if (type !== 'Document') return;
      let doc = byId.get(requestId);
      if (!doc) {
        if (!match(request.url)) return;
        doc = { requestId, requestedUrl: request.url, startedAt: Date.now(), redirects: [] };
        byId.set(requestId, doc);
        documents.push(doc);
      } else if (redirectResponse) {
        doc.redirects.push({ url: redirectResponse.url, status: redirectResponse.status });
      }
    });
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      const doc = byId.get(requestId);
      if (!doc) return;
      doc.url = response.url;
      doc.status = response.status;
      doc.mimeType = response.mimeType;
      doc.respondedAt = Date.now();
    });
    cdp.on('Network.loadingFinished', ({ requestId }) => {
      const doc = byId.get(requestId);
      if (!doc) return;
      doc.finishedAt = Date.now();
      doc.bodyRead = cdp
        .send('Network.getResponseBody', { requestId })
        .then(({ body, base64Encoded }) => {
          doc.body = Buffer.from(body, base64Encoded ? 'base64' : 'utf8');
        })
        .catch((error) => {
          doc.bodyError = error.message;
        });
    });
    cdp.on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
      const doc = byId.get(requestId);
      if (!doc) return;
      doc.failedAt = Date.now();
      doc.errorText = errorText;
      doc.canceled = Boolean(canceled);
    });
    await cdp.send('Network.enable', { maxResourceBufferSize: 32 * 1024 * 1024, maxTotalBufferSize: 64 * 1024 * 1024 });
    sessions.push(cdp);
  }

  // The first matching document that finished loading or failed, with its
  // body read, within `timeout`.
  async function settled(predicate = () => true, timeout = 60_000) {
    let found = null;
    await expect
      .poll(
        () => {
          found = documents.find((doc) => (doc.finishedAt || doc.failedAt) && predicate(doc)) || null;
          return Boolean(found);
        },
        { message: 'a matching document must finish loading', timeout, intervals: [100, 250, 500] }
      )
      .toBe(true);
    if (found.bodyRead) await found.bodyRead;
    return found;
  }

  return {
    documents,
    guests: sessions.length,
    settled,
    stop: () => Promise.all(sessions.map((cdp) => cdp.detach().catch(() => {}))),
  };
}

// A document record without its body, for evidence files.
function describeDocument(doc) {
  if (!doc) return null;
  const { bodyRead: _bodyRead, body, ...rest } = doc;
  return {
    ...rest,
    bodyLength: body ? body.length : null,
    bodySha256: body ? sha256(body) : null,
  };
}

// ---------------------------------------------------------------------------
// Node stores

// Copy an SQLite database with its -wal and -shm files, when present, into
// `destDir` (new and empty), and open the copy read-only. The original is
// never opened.
function copySqlite(source, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const copied = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = path.join(destDir, path.basename(from));
    fs.copyFileSync(from, to);
    copied[path.basename(from)] = { bytes: fs.statSync(to).size, sha256: sha256File(to) };
  }
  if (!copied[path.basename(source)]) throw new Error(`${source} does not exist`);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(destDir, path.basename(source)), { readOnly: true });
  return { db, copied };
}

// ---------------------------------------------------------------------------
// The native IPFS node's progress record

// The phase an item names, normalized the way the renderer's own reader does
// (src/renderer/lib/ipfs-progress-status.js candidatePhase).
function progressPhase(item) {
  const raw = item?.phase || item?.current_phase || item?.last_phase || item?.event;
  return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[-\s]+/g, '_') : '';
}

// The progress events (`{ list: 'events', seenAt, item }` as collected) of
// the requests that name `cid`, in the node's own event order. The `active`
// list only mirrors each request's latest phase, so it is left out.
function progressItemsFor(collected, cid) {
  const requestIds = new Set(
    collected
      .filter(({ item }) => JSON.stringify(item).includes(cid))
      .map(({ item }) => item.request_id)
      .filter((id) => id !== undefined && id !== null)
  );
  return collected
    .filter(({ list, item }) => list === 'events' && (requestIds.has(item.request_id) || JSON.stringify(item).includes(cid)))
    .sort((a, b) => (a.item.event_id ?? 0) - (b.item.event_id ?? 0));
}

const FETCH_PHASES = new Set(['fetching_bitswap', 'fetching_http_provider']);

// Where, in event order, the node checked its cache, first fetched from the
// network and then stored a block, and whether any cache hit occurred. The
// freedom-ipfs addon (0.4.5 and 0.4.6) never emits `cache_miss`: a cold
// request runs checking_cache, provider_lookup, a fetch phase and
// block_store_put. A cache miss and its fetch are still reported if a later
// addon emits them.
function phaseOrderEvidence(items) {
  const phases = items.map(({ item }) => progressPhase(item));
  const cacheMissAt = phases.indexOf('cache_miss');
  const checkingCacheAt = phases.indexOf('checking_cache');
  let fetchAt = -1;
  if (cacheMissAt !== -1) {
    fetchAt = phases.findIndex((phase, index) => index > cacheMissAt && FETCH_PHASES.has(phase));
  }
  const firstFetchAt = phases.findIndex((phase) => FETCH_PHASES.has(phase));
  const blockStorePutAt =
    firstFetchAt === -1 ? -1 : phases.findIndex((phase, index) => index > firstFetchAt && phase === 'block_store_put');
  const hitLimit = fetchAt === -1 ? phases.length : fetchAt;
  return {
    phases,
    rawPhases: items.map(({ item }) => item.raw_phase ?? null),
    cacheMissAt: cacheMissAt === -1 ? null : cacheMissAt,
    fetchAt: fetchAt === -1 ? null : fetchAt,
    fetchPhase: fetchAt === -1 ? null : phases[fetchAt],
    cacheHitBeforeFetch: phases.slice(0, hitLimit).includes('cache_hit'),
    firstFetchAt: firstFetchAt === -1 ? null : firstFetchAt,
    firstFetchPhase: firstFetchAt === -1 ? null : phases[firstFetchAt],
    checkingCacheAt: checkingCacheAt === -1 ? null : checkingCacheAt,
    blockStorePutAt: blockStorePutAt === -1 ? null : blockStorePutAt,
    cacheHits: phases.filter((phase) => phase === 'cache_hit').length,
  };
}

// ---------------------------------------------------------------------------
// Chromium's NetLog

// Hosts of public Swarm and IPFS HTTP gateways, path- and subdomain-style.
const PUBLIC_GATEWAY_HOST =
  /(^|\.)(gateway\.ethswarm\.org|bzz\.link|bzz\.limo|swarm-gateways\.net|gateway\.fairdatasociety\.org|eth\.limo|eth\.link|ipfs\.io|dweb\.link|w3s\.link|storacha\.link|nftstorage\.link|cloudflare-ipfs\.com|gateway\.pinata\.cloud|mypinata\.cloud|ipfs\.filebase\.io|4everland\.io|gateway\.lighthouse\.storage|flk-ipfs\.xyz|trustless-gateway\.link|ipfs\.runfission\.com|cf-ipfs\.com)$/i;
const GATEWAY_PATH = /^\/(bzz:?|bytes|chunks|ipfs|ipns)\//i;
const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i;

// Every URL request Chromium started, from its NetLog, and those that went to
// a public Swarm or IPFS gateway: a known gateway host, a non-loopback URL
// with a gateway-style path or a `.ipfs.`/`.ipns.` subdomain, or any
// non-loopback URL that names one of `references`.
function scanNetlogForGateways(netlogFile, references = []) {
  const log = JSON.parse(fs.readFileSync(netlogFile, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const urls = [];
  for (const event of log.events) {
    if (types[event.type] === 'URL_REQUEST_START_JOB' && event.phase === 1 && event.params?.url) {
      urls.push(event.params.url);
    }
  }
  return classifyRequestUrls(urls, references);
}

function classifyRequestUrls(urls, references = []) {
  const schemes = {};
  const hosts = new Set();
  const gatewayRequests = [];
  const lowerRefs = references.map((ref) => ref.toLowerCase());
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    schemes[parsed.protocol] = (schemes[parsed.protocol] || 0) + 1;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const host = parsed.hostname;
    if (LOOPBACK_HOST.test(host)) continue;
    hosts.add(host);
    const reasons = [];
    if (PUBLIC_GATEWAY_HOST.test(host)) reasons.push('public gateway host');
    if (GATEWAY_PATH.test(parsed.pathname)) reasons.push('gateway path');
    if (/\.(ipfs|ipns)\./i.test(host)) reasons.push('subdomain gateway');
    if (lowerRefs.some((ref) => url.toLowerCase().includes(ref))) reasons.push('names a pinned reference');
    if (reasons.length) gatewayRequests.push({ url, reasons });
  }
  return { requests: urls.length, schemes, hosts: [...hosts].sort(), gatewayRequests };
}

module.exports = {
  REPO_ROOT,
  NODES_OFF,
  installedResourcesDir,
  processTable,
  packagedHelpers,
  anyPackagedHelpers,
  quitCleanly,
  processInfo,
  isRunningPid,
  parseProcNetTcp,
  tcpListeners,
  pidsHoldingSocket,
  openFiles,
  mappedFiles,
  canConnect,
  DIGESTS_VAR,
  digestMap,
  expectedNativeDigests,
  sha256,
  sha256File,
  pinnedReferences,
  cidV1Bytes,
  makeScratchRoot,
  listScratch,
  launchInstalled,
  evidenceDir,
  writeJson,
  waitForNodeToSettle,
  expectNodeRunning,
  registryEntry,
  readNodeState,
  isClearedState,
  evalInActiveWebview,
  activeHref,
  navigate,
  navigateFromStartPage,
  loadInActiveWebview,
  errorPageParams,
  waitForErrorPage,
  watchDocuments,
  describeDocument,
  copySqlite,
  progressPhase,
  progressItemsFor,
  phaseOrderEvidence,
  scanNetlogForGateways,
  classifyRequestUrls,
};
