/**
 * Integration test: namespace discovery decides, in Chromium itself, which
 * names go to the Handshake guard without an ordinary DNS lookup first
 * (`src/main/network-manager.js`, `fetchHnsNamespaces` and
 * `setImportedHnsRoots`), and its own request carries no cookie, takes no
 * redirect and keeps no cache.
 *
 * The unit suites pin the PAC text and the fetch options on fakes, and infer
 * from the PAC that a listed root is never looked up. This spawns Electron on
 * `hns-namespace-discovery-electron-probe.js`, which runs Chromium's resolver
 * against a local DNS-over-HTTPS server so every lookup is seen where it is
 * made, rather than inferred, and asserts the probe's report. Nothing it dials
 * leaves the machine.
 *
 * Skipped when the Electron binary cannot be resolved; the `ipfs-gateway-proxy`
 * CI job sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a missing binary into
 * a failure instead (see `ipfs-gateway-proxy.test.js` for the details).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED = process.env.FREEDOM_ELECTRON_NET_TEST === '1';

function electronBinaryPath() {
  try {
    // Outside Electron, `require('electron')` resolves to the installed
    // binary's path (the package's own `path.txt`), on every platform.
    const resolved = jest.requireActual('electron');
    return typeof resolved === 'string' ? resolved : null;
  } catch {
    return null;
  }
}

const ELECTRON_PATH = electronBinaryPath();
if (REQUIRED && !ELECTRON_PATH) {
  throw new Error(
    'FREEDOM_ELECTRON_NET_TEST=1 but no Electron binary is installed — fetch it with ' +
      '`node -e "require(\'electron\')"` (npm ci does not, at any --ignore-scripts setting)'
  );
}
const describeWithElectron = ELECTRON_PATH ? describe : describe.skip;

const PROBE = path.join(__dirname, 'hns-namespace-discovery-electron-probe.js');
const PROBE_TIMEOUT_MS = 90_000;
const LISTED = 'hnsprobe';
const UNLISTED = 'unlistedprobe';

const under = (root) => (name) => name === root || name.endsWith(`.${root}`);

function runProbe() {
  return new Promise((resolve, reject) => {
    // Owned here, not by the probe: Electron's GPU and Crashpad children can
    // recreate it after the probe exits, and a SIGKILL runs no handler.
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-discovery-probe-'));
    const child = spawn(ELECTRON_PATH, ['--no-sandbox', '--headless', PROBE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', FREEDOM_PROBE_USER_DATA: userData },
    });
    child.on('close', () => fs.rmSync(userData, { recursive: true, force: true }));
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms\n${stdout}\n${stderr}`));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((entry) => entry.startsWith('PROBE-RESULT '));
      if (!line) {
        reject(new Error(`probe produced no result\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice('PROBE-RESULT '.length)));
    });
  });
}

describeWithElectron('HNS namespace discovery in a real Electron process', () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  test('runs on a live guard with no routing failure', () => {
    expect(results.guard).toMatch(/^PROXY 127\.0\.0\.1:\d+$/);
    expect(results.fatal).toBeNull();
    expect(results.firstRefresh).toEqual([LISTED]);
  });

  // The baseline the list exists to change: with only `.pirate` built in, a
  // dotted name is first asked of ordinary DNS and goes DIRECT when it exists.
  test('before any list, a name under the root is looked up in ordinary DNS and goes DIRECT', () => {
    expect(results.beforeDiscovery.existing).toBe('DIRECT');
    expect(results.beforeDiscovery.queried).toEqual([`app.${LISTED}`]);
  });

  test('a listed root goes to the guard even for a name that also resolves in ordinary DNS', () => {
    expect(results.ordinaryDns.listed).toBe(results.guard);
    expect(results.ordinaryDns.unlisted).toBe('DIRECT');
    expect(results.ordinaryDns.queried).toEqual([`www.${UNLISTED}`]);
  });

  // A resolver that answers every name would send an unlisted Handshake name
  // DIRECT to whatever it made up; a listed root never asks it.
  test('a resolver that fabricates answers cannot pull a listed root off the guard', () => {
    expect(results.honestResolver.unlistedMissing).toBe(results.guard);
    expect(results.fabricatingResolver.unlistedMissing).toBe('DIRECT');
    expect(results.fabricatingResolver.listedMissing).toBe(results.guard);
    expect(results.fabricatingResolver.queried).toEqual([`missing.${UNLISTED}`]);
  });

  // Observed at the resolver, so a lookup Chromium makes before or beside the
  // PAC would show here: a fetch, a navigation, a subresource and a preconnect.
  test('no traffic under a listed root is looked up at the resolver', () => {
    const { traffic } = results;
    expect(traffic.fetched.error).toMatch(/ERR_TUNNEL_CONNECTION_FAILED/);
    expect(traffic.navigated.error).toMatch(/ERR_TUNNEL_CONNECTION_FAILED/);
    expect(traffic.page).toEqual({});
    expect(traffic.queried.filter(under(LISTED)).filter((name) => name !== `prefetch.${LISTED}`)).toEqual([]);
  });

  // The control: the same traffic for an unlisted root is seen there, so the
  // empty list above is an observation, not a blind spot.
  test('the same traffic under an unlisted root is seen at the resolver', () => {
    expect(results.traffic.queried).toEqual(expect.arrayContaining([
      `fetch.${UNLISTED}`, `img.${UNLISTED}`, `prefetch.${UNLISTED}`,
    ]));
  });

  // Known gap, not closed by discovery: Chromium resolves a page's
  // `<link rel="dns-prefetch">` hint without consulting the PAC, so a page can
  // still have any name, listed or not, looked up in ordinary DNS. Measured on
  // Electron 44.9.3 in a plain window. This fails once that is closed, and
  // should then become an ordinary test.
  test.failing('nor is a dns-prefetch hint for a name under a listed root', () => {
    expect(results.traffic.queried).not.toContain(`prefetch.${LISTED}`);
  });

  test('the request sends no cookie or header of its own and is never cached', () => {
    const { request } = results;
    // The control: the same session's own default fetch does send the cookie.
    expect(request.controlCookie).toEqual(['probe-session=probe-cookie']);
    expect(request.cookies).toEqual([null, null]);
    // A cacheable answer, asked for twice, reaches the server twice.
    expect(request.paths).toEqual(['/public/hns/namespaces/v1', '/public/hns/namespaces/v1']);
    for (const names of request.headerNames) {
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('authorization');
      expect(names.filter((name) => name.startsWith('x-'))).toEqual([]);
    }
  });

  test('a redirect is refused, not followed', () => {
    expect(results.redirect.error).toMatch(/redirect/i);
    expect(results.redirect.paths).toEqual(['/redirect']);
  });

  test('a body that stalls is unavailable at the 3-second deadline, and an oversized one at 64 KiB', () => {
    expect(results.stall.error).toBe('namespace list deadline exceeded');
    expect(results.stall.ms).toBeGreaterThanOrEqual(2_900);
    expect(results.stall.ms).toBeLessThan(4_500);
    expect(results.oversized.error).toBe('namespace list exceeds 64 KiB');
  });

  // hns-manager.test.js pins the next refresh to 10 minutes after the last;
  // this shows that refresh is all a new root needs, on every session.
  test('a root added after the last refresh goes to the guard at the next one', () => {
    const { addedRoot } = results;
    expect(addedRoot.before).toBe('DIRECT');
    expect(addedRoot.refresh).toEqual([LISTED, 'laterprobe']);
    expect(addedRoot.after.defaultSession).toBe(results.guard);
    expect(addedRoot.after.enrolled).toBe(results.guard);
    expect(addedRoot.after.queried).toEqual([]);
  });
});
