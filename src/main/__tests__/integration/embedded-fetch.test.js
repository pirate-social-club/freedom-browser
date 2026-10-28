// GHSA-xjj6-f33q-929c: a caught fetch rejection must not leave an internal
// stream whose later error terminates Electron or its worker.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lock = require('../../../../package-lock.json');

let electron;
try { electron = jest.requireActual('electron'); } catch { /* Optional outside the runtime CI job. */ }
if (typeof electron !== 'string') electron = null;
if (!electron && process.env.FREEDOM_ELECTRON_NET_TEST === '1') {
  throw new Error('Embedded fetch acceptance requires the real Electron binary');
}

(electron ? describe : describe.skip)('embedded Electron fetch', () => {
  let result;
  beforeAll(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-embedded-fetch-'));
    // Keep this profile until the enclosing CI cgroup's cleanup verifier has
    // proved every Electron descendant gone. The direct child's close event
    // alone does not establish that barrier, even on a successful run.
    console.info(`Embedded fetch profile retained for outer cleanup: ${profile}`);
    result = await new Promise((resolve, reject) => {
        const child = spawn(electron, ['--no-sandbox', '--headless', path.join(__dirname, 'embedded-fetch-electron-probe.js')], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '', FREEDOM_PROBE_USER_DATA: profile },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const lines = stdout.split('\n').filter((line) => line.startsWith('PROBE-RESULT '));
          if (timedOut || code !== 0 || signal || lines.length !== 1) {
            reject(new Error(`Embedded fetch probe failed: code=${code} signal=${signal} timeout=${timedOut}\n${stdout}\n${stderr}`));
          } else {
            try { resolve(JSON.parse(lines[0].slice('PROBE-RESULT '.length))); } catch (error) { reject(error); }
          }
        });
    });
  }, 50_000);

  test.each(['main', 'worker'])('%s handles real responses and survives rejected streams', (context) => {
    const observed = result[context];
    expect(observed.versions.electron).toBe(lock.packages['node_modules/electron'].version);
    expect(observed.versions.node).toBe('24.22.1');
    expect(observed.versions.undici).toBe('7.30.1');
    expect(observed.cases).toEqual([
      { name: 'json', status: 200, value: { ok: true } },
      { name: 'gzip', status: 200, value: { ok: true } },
      expect.objectContaining({ name: 'excessive-encoding', error: 'TypeError', cause: 'too many content-encodings in response: 6, maximum allowed is 5' }),
      expect.objectContaining({ name: 'early-close', error: 'TypeError', code: 'UND_ERR_SOCKET' }),
      { name: 'json-after-errors', status: 200, value: { ok: true } },
    ]);
    expect(result.workerExit).toBe(0);
    for (const name of ['json', 'gzip', 'excessive-encoding', 'early-close', 'json-after-errors']) {
      expect(result.served.filter((url) => url === `/${name}`)).toHaveLength(2);
    }
  });
});
