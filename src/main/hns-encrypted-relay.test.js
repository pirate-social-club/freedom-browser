const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const dgram = require('dgram');
const net = require('net');
const { query, record, response } = require('../../test/helpers/hns-dns-fixtures');
const { parseQuery } = require('./hns-dns-wire');
const { createHnsEncryptedRelay, ENCRYPTED_RESOLVER } = require('./hns-encrypted-relay');

function mockHttps(handler = (request) => response(request)) {
  return jest.fn((url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = jest.fn(() => request.emit('close'));
    request.end = jest.fn((message) => {
      queueMicrotask(async () => {
        const body = await handler(message, request);
        if (body === null) return;
        const incoming = new PassThrough();
        incoming.statusCode = 200;
        incoming.headers = { 'content-type': 'application/dns-message' };
        callback(incoming);
        incoming.end(body);
      });
    });
    return request;
  });
}

describe('encrypted HNS relay', () => {
  let relay;
  let root;
  afterEach(async () => {
    await relay?.close();
    if (root) await new Promise((resolve) => root.close(resolve));
    relay = null; root = null;
  });

  async function setup(handler) {
    root = dgram.createSocket('udp4');
    await new Promise((resolve) => root.bind(0, '127.0.0.1', resolve));
    const request = mockHttps(handler);
    const onFailure = jest.fn();
    relay = createHnsEncryptedRelay({ rootAddr: `127.0.0.1:${root.address().port}`, request, onFailure, deadlineMs: 200 });
    return { request, onFailure };
  }

  test('uses authenticated HTTPS and transports the full DNS wire query without accepting AD', async () => {
    const { request } = await setup();
    const message = query('app.pirate', 1, 1, true);
    const reply = await relay.answer(message, true);
    expect(request).toHaveBeenCalledWith(ENCRYPTED_RESOLVER, expect.objectContaining({
      method: 'POST', agent: false, rejectUnauthorized: true, servername: 'dns.pirate.sc',
    }), expect.any(Function));
    expect(request.mock.results[0].value.end).toHaveBeenCalledWith(message);
    expect(reply.readUInt16BE(2) & 0x20).toBe(0);
  });

  test.each([['', 48, 1], ['pirate', 43, 1], ['chain.hnsd', 16, 4]])('sends root authority/metadata only to owned loopback: %s/%s', async (host, type, klass) => {
    const { request } = await setup();
    root.on('message', (message, peer) => root.send(response(message, [[], [], []]), peer.port, peer.address));
    await expect(relay.answer(query(host, type, klass), true)).resolves.toBeInstanceOf(Buffer);
    expect(request).not.toHaveBeenCalled();
  });

  test('malformed remote data retires the relay and cancels other pending requests', async () => {
    const { request, onFailure } = await setup((message) => parseQuery(message).question.labels[0] === 'bad'
      ? response(message, [[record('pirate', 43, Buffer.alloc(36))], [], []]) : null);
    const pending = relay.answer(query('waiting.pirate'), true);
    const waiting = expect(pending).rejects.toThrow();
    await expect(relay.answer(query('bad.pirate'), true)).rejects.toThrow();
    await waiting;
    expect(relay.isActive()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(request.mock.results[0].value.destroy).toHaveBeenCalled();
  });

  test('close refuses a delayed success from an old resolver generation', async () => {
    let complete;
    await setup((message) => new Promise((resolve) => { complete = () => resolve(response(message)); }));
    const pending = relay.answer(query(), true);
    const refused = expect(pending).rejects.toThrow();
    await Promise.resolve();
    await relay.close();
    await refused;
    complete(); await new Promise((resolve) => setImmediate(resolve));
    expect(relay.isActive()).toBe(false);
  });

  test('total deadline covers a stalled HTTPS operation', async () => {
    const { onFailure } = await setup(() => null);
    await expect(relay.answer(query(), true)).rejects.toThrow();
    expect(onFailure).toHaveBeenCalledWith('encrypted_dns_transport_failed');
  });

  test('oversized response body is rejected before it reaches the validator', async () => {
    const { onFailure } = await setup(() => Buffer.alloc(65536));
    await expect(relay.answer(query(), true)).rejects.toThrow();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('TCP reassembles fragmented frames and supports reuse; UDP sends TC for a large reply', async () => {
    await setup((message) => response(message, [[record('app.pirate', 16, Buffer.alloc(5000))], [], []]));
    const address = await relay.start();
    const port = Number(address.split(':')[1]);
    const socket = net.connect(port, '127.0.0.1');
    const message = query(); const frame = Buffer.alloc(message.length + 2);
    frame.writeUInt16BE(message.length, 0); message.copy(frame, 2);
    const replies = [];
    let buffered = Buffer.alloc(0);
    const received = new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 2 && buffered.length >= buffered.readUInt16BE(0) + 2) {
          const length = buffered.readUInt16BE(0);
          replies.push(buffered.subarray(2, length + 2)); buffered = buffered.subarray(length + 2);
          if (replies.length === 2) resolve();
        }
      });
    });
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(frame.subarray(0, 1)); socket.write(frame.subarray(1, 15));
    socket.write(Buffer.concat([frame.subarray(15), frame]));
    await received;
    expect(replies.every((reply) => reply.length > 4096 && !(reply.readUInt16BE(2) & 0x20))).toBe(true);
    socket.destroy();
    const udp = dgram.createSocket('udp4');
    const truncated = new Promise((resolve, reject) => {
      udp.once('message', resolve); udp.once('error', reject);
    });
    udp.send(message, port, '127.0.0.1');
    const reply = await truncated; udp.close();
    expect(reply.readUInt16BE(2) & 0x220).toBe(0x200);
  });

  describe('wildcard proof completion', () => {
    // Real dns.pirate.sc exchanges for a member host under the *.8s28 wildcard.
    const wire = require('../../test/helpers/hns-wildcard-wire.json').exchanges;
    const { parseMessage, DNS_TYPE_PROOF_PROBE } = require('./hns-dns-wire');
    const hex = (key, part) => Buffer.from(wire[key][part], 'hex');
    // Answers the relay's queries with the captured responses, re-addressed to
    // the ID each query actually carried.
    const resolver = (overrides = {}) => (message) => {
      const asked = parseQuery(message);
      const host = asked.question.labels.join('.');
      const key = asked.question.type === DNS_TYPE_PROOF_PROBE
        ? (host.startsWith('_443') ? 'proof_tlsa' : 'proof_a')
        : { 'membertest.8s28': 'answer_a', '_443._tcp.membertest.8s28': 'answer_tlsa', 'app.8s28': 'answer_plain' }[host];
      if (key in overrides) return overrides[key](message);
      const body = Buffer.from(hex(key, 'response'));
      body.writeUInt16BE(asked.id, 0);
      return body;
    };
    const nsec = (message) => parseMessage(message).records.filter((rr) => rr.section === 1 && rr.type === 47);

    test.each([['answer_a'], ['answer_tlsa']])('%s: one denial fetch over the same encrypted exchange, and its NSEC proof reaches the validator', async (key) => {
      const { request } = await setup(resolver());
      const reply = await relay.answer(hex(key, 'query'), true);
      expect(request).toHaveBeenCalledTimes(2);
      const probe = parseQuery(request.mock.results[1].value.end.mock.calls[0][0]);
      expect(probe.question).toEqual({ ...parseQuery(hex(key, 'query')).question, type: DNS_TYPE_PROOF_PROBE });
      expect(request.mock.calls[1][0]).toBe(ENCRYPTED_RESOLVER);
      expect(nsec(reply).map((rr) => rr.labels.join('.')).sort()).toEqual(['*.8s28', '_443._tcp.app.8s28']);
      expect(reply.readUInt16BE(2) & 0x20).toBe(0); // still no AD from the remote
    });

    test('an explicit record is passed through without a second request', async () => {
      const { request } = await setup(resolver());
      const reply = await relay.answer(hex('answer_plain', 'query'), true);
      expect(request).toHaveBeenCalledTimes(1);
      const expected = Buffer.from(hex('answer_plain', 'response'));
      expected.writeUInt16BE(expected.readUInt16BE(2) & ~0x20, 2); // the remote's AD is never passed on
      expect(reply.equals(expected)).toBe(true);
    });

    test('a denial asserting root authority retires the generation like any bad remote reply', async () => {
      const { onFailure } = await setup(resolver({
        proof_a: (message) => response(message, [[], [record('', 46, Buffer.alloc(30))], []]),
      }));
      await expect(relay.answer(hex('answer_a', 'query'), true)).rejects.toThrow();
      expect(onFailure).toHaveBeenCalledWith('encrypted_dns_transport_failed');
      expect(relay.isActive()).toBe(false);
    });

    test('a denial with no usable proof leaves the answer unproven for the validator to refuse', async () => {
      const { request } = await setup(resolver({
        proof_a: (message) => response(message, [[], [], []], 0x8180),
      }));
      const reply = await relay.answer(hex('answer_a', 'query'), true);
      expect(request).toHaveBeenCalledTimes(2);
      expect(nsec(reply)).toEqual([]);
    });

    test('a stalled denial fetch is bounded by the deadline', async () => {
      const { onFailure } = await setup(resolver({ proof_a: () => null }));
      await expect(relay.answer(hex('answer_a', 'query'), true)).rejects.toThrow();
      expect(onFailure).toHaveBeenCalledWith('encrypted_dns_transport_failed');
    });

    test('closing the generation during the denial fetch refuses the answer', async () => {
      let release;
      await setup(resolver({ proof_a: (message) => new Promise((resolve) => {
        release = () => { const body = Buffer.from(hex('proof_a', 'response')); body.writeUInt16BE(parseQuery(message).id, 0); resolve(body); };
      }) }));
      const pending = relay.answer(hex('answer_a', 'query'), true);
      const refused = expect(pending).rejects.toThrow();
      while (!release) await new Promise((resolve) => setImmediate(resolve));
      await relay.close();
      await refused;
      release(); await new Promise((resolve) => setImmediate(resolve));
      expect(relay.isActive()).toBe(false);
    });
  });
});
