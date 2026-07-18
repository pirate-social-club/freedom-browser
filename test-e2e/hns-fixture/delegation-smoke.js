const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');
const StubResolver = require('bns/lib/resolver/stub');
const wire = require('bns/lib/wire');
const { HsdRegtestPeer } = require('./fixture-server');
const { APP_NAME, createSignedZone } = require('./signed-zone');

const HNSD_PATH = path.join(__dirname, '..', '.hns-fixture-bin', 'hnsd-regtest');
const ROOT_ADDR = '127.0.0.1:25349';
const RECURSIVE_ADDR = '127.0.0.1:25350';

function createCertificate(directory) {
  const keyPath = path.join(directory, 'origin.key.pem');
  const certPath = path.join(directory, 'origin.cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '2', '-subj', '/CN=app.pirate',
    '-addext', 'subjectAltName=DNS:app.pirate',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return new X509Certificate(fs.readFileSync(certPath)).raw;
}

async function waitForRecord(resolver, name, type, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await resolver.lookup(name, type);
      const record = response.answer.find((answer) => answer.type === type);
      if (record) return record;
    } catch { /* hnsd is still syncing or validating the delegation */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`hnsd did not resolve validated ${name}`);
}

async function main() {
  assert(fs.existsSync(HNSD_PATH), 'run hns:test-fixture:download first');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-delegation-'));
  const peer = await new HsdRegtestPeer().open();
  const resolver = new StubResolver({ edns: true, dnssec: true });
  resolver.setServers([RECURSIVE_ADDR]);
  const { server, onChainRecords } = createSignedZone(createCertificate(directory));
  let hnsd;
  try {
    // DNS referrals have no port field, so the delegated authority must use
    // the protocol-defined port 53. CI runs this isolated fixture with the
    // isolated unprivileged-port network namespace; production hnsd never uses port 53.
    await server.open(53, '127.0.0.1');
    await peer.mine(100);
    await peer.registerNames({ pirate: onChainRecords });
    hnsd = spawn(HNSD_PATH, [
      '-s', `${peer.host}:${peer.port}`,
      '-n', ROOT_ADDR,
      '-r', RECURSIVE_ADDR,
      '-x', directory,
      '-t',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    hnsd.stderr.on('data', (data) => { stderr += String(data); });
    hnsd.once('exit', (code) => {
      if (code && !process.exitCode) console.error(stderr.trim());
    });
    await resolver.open();
    const a = await waitForRecord(resolver, APP_NAME, wire.types.A);
    const dane = await waitForRecord(resolver, `_443._tcp.${APP_NAME}`, wire.types.TLSA);
    assert.strictEqual(a.data.address, '127.0.0.1');
    assert.strictEqual(dane.data.usage, 3);
    assert.strictEqual(dane.data.selector, 1);
    assert.strictEqual(dane.data.matchingType, 1);
    console.log('hnsd resolved the on-chain DS delegation and signed TLSA zone');
  } finally {
    if (hnsd && hnsd.exitCode == null) {
      hnsd.kill('SIGINT');
      await new Promise((resolve) => hnsd.once('exit', resolve));
    }
    try { await resolver.close(); } catch { /* not opened */ }
    try { await server.close(); } catch { /* not opened */ }
    await peer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
