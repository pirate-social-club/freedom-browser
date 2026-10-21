/**
 * Integration test: a session's certificate verifier decides every request,
 * including ones issued concurrently with the first request to a host
 * (electron#55046, fixed in Electron 44.9.0). Handshake browsing depends on
 * that verifier for DANE (`src/main/hns-manager.js`), so a request that fell
 * back to Chromium's default verification would not be the request DANE
 * approved.
 *
 * This can only be shown from a real Electron main process: the probe
 * `cert-verify-concurrency-electron-probe.js` issues a second request to each
 * fresh host from inside the verifier while the first is still unverified, on
 * an in-memory session with a throwaway certificate that only the verifier
 * accepts. Skipped when the Electron binary cannot be resolved; the
 * ipfs-gateway-proxy CI job sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a
 * missing binary into a failure instead.
 */

const { spawn } = require('child_process');
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

const PROBE = path.join(__dirname, 'cert-verify-concurrency-electron-probe.js');
const PROBE_TIMEOUT_MS = 90_000;

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_PATH, ['--no-sandbox', '--headless', PROBE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
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

describeWithElectron('certificate verifier under concurrent first requests', () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  test("Chromium's default verification refuses the fixture, so only the verifier can accept it", () => {
    expect(results.defaultVerdicts.length).toBeGreaterThan(0);
    expect(results.defaultVerdicts).not.toContain(0);
  });

  test('a request issued while the first to its host is unverified is still the verifier\'s', () => {
    expect(results.acceptedFailures).toEqual([]);
    expect(results.acceptedCount).toBe(results.hosts.length * 2);
  });

  test('the verifier saw every host, and a host it refuses stays refused', () => {
    expect(results.verifiedHosts).toEqual(
      [...results.hosts, 'refused.certprobe.test'].sort()
    );
    expect(results.refusedOk).toBe(0);
  });
});
