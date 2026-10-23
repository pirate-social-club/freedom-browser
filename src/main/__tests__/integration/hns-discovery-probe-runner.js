// Process and evidence ownership for the synthetic HNS integration probe.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runProbe({ electronPath, probePath, timeoutMs, env = {}, spawnImpl = spawn,
  evidenceRoot = process.env.FREEDOM_HNS_PROBE_EVIDENCE_DIR }) {
  const childEnv = { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '' };
  const mode = childEnv.FREEDOM_PROBE_WITHOUT_BLINK_SETTINGS === '1' ? 'control' : 'protected';
  let evidenceDirectory;
  if (evidenceRoot) {
    if (!path.isAbsolute(evidenceRoot)) throw new Error('HNS probe evidence directory must be absolute');
    fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    evidenceDirectory = fs.mkdtempSync(path.join(evidenceRoot, `${mode}-`));
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-discovery-probe-'));
  const started = Date.now();
  const receipt = {
    mode, startedAt: new Date(started).toISOString(), timeoutMs,
    wrapperVersions: { ...process.versions }, pid: null,
    closed: false, exitCode: null, signal: null, timedOut: false,
    spawnError: null, parseError: null, resultFound: false,
  };
  const stdout = [];
  const stderr = [];
  const output = () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
  const retain = () => {
    if (!evidenceDirectory) return;
    const bytes = output();
    const write = (name, data) => fs.writeFileSync(path.join(evidenceDirectory, name), data, { mode: 0o600 });
    write('stdout.log', bytes.stdout);
    write('stderr.log', bytes.stderr);
    write('process.json', JSON.stringify({ ...receipt,
      observedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      stdoutBytes: bytes.stdout.length, stderrBytes: bytes.stderr.length,
    }, null, 2) + '\n');
  };
  const removeProfile = () => fs.rmSync(userData, { recursive: true, force: true });

  return new Promise((resolve, reject) => {
    let child;
    let timer;
    const fail = (error) => {
      try { retain(); } catch (captureError) {
        reject(new Error(`HNS probe evidence capture failed: ${captureError.message}; ${error.message}`));
        return;
      }
      reject(error);
    };
    try {
      child = spawnImpl(electronPath, ['--no-sandbox', '--headless', probePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...childEnv, FREEDOM_PROBE_USER_DATA: userData },
      });
      receipt.pid = child.pid ?? null;
    } catch (error) {
      receipt.spawnError = error.message;
      removeProfile();
      fail(error);
      return;
    }
    timer = setTimeout(() => {
      receipt.timedOut = true;
      child.kill('SIGKILL');
      const bytes = output();
      fail(new Error(`probe timed out after ${timeoutMs}ms\n${bytes.stdout}\n${bytes.stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      receipt.spawnError = error.message;
      removeProfile();
      fail(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      receipt.closed = true;
      receipt.exitCode = code;
      receipt.signal = signal;
      const bytes = output();
      const line = bytes.stdout.toString('utf8').split('\n').find((entry) => entry.startsWith('PROBE-RESULT '));
      receipt.resultFound = Boolean(line);
      let result;
      if (line) {
        try { result = JSON.parse(line.slice('PROBE-RESULT '.length)); } catch (error) {
          receipt.parseError = error.message;
        }
      }
      try {
        removeProfile();
        retain();
      } catch (error) {
        reject(error);
        return;
      }
      if (receipt.timedOut || receipt.spawnError) return;
      if (!line || receipt.parseError) {
        reject(new Error(`probe produced ${line ? 'invalid JSON' : 'no result'}\nstdout:\n${bytes.stdout}\nstderr:\n${bytes.stderr}`));
        return;
      }
      // Preserve the existing integration assertions. The diagnostic also
      // evaluates the retained exit code; it is never discarded as before.
      resolve(result);
    });
  });
}

module.exports = { runProbe };
