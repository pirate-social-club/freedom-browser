// Probe instrumentation only. Never imported by the product application.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isMainThread } = require('node:worker_threads');

const context = isMainThread ? 'main' : 'worker';

function report(type, fields = {}) {
  const line = 'RUNTIME_FETCH_PROBE ' + JSON.stringify({ type, context, ...fields }) + '\n';
  if (Buffer.byteLength(line) > 4096) throw new Error('Probe event budget exceeded');
  fs.writeSync(1, line);
}

function errorIdentity(error) {
  return {
    name: String(error?.name || 'unknown').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80),
    code: String(error?.code || error?.cause?.code || 'unknown').replace(/[^A-Z0-9_]/g, '').slice(0, 80),
  };
}

function observeRuntime() {
  // An explicit diagnostic exit prevents Electron's default error dialog.
  // Observing this event does not establish an uninstrumented browser crash.
  process.on('uncaughtExceptionMonitor', (error) => {
    report('uncaught-error', errorIdentity(error));
  });
  process.prependListener('uncaughtException', () => process.exit(42));
  let builtinSource = { available: false };
  try {
    const source = process.binding('natives')['internal/deps/undici/undici'];
    if (typeof source === 'string' && Buffer.byteLength(source) <= 4 * 1024 ** 2) {
      builtinSource = { available: true, bytes: Buffer.byteLength(source),
        sha256: crypto.createHash('sha256').update(source).digest('hex') };
    }
  } catch { /* Missing embedded-source evidence remains unknown. */ }
  report('runtime', {
    versions: { electron: process.versions.electron, node: process.versions.node, undici: process.versions.undici },
    builtinSource,
  });
}

async function request(origin) {
  try {
    const response = await fetch(origin);
    const value = await response.json();
    report('fetch-completed', { status: response.status, bodyMatches: value?.ok === true && Object.keys(value).length === 1 });
  } catch (error) {
    report('fetch-rejected', errorIdentity(error));
  }
  // Read the existing dispatcher only; importing an external Undici here
  // would change the very runtime being measured. Closing this isolated
  // probe's agent is a completion barrier, not a retry or timing delay.
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (!dispatcher || typeof dispatcher.close !== 'function') {
    report('completion-unavailable');
    return false;
  }
  await dispatcher.close();
  await new Promise((resolve) => setImmediate(resolve));
  report('request-settled');
  return true;
}

module.exports = { report, observeRuntime, request };
