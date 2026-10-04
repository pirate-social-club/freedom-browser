const { EventEmitter } = require('events');
const { createHnsGuardResources } = require('./hns-guard-resources');
const { createHnsGuardForwarding } = require('./hns-guard-forwarding');

function stream() {
  const value = new EventEmitter();
  value.destroyed = false;
  value.destroy = jest.fn(() => {
    if (value.destroyed) return;
    value.destroyed = true;
    value.emit('close');
  });
  value.write = jest.fn();
  value.pipe = jest.fn();
  value.resume = jest.fn();
  value.setTimeout = jest.fn();
  value.writeHead = jest.fn();
  value.end = jest.fn();
  return value;
}

function fixture() {
  const resources = createHnsGuardResources();
  resources.publish();
  const upstream = stream();
  const outbound = stream();
  let route = { host: '127.0.0.1', port: 5380 };
  const net = { connect: jest.fn(() => upstream) };
  const http = { request: jest.fn(() => outbound) };
  const fallbackConnect = jest.fn(async (_req, client) => { client.write('refused'); client.destroy(); });
  const fallbackHttp = jest.fn(async (_req, res) => { res.writeHead(502); res.end('refused'); });
  const forwarding = createHnsGuardForwarding({ net, http, resources, getRoute: () => route,
    isAllowed: () => true, markHost: jest.fn(), parseAuthority: () => ({ host: 'example.hns' }),
    writeError: jest.fn(), fallbackConnect, fallbackHttp, log: { warn: jest.fn() }, timeoutMs: 5000 });
  return { resources, upstream, outbound, net, http, fallbackConnect, fallbackHttp, forwarding,
    withdraw() { route = null; resources.withdraw(); } };
}

describe('HNS guard resource containment', () => {
  test('drain waits for actual closure, keeps admission closed and coalesces concurrent callers', async () => {
    const r = createHnsGuardResources();
    r.publish();
    const slow = stream();
    slow.destroy.mockImplementation(() => { slow.destroyed = true; });
    r.track(slow);
    let finished = false;
    const first = r.drain();
    expect(r.drain()).toBe(first);
    first.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    const arriving = stream();
    r.track(arriving);
    expect(arriving.destroy).toHaveBeenCalledTimes(1);
    slow.emit('close');
    await first;
    const later = stream();
    r.track(later);
    expect(later.destroy).toHaveBeenCalledTimes(1);
    r.publish();
    const admitted = stream();
    r.track(admitted);
    expect(admitted.destroy).not.toHaveBeenCalled();
  });

  test('a throwing destroy cannot prevent attempting other resource closures', async () => {
    const r = createHnsGuardResources();
    r.publish();
    const bad = stream();
    bad.destroy.mockImplementation(() => { throw new Error('native destruction'); });
    const other = stream();
    r.track(bad); r.track(other);
    await expect(r.drain()).rejects.toThrow('HNS guard resource destruction failed');
    expect(other.destroy).toHaveBeenCalledTimes(1);
  });

  test.each(['before-connect', 'partial-header', 'tunnel'])('CONNECT downstream close at %s closes its upstream and ignores late callbacks', (stage) => {
    const f = fixture();
    const client = stream();
    f.forwarding.connect({ url: 'example.hns:443', httpVersion: '1.1', headers: {} }, client);
    const connected = f.net.connect.mock.calls[0][2];
    if (stage !== 'before-connect') connected();
    if (stage === 'partial-header') f.upstream.emit('data', Buffer.from('HTTP/1.1 20'));
    if (stage === 'tunnel') f.upstream.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
    client.destroy();
    expect(f.upstream.destroy).toHaveBeenCalledTimes(1);
    const writes = client.write.mock.calls.length;
    const upstreamWrites = f.upstream.write.mock.calls.length;
    connected();
    f.upstream.emit('data', Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    f.upstream.emit('error', new Error('late failure'));
    f.upstream.setTimeout.mock.calls[0][1]();
    expect(client.write).toHaveBeenCalledTimes(writes);
    expect(f.upstream.write).toHaveBeenCalledTimes(upstreamWrites);
    expect(f.fallbackConnect).not.toHaveBeenCalled();
  });

  test('an established CONNECT upstream close destroys the downstream', () => {
    const f = fixture();
    const client = stream();
    f.forwarding.connect({ url: 'example.hns:443', httpVersion: '1.1', headers: {} }, client);
    f.upstream.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
    f.upstream.destroy();
    expect(client.destroyed).toBe(true);
  });

  test('an upstream refusal sends its diagnostic before synchronous pair closure', () => {
    const f = fixture();
    const client = stream();
    f.forwarding.connect({ url: 'example.hns:443', httpVersion: '1.1', headers: {} }, client);
    f.upstream.emit('data', Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    expect(client.write).toHaveBeenCalledWith('refused');
    expect(client.destroyed).toBe(true);
    expect(f.upstream.destroyed).toBe(true);
  });

  test('a preclosed CONNECT client opens no upstream and unreported late closure cancels the pending socket', () => {
    const f = fixture();
    const closed = stream(); closed.destroy();
    f.forwarding.connect({ url: 'example.hns:443' }, closed);
    expect(f.net.connect).not.toHaveBeenCalled();
    const late = stream();
    f.forwarding.connect({ url: 'example.hns:443', httpVersion: '1.1', headers: {} }, late);
    late.destroyed = true;
    f.net.connect.mock.calls[0][2]();
    expect(f.upstream.destroyed).toBe(true);
    expect(f.upstream.write).not.toHaveBeenCalled();
    expect(f.fallbackConnect).not.toHaveBeenCalled();
  });

  test.each(['aborted', 'response-close', 'response-error'])('HTTP %s closes request, response and owned upstream socket without late fallback', async (event) => {
    const f = fixture();
    const req = stream();
    Object.assign(req, { url: 'http://example.hns/', headers: {}, method: 'GET' });
    const res = stream();
    res.writableFinished = false;
    f.forwarding.request(req, res);
    const response = stream();
    response.statusCode = 200;
    const socket = stream();
    f.outbound.emit('socket', socket);
    f.http.request.mock.calls[0][1](response);
    if (event === 'aborted') req.emit('aborted');
    else if (event === 'response-close') res.destroy();
    else res.emit('error', new Error('downstream'));
    expect(f.outbound.destroyed).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(socket.destroyed).toBe(true);
    f.outbound.emit('error', new Error('late'));
    expect(f.fallbackHttp).not.toHaveBeenCalled();
    await f.resources.drain();
    expect(socket.destroyed).toBe(true);
    expect(f.http.request.mock.calls[0][0].agent).toBe(false);
  });

  test('normal incoming GET close does not cancel its pending response', () => {
    const f = fixture();
    const req = stream();
    Object.assign(req, { url: 'http://example.hns/', headers: {}, method: 'GET' });
    const res = stream();
    f.forwarding.request(req, res);
    req.emit('close');
    expect(f.outbound.destroy).not.toHaveBeenCalled();
    const response = stream();
    Object.assign(response, { statusCode: 200, complete: true });
    f.http.request.mock.calls[0][1](response);
    expect(response.pipe).toHaveBeenCalledWith(res);
    res.writableFinished = true;
    res.emit('close');
    expect(response.destroy).not.toHaveBeenCalled();
  });

  test('a response arriving after cancellation is destroyed before it can write or pipe', () => {
    const f = fixture();
    const req = stream();
    Object.assign(req, { url: 'http://example.hns/', headers: {}, method: 'GET' });
    const res = stream();
    f.forwarding.request(req, res);
    req.emit('aborted');
    const response = stream(); response.statusCode = 200;
    f.http.request.mock.calls[0][1](response);
    expect(response.destroyed).toBe(true);
    expect(response.pipe).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  test('withdrawn guard opens no new upstream connection', () => {
    const f = fixture(); f.withdraw();
    f.forwarding.connect({ url: 'example.hns:443' }, stream());
    f.forwarding.request({ url: 'http://example.hns/', headers: {} }, stream());
    expect(f.net.connect).not.toHaveBeenCalled();
    expect(f.http.request).not.toHaveBeenCalled();
  });
});
