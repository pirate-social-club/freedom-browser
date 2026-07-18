const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const tls = require('tls');

const repoRoot = path.resolve(__dirname, '..');
const fingertipd = path.join(repoRoot, 'hns-bin', 'linux-x64', 'fingertipd');
const hnsd = path.join(repoRoot, 'hns-bin', 'linux-x64', 'hnsd');
const timeoutMs = Number(process.env.HNS_MAINNET_TIMEOUT_MS || 20 * 60 * 1000);

function waitForEvent(events, predicate) {
  const existing = events.items.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.listeners.delete(listener);
      reject(new Error(`mainnet HNS readiness timed out after ${timeoutMs}ms`));
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
    let event;
    try { event = JSON.parse(line); } catch { return; }
    events.items.push(event);
    for (const listener of events.listeners) listener(event);
  });
  return events;
}

function requestThroughProxy(proxyAddr, ca) {
  return new Promise((resolve, reject) => {
    const [host, portText] = proxyAddr.split(':');
    const socket = net.connect(Number(portText), host);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(20_000, () => fail(new Error('mainnet proxy request timed out')));
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
      const connectStatus = response.subarray(0, end).toString('ascii').split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200\b/.test(connectStatus)) {
        fail(new Error(`mainnet proxy rejected CONNECT: ${connectStatus}`));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: 'app.pirate',
        ca,
        rejectUnauthorized: true,
      });
      let reply = '';
      secure.setEncoding('utf8');
      secure.once('secureConnect', () => {
        secure.write('GET / HTTP/1.1\r\nHost: app.pirate\r\nConnection: close\r\n\r\n');
      });
      secure.on('data', (data) => { reply += data; });
      secure.once('error', reject);
      secure.once('end', () => resolve({
        reply,
        certificate: secure.getPeerCertificate(),
      }));
    };
    socket.on('data', onData);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function main() {
  assert(fs.existsSync(fingertipd), 'run npm run hns:download first');
  assert(fs.existsSync(hnsd), 'run npm run hns:download first');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-mainnet-'));
  const child = spawn(fingertipd, [
    '-data-dir', directory,
    '-hnsd-path', hnsd,
    '-root-addr', '127.0.0.1:25349',
    '-recursive-addr', '127.0.0.1:25350',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const events = collectEvents(child);
    const ready = await waitForEvent(events, (event) => event.type === 'ready');
    const sync = await waitForEvent(events, (event) => event.type === 'sync' && event.synced === true);
    const result = await requestThroughProxy(ready.proxyAddr, fs.readFileSync(ready.caPath));
    assert(/^HTTP\/1\.[01] [23]\d\d\b/.test(result.reply), 'app.pirate returned no successful HTTP response');
    assert.strictEqual(result.certificate.subjectaltname, 'DNS:app.pirate');
    console.log(JSON.stringify({
      date: new Date().toISOString(),
      height: sync.height,
      hostname: 'app.pirate',
      tlsNavigation: 'verified',
    }));
  } finally {
    await stopChild(child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
