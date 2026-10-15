// Installed Linux evaluation acceptance for Handshake browsing.
//
// Drives the installed package the way a person does: type each HNS address
// into the real address bar, wait for the page to render over the app's own
// HNS stack (local hnsd chain authority, encrypted delegated DNS, local
// DNSSEC/DANE checks behind the guard proxy), then quit the app completely and
// relaunch it against the same profile and do it again. Nothing here stubs or
// bypasses the network path, so the run proves whatever network the machine
// is on: run it with the VPN connected to prove VPN-on browsing.
//
// Opt-in, because it needs the public HNS test hosts and real chain sync:
//
//   FREEDOM_E2E_HNS_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/hns-browsing.spec.js
//
// FREEDOM_E2E_HNS_HOSTS overrides the hosts and expected page titles as
// `host=title regexp` pairs separated by `;`. The defaults are the staging
// hosts the workspace owner named for this gate; their titles are staging data
// and can change, in which case pass the current ones rather than loosening
// the check. FREEDOM_E2E_HNS_UNCLAIMED names a host under a served root that
// no community or member owns; the gateway must refuse it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget, isPackagedRun } = require('../packaged-launch');
const { closeApp } = require('../close-app');

const ENABLED = process.env.FREEDOM_E2E_HNS_LIVE === '1';

const DEFAULT_HOSTS = [
  ['app.pirate', 'Videos for you'],
  ['app.8s28', 'E2E HNS 8s28'],
  ['membertest.8s28', 'Community test creator'],
  ['app.a18n', 'HNS a18n staging'],
  ['journeytest.a18n', 'staging_operator'],
];

function configuredHosts() {
  const raw = process.env.FREEDOM_E2E_HNS_HOSTS;
  if (!raw) return DEFAULT_HOSTS;
  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      if (at <= 0) throw new Error(`FREEDOM_E2E_HNS_HOSTS entry needs host=title: ${pair}`);
      return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
    });
}

const HOSTS = configuredHosts();
const UNCLAIMED = process.env.FREEDOM_E2E_HNS_UNCLAIMED || `nobody-${Date.now().toString(36)}.8s28`;

// The first navigation also waits out hnsd's initial chain sync from the
// packaged checkpoint, which took about half a minute on the owner's machine.
const FIRST_RENDER_TIMEOUT_MS = 5 * 60_000;
const RENDER_TIMEOUT_MS = 90_000;

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

// The committed document in the active tab, with its main-frame HTTP status
// from Navigation Timing (0 for a document that was not fetched over HTTP).
const pageIdentity = (window) =>
  evalInActiveWebview(
    window,
    'JSON.stringify({ host: location.host, protocol: location.protocol, title: document.title, ' +
      'search: location.pathname.endsWith("/pages/error.html") ? location.search : "", ' +
      'status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0 })'
  ).then((value) => (value ? JSON.parse(value) : null));

// Drive the address bar the way a user would: focus, type, Enter.
async function navigate(window, address) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
}

// Retries the navigation itself while hnsd is still syncing: until the chain
// is ready the guard refuses HNS hosts, and the app shows an error page rather
// than retrying on its own.
async function expectRendered(window, host, titlePattern, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    await navigate(window, host);
    const attemptEnd = Math.min(deadline, Date.now() + 30_000);
    while (Date.now() < attemptEnd) {
      last = await pageIdentity(window);
      if (last && last.host === host && last.protocol === 'https:' && new RegExp(titlePattern).test(last.title)) {
        return last;
      }
      await window.waitForTimeout(1_000);
    }
  }
  throw new Error(`${host} did not render a page titled /${titlePattern}/ within ${timeout} ms; last seen ${JSON.stringify(last)}`);
}

async function launch(dirs) {
  const app = await launchApp({
    ...packagedLaunchTarget(),
    cwd: path.resolve(__dirname, '..', '..'),
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
// resources (the HNS and dVPN helpers), found by walking the app's tree.
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

// Quit the way a user does and require a clean shutdown: the app exits by
// itself with code 0 (never killed at the launcher's quit deadline), and every
// helper it started is gone afterwards. Returns the evidence for the report.
async function quitCleanly(app, resourcesDir, phase) {
  const helpers = packagedHelpers(app.process().pid, resourcesDir);
  expect(helpers.map((proc) => path.basename(proc.exe)), `the HNS helpers were running (${phase})`).toEqual(
    expect.arrayContaining(['hnsd', 'fingertipd'])
  );
  await closeApp(app, { timeout: 100_000 });
  const exit = app.exitResult();
  expect(exit, `the app must quit by itself with code 0 (${phase})`).toEqual({ code: 0, signal: null, forced: false });
  let survivors = [];
  await expect
    .poll(
      () => {
        const table = processTable();
        survivors = helpers.filter((proc) => table.get(proc.pid)?.start === proc.start);
        return survivors.length;
      },
      { message: `helpers left running after quit (${phase})`, timeout: 15_000, intervals: [500] }
    )
    .toBe(0);
  return { exit, helpers: helpers.map((proc) => ({ pid: proc.pid, exe: proc.exe })), survivors };
}

// The main-frame HTTP status every tab saw for `host`, read from each guest
// webview's own network events. It holds whether Chromium committed the
// response or turned an empty error response into a load failure.
async function watchDocumentStatus(app, host) {
  const statuses = [];
  const sessions = [];
  for (const page of app.context().pages()) {
    if (/\/renderer\/index\.html(?:[?#]|$)/.test(page.url())) continue;
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Network.responseReceived', ({ type, response }) => {
      try {
        if (type === 'Document' && new URL(response.url).host === host) statuses.push(response.status);
      } catch {
        // Not a URL with a host.
      }
    });
    await cdp.send('Network.enable');
    sessions.push(cdp);
  }
  return {
    statuses,
    stop: () => Promise.all(sessions.map((cdp) => cdp.detach().catch(() => {}))),
  };
}

test.describe('installed HNS browsing', () => {
  test.skip(!ENABLED, 'set FREEDOM_E2E_HNS_LIVE=1 to browse the public HNS test hosts');
  test.skip(ENABLED && !isPackagedRun(), 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary');

  test('opens every HNS host, refuses an unclaimed one, and does it again after a full restart', async () => {
    test.setTimeout(20 * 60_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-acceptance-'));
    const dirs = {
      userData: path.join(root, 'userData'),
      ant: path.join(root, 'ant-data'),
      ipfs: path.join(root, 'ipfs-data'),
      identity: path.join(root, 'identity'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    // Only HNS is under test; the other bundled nodes stay off.
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

    // The installed package's resources directory, next to its executable.
    const resourcesDir = fs.realpathSync(path.join(path.dirname(packagedLaunchTarget().executablePath), 'resources'));
    let session = null;
    try {
      for (const phase of ['first launch', 'after full restart']) {
        session = await launch(dirs);
        const { window } = session;
        let first = true;
        for (const [host, title] of HOSTS) {
          const seen = await expectRendered(window, host, title, first ? FIRST_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS);
          test.info().annotations.push({ type: phase, description: `${host}: ${seen.title}` });
          first = false;
        }
        // The gateway answers an empty 421 for a name nobody owns. Chromium
        // either commits that response or fails the load with
        // ERR_HTTP_RESPONSE_CODE_FAILURE, which Freedom shows on its error
        // page, so the page alone cannot tell a 421 from an empty 500: the
        // guest's own network events must report 421 as well. A DNS, tunnel or
        // certificate failure, a script failure or a catch-all page fails here.
        const documentStatus = await watchDocumentStatus(session.app, UNCLAIMED);
        await navigate(window, UNCLAIMED);
        let unclaimed = null;
        await expect
          .poll(
            async () => {
              unclaimed = await pageIdentity(window);
              if (!unclaimed) return null;
              if (unclaimed.host === UNCLAIMED && unclaimed.protocol === 'https:') return `status ${unclaimed.status}`;
              const params = new URLSearchParams(unclaimed.search);
              const failed = params.get('url') ? new URL(params.get('url')).host : null;
              return failed === UNCLAIMED ? `error ${params.get('error')}` : null;
            },
            { message: `${UNCLAIMED} must reach the gateway and be refused (${phase})`, timeout: RENDER_TIMEOUT_MS, intervals: [1_000] }
          )
          .toMatch(/^(status 421|error ERR_HTTP_RESPONSE_CODE_FAILURE)$/);
        await documentStatus.stop();
        expect(documentStatus.statuses, `${UNCLAIMED} main-frame response status (${phase})`).toEqual([421]);
        test.info().annotations.push({
          type: phase,
          description: `${UNCLAIMED}: ${JSON.stringify({ ...unclaimed, responseStatuses: documentStatus.statuses })}`,
        });
        const quit = await quitCleanly(session.app, resourcesDir, phase);
        session = null;
        test.info().annotations.push({ type: phase, description: `quit: ${JSON.stringify(quit)}` });
      }
    } finally {
      if (session) await closeApp(session.app, { timeout: 100_000 }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
