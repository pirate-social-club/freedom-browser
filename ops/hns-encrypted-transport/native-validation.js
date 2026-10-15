// Runs only on the hosted runner inside a namespace with loopback and no egress.
// Synthetic delegations test libunbound, not Handshake consensus or live sites.
const assert = require('assert/strict');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createHnsEncryptedRelay } = require('../../src/main/hns-encrypted-relay');
const { parseMessage, parseQuery, validateResponse } = require('../../src/main/hns-dns-wire');
const { createHnsNativeCustody } = require('../../src/main/hns-native-custody');
const loggerPath = require.resolve('../../src/main/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { warn: () => {}, info: () => {} } };
const { queryDns } = require('../../src/main/hns-local-resolver');
delete require.cache[loggerPath];
const { name, query, record, response } = require('../../test/helpers/hns-dns-fixtures');

const binary = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const TLD = 'transport-fixture';
const CHILD = `site.${TLD}`;
const HOST = `app.${CHILD}`;
const TTL = 60;
const observed = [];
const results = {};
const tcpConnections = {};
let fixtureMode;
const createServer = net.createServer;
net.createServer = (...args) => {
  const server = createServer(...args);
  if (typeof args[0] === 'function') {
    const mode = fixtureMode;
    server.on('connection', () => { tcpConnections[mode] = (tcpConnections[mode] || 0) + 1; });
  }
  return server;
};
const children = new Set();
const sockets = new Set();
const relays = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function validatedQuery(host, type) { const message = query(host, type, 1, true); message.writeUInt16BE(0x0100, 2); return message; }

function keyFromScalar(scalar) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey(null, 'uncompressed').subarray(1);
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    d: scalar.toString('base64url'), x: point.subarray(0, 32).toString('base64url'),
    y: point.subarray(32).toString('base64url') } });
  const dnskey = Buffer.concat([Buffer.from([1, 1, 3, 13]), point]);
  let sum = 0;
  for (let i = 0; i < dnskey.length; i += 1) sum += i & 1 ? dnskey[i] : dnskey[i] << 8;
  sum += (sum >>> 16) & 65535;
  return { key, dnskey, tag: sum & 65535 };
}

function testKey(number) {
  const scalar = Buffer.alloc(32); scalar.writeUInt32BE(number, 28);
  return keyFromScalar(scalar);
}

// Intentionally public synthetic root ZSK from pinned hnsd src/dnssec.h.
const rootKey = keyFromScalar(Buffer.from('54276ff8604a3494c5c76d6651f14b289c7253ba636be4bfd7969308f48da47d', 'hex'));
// Root ZSK has flag256, not257. The key tag must cover those exact flags.
rootKey.dnskey.writeUInt16BE(256, 0);
let rootTag = 0;
for (let i = 0; i < rootKey.dnskey.length; i += 1) rootTag += i & 1 ? rootKey.dnskey[i] : rootKey.dnskey[i] << 8;
rootKey.tag = (rootTag + ((rootTag >>> 16) & 65535)) & 65535;
const tldKey = testKey(2);
const childKey = testKey(3);

function ds(owner, key) {
  const header = Buffer.alloc(4); header.writeUInt16BE(key.tag); header[2] = 13; header[3] = 2;
  return Buffer.concat([header, crypto.createHash('sha256').update(name(owner)).update(key.dnskey).digest()]);
}

function signedSet(owner, type, data, key, signer) {
  const header = Buffer.alloc(18);
  header.writeUInt16BE(type); header[2] = 13; header[3] = owner.split('.').filter(Boolean).length;
  header.writeUInt32BE(TTL, 4);
  header.writeUInt32BE(Math.floor(Date.now() / 1000) + 3600, 8);
  header.writeUInt32BE(Math.floor(Date.now() / 1000) - 60, 12);
  header.writeUInt16BE(key.tag, 16);
  const prefix = Buffer.concat([header, name(signer)]);
  const rrset = [...data].sort(Buffer.compare).map((value) => record(owner, type, value, 1, TTL));
  const signature = crypto.sign('sha256', Buffer.concat([prefix, ...rrset]), {
    key: key.key, dsaEncoding: 'ieee-p1363',
  });
  return [...rrset, record(owner, 46, Buffer.concat([prefix, signature]), 1, TTL)];
}

const paddedKeys = [tldKey.dnskey, ...Array.from({ length: 70 }, (_, i) => testKey(i + 10).dnskey)];
const tldKeys = signedSet(TLD, 48, paddedKeys, tldKey, TLD);
const childKeys = signedSet(CHILD, 48, [childKey.dnskey], childKey, CHILD);
const tldDs = signedSet(TLD, 43, [ds(TLD, tldKey)], rootKey, '');
const childDs = signedSet(CHILD, 43, [ds(CHILD, childKey)], tldKey, TLD);
const address = signedSet(HOST, 1, [Buffer.from([192, 0, 2, 42])], childKey, CHILD);
const ipv6 = signedSet(HOST, 28, [Buffer.from('20010db8000000000000000000000042', 'hex')], childKey, CHILD);
const tlsa = signedSet(`_443._tcp.${HOST}`, 52, [Buffer.concat([Buffer.from([3, 1, 1]), Buffer.alloc(32, 42)])], childKey, CHILD);

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function udpExchange(message, port, timeout = 5000) {
  const socket = dgram.createSocket('udp4'); sockets.add(socket);
  return new Promise((resolve, reject) => {
    const finish = (error, body) => {
      clearTimeout(timer); socket.close(() => sockets.delete(socket));
      if (error) reject(error); else resolve(body);
    };
    const timer = setTimeout(() => finish(new Error('Native DNS fixture timeout')), timeout);
    socket.once('error', (error) => finish(error));
    socket.on('message', (body, peer) => {
      if (peer.address !== '127.0.0.1' || peer.port !== port) return;
      try { validateResponse(body, parseQuery(message)); finish(null, body); }
      catch (error) { finish(error); }
    });
    socket.send(message, port, '127.0.0.1');
  });
}

async function stopped(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
  await done; clearTimeout(timer);
}

async function generation(mode) {
  fixtureMode = mode;
  const dir = path.join(output, mode); fs.mkdirSync(dir, { mode: 0o700 });
  const rootPort = await reservePort(); const recursivePort = await reservePort();
  const root = dgram.createSocket('udp4'); sockets.add(root);
  await new Promise((resolve) => root.bind(0, '127.0.0.1', resolve));
  root.on('message', async (message, peer) => {
    try {
      const q = parseQuery(message).question;
      const body = q.labels.join('.') === TLD && q.type === 43 ? response(message, [tldDs, [], []], 0x8510)
        : await udpExchange(message, rootPort);
      root.send(body, peer.port, peer.address);
    } catch { /* A native startup miss is retried by the fixture client. */ }
  });
  const request = (_url, _options, callback) => {
    const outgoing = new EventEmitter(); outgoing.destroy = () => outgoing.emit('close');
    outgoing.end = (message) => {
      const q = parseQuery(message).question; const host = q.labels.join('.');
      observed.push({ mode, name: host, type: q.type });
      let records = [];
      if (host === TLD && q.type === 48) records = tldKeys.map((rr) => Buffer.from(rr));
      if (host === CHILD && q.type === 48) records = childKeys;
      if (host === CHILD && q.type === 43) records = childDs;
      if (host === HOST && q.type === 1) records = address;
      if (host === HOST && q.type === 28) records = ipv6;
      if (host === `_443._tcp.${HOST}` && q.type === 52) records = tlsa;
      if (mode === 'bad-dnskey' && host === TLD && q.type === 48) records.at(-1)[records.at(-1).length - 1] ^= 1;
      if (mode === 'bad-address' && host === HOST && q.type === 1) {
        records = address.map((rr) => Buffer.from(rr)); records.at(-1)[records.at(-1).length - 1] ^= 1;
      }
      if (mode === 'large-final' && host === HOST && q.type === 28) {
        records = signedSet(HOST, 28, Array.from({ length: 180 }, (_, i) => {
          const value = Buffer.from('20010db8000000000000000000000000', 'hex'); value.writeUInt16BE(i + 1, 14); return value;
        }), childKey, CHILD);
      }
      queueMicrotask(() => {
        const incoming = new PassThrough(); incoming.statusCode = 200;
        incoming.headers = { 'content-type': 'application/dns-message' };
        callback(incoming); incoming.end(response(message, [records, [], []]));
      });
    };
    return outgoing;
  };
  const relay = createHnsEncryptedRelay({ rootAddr: `127.0.0.1:${root.address().port}`, request });
  relays.add(relay); const relayAddress = await relay.start();
  fs.writeFileSync(path.join(dir, 'validator.conf'), `server:\n  serve-expired: no\nforward-zone:\n  name: "."\n  forward-addr: ${relayAddress.replace(':', '@')}\n  forward-first: no\n`);
  const args = ['-n', `127.0.0.1:${rootPort}`, '-r', `127.0.0.1:${recursivePort}`, '-u', path.join(dir, 'validator.conf'), '-p', '1', '-x', dir];
  const log = fs.openSync(path.join(dir, 'native.log'), 'wx', 0o600);
  const child = spawn(binary, args, { stdio: ['ignore', log, log] }); children.add(child); fs.closeSync(log);
  let answer;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { answer = parseMessage(await udpExchange(validatedQuery(HOST, mode === 'large-final' ? 28 : 1), recursivePort, 12000)); break; }
    catch { if (child.exitCode !== null) throw new Error('Native validator exited'); await pause(100); }
  }
  assert(answer, 'Native validator never answered');
  if (mode === 'valid') {
    assert(response(query(TLD, 48), [tldKeys, [], []]).length > 4096);
    assert(tcpConnections[mode] > 0, 'Large intermediate DNSKEY must use relay TCP');
    assert.equal(answer.flags & 15, 0); assert(answer.flags & 0x20, 'Locally validated answer must have AD');
    assert(answer.records.some((rr) => rr.type === 1), 'Missing validated address');
    const tls = parseMessage(await udpExchange(validatedQuery(`_443._tcp.${HOST}`, 52), recursivePort));
    assert(tls.flags & 0x20); assert(tls.records.some((rr) => rr.type === 52));
  } else if (['bad-dnskey', 'bad-address'].includes(mode)) {
    assert.equal(answer.flags & 15, 2, 'Corrupted DNSSEC signature must SERVFAIL');
    if (mode === 'bad-address') {
      const other = parseMessage(await udpExchange(validatedQuery(HOST, 28), recursivePort));
      assert(other.flags & 0x20); assert.equal(other.flags & 15, 0);
    }
  }
  else {
    assert(answer.flags & 0x200, 'Oversized final native reply must set TC');
    await assert.rejects(queryDns({ host: '127.0.0.1', port: recursivePort, hostname: HOST, type: 28,
      recursive: true, dnssec: true, tcpFallback: false }), (error) => error.code === 'ETRUNCATED');
  }
  results[mode] = { passed: true, flags: answer.flags, remote_queries: observed.filter((entry) => entry.mode === mode).length, relay_tcp_connections: tcpConnections[mode] || 0,
    intermediate_dnskey_bytes: response(query(TLD, 48), [tldKeys, [], []]).length, production_udp_client_refused: mode === 'large-final' };
  await stopped(child); children.delete(child); await relay.close(); relays.delete(relay);
  await new Promise((resolve) => root.close(resolve)); sockets.delete(root);
}

async function custody() {
  const helper = path.resolve('hns-bin/linux-x64/fingertipd');
  const launcher = path.resolve('assets/hns/hnsd-encrypted');
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const dir = path.join(output, `custody-${signal}`); fs.mkdirSync(dir, { mode: 0o700 });
    const receipt = path.join(dir, 'native.stat');
    const journal = path.join(dir, 'custody.json');
    const record = createHnsNativeCustody(receipt, { journalPath: journal }); record.prepare();
    fs.writeFileSync(path.join(dir, 'validator.conf'), 'forward-zone:\n  name: "."\n  forward-addr: 127.0.0.1@9\n  forward-first: no\n');
    const rootPort = await reservePort(); const recursivePort = await reservePort();
    const child = spawn(helper, ['-data-dir', dir, '-hnsd-path', launcher,
      '-root-addr', `127.0.0.1:${rootPort}`, '-recursive-addr', `127.0.0.1:${recursivePort}`], {
      env: { ...process.env, FREEDOM_HNSD_BINARY: binary, FREEDOM_HNSD_CONFIG: path.join(dir, 'validator.conf'), FREEDOM_HNSD_PIDFILE: receipt },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.add(child); record.bindParent(child.pid); await record.capture();
    const closed = new Promise((resolve) => child.once('close', resolve));
    const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill(signal); await exited;
    await record.terminate(); await closed; children.delete(child);
    assert.equal(JSON.parse(fs.readFileSync(journal)).status, 'closed');
    results[`custody-${signal}`] = { passed: true };
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  assert(Object.keys(os.networkInterfaces()).every((entry) => entry === 'lo'), 'Fixture requires loopback-only network namespace');
  try {
    for (const mode of ['valid', 'bad-dnskey', 'bad-address', 'large-final']) await generation(mode);
    await custody();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, observed }, null, 2) + '\n');
  } finally {
    for (const child of children) await stopped(child);
    for (const relay of relays) await relay.close();
    for (const socket of sockets) { try { socket.close(); } catch { /* Closed already. */ } }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
