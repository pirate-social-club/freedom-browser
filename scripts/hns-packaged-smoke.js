#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const RETRY_DELAY_MS = 5 * 1000;

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
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
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

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function canBindUdpPort(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (available) => {
      try {
        socket.close();
      } catch {
        // Ignore cleanup failures after a bind error.
      }
      resolve(available);
    };
    socket.once('error', () => finish(false));
    socket.bind(port, '127.0.0.1', () => finish(true));
  });
}

async function reserveDualProtocolPort(excluded = new Set()) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await reserveTcpPort();
    if (!excluded.has(port) && await canBindUdpPort(port)) return port;
  }
  throw new Error('Could not reserve an HNS resolver port');
}

function waitForHelperReady(child, timeoutMs = 30 * 1000) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error('Packaged HNS helper did not become ready'));
    }, timeoutMs);

    const finish = (error, event) => {
      clearTimeout(timer);
      lines.close();
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(event);
    };
    const onClose = (code) => finish(new Error(`Packaged HNS helper exited before ready (${code})`));

    child.once('close', onClose);
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'ready' && event.proxyAddr && event.caPath) {
          finish(null, event);
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
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(5000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runSmoke(options) {
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
  if (hosts.length !== 3) {
    throw new Error('The release smoke requires three distinct HNS hosts');
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-release-smoke-'));
  const excludedPorts = new Set();
  const rootPort = await reserveDualProtocolPort(excludedPorts);
  excludedPorts.add(rootPort);
  const recursivePort = await reserveDualProtocolPort(excludedPorts);
  let child = null;

  try {
    child = spawn(helperPath, [
      '-data-dir', dataDir,
      '-hnsd-path', hnsdPath,
      '-root-addr', `127.0.0.1:${rootPort}`,
      '-recursive-addr', `127.0.0.1:${recursivePort}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Consume stderr without forwarding hostnames or other helper internals to release logs.
    child.stderr.on('data', () => {});
    const ready = await waitForHelperReady(child);
    child.stdout.resume();
    const ca = fs.readFileSync(ready.caPath);
    const successful = new Map();
    const deadline = Date.now() + options.timeoutMs;

    while (Date.now() < deadline && successful.size < hosts.length) {
      for (let index = 0; index < hosts.length; index += 1) {
        if (successful.has(index)) continue;
        try {
          const statusCode = await requestHttpsThroughProxy({
            proxyAddr: ready.proxyAddr,
            ca,
            hostname: hosts[index],
          });
          successful.set(index, statusCode);
          console.log(`Required HNS host ${index + 1}/${hosts.length} passed with HTTP ${statusCode}`);
        } catch {
          // A fresh helper may need time to synchronize before proofs are available.
        }
      }
      if (successful.size < hosts.length) await delay(RETRY_DELAY_MS);
    }

    if (successful.size !== hosts.length) {
      const failedIndexes = hosts
        .map((_host, index) => index)
        .filter((index) => !successful.has(index))
        .map((index) => index + 1)
        .join(', ');
      throw new Error(`Packaged HNS HTTPS smoke failed for required host index(es): ${failedIndexes}`);
    }

    console.log(`Packaged HNS HTTPS smoke passed for ${hosts.length}/${hosts.length} required hosts.`);
  } finally {
    await stopHelper(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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
  extractStatusCode,
  getSmokeHosts,
  normalizeHostname,
  parseArgs,
  parseProxyAddress,
  requestHttpsThroughProxy,
  runSmoke,
};
