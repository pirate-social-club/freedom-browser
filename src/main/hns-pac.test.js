jest.mock('./logger', () => ({ info: jest.fn(), error: jest.fn() }));

const { EventEmitter } = require('events');
const {
  buildHnsPacScript,
  createHnsPacLifecycle,
  getProxyAddr,
} = require('./hns-pac');
const { setDynamicHnsPublicSuffixes } = require('../shared/hns-hosts');

function createServerHarness() {
  let nextPort = 47000;
  const servers = [];
  const createServer = jest.fn((handler) => {
    const server = new EventEmitter();
    server.handler = handler;
    server.listen = jest.fn((_port, _host, callback) => callback());
    server.address = jest.fn(() => ({ port: nextPort++ }));
    server.close = jest.fn((callback) => callback());
    servers.push(server);
    return server;
  });
  return { createServer, servers };
}

const ready = (port) => ({
  hns: {
    mode: 'bundled',
    synced: true,
    api: `http://127.0.0.1:${port}`,
  },
});

describe('HNS PAC lifecycle', () => {
  afterEach(() => setDynamicHnsPublicSuffixes([]));

  test('generates compact, fail-closed HNS transport rules', () => {
    setDynamicHnsPublicSuffixes(['xn--pokmon-dva']);
    const pac = buildHnsPacScript('127.0.0.1:44041');
    expect(pac).toContain('var hnsRoots = {"pirate":1,"xn--pokmon-dva":1}');
    expect(pac).toContain('levels === 0 || hnsRoots[root] === 1');
    expect(pac).toContain('return "PROXY 127.0.0.1:44041"');
    expect(pac).toContain('return "DIRECT"');
    expect(() => buildHnsPacScript('resolver.example:8080')).toThrow(/loopback/);
  });

  test('accepts only fully-ready loopback registry endpoints', () => {
    expect(getProxyAddr(ready(44041).hns)).toBe('127.0.0.1:44041');
    expect(getProxyAddr({ ...ready(44041).hns, synced: false })).toBeNull();
    expect(getProxyAddr({ ...ready(44041).hns, api: 'http://192.0.2.1:44041' })).toBeNull();
  });

  test('installs, regenerates on port change, and clears on loss of readiness', async () => {
    const targetSession = { setProxy: jest.fn(async () => {}) };
    const { createServer, servers } = createServerHarness();
    const lifecycle = createHnsPacLifecycle({
      targetSession,
      createServer,
      subscribe: jest.fn(),
    });

    await lifecycle.schedule(ready(44041));
    expect(targetSession.setProxy).toHaveBeenLastCalledWith({
      pacScript: 'http://127.0.0.1:47000/proxy.pac',
    });
    expect(lifecycle.getAppliedProxyAddr()).toBe('127.0.0.1:44041');

    await lifecycle.schedule(ready(44042));
    expect(targetSession.setProxy).toHaveBeenLastCalledWith({
      pacScript: 'http://127.0.0.1:47001/proxy.pac',
    });
    expect(servers[0].close).toHaveBeenCalled();
    expect(lifecycle.getAppliedProxyAddr()).toBe('127.0.0.1:44042');

    await lifecycle.schedule({ hns: { mode: 'none', synced: false, api: null } });
    expect(targetSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' });
    expect(servers[1].close).toHaveBeenCalled();
    expect(lifecycle.getAppliedProxyAddr()).toBeNull();
  });

  test('subscribes once and clears routing when stopped', async () => {
    const targetSession = { setProxy: jest.fn(async () => {}) };
    const { createServer } = createServerHarness();
    let observer;
    const unsubscribe = jest.fn();
    const unsubscribeHostPolicy = jest.fn();
    let hostPolicyObserver;
    const subscribe = jest.fn((listener) => {
      observer = listener;
      return unsubscribe;
    });
    const subscribeHostPolicy = jest.fn((listener) => {
      hostPolicyObserver = listener;
      return unsubscribeHostPolicy;
    });
    const lifecycle = createHnsPacLifecycle({
      targetSession,
      createServer,
      subscribe,
      subscribeHostPolicy,
    });

    lifecycle.start();
    lifecycle.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
    await observer(ready(44041));
    await hostPolicyObserver(['.pirate', '.new-root']);
    expect(createServer).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeHostPolicy).toHaveBeenCalledTimes(1);
    expect(targetSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' });
  });
});
