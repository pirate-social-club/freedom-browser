const {
  test,
  expect,
  launchElectronProfile,
  PAGE_MARKER,
} = require('./hns-electron-fixtures');
const { X509Certificate } = require('crypto');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const StubResolver = require('./hns-fixture/node_modules/bns/lib/resolver/stub');
const wire = require('./hns-fixture/node_modules/bns/lib/wire');
const {
  ACCEPT_CERTIFICATE,
  USE_CHROMIUM_VERIFICATION,
  createCertificateVerifyProc,
} = require('../src/main/hns-cert-verifier');

async function waitForAuthenticatedTlsa(recursiveAddr) {
  const resolver = new StubResolver({ edns: true, dnssec: true });
  resolver.setServers([recursiveAddr]);
  await resolver.open();
  try {
    await expect.poll(async () => {
      try {
        const response = await resolver.lookup('_443._tcp.app.pirate.', wire.types.TLSA);
        return response.ad && response.answer.some((answer) => answer.type === wire.types.TLSA);
      } catch {
        return false;
      }
    }, { timeout: 30_000 }).toBe(true);
  } finally {
    await resolver.close();
  }
}

const activeWebviewEval = (window, expression) => window.evaluate(async (script) => {
  const webview = document.querySelector('webview.active, webview:not(.hidden)');
  if (!webview?.executeJavaScript) return null;
  try { return await webview.executeJavaScript(script); } catch { return null; }
}, expression);

const activeWebviewUrl = (window) => window.evaluate(() => {
  const webview = document.querySelector('webview.active, webview:not(.hidden)');
  return webview?.getURL?.() || webview?.src || '';
});

function fetchProxyLeaf(proxyAddr) {
  return new Promise((resolve, reject) => {
    const [host, portText] = proxyAddr.split(':');
    const socket = net.connect(Number(portText), host);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(10_000, () => fail(new Error('profile proxy connection timed out')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write('CONNECT app.pirate:443 HTTP/1.1\r\nHost: app.pirate:443\r\n\r\n');
    });
    let response = Buffer.alloc(0);
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const status = response.subarray(0, end).toString('ascii').split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
        fail(new Error(`profile proxy rejected CONNECT: ${status}`));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: 'app.pirate',
        rejectUnauthorized: false,
      });
      secure.once('error', reject);
      secure.once('secureConnect', () => {
        const certificate = secure.getPeerCertificate();
        secure.end();
        resolve(certificate.raw);
      });
    };
    socket.on('data', onData);
  });
}

function verifyProfileLeaf(caPath, leafData) {
  const trustedCertificate = new X509Certificate(fs.readFileSync(caPath));
  const leaf = new X509Certificate(leafData);
  const verify = createCertificateVerifyProc(trustedCertificate.fingerprint, {
    trustedCertificate,
  });
  let result;
  verify({
    hostname: 'app.pirate',
    certificate: { data: leafData, fingerprint: leaf.fingerprint },
  }, (value) => { result = value; });
  return result;
}

test('real Electron navigation renders DANE origin through the profile CA', async ({ window }) => {
  await expect.poll(
    () => window.evaluate(() => window.hns.getStatus()),
    { timeout: 60_000 },
  ).toMatchObject({ status: 'running', synced: true });

  // Name readiness can precede completion of the delegated TLSA validation
  // path. Prime that hermetic path before navigation so an early negative
  // DNSSEC cache entry cannot turn this into a fixture-ordering test.
  const status = await window.evaluate(() => window.hns.getStatus());
  await waitForAuthenticatedTlsa(status.recursiveAddr);

  const input = window.locator('[data-test="address-input"]');
  await input.fill('https://app.pirate/');
  await input.press('Enter');

  await expect.poll(() => activeWebviewEval(
    window,
    `document.querySelector('[data-test="hns-dane-marker"]')?.textContent || null`,
  ), { timeout: 45_000 }).toBe(PAGE_MARKER);
});

test.describe('mismatched DANE fixture', () => {
  test.use({ hnsTlsaMatches: false });

  test('Electron keeps navigation fail-closed when TLSA does not match', async ({ window }) => {
    await expect.poll(
      () => window.evaluate(() => window.hns.getStatus()),
      { timeout: 60_000 },
    ).toMatchObject({ status: 'running', synced: false });

    const input = window.locator('[data-test="address-input"]');
    await input.fill('https://app.pirate/');
    await input.press('Enter');

    await expect.poll(() => activeWebviewUrl(window), { timeout: 15_000 })
      .toMatch(/\/pages\/hns-syncing\.html$/);
    await expect.poll(() => activeWebviewEval(
      window,
      `document.querySelector('[data-test="hns-dane-marker"]')?.textContent || null`,
    )).toBeNull();
  });
});

test('two profiles run concurrently with mutually isolated CA trust', async ({
  electronApp,
  hnsInfrastructure,
  window: windowA,
}) => {
  const profileB = await launchElectronProfile(hnsInfrastructure, 'electron-b');
  try {
    const windowB = await profileB.app.firstWindow();
    await windowB.waitForSelector('[data-test="address-input"]', { state: 'visible' });

    await expect.poll(
      () => windowA.evaluate(() => window.hns.getStatus()),
      { timeout: 60_000 },
    ).toMatchObject({ status: 'running', synced: true });
    await expect.poll(
      () => windowB.evaluate(() => window.hns.getStatus()),
      { timeout: 60_000 },
    ).toMatchObject({ status: 'running', synced: true });

    const [statusA, statusB] = await Promise.all([
      windowA.evaluate(() => window.hns.getStatus()),
      windowB.evaluate(() => window.hns.getStatus()),
    ]);
    expect(statusA.proxyAddr).not.toBe(statusB.proxyAddr);
    expect(statusA.recursiveAddr).not.toBe(statusB.recursiveAddr);
    expect(statusA.caPemPath).not.toBe(statusB.caPemPath);

    await Promise.all([
      waitForAuthenticatedTlsa(statusA.recursiveAddr),
      waitForAuthenticatedTlsa(statusB.recursiveAddr),
    ]);
    const [leafA, leafB] = await Promise.all([
      fetchProxyLeaf(statusA.proxyAddr),
      fetchProxyLeaf(statusB.proxyAddr),
    ]);

    expect(verifyProfileLeaf(statusA.caPemPath, leafA)).toBe(ACCEPT_CERTIFICATE);
    expect(verifyProfileLeaf(statusB.caPemPath, leafB)).toBe(ACCEPT_CERTIFICATE);
    expect(verifyProfileLeaf(statusA.caPemPath, leafB)).toBe(USE_CHROMIUM_VERIFICATION);
    expect(verifyProfileLeaf(statusB.caPemPath, leafA)).toBe(USE_CHROMIUM_VERIFICATION);

    // Keep the Playwright-owned first application live for the whole assertion;
    // this makes the concurrency claim explicit rather than sequential startup.
    expect(electronApp.process().exitCode).toBeNull();
    expect(profileB.app.process().exitCode).toBeNull();
  } finally {
    await profileB.close();
  }
});
