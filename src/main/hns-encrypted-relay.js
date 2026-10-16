const dgram = require('dgram');
const https = require('https');
const net = require('net');
const { randomInt } = require('crypto');
const {
  MAX_DNS_MESSAGE, parseMessage, parseQuery, isLocalQuestion, validateResponse, questionResponse, udpResponse,
  needsWildcardProof, buildWildcardProofQuery, appendWildcardProof,
} = require('./hns-dns-wire');

const ENCRYPTED_RESOLVER = 'https://dns.pirate.sc/dns-query';
const REQUEST_DEADLINE_MS = 5000;
const MAX_PENDING = 128;

function buildTransportProbe() {
  // CD and DO ask for the records, without trusting the server's validation.
  const message = Buffer.from('000001100001000000000001036170700670697261746500000100010000291000000080000000', 'hex');
  message.writeUInt16BE(randomInt(65536), 0);
  return message;
}

function createHnsEncryptedRelay({ rootAddr, onFailure = () => {}, request = https.request,
  deadlineMs = REQUEST_DEADLINE_MS } = {}) {
  const root = /^127\.0\.0\.1:(\d+)$/.exec(rootAddr || '');
  if (!root || Number(root[1]) < 1 || Number(root[1]) > 65535) throw new Error('Owned HNS root endpoint required');
  const pending = new Set();
  const clients = new Set();
  const resources = new Set();
  const waiters = new Set();
  let active = true;
  let failed = false;
  let udp;
  let tcp;
  let closing;
  let address;

  function track(resource) {
    resources.add(resource);
    resource.once('close', () => {
      resources.delete(resource);
      if (!resources.size) { for (const done of waiters) done(); waiters.clear(); }
    });
    if (!active || failed) resource.destroy?.();
    return resource;
  }

  function fail() {
    if (!active || failed) return;
    failed = true;
    // Revoke before notifying the manager; old asynchronous work stays refused.
    for (const cancel of [...pending]) cancel();
    for (const socket of clients) socket.destroy();
    onFailure('encrypted_dns_transport_failed');
  }

  function exchange(message, query, local) {
    return new Promise((resolve, reject) => {
      if (!active || failed || pending.size >= MAX_PENDING) {
        reject(new Error('HNS transport unavailable'));
        return;
      }
      let resource;
      let response;
      let settled = false;
      const finish = (error, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (local) {
          try { resource?.close(); } catch { /* Already closed. */ }
        } else {
          response?.destroy();
          resource?.destroy();
        }
        if (error || !active || failed) reject(error || new Error('HNS generation retired'));
        else resolve(body);
      };
      const cancel = () => finish(new Error('HNS request cancelled'));
      const timer = setTimeout(() => {
        finish(new Error('HNS transport deadline exceeded'));
        if (!local) fail();
      }, deadlineMs);
      pending.add(cancel);
      const received = (body) => {
        try { finish(null, validateResponse(body, query, !local)); }
        catch (error) { finish(error); if (!local) fail(); }
      };
      try {
        if (local) {
          resource = track(dgram.createSocket('udp4'));
          resource.once('error', (error) => finish(error));
          resource.once('message', (body, peer) => {
            if (peer.address !== '127.0.0.1' || peer.port !== Number(root[1])) {
              finish(new Error('Unexpected local HNS responder'));
              return;
            }
            received(body);
          });
          resource.send(message, Number(root[1]), '127.0.0.1', (error) => { if (error) finish(error); });
          return;
        }
        resource = request(ENCRYPTED_RESOLVER, {
          method: 'POST', agent: false, rejectUnauthorized: true,
          servername: 'dns.pirate.sc',
          headers: { Accept: 'application/dns-message', 'Content-Type': 'application/dns-message',
            'Content-Length': message.length, 'Cache-Control': 'no-store' },
        }, (incoming) => {
          response = track(incoming);
          if (settled || !active || failed) { incoming.destroy(); return; }
          if (incoming.statusCode !== 200 ||
              String(incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/dns-message' ||
              (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity')) {
            finish(new Error('Invalid encrypted DNS HTTP response'));
            fail();
            return;
          }
          let size = 0;
          const chunks = [];
          incoming.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_DNS_MESSAGE) { finish(new Error('Encrypted DNS body too large')); fail(); return; }
            chunks.push(chunk);
          });
          incoming.on('error', () => { if (!settled) { finish(new Error('Encrypted DNS body failed')); fail(); } });
          incoming.on('aborted', () => { if (!settled) { finish(new Error('Encrypted DNS body aborted')); fail(); } });
          incoming.on('end', () => { if (!settled) received(Buffer.concat(chunks, size)); });
        });
        track(resource);
        resource.on('socket', (socket) => { track(socket); socket.on('error', () => {}); });
        resource.on('error', () => { if (!settled) { finish(new Error('Encrypted DNS connection failed')); fail(); } });
        resource.end(message);
      } catch (error) { finish(error); if (!local) fail(); }
    });
  }

  // dns.pirate.sc answers wildcard-expanded names (member hosts and their
  // _443._tcp TLSA) without the NSEC records that prove the expansion, which
  // the validator needs (RFC 4035 section 5.3.4). Fetch the signed denial for
  // that name over the same encrypted exchange, so the same deadline,
  // cancellation and refusal of foreign root authority apply, and hand both
  // to hnsd/libunbound together. Authentication stays entirely there.
  async function completeWildcardProof(query, reply) {
    const parsed = parseMessage(reply);
    if (!needsWildcardProof(reply, parsed)) return reply;
    const proofMessage = buildWildcardProofQuery(query, randomInt(65536));
    const proof = await exchange(proofMessage, parseQuery(proofMessage), false);
    try {
      return appendWildcardProof(reply, parsed, proof);
    } catch {
      // An unusable denial leaves the answer unproven; the validator refuses it.
      return reply;
    }
  }

  async function answer(message, stream = false) {
    const query = parseQuery(message);
    if (query.question.klass === 4 && (query.question.type !== 16 ||
        !['chain.hnsd', 'size.pool.hnsd'].includes(query.question.labels.join('.')))) {
      throw new Error('Unsupported local metadata query');
    }
    try {
      const local = isLocalQuestion(query);
      let reply = await exchange(message, query, local);
      if (!local) reply = await completeWildcardProof(query, reply);
      if (!active || failed) throw new Error('HNS generation retired');
      return stream ? reply : udpResponse(reply, message, query);
    } catch {
      if (!active || failed) throw new Error('HNS transport unavailable');
      return questionResponse(message, query, 2);
    }
  }

  function acceptTcp(socket) {
    if (!active || failed || clients.size >= 64) { socket.destroy(); return; }
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.setTimeout(deadlineMs, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    let queued = 0;
    let sequence = Promise.resolve();
    socket.on('data', (chunk) => {
      if (!active || failed || buffered.length + chunk.length > 2 * (MAX_DNS_MESSAGE + 2)) {
        socket.destroy(); return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const length = buffered.readUInt16BE(0);
        if (length < 12 || queued >= 8) { socket.destroy(); return; }
        if (buffered.length < length + 2) return;
        const message = Buffer.from(buffered.subarray(2, length + 2));
        buffered = buffered.subarray(length + 2);
        queued += 1;
        sequence = sequence.then(async () => {
          if (socket.destroyed || !active || failed) return;
          const reply = await answer(message, true);
          if (socket.destroyed || !active || failed) return;
          const frame = Buffer.alloc(reply.length + 2);
          frame.writeUInt16BE(reply.length, 0);
          reply.copy(frame, 2);
          if (!socket.write(frame)) await new Promise((resolve) => {
            socket.once('drain', resolve); socket.once('close', resolve);
          });
        }).catch(() => socket.destroy()).finally(() => { queued -= 1; });
      }
    });
  }

  async function start() {
    if (address || tcp || !active) throw new Error('HNS relay already started or closed');
    tcp = net.createServer(acceptTcp);
    await new Promise((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(0, '127.0.0.1', resolve);
    });
    tcp.on('error', fail);
    udp = dgram.createSocket('udp4');
    udp.on('message', (message, peer) => {
      if (peer.address !== '127.0.0.1' || !active || failed) return;
      answer(message).then((reply) => {
        if (active && !failed) udp.send(reply, peer.port, peer.address, () => {});
      }).catch(() => {});
    });
    await new Promise((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(tcp.address().port, '127.0.0.1', resolve);
    }).catch(async (error) => { await close(); throw error; });
    udp.on('error', fail);
    address = `127.0.0.1:${tcp.address().port}`;
    return address;
  }

  function close() {
    if (closing) return closing;
    active = false;
    for (const cancel of [...pending]) cancel();
    for (const socket of clients) socket.destroy();
    const stop = (server) => new Promise((resolve) => {
      if (!server) { resolve(); return; }
      try { server.close(resolve); } catch { resolve(); }
    });
    const drained = resources.size ? new Promise((resolve) => waiters.add(resolve)) : Promise.resolve();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('HNS transport drainage timed out')), 5000);
    });
    closing = Promise.race([Promise.all([stop(tcp), stop(udp), drained]), deadline])
      .then(() => {}).finally(() => clearTimeout(timer));
    return closing;
  }

  async function probe() {
    const message = buildTransportProbe();
    const reply = await exchange(message, parseQuery(message), false);
    if ((reply.readUInt16BE(2) & 15) !== 0) throw new Error('Encrypted DNS probe refused');
  }

  return { start, close, probe, answer, isActive: () => active && !failed };
}

module.exports = { createHnsEncryptedRelay, ENCRYPTED_RESOLVER, REQUEST_DEADLINE_MS, buildTransportProbe };
