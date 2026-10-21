/**
 * Integration test: name-resolution and chain traffic follow the Electron
 * session of the window it is for (`src/main/browsing-transport.js`). A private
 * window's ENS lookups, the Colibri verifier's prover and RPC requests and the
 * gateway transport's dials go out through that window's partition and its
 * proxy, never through the default session's, and never DIRECT when that
 * proxy cannot be reached.
 *
 * Like `ens-ccip-proxy.test.js`, this can only be proven from a real Electron
 * main process — the unit suites pin the wiring on a fake `net.request`, not
 * Chromium's routing. This spawns Electron on
 * `session-transport-proxy-electron-probe.js`, which drives the real gateway
 * transport, the real quorum-leg provider and the real Colibri worker host and
 * worker against two local SOCKS5 recorders (one per session) and a local
 * HTTPS origin that tells which recorder each connection came through, and
 * asserts the probe's report. Nothing it dials leaves the machine.
 *
 * Skipped when the Electron binary cannot be resolved; the `ipfs-gateway-proxy`
 * CI job sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a missing binary into
 * a failure instead (see `ipfs-gateway-proxy.test.js` for the details, including
 * why CI fetches the binary before jest starts).
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

const PROBE = path.join(__dirname, 'session-transport-proxy-electron-probe.js');
const PROBE_TIMEOUT_MS = 90_000;
const HOST = 'ccip.example.test';

function runProbe() {
  return new Promise((resolve, reject) => {
    // Owned here, not by the probe: Electron's GPU and Crashpad children can
    // recreate it after the probe exits, and a SIGKILL runs no handler.
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-session-transport-probe-'));
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

describeWithElectron('session-bound name-resolution transport in a real Electron process', () => {
  let results;
  let origin;

  beforeAll(async () => {
    results = await runProbe();
    origin = `${HOST}:${results.originPort}`;
  }, PROBE_TIMEOUT_MS);

  const viaOnly = (leg, recorder) => {
    expect(leg.originRoutes.length).toBeGreaterThan(0);
    expect(leg.originRoutes.every((entry) => entry.via === recorder)).toBe(true);
    expect(leg.directConnections).toBe(0);
  };

  test('a gateway dial named for the private session goes through its proxy only', () => {
    expect(results.fetchB.value).toEqual({ status: 200, body: 'ok' });
    expect(results.fetchB.recorderB).toEqual([origin]);
    expect(results.fetchB.recorderA).toEqual([]);
    viaOnly(results.fetchB, 'B');
  });

  test("and one named for the default session goes through the default session's", () => {
    expect(results.fetchA.value).toEqual({ status: 200, body: 'ok' });
    expect(results.fetchA.recorderA).toEqual([origin]);
    expect(results.fetchA.recorderB).toEqual([]);
    viaOnly(results.fetchA, 'A');
  });

  // No silent fallback: a session whose proxy is down gets a failed request,
  // not a direct connection to the origin.
  test('an unreachable proxy fails the request and nothing reaches the origin', () => {
    expect(results.fetchC.error).toMatch(/ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS/);
    expect(results.fetchC.originRoutes).toEqual([]);
    expect(results.fetchC.directConnections).toBe(0);
    expect(results.fetchC.recorderA).toEqual([]);
    expect(results.fetchC.recorderB).toEqual([]);
  });

  // The control: the origin does see a direct connection when one is made, so
  // the zero counts above are observations, not blind spots.
  test('a direct connection to the origin is detected when there is one', () => {
    expect(results.fetchDirectControl.value).toEqual({ status: 200, body: 'ok' });
    expect(results.fetchDirectControl.originRoutes).toEqual([{ route: 'x', via: 'direct' }]);
    expect(results.fetchDirectControl.directConnections).toBeGreaterThan(0);
  });

  test("the ENS quorum-leg provider sends its JSON-RPC on the session it was created in", () => {
    expect(results.ensB.value).toBe('0x1');
    expect(results.ensB.recorderB).toEqual([origin]);
    expect(results.ensB.recorderA).toEqual([]);
    expect(results.ensB.originRoutes).toEqual([{ route: 'rpc', via: 'B' }]);
    expect(results.ensB.directConnections).toBe(0);

    expect(results.ensA.value).toBe('0x1');
    expect(results.ensA.recorderA).toEqual([origin]);
    expect(results.ensA.recorderB).toEqual([]);
    expect(results.ensA.originRoutes).toEqual([{ route: 'rpc', via: 'A' }]);
    expect(results.ensA.directConnections).toBe(0);
  });

  // The verifier itself runs in a worker thread with no network of its own;
  // the fake prover makes the request fail, which is fine — what matters is
  // which way its traffic went.
  test("the Colibri worker's network goes out through the bridge on the client's session", () => {
    expect(results.colibriB.timedOut).toBeUndefined();
    expect(results.colibriB.recorderB).toContain(origin);
    expect(results.colibriB.recorderA).toEqual([]);
    expect(results.colibriB.originRoutes.some((entry) => entry.route === 'prover')).toBe(true);
    viaOnly(results.colibriB, 'B');
  });

  test("retiring the private session tears down every request in flight on it", () => {
    expect(results.retireB.reachedHang).toBe(true);
    // The bridge fetch, a plain gateway dial and an ENS quorum leg, the last
    // two with no caller signal: only the session's retirement ended them.
    expect(results.retireB.hangRequests).toBeGreaterThanOrEqual(3);
    expect(results.retireB.openBeforeRetire).toBe(results.retireB.hangRequests);
    expect(results.retireB.plainFetch.code).toBe('SESSION_UNAVAILABLE');
    expect(results.retireB.ensLeg.timedOut).toBeUndefined();
    expect(results.retireB.ensLeg.error).toMatch(/Browsing session unavailable/);
    expect(results.retireB.allClosed).toBe(true);
    expect(results.retireB.closeMs).toBeLessThan(2_000);
  });

  test('and nothing new is dialled on it afterwards', () => {
    expect(results.afterRetireB.fetch.code).toBe('SESSION_UNAVAILABLE');
    // Refused before it reaches a worker: a retired session's workers are gone
    // with its verifier state, and none is spawned for it again.
    expect(results.afterRetireB.bridge.code).toBe('SESSION_UNAVAILABLE');
    expect(results.afterRetireB.recorderB).toEqual([]);
    expect(results.afterRetireB.recorderA).toEqual([]);
    expect(results.afterRetireB.originRoutes).toEqual([]);
    expect(results.afterRetireB.directConnections).toBe(0);
  });

  test('a private caller without a session is refused rather than given the default one', () => {
    expect(results.privateWithoutSession).toEqual({ threw: true, code: 'SESSION_UNAVAILABLE' });
    expect(results.noContextIsDefault).toBe(true);
  });
});
