const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const { X509Certificate } = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const tls = require('tls');
const StubResolver = require('bns/lib/resolver/stub');
const wire = require('bns/lib/wire');
const { HsdRegtestPeer } = require('./fixture-server');
const { createSignedZone } = require('./signed-zone');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FINGERTIPD_PATH = path.join(REPO_ROOT, 'hns-bin', 'linux-x64', 'fingertipd');
const HNSD_PATH = path.join(__dirname, '..', '.hns-fixture-bin', 'hnsd-regtest');
const ROOT_ADDR = '127.0.0.1:26349';
const RECURSIVE_ADDR = '127.0.0.1:26350';
const PAGE_MARKER = 'freedom-hns-dane-ok';

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
  for (let base = 30000; base < 50000; base += 4) {
    if (await canBind(base) && await canBind(base + 1)
      && await canBind(base + 2) && await canBind(base + 3)) return base;
  }
  throw new Error('could not reserve four fixture peer ports');
}

function waitForEvent(events, predicate, timeoutMs = 30_000) {
  const existing = events.items.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.listeners.delete(listener);
      reject(new Error('timed out waiting for fingertipd event'));
    }, timeoutMs);
    const listener = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      events.listeners.delete(listener);
      resolve(event);
    };
    events.listeners.add(listener);
  });
}

function collectEvents(child) {
  const events = { items: [], listeners: new Set() };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const event = JSON.parse(line);
    events.items.push(event);
    for (const listener of events.listeners) listener(event);
  });
  return events;
}

function connectThroughProxy(proxyAddr, ca) {
  return new Promise((resolve, reject) => {
    const [host, portText] = proxyAddr.split(':');
    const socket = net.connect(Number(portText), host);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(10_000, () => fail(new Error('proxy connection timed out')));
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
        fail(new Error(`proxy rejected CONNECT: ${status}`));
        return;
      }
      const secure = tls.connect({ socket, servername: 'app.pirate', ca, rejectUnauthorized: true });
      let body = '';
      secure.setEncoding('utf8');
      secure.once('secureConnect', () => {
        secure.write('GET / HTTP/1.1\r\nHost: app.pirate\r\nConnection: close\r\n\r\n');
      });
      secure.on('data', (data) => { body += data; });
      secure.once('error', reject);
      secure.once('end', () => resolve({ body, certificate: secure.getPeerCertificate() }));
    };
    socket.on('data', onData);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function waitForAuthenticatedTlsa() {
  const resolver = new StubResolver({ edns: true, dnssec: true });
  resolver.setServers([RECURSIVE_ADDR]);
  await resolver.open();
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await resolver.lookup('_443._tcp.app.pirate.', wire.types.TLSA);
      const record = response.answer.find((answer) => answer.type === wire.types.TLSA);
      if (record && response.ad) return record;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('recursive fixture did not return authenticated TLSA');
  } finally {
    await resolver.close();
  }
}

async function runCase({ matching }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-fingertipd-e2e-'));
  const origin = createCertificate(directory, 'origin');
  const tlsaCertificate = matching ? origin : createCertificate(directory, 'unbound');
  const { server: dnsServer, onChainRecords } = createSignedZone(tlsaCertificate.raw);
  const peer = await new HsdRegtestPeer({ port: await findPeerPortBase() }).open();
  const originServer = https.createServer({ key: origin.key, cert: origin.cert }, (_req, res) => {
    res.end(PAGE_MARKER);
  });
  let daemon;
  let dnsOpened = false;
  try {
    await dnsServer.open(53, '127.0.0.1');
    dnsOpened = true;
    await new Promise((resolve, reject) => {
      originServer.once('error', reject);
      originServer.listen(443, '127.0.0.1', resolve);
    });
    await peer.mine(100);
    await peer.registerNames({ pirate: onChainRecords });
    daemon = spawn(FINGERTIPD_PATH, [
      '-data-dir', path.join(directory, 'profile-hns-data'),
      '-hnsd-path', HNSD_PATH,
      '-hnsd-seed', `${peer.host}:${peer.port}`,
      '-root-addr', ROOT_ADDR,
      '-recursive-addr', RECURSIVE_ADDR,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    daemon.stderr.on('data', (data) => { stderr += String(data); });
    const events = collectEvents(daemon);
    const ready = await waitForEvent(events, (event) => event.type === 'ready');
    await waitForEvent(events, (event) => event.type === 'sync' && event.synced === true);
    await waitForAuthenticatedTlsa();
    try {
      const result = await connectThroughProxy(ready.proxyAddr, fs.readFileSync(ready.caPath));
      if (!matching) throw new Error('mismatched TLSA unexpectedly reached the HTTPS origin');
      assert(result.body.includes(PAGE_MARKER));
      assert.strictEqual(result.certificate.subject.CN, 'app.pirate');
      return true;
    } catch (error) {
      if (matching) {
        throw new Error(`${error.message}\nfingertipd stderr:\n${stderr}`, { cause: error });
      }
      assert(!String(error.message).includes('unexpectedly reached'));
      return false;
    }
  } finally {
    await stopChild(daemon);
    if (originServer.listening) {
      await new Promise((resolve) => originServer.close(resolve));
    }
    if (dnsOpened) await dnsServer.close();
    await peer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  assert(fs.existsSync(FINGERTIPD_PATH), 'run hns:download first');
  assert(fs.existsSync(HNSD_PATH), 'run hns:test-fixture:download first');
  assert.strictEqual(await runCase({ matching: true }), true);
  assert.strictEqual(await runCase({ matching: false }), false);
  console.log('fingertipd accepts matching DANE and rejects mismatched TLSA');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
