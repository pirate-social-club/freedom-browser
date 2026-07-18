const { test: base, expect, _electron: electron } = require('@playwright/test');
const { execFileSync } = require('child_process');
const { X509Certificate } = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
process.env.NODE_BACKEND = 'js';
const { HsdRegtestPeer } = require('./hns-fixture/fixture-server');
const { createSignedZone } = require('./hns-fixture/signed-zone');

const repoRoot = path.resolve(__dirname, '..');
const PAGE_MARKER = 'freedom-electron-hns-dane-ok';

function createCertificate(directory, name) {
  const keyPath = path.join(directory, `${name}.key.pem`);
  const certPath = path.join(directory, `${name}.cert.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '2', '-subj', '/CN=app.pirate',
    '-addext', 'subjectAltName=DNS:app.pirate',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    raw: new X509Certificate(fs.readFileSync(certPath)).raw,
  };
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function findPeerPortBase() {
  for (let base = 34000; base < 50000; base += 4) {
    if (await canBind(base) && await canBind(base + 1)
      && await canBind(base + 2) && await canBind(base + 3)) return base;
  }
  throw new Error('could not reserve HNS Electron fixture ports');
}

async function startInfrastructure({ matching = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-electron-infra-'));
  const origin = createCertificate(directory, 'origin');
  const tlsaCertificate = matching ? origin : createCertificate(directory, 'unbound');
  const { server: dnsServer, onChainRecords } = createSignedZone(tlsaCertificate.raw);
  const peer = await new HsdRegtestPeer({ port: await findPeerPortBase() }).open();
  const originServer = https.createServer({ key: origin.key, cert: origin.cert }, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<main data-test="hns-dane-marker">${PAGE_MARKER}</main>`);
  });
  const binDir = path.join(directory, 'bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(path.join(repoRoot, 'hns-bin', 'linux-x64', 'fingertipd'),
    path.join(binDir, 'fingertipd'));
  fs.symlinkSync(path.join(repoRoot, 'test-e2e', '.hns-fixture-bin', 'hnsd-regtest'),
    path.join(binDir, 'hnsd'));

  try {
    await dnsServer.open(53, '127.0.0.1');
    await new Promise((resolve, reject) => {
      originServer.once('error', reject);
      originServer.listen(443, '127.0.0.1', resolve);
    });
    await peer.mine(100);
    await peer.registerNames({ pirate: onChainRecords });
  } catch (error) {
    if (originServer.listening) await new Promise((resolve) => originServer.close(resolve));
    try { await dnsServer.close(); } catch { /* not opened */ }
    await peer.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    binDir,
    marker: PAGE_MARKER,
    seed: `${peer.host}:${peer.port}`,
    async close() {
      if (originServer.listening) await new Promise((resolve) => originServer.close(resolve));
      await dnsServer.close();
      await peer.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function launchElectronProfile(hnsInfrastructure, label = 'electron') {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-electron-profile-'));
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_HNS_E2E: '1',
      FREEDOM_TEST_USER_DATA: userDataDir,
      FREEDOM_HNS_TEST_BIN_DIR: hnsInfrastructure.binDir,
      FREEDOM_HNS_TEST_SEED: hnsInfrastructure.seed,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    timeout: 30_000,
  });
  app.process().stdout?.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
  app.process().stderr?.on('data', (data) => process.stderr.write(`[${label}] ${data}`));
  return {
    app,
    userDataDir,
    async close() {
      try { await app.close(); } catch { /* already closed */ }
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

const test = base.extend({
  hnsTlsaMatches: [true, { option: true }],

  hnsInfrastructure: async ({ hnsTlsaMatches }, use) => {
    const infrastructure = await startInfrastructure({ matching: hnsTlsaMatches });
    await use(infrastructure);
    await infrastructure.close();
  },

  electronApp: async ({ hnsInfrastructure }, use) => {
    const profile = await launchElectronProfile(hnsInfrastructure, 'electron-a');
    await use(profile.app);
    await profile.close();
  },

  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await use(win);
  },
});

module.exports = {
  expect,
  launchElectronProfile,
  PAGE_MARKER,
  startInfrastructure,
  test,
};
