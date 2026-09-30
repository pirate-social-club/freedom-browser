#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { installHnsCheckpoint } = require('../src/main/hns-checkpoint');

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const RETRY_DELAY_MS = 5 * 1000;
const CLEANUP_RESERVE_MS = 7000;
const MAX_STARTUP_DIAGNOSTIC_BYTES = 8 * 1024;

function parseArgs(args = process.argv.slice(2)) {
  const options = {
    resourcesDir: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--resources-dir') {
      options.resourcesDir = args[index + 1] || null;
      index += 1;
    } else if (args[index] === '--timeout-ms') {
      options.timeoutMs = Number(args[index + 1]);
      index += 1;
    }
  }

  if (!options.resourcesDir) {
    throw new Error('--resources-dir is required');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= CLEANUP_RESERVE_MS) {
    throw new Error('--timeout-ms must exceed the cleanup reserve');
  }

  return options;
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('Every HNS smoke target must be a plain dotted hostname');
  }
  return hostname;
}

function getSmokeHosts(extraHost = process.env.FREEDOM_HNS_SMOKE_EXTRA_HOST) {
  if (!extraHost) {
    throw new Error(
      'FREEDOM_HNS_SMOKE_EXTRA_HOST must contain the third requested host for release validation'
    );
  }

  return Array.from(new Set([
    'app.pirate',
    'app.dankmeme',
    normalizeHostname(extraHost),
  ]));
}

function parseProxyAddress(proxyAddr) {
  const parsed = new URL(`http://${proxyAddr}`);
  const port = Number(parsed.port);
  if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Helper emitted an invalid proxy address');
  }
  return { host: parsed.hostname, port };
}

function extractStatusCode(responseHead) {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(responseHead);
  return match ? Number(match[1]) : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyHelperStartupDiagnostics(value) {
  const diagnostic = String(value || '');
  if (/libunbound[^\s]*.*(?:not found|cannot open shared object)/i.test(diagnostic)) {
    return 'the packaged HNS daemon has a missing runtime dependency';
  }
  if (/permission denied/i.test(diagnostic)) {
    return 'a packaged HNS executable could not be started';
  }
  if (/DNS sockets did not become ready/i.test(diagnostic)) {
    return 'the packaged HNS daemon did not open its resolver sockets';
  }
  if (/failed (?:starting daemon|opening (?:ns|rs))/i.test(diagnostic)) {
    return 'the packaged HNS daemon failed during startup';
  }
  return null;
}

function createSmokeBudget(timeoutMs, now = () => performance.now()) {
  const deadline = now() + timeoutMs;
  return {
    remaining: () => Math.max(0, deadline - now()),
    requestTimeout: (maximum = REQUEST_TIMEOUT_MS) => {
      const remaining = deadline - now() - CLEANUP_RESERVE_MS;
      if (remaining <= 0) throw new Error('Smoke work deadline reached');
      return Math.min(maximum, remaining);
    },
  };
}

function classifyRequestFailure(error) {
  const message = String(error?.message || '');
  const connect = /^Proxy CONNECT returned (\d{3})$/.exec(message);
  if (connect) return `connect-status-${connect[1]}`;
  const response = /^HTTPS request returned (\d{3})$/.exec(message);
  if (response) return `http-status-${response[1]}`;
  if (message === 'HTTPS request timed out') return 'request-timeout';
  if (message === 'Smoke work deadline reached') return 'work-deadline';
  const code = String(error?.code || '');
  if (/CERT|TLS|SSL/.test(code)) return 'tls-validation-or-protocol';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(code)) return 'transport-error';
  return 'request-failure';
}

async function installPackagedCheckpoint(resourcesDir, dataDir, readPackagedSource, assertActive = () => {}) {
  const modulePath = require.resolve('../src/main/hns-checkpoint');
  let packagedSource;
  if (readPackagedSource) {
    packagedSource = await readPackagedSource();
  } else {
    const { extractFile } = await import('@electron/asar');
    packagedSource = extractFile(path.join(resourcesDir, 'app.asar'), 'src/main/hns-checkpoint.js');
  }
  if (!Buffer.from(packagedSource).equals(fs.readFileSync(modulePath))) {
    throw new Error('Packaged checkpoint validator differs from reviewed source');
  }
  assertActive();
  return installHnsCheckpoint(path.join(resourcesDir, 'assets/hns/checkpoint_main.dat'), dataDir);
}

async function installCheckpointWithinBudget(resourcesDir, dataDir, budget, readPackagedSource) {
  let closed = false;
  try {
    const timeout = budget.requestTimeout(30000);
    return await withTimeout(installPackagedCheckpoint(resourcesDir, dataDir, readPackagedSource, () => {
      if (closed) throw new Error('Checkpoint stage closed');
      budget.requestTimeout();
    }), timeout);
  } finally {
    // A timed-out import may still finish. It must never recreate cleaned state.
    closed = true;
  }
}

async function reservePortWithinBudget(excluded, budget) {
  const cancellation = new AbortController();
  try {
    const timeout = budget.requestTimeout();
    return await withTimeout(reserveDualProtocolPort(excluded, cancellation.signal), timeout);
  } finally {
    cancellation.abort();
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Smoke work deadline reached')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reserveTcpPort(signal) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) {
        server.close(() => {});
        reject(error);
      } else resolve(port);
    };
    const abort = () => finish(new Error('Port reservation cancelled'));
    server.once('error', (error) => finish(error));
    // Keep this guard installed after cancellation: listen may complete late.
    server.once('listening', () => {
      if (settled || signal?.aborted) {
        server.close(() => {});
        return;
      }
      const port = server.address().port;
      server.close((error) => finish(error, port));
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    server.listen(0, '127.0.0.1');
  });
}

function canBindUdpPort(port, signal) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    let settled = false;
    const close = () => {
      try { socket.close(); } catch { /* Already closed or not yet bound. */ }
    };
    const finish = (available) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      close();
      resolve(available);
    };
    const abort = () => finish(false);
    socket.once('error', () => finish(false));
    socket.once('listening', () => {
      if (settled || signal?.aborted) close();
      else finish(true);
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.bind(port, '127.0.0.1');
  });
}

async function reserveDualProtocolPort(excluded = new Set(), signal) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (signal?.aborted) throw new Error('Port reservation cancelled');
    const port = await reserveTcpPort(signal);
    if (!excluded.has(port) && await canBindUdpPort(port, signal)) return port;
  }
  throw new Error('Could not reserve an HNS resolver port');
}

function waitForHelperReady(child, timeoutMs = 30 * 1000) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Packaged HNS helper did not become ready')),
      timeoutMs
    );

    const finish = (error, event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.off('close', onClose);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(event);
    };
    const onError = () => finish(new Error('Packaged HNS helper could not start'));
    const onClose = (code) => finish(new Error(`Packaged HNS helper exited before ready (${code})`));

    child.once('close', onClose);
    child.once('error', onError);
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'ready' && event.proxyAddr && event.caPath) {
          finish(null, event);
        } else if (event.type === 'error') {
          const category = classifyHelperStartupDiagnostics(event.error) ||
            'the packaged HNS helper reported a startup failure';
          finish(new Error(category));
        }
      } catch {
        // Ignore non-JSON helper output.
      }
    });
  });
}

function requestHttpsThroughProxy({ proxyAddr, ca, hostname, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const proxy = parseProxyAddress(proxyAddr);
    const socket = net.connect(proxy.port, proxy.host);
    let settled = false;
    let connectHead = Buffer.alloc(0);

    const finish = (error, statusCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(statusCode);
    };
    const timer = setTimeout(() => finish(new Error('HTTPS request timed out')), timeoutMs);

    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nConnection: keep-alive\r\n\r\n`
      );
    });

    const onConnectData = (chunk) => {
      connectHead = Buffer.concat([connectHead, chunk]);
      const headerEnd = connectHead.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      socket.off('data', onConnectData);
      const responseHead = connectHead.subarray(0, headerEnd).toString('latin1');
      const connectStatus = extractStatusCode(responseHead);
      if (connectStatus !== 200) {
        finish(new Error(`Proxy CONNECT returned ${connectStatus || 'an invalid response'}`));
        return;
      }

      const remaining = connectHead.subarray(headerEnd + 4);
      if (remaining.length > 0) socket.unshift(remaining);

      const secureSocket = tls.connect({
        socket,
        servername: hostname,
        ca,
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      });
      let response = Buffer.alloc(0);

      secureSocket.once('secureConnect', () => {
        secureSocket.write(
          `GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\nUser-Agent: Freedom-Release-Smoke\r\n\r\n`
        );
      });
      secureSocket.on('data', (data) => {
        response = Buffer.concat([response, data]);
        const responseHeaderEnd = response.indexOf('\r\n');
        if (responseHeaderEnd === -1) return;
        const statusCode = extractStatusCode(response.subarray(0, responseHeaderEnd).toString('latin1'));
        if (!statusCode || statusCode < 200 || statusCode >= 400) {
          finish(new Error(`HTTPS request returned ${statusCode || 'an invalid response'}`));
          return;
        }
        finish(null, statusCode);
      });
      secureSocket.once('error', (error) => finish(error));
    };

    socket.on('data', onConnectData);
  });
}

async function stopHelper(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let closed = false;
  const close = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  child.kill('SIGTERM');
  await Promise.race([close, delay(3000)]);
  if (!closed) {
    child.kill('SIGKILL');
    await Promise.race([close, delay(2000)]);
  }
  if (!closed) throw new Error('Packaged helper cleanup did not complete');
}

async function runSmoke(options) {
  const budget = createSmokeBudget(options.timeoutMs);
  const resourcesDir = path.resolve(options.resourcesDir);
  const hnsBinDir = path.join(resourcesDir, 'hns-bin');
  const helperPath = path.join(hnsBinDir, 'fingertipd');
  const hnsdPath = path.join(hnsBinDir, 'hnsd');
  const requiredPaths = [helperPath, hnsdPath, path.join(hnsBinDir, 'PROVENANCE.md')];
  for (const requiredPath of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Packaged HNS resource is missing: ${path.basename(requiredPath)}`);
    }
  }
  const hosts = getSmokeHosts();
  if (hosts.length !== 3) throw new Error('The release smoke requires three distinct HNS hosts');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-release-smoke-'));
  let child = null;
  const failures = new Map();
  const successful = new Map();
  try {
    await installCheckpointWithinBudget(resourcesDir, dataDir, budget);
    console.log('Packaged fresh-profile checkpoint integrity and validator source passed');
    const excludedPorts = new Set();
    const rootPort = await reservePortWithinBudget(excludedPorts, budget);
    excludedPorts.add(rootPort);
    const recursivePort = await reservePortWithinBudget(excludedPorts, budget);
    budget.requestTimeout();
    child = spawn(helperPath, [
      '-data-dir', dataDir,
      '-hnsd-path', hnsdPath,
      '-root-addr', `127.0.0.1:${rootPort}`,
      '-recursive-addr', `127.0.0.1:${recursivePort}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let startupDiagnostics = '';
    child.stderr.on('data', (data) => {
      startupDiagnostics = `${startupDiagnostics}${data}`.slice(-MAX_STARTUP_DIAGNOSTIC_BYTES);
    });
    let ready;
    try {
      ready = await waitForHelperReady(child, budget.requestTimeout(30000));
    } catch {
      throw new Error(classifyHelperStartupDiagnostics(startupDiagnostics) ||
        'the packaged HNS helper failed readiness');
    }
    child.stdout.resume();
    const ca = fs.readFileSync(ready.caPath);
    while (budget.remaining() > CLEANUP_RESERVE_MS && successful.size < hosts.length) {
      for (let index = 0; index < hosts.length; index += 1) {
        if (successful.has(index)) continue;
        if (budget.remaining() <= CLEANUP_RESERVE_MS) break;
        try {
          const statusCode = await requestHttpsThroughProxy({
            proxyAddr: ready.proxyAddr, ca, hostname: hosts[index],
            timeoutMs: budget.requestTimeout(),
          });
          successful.set(index, statusCode);
          console.log(`Required HNS host ${index + 1}/${hosts.length} passed with HTTP ${statusCode}`);
        } catch (error) {
          const category = classifyRequestFailure(error);
          failures.set(index, category);
          console.log(`Required HNS host ${index + 1}/${hosts.length} failed: ${category}`);
        }
      }
      if (successful.size < hosts.length && budget.remaining() > CLEANUP_RESERVE_MS) {
        await delay(budget.requestTimeout(RETRY_DELAY_MS));
      }
    }
    if (successful.size !== hosts.length) {
      const failed = hosts.map((_host, index) => index).filter((index) => !successful.has(index))
        .map((index) => `${index + 1}:${failures.get(index) || 'not-attempted-before-deadline'}`).join(', ');
      throw new Error(`Packaged HNS HTTPS smoke failed for required indexes/categories: ${failed}`);
    }
  } finally {
    try {
      await stopHelper(child);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  if (budget.remaining() === 0) throw new Error('Smoke total deadline exceeded during cleanup');
  console.log(`Packaged HNS HTTPS smoke passed for ${hosts.length}/${hosts.length} required hosts.`);
}

async function main() {
  try {
    await runSmoke(parseArgs());
  } catch (error) {
    console.error(`Packaged HNS HTTPS smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyHelperStartupDiagnostics,
  classifyRequestFailure,
  createSmokeBudget,
  installPackagedCheckpoint,
  installCheckpointWithinBudget,
  reserveTcpPort,
  canBindUdpPort,
  extractStatusCode,
  getSmokeHosts,
  normalizeHostname,
  parseArgs,
  parseProxyAddress,
  requestHttpsThroughProxy,
  runSmoke,
};
