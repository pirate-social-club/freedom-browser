const { EventEmitter } = require('events');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }

function fixture(options = {}) {
  const children = [];
  const lines = [];
  let port = 41000;
  const relay = { close: jest.fn(async () => {}), probe: jest.fn(async () => {}) };
  const custody = { prepare: jest.fn(), bindParent: jest.fn(), capture: jest.fn(async () => {}),
    isCaptured: () => true, terminate: jest.fn(async () => {}), neverSpawned: jest.fn() };
  const transport = { relay, custody, launcher: '/launcher', env: {} };
  const createTransport = jest.fn(() => options.transport || Promise.resolve(transport));
  const monitor = { allowed: () => true, close: jest.fn(async () => {}) };
  const createMonitor = jest.fn(() => monitor);
  const network = Object.fromEntries(['setHnsProtectionRequired', 'setHnsProxy', 'clearHnsProxy',
    'setHnsResolverAddrs', 'registerProxySession', 'unregisterProxySession', 'beginHnsCertificateUpdate',
    'rebuild'].map((name) => [name, jest.fn(async () => {})]));
  network.getHnsProxyAddr = () => '127.0.0.1:44000';
  network.refreshImportedHnsSuffixes = async () => ['.pirate'];
  const spawn = jest.fn(() => {
    const child = new EventEmitter(); child.pid = children.length + 100;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    child.kill = jest.fn((signal) => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null); return true; });
    children.push(child); return child;
  });
  const makeServer = () => {
    const server = new EventEmitter(); const ownPort = ++port;
    server.unref = () => {};
    server.listen = (_port, _host, callback) => callback();
    server.address = () => ({ port: ownPort }); server.close = (callback) => callback?.();
    return server;
  };
  const chain = jest.fn(async () => ({ synced: true, tipHash: 'a'.repeat(64), tipTime: Math.floor(Date.now() / 1000), height: 100, peers: 1, progress: 1 }));
  const validator = jest.fn(async () => ({ ok: true }));
  const cert = { setCertificateVerifyProc: jest.fn() };
  const { mod } = loadMainModule(require.resolve('./hns-manager'), {
    electronOverrides: { session: { defaultSession: cert } },
    extraMocks: {
      fs: () => ({ existsSync: () => true, readFileSync: () => Buffer.from('test'), mkdirSync: jest.fn() }),
      crypto: () => ({ ...jest.requireActual('crypto'), X509Certificate: class { raw = Buffer.from('test'); } }),
      net: () => ({ createServer: makeServer }),
      dgram: () => ({ createSocket: () => { const socket = new EventEmitter(); socket.unref = () => {};
        socket.close = () => {}; socket.bind = (_port, _host, callback) => callback(); return socket; } }),
      child_process: () => ({ spawn }),
      readline: () => ({ createInterface: () => { const line = new EventEmitter(); line.close = () => {}; lines.push(line); return line; } }),
      [require.resolve('./logger')]: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
      [require.resolve('./network-manager')]: () => network,
      [require.resolve('./hns-network-monitor')]: () => ({ createHnsNetworkMonitor: createMonitor }),
      [require.resolve('./hns-validator-transport')]: () => ({ createHnsValidatorTransport: createTransport }),
      [require.resolve('./hns-health')]: () => ({ probeHnsChainState: chain, probeHnsValidator: validator }),
      [require.resolve('./hns-checkpoint')]: () => ({ installHnsCheckpoint: jest.fn() }),
      [require.resolve('./browser-state-sanitizer')]: () => ({ pruneUnknownSingleLabelHistory: jest.fn() }),
      [require.resolve('./service-registry')]: () => ({ MODE: { BUNDLED: 'bundled' },
        ...Object.fromEntries(['updateService', 'setStatusMessage', 'setErrorState', 'clearErrorState', 'clearService'].map((name) => [name, jest.fn()])) }),
    },
  });
  return { mod, network, spawn, children, lines, relay, custody, transport, createTransport, createMonitor, monitor, chain, validator };
}

describe('HNS encrypted generation lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test('helper ready alone publishes no route or CA authority', async () => {
    const ctx = fixture(); await ctx.mod.startHns();
    ctx.lines[0].emit('line', JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44001', caPath: '/ca' }));
    await flush();
    expect(ctx.network.setHnsProtectionRequired).toHaveBeenCalledWith(true);
    expect(ctx.network.setHnsProxy).not.toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);
    await ctx.mod.stopHns();
    expect(ctx.custody.terminate).toHaveBeenCalledTimes(1);
  });

  test('stop during asynchronous transport preparation cannot spawn a late helper', async () => {
    const pending = deferred(); const ctx = fixture({ transport: pending.promise });
    const starting = ctx.mod.startHns(); await flush();
    expect(ctx.createTransport).toHaveBeenCalledTimes(1);
    const stopping = ctx.mod.stopHns(); pending.resolve(ctx.transport);
    await Promise.all([starting, stopping]);
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.relay.close).toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus().status).toBe('stopped');
  });

  test('a later explicit stop extends the same teardown barrier through observer closure', async () => {
    const native = deferred(); const observer = deferred(); const ctx = fixture();
    await ctx.mod.startHns(); ctx.custody.terminate.mockReturnValue(native.promise);
    ctx.monitor.close.mockReturnValue(observer.promise);
    const recovering = ctx.mod.stopHns({ recovering: true });
    const explicit = ctx.mod.stopHns(); await ctx.mod.startHns();
    expect(ctx.createMonitor).toHaveBeenCalledTimes(1);
    native.resolve(); await flush();
    expect(ctx.mod.getHnsStatus().status).toBe('stopping');
    expect(ctx.spawn).toHaveBeenCalledTimes(1);
    observer.resolve(); await Promise.all([recovering, explicit]); await flush();
    expect(ctx.createMonitor).toHaveBeenCalledTimes(2);
    expect(ctx.spawn).toHaveBeenCalledTimes(2);
    await ctx.mod.stopHns();
  });

  test('unknown native cleanup prevents another generation', async () => {
    const ctx = fixture(); await ctx.mod.startHns();
    ctx.custody.terminate.mockRejectedValue(new Error('Unresolved identity'));
    await expect(ctx.mod.stopHns()).rejects.toThrow();
    await ctx.mod.startHns();
    expect(ctx.spawn).toHaveBeenCalledTimes(1);
  });

  test('Go exit is followed by native termination before shared stdio closure', async () => {
    const ctx = fixture(); await ctx.mod.startHns(); const child = ctx.children[0];
    child.kill.mockImplementation((signal) => {
      child.signalCode = signal; child.emit('exit', null, signal); return true;
    });
    ctx.custody.terminate.mockImplementation(async () => child.emit('close', null));
    await ctx.mod.stopHns();
    expect(ctx.custody.terminate).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getHnsStatus().status).toBe('stopped');
  });
});
