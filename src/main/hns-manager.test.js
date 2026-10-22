const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function createProcessMock() {
  const proc = new (require('events').EventEmitter)();
  proc.stdout = new (require('events').EventEmitter)();
  proc.stderr = new (require('events').EventEmitter)();
  proc.exitCode = null;
  proc.signalCode = null;
  const emit = proc.emit.bind(proc);
  proc.emit = (event, ...args) => {
    if (event === 'close' && proc.exitCode === null && proc.signalCode === null) {
      proc.exitCode = args[0] ?? 0;
      emit('exit', proc.exitCode, null);
    }
    return emit(event, ...args);
  };
  proc.emitStdout = (...args) => proc.stdout.emit(...args);
  proc.emitStderr = (...args) => proc.stderr.emit(...args);
  proc.kill = jest.fn((signal) => {
    proc.signalCode = signal;
    emit('exit', null, signal);
    emit('close', null, signal);
    return true;
  });
  return proc;
}

function loadHnsManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = createAppMock({
    isPackaged: options.isPackaged ?? false,
    userDataDir: options.userDataDir || '/tmp/freedom-test-hns',
  });
  const windows = options.windows || [];
  const windowMock = { webContents: { send: jest.fn() } };
  const allWindows = windows.length > 0 ? windows : [windowMock];
  const BrowserWindow = { getAllWindows: jest.fn(() => allWindows) };
  const session = {
    defaultSession: {
      setCertificateVerifyProc: jest.fn(),
      setProxy: jest.fn(() => Promise.resolve()),
    },
  };

  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') return options.existsSync(target);
      if (target.includes('fingertipd')) return options.fingertipdExists ?? true;
      if (target.includes('hnsd')) return options.hnsdExists ?? true;
      if (target.includes('hns-data')) return true;
      return false;
    }),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn((...args) => options.readFileSync?.(...args)),
    writeFileSync: jest.fn(),
  };

  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const clearService = jest.fn();

  const setHnsProtectionRequired = jest.fn();
  const setHnsProxy = jest.fn();
  const beginHnsCertificateUpdate = jest.fn(async () => {});
  const setHnsResolverAddrs = jest.fn();
  const clearHnsProxy = jest.fn();
  const registerProxySession = jest.fn(async () => {});
  const unregisterProxySession = jest.fn();
  const rebuild = jest.fn(() => Promise.resolve());
  const getHnsProxyAddr = jest.fn(() => options.effectiveHnsProxyAddr ?? '127.0.0.1:55000');
  const fetchHnsNamespaces = jest.fn(options.fetchHnsNamespaces || (async () => ({
    generatedAt: Date.parse('2026-10-22T07:00:00.000Z'), roots: new Map(), receivedAt: performance.now(),
  })));
  // The real routing call sets the shared set that hns-manager also reads; the
  // module registry is shared after loadMainModule's reset, so this is that set.
  const setImportedHnsRoots = jest.fn((roots) => require('../shared/hns-hosts').setDynamicHnsPublicSuffixes(roots));
  const getProxySessionPolicy = jest.fn(options.getProxySessionPolicy || (() => ({ allowed: true, generation: 1, state: 'ready' })));
  let guardRouting = options.guardRouting ?? true;
  let guardRoutingObserver = null;
  const isHnsGuardRouting = jest.fn(() => guardRouting);
  const setHnsGuardRoutingObserver = jest.fn((observer) => { guardRoutingObserver = observer; });
  // Stands in for a routing policy commit that changes guard routing.
  const commitGuardRouting = (value) => { guardRouting = value; guardRoutingObserver?.(value); };
  const canResolveHnsFallbackForHost = jest.fn(() => Promise.resolve(options.canResolveHnsFallbackForHost ?? false));
  const getHnsResolutionForHost = jest.fn(() => {
    if (Object.prototype.hasOwnProperty.call(options, 'hnsResolutionForHost')) {
      return Promise.resolve(options.hnsResolutionForHost);
    }
    return Promise.resolve(options.canResolveHnsFallbackForHost ? { resolverType: 'doh' } : null);
  });
  const isHnsProxyHost = jest.fn(() => options.isHnsProxyHost ?? false);
  const pruneUnknownSingleLabelHistory = jest.fn();
  const installHnsCheckpoint = jest.fn(() => {
    if (options.checkpointError) throw new Error(options.checkpointError);
    return true;
  });
  const spawnedProcesses = [];
  const tcpPorts = [...(options.tcpPorts || [41001, 41002, 41003, 41004])];
  const unavailableUdpPorts = new Set(options.unavailableUdpPorts || []);
  const spawn = jest.fn((binary, args = []) => {
    const proc = (options.createProcess || createProcessMock)();
    proc.pid = 100 + spawnedProcesses.length;
    proc.binary = binary;
    proc.args = args;
    spawnedProcesses.push(proc);
    return proc;
  });
  const readlineHandlers = new Map();
  const readlineInterface = {
    close: jest.fn(),
    on: jest.fn((event, handler) => {
      readlineHandlers.set(event, handler);
    }),
  };

  const { mod } = loadMainModule(require.resolve('./hns-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      electron: () => ({
        app,
        ipcMain,
        BrowserWindow,
        session,
      }),
      fs: () => fsMock,
      child_process: () => ({
        spawn,
      }),
      crypto: () => ({
        ...jest.requireActual('crypto'),
        ...options.cryptoMock,
      }),
      net: () => ({
        createServer: jest.fn(() => {
          const handlers = new Map();
          const port = tcpPorts.shift() || 41999;
          return {
            unref: jest.fn(),
            once: jest.fn((event, handler) => {
              handlers.set(event, handler);
            }),
            listen: jest.fn((_port, _host, callback) => {
              callback?.();
            }),
            address: jest.fn(() => ({ port })),
            close: jest.fn((callback) => {
              callback?.();
            }),
          };
        }),
      }),
      dgram: () => ({
        createSocket: jest.fn(() => {
          const handlers = new Map();
          return {
            unref: jest.fn(),
            once: jest.fn((event, handler) => {
              handlers.set(event, handler);
            }),
            bind: jest.fn((port, _host, callback) => {
              if (unavailableUdpPorts.has(port)) {
                handlers.get('error')?.(new Error('EADDRINUSE'));
                return;
              }
              callback?.();
            }),
            close: jest.fn(),
          };
        }),
      }),
      readline: () => ({
        createInterface: jest.fn(() => readlineInterface),
      }),
      [require.resolve('./logger')]: () => log,
      [require.resolve('./service-registry')]: () => ({
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
        MODE: { BUNDLED: 'bundled', REUSED: 'reused', EXTERNAL: 'external', NONE: 'none' },
      }),
      [require.resolve('./network-manager')]: () => ({
        setHnsProtectionRequired,
        setHnsProxy,
        beginHnsCertificateUpdate,
        setHnsResolverAddrs,
        clearHnsProxy,
        registerProxySession,
        unregisterProxySession,
        rebuild,
        getHnsProxyAddr,
        fetchHnsNamespaces,
        setImportedHnsRoots,
        getProxySessionPolicy,
        isHnsGuardRouting,
        setHnsGuardRoutingObserver,
        getHnsResolutionForHost,
        canResolveHnsFallbackForHost,
        isHnsProxyHost,
      }),
      [require.resolve('./browser-state-sanitizer')]: () => ({
        pruneUnknownSingleLabelHistory,
      }),
      [require.resolve('./hns-checkpoint')]: () => ({ installHnsCheckpoint }),
      [require.resolve('./hns-network-monitor')]: () => ({
        createHnsNetworkMonitor: () => ({ allowed: () => true, close: jest.fn(async () => {}) }),
      }),
      [require.resolve('./hns-validator-transport')]: () => ({
        createHnsValidatorTransport: jest.fn(async () => ({
          launcher: '/test-owned-encrypted-launcher', env: {},
          relay: { probe: jest.fn(async () => {}), close: jest.fn(async () => {}) },
          custody: { prepare: jest.fn(), bindParent: jest.fn(), capture: jest.fn(async () => {}),
            isCaptured: () => true, terminate: jest.fn(async () => {}), neverSpawned: jest.fn() },
        })),
      }),
      [require.resolve('./hns-health')]: () => ({
        HNS_VALIDATOR_INCOMPLETE_CODES: jest.requireActual('./hns-health').HNS_VALIDATOR_INCOMPLETE_CODES,
        probeHnsValidator: options.probeHnsValidator || jest.fn(async () => ({ ok: true })),
        probeHnsChainState: options.probeHnsChainState || jest.fn(async () => ({
          synced: true, height: 326149, progress: 0.99, peers: 2,
          tipHash: 'a'.repeat(64), tipTime: Math.floor(Date.now() / 1000),
        })),
      }),
      [require.resolve('../shared/platform-capabilities')]: () => ({
        getCapabilityStatus: jest.fn(() => ({
          supported: options.hnsSupported ?? true,
          target: options.hnsTarget || 'linux-x64',
          unsupportedReason: options.hnsSupported === false
            ? 'Handshake browsing is unavailable on this platform.'
            : null,
        })),
      }),
    },
  });

  return {
    mod,
    app,
    ipcMain,
    BrowserWindow,
    session,
    fsMock,
    installHnsCheckpoint,
    log,
    updateService,
    setStatusMessage,
    setErrorState,
    clearErrorState,
    clearService,
    setHnsProxy,
    beginHnsCertificateUpdate,
    setHnsResolverAddrs,
    clearHnsProxy,
    registerProxySession,
    unregisterProxySession,
    rebuild,
    getHnsProxyAddr,
    fetchHnsNamespaces,
    setImportedHnsRoots,
    getProxySessionPolicy,
    isHnsGuardRouting,
    setHnsGuardRoutingObserver,
    commitGuardRouting,
    getHnsResolutionForHost,
    canResolveHnsFallbackForHost,
    isHnsProxyHost,
    pruneUnknownSingleLabelHistory,
    spawn,
    spawnedProcesses,
    readlineInterface,
    readlineHandlers,
    windowMock,
  };
}

const OBSOLETE_HNS_CANARY = ['shake', 'station'].join('');

function loadCertificateSessionFixture() {
  return loadHnsManagerModule({
    cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
    readFileSync: () => 'test certificate',
  });
}

async function emitHelperReady(ctx) {
  await ctx.mod.startHns();
  ctx.readlineHandlers.get('line')?.(JSON.stringify({
    type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem',
  }));
  await jest.advanceTimersByTimeAsync(6000);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('hns-manager', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('STATUS exports all expected states', () => {
    const ctx = loadHnsManagerModule();
    expect(ctx.mod.STATUS).toHaveProperty('STOPPED');
    expect(ctx.mod.STATUS).toHaveProperty('STARTING');
    expect(ctx.mod.STATUS).toHaveProperty('RUNNING');
    expect(ctx.mod.STATUS).toHaveProperty('STOPPING');
    expect(ctx.mod.STATUS).toHaveProperty('ERROR');
  });

  test('does not launch the helper when the bundled checkpoint is invalid', async () => {
    const ctx = loadHnsManagerModule({ checkpointError: 'invalid checkpoint digest' });
    await ctx.mod.startHns();
    expect(ctx.mod.getHnsStatus().status).toBe('error');
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('hns', 'HNS checkpoint unavailable or invalid');
  });

  test('getHnsStatus returns initial state', () => {
    const ctx = loadHnsManagerModule();
    const status = ctx.mod.getHnsStatus();
    expect(status).toEqual({
      supported: true,
      target: 'linux-x64',
      unsupportedReason: null,
      status: 'stopped',
      error: null,
      synced: false,
      canaryReady: false,
      localResolverReady: false,
      dohFallbackReady: false,
      height: 0,
      peerCount: 0,
      syncProgress: 0,
      proxyAddr: null,
      caPemPath: null,
      rootAddr: null,
      recursiveAddr: null,
    });
  });

  test('two native validations publish readiness and a later failure retires it', async () => {
    const validator = jest.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false });
    const ctx = loadHnsManagerModule({
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate', probeHnsValidator: validator,
    });
    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
    const published = ctx.setHnsProxy.mock.calls[0][1];
    expect(published.isValid()).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);
    expect(published.isValid()).toBe(false);
    expect(ctx.clearHnsProxy).toHaveBeenCalled();
  });

  // A validation probe that cannot complete (a query timed out) is retried
  // inside the existing lease; it never renews it, and expiry still retires.
  const timedOut = () => Object.assign(new Error('DNS query timed out for app.pirate'), { code: 'ETIMEOUT' });
  async function publishedWith(validator) {
    const ctx = loadHnsManagerModule({
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate', probeHnsValidator: validator,
    });
    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
    return { ctx, published: ctx.setHnsProxy.mock.calls[0][1] };
  }

  test('a validation probe that does not complete is retried within the lease and a verified success keeps the generation', async () => {
    const validator = jest.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(timedOut()).mockResolvedValue({ ok: true });
    const { ctx, published } = await publishedWith(validator);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('Validator probe did not complete; retrying within the current lease (1/2)'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(validator).toHaveBeenCalledTimes(4);
    expect(published.isValid()).toBe(true);
    expect(ctx.clearHnsProxy).not.toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
  });

  test('probes that keep failing to complete retire the generation as incomplete', async () => {
    const validator = jest.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(timedOut());
    const { ctx, published } = await publishedWith(validator);
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(published.isValid()).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(validator).toHaveBeenCalledTimes(5);
    expect(published.isValid()).toBe(false);
    expect(ctx.clearHnsProxy).toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith('[HNS] Resolver generation retired: hns_validation_incomplete');
  });

  test('a retry renews nothing: the lease still expires on schedule and a late success cannot revive it', async () => {
    const slowFailure = () => new Promise((_resolve, reject) => setTimeout(() => reject(timedOut()), 6000));
    const lateSuccess = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 6000));
    const validator = jest.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(slowFailure).mockImplementationOnce(lateSuccess).mockResolvedValue({ ok: true });
    // Leases run on the monotonic clock; let it follow the faked one here.
    const start = Date.now();
    const monotonic = jest.spyOn(require('perf_hooks').performance, 'now').mockImplementation(() => Date.now() - start);
    try {
    // The second success at t=6 s renewed the validation lease to t=21 s.
    const { ctx, published } = await publishedWith(validator);
    await jest.advanceTimersByTimeAsync(14800); // t=20.8 s: the retry is still in flight
    expect(validator).toHaveBeenCalledTimes(4);
    expect(published.isValid()).toBe(true);
    await jest.advanceTimersByTimeAsync(400); // t=21.2 s: past the lease, nothing renewed it
    expect(published.isValid()).toBe(false);
    await jest.advanceTimersByTimeAsync(3000); // the retry's success arrives at t=24 s
    expect(published.isValid()).toBe(false);
    expect(ctx.setHnsProxy.mock.calls.filter(([, authority]) => authority === published)).toHaveLength(1);
    } finally {
      monotonic.mockRestore();
    }
  });

  test.each([
    ['truncated (TCP fallback is off)', 'ETRUNCATED'],
    ['mismatched or malformed', undefined],
  ])('a %s reply is a failed answer, not an incomplete probe: it retires at once', async (_label, code) => {
    const failure = Object.assign(new Error('DNS reply refused'), code ? { code } : {});
    const validator = jest.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(failure);
    const { ctx, published } = await publishedWith(validator);
    await jest.advanceTimersByTimeAsync(5000);
    expect(validator).toHaveBeenCalledTimes(3);
    expect(published.isValid()).toBe(false);
    expect(ctx.log.warn).toHaveBeenCalledWith('[HNS] Resolver generation retired: hns_validation_failed');
    expect(ctx.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('retrying within the current lease'));
  });

  test('a remote DoH result cannot replace failed local DNSSEC validation', async () => {
    const ctx = loadHnsManagerModule({
      hnsResolutionForHost: { resolverType: 'doh' },
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate', probeHnsValidator: jest.fn(async () => ({ ok: false })),
    });
    await emitHelperReady(ctx);
    expect(ctx.mod.getHnsStatus()).toMatchObject({ dohFallbackReady: false, localResolverReady: false });
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    expect(ctx.getHnsResolutionForHost).not.toHaveBeenCalled();
    expect(ctx.canResolveHnsFallbackForHost).not.toHaveBeenCalled();
  });

  test('skips readiness broadcasts when validation remains ready', async () => {
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const broadcasts = () => ctx.updateService.mock.calls.filter(([_service, updates]) => (
      Object.prototype.hasOwnProperty.call(updates, 'dohFallbackReady') &&
      !Object.prototype.hasOwnProperty.call(updates, 'synced')
    ));
    expect(broadcasts()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(5000);
    expect(broadcasts()).toHaveLength(2);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
  });

  test('helper canary changes do not override independently observed chain readiness', async () => {
    jest.useFakeTimers();
    const ctx = loadHnsManagerModule({
      cryptoMock: {
        X509Certificate: class {
          raw = Buffer.from('test certificate');
        },
      },
      hnsHealth: {
        buildHnsHealthProbeHosts: jest.fn(() => ['pirate', 'app.pirate']),
        formatHnsHealthSummary: jest.fn(() => 'pirate=OK, app.pirate=OK'),
        probeHnsResolver: jest.fn(() => Promise.resolve({
          ok: true,
          results: [
            { host: 'pirate', ok: true, addresses: ['173.199.93.117'] },
            { host: 'app.pirate', ok: true, addresses: ['173.199.93.117'] },
          ],
        })),
      },
      readFileSync: () => 'test certificate',
    });

    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({
      type: 'ready',
      proxyAddr: '127.0.0.1:44041',
      caPath: '/tmp/hns-ca.pem',
    }));
    await Promise.resolve();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({
      type: 'sync',
      synced: true,
      height: 326149,
    }));

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);

    ctx.readlineHandlers.get('line')?.(JSON.stringify({
      type: 'sync',
      synced: false,
      canaryReady: false,
      height: 326150,
    }));

    expect(ctx.mod.getHnsStatus().synced).toBe(true);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
    expect(ctx.mod.getHnsStatus().dohFallbackReady).toBe(false);
  });

  test('a quiet stalled height and a successful helper canary cannot establish chain sync', async () => {
    jest.useFakeTimers();
    const ctx = loadHnsManagerModule({
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate',
      probeHnsChainState: jest.fn(async () => ({ synced: false, height: 136149, progress: 0.4, peers: 0 })),
    });
    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    await Promise.resolve();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({ type: 'sync', synced: true, height: 136149 }));
    await jest.advanceTimersByTimeAsync(30000);
    expect(ctx.mod.getHnsStatus()).toMatchObject({ synced: false, canaryReady: true, localResolverReady: false, height: 136149, peerCount: 0 });
    expect(ctx.setStatusMessage).toHaveBeenLastCalledWith('hns', 'Syncing block 136149; 0 peers');
  });

  test('lost chain sync or metadata retires authority until a fresh generation', async () => {
    let chain = { synced: true, height: 349265, progress: 1, peers: 2, tipHash: 'a'.repeat(64) };
    const ctx = loadHnsManagerModule({
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate',
      probeHnsChainState: jest.fn(async () => {
        if (chain instanceof Error) throw chain;
        return { ...chain, tipTime: Math.floor(Date.now() / 1000) };
      }),
    });
    await emitHelperReady(ctx);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
    const first = ctx.setHnsProxy.mock.calls[0][1];
    chain = { ...chain, synced: false };
    await jest.advanceTimersByTimeAsync(2000);
    expect(ctx.mod.getHnsStatus()).toMatchObject({ synced: false, localResolverReady: false });
    expect(first.isValid()).toBe(false);
    await ctx.mod.stopHns();
    chain = { ...chain, synced: true };
    await emitHelperReady(ctx);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);
    const second = ctx.setHnsProxy.mock.calls[1][1];
    expect(second.generation).toBeGreaterThan(first.generation);
    chain = new Error('resolver stopped responding');
    await jest.advanceTimersByTimeAsync(2000);
    expect(ctx.mod.getHnsStatus()).toMatchObject({ synced: false, localResolverReady: false });
    expect(second.isValid()).toBe(false);
  });

  test('an address-only local delegation cannot replace native validation', async () => {
    const ctx = loadHnsManagerModule({
      hnsResolutionForHost: { resolverType: 'local' },
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate', probeHnsValidator: jest.fn(async () => ({ ok: false })),
    });
    await emitHelperReady(ctx);
    expect(ctx.mod.getHnsStatus()).toMatchObject({ dohFallbackReady: false, localResolverReady: false });
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    expect(ctx.getHnsResolutionForHost).not.toHaveBeenCalled();
  });

  test('publishes guarded HNS proxy instead of helper upstream', async () => {
    const ctx = loadHnsManagerModule({
      effectiveHnsProxyAddr: '127.0.0.1:55000',
      cryptoMock: {
        X509Certificate: class {
          raw = Buffer.from('test certificate');
        },
      },
      readFileSync: () => 'test certificate',
    });

    await emitHelperReady(ctx);

    expect(ctx.setHnsProxy).toHaveBeenCalledWith('127.0.0.1:44041', expect.objectContaining({
      generation: expect.any(Number), caFingerprint: expect.any(String), isValid: expect.any(Function),
    }));
    expect(ctx.rebuild).toHaveBeenCalled();
    expect(ctx.getHnsProxyAddr).toHaveBeenCalled();
    expect(ctx.updateService).toHaveBeenCalledWith('hns', expect.objectContaining({
      api: 'http://127.0.0.1:55000',
      proxy: '127.0.0.1:55000',
    }));
    expect(ctx.updateService).not.toHaveBeenCalledWith('hns', expect.objectContaining({
      proxy: '127.0.0.1:44041',
    }));
    expect(ctx.mod.getHnsStatus().proxyAddr).toBe('127.0.0.1:55000');
  });

  test('helper sync event reports only canary health before chain observation', async () => {
    const ctx = loadHnsManagerModule();

    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({
      type: 'sync',
      synced: true,
      canaryReady: false,
      height: 326149,
    }));

    expect(ctx.mod.getHnsStatus()).toEqual(expect.objectContaining({
      synced: false,
      canaryReady: true,
      height: 0,
    }));
  });

  test('checkBinary returns true when fingertipd exists', () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: true });
    expect(ctx.mod.checkBinary()).toBe(true);
  });

  test('checkBinary returns false when fingertipd missing', () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: false });
    expect(ctx.mod.checkBinary()).toBe(false);
  });

  test('checkBinary returns false when fingertipd contains obsolete canary', () => {
    const ctx = loadHnsManagerModule({
      readFileSync: (target) => (
        target.includes('fingertipd')
          ? Buffer.from(`obsolete canary: ${OBSOLETE_HNS_CANARY}`)
          : 'test certificate'
      ),
    });
    expect(ctx.mod.checkBinary()).toBe(false);
  });

  test('startHns sets error when fingertipd binary not found', async () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: false });
    await ctx.mod.startHns();
    expect(ctx.mod.getHnsStatus().status).toBe('error');
    expect(ctx.mod.getHnsStatus().error).toContain('Helper binary not found');
  });

  test('startHns refuses unsupported targets before inspecting or spawning binaries', async () => {
    const ctx = loadHnsManagerModule({
      hnsSupported: false,
      hnsTarget: 'mac-arm64',
    });

    await ctx.mod.startHns();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.fsMock.existsSync).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith(
      'hns',
      'Handshake browsing is unavailable on this platform.'
    );
    expect(ctx.mod.getHnsStatus()).toMatchObject({
      supported: false,
      target: 'mac-arm64',
      status: 'stopped',
    });
  });

  test('startHns sets error when hnsd binary not found', async () => {
    const ctx = loadHnsManagerModule({
      fingertipdExists: true,
      hnsdExists: false,
    });
    await ctx.mod.startHns();
    expect(ctx.mod.getHnsStatus().status).toBe('error');
    expect(ctx.mod.getHnsStatus().error).toContain('hnsd binary not found');
  });

  test('startHns rejects obsolete fingertipd canary before spawning', async () => {
    const ctx = loadHnsManagerModule({
      readFileSync: (target) => (
        target.includes('fingertipd')
          ? Buffer.from(`obsolete canary: ${OBSOLETE_HNS_CANARY}`)
          : 'test certificate'
      ),
    });

    await ctx.mod.startHns();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus().status).toBe('error');
    expect(ctx.mod.getHnsStatus().error).toContain(`obsolete hardcoded canary "${OBSOLETE_HNS_CANARY}"`);
    expect(ctx.setErrorState).toHaveBeenCalledWith('hns', expect.stringContaining('obsolete hardcoded canary'));
  });

  test('startHns ignores request when already running', async () => {
    const ctx = loadHnsManagerModule();
    ctx.mod.startHns();
    expect(ctx.mod.getHnsStatus().status).toBe('starting');
    const statusBefore = ctx.mod.getHnsStatus().status;
    await ctx.mod.startHns();
    expect(ctx.mod.getHnsStatus().status).toBe(statusBefore);
  });

  test('startHns allocates resolver ports and passes them to fingertipd', async () => {
    const ctx = loadHnsManagerModule({
      tcpPorts: [42111, 42112],
    });

    await ctx.mod.startHns();

    expect(ctx.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.spawnedProcesses[0].args).toEqual(
      expect.arrayContaining([
        '-root-addr',
        '127.0.0.1:42111',
        '-recursive-addr',
        '127.0.0.1:42112',
      ])
    );
    expect(ctx.mod.getHnsStatus()).toEqual(
      expect.objectContaining({
        status: 'starting',
        rootAddr: '127.0.0.1:42111',
        recursiveAddr: '127.0.0.1:42112',
      })
    );
  });

  test('startHns retries UDP collisions while allocating resolver ports', async () => {
    const ctx = loadHnsManagerModule({
      tcpPorts: [43001, 43002, 43003],
      unavailableUdpPorts: [43001],
    });

    await ctx.mod.startHns();

    expect(ctx.spawnedProcesses[0].args).toEqual(
      expect.arrayContaining([
        '-root-addr',
        '127.0.0.1:43002',
        '-recursive-addr',
        '127.0.0.1:43003',
      ])
    );
  });

  test('startHns rate-limits repeated helper DNS misses as resolver info', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-02T12:00:00.000Z'));

    const ctx = loadHnsManagerModule();
    await ctx.mod.startHns();
    const proc = ctx.spawnedProcesses[0];

    proc.emitStderr(
      'data',
      Buffer.from('2026/05/02 12:00:00 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)\n')
    );
    jest.setSystemTime(new Date('2026-05-02T12:00:05.000Z'));
    proc.emitStderr(
      'data',
      Buffer.from('2026/05/02 12:00:05 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)\n')
    );

    expect(ctx.log.warn).not.toHaveBeenCalled();
    let helperInfoCalls = ctx.log.info.mock.calls
      .map(([message]) => message)
      .filter((message) => message.startsWith('[HNS helper]'));
    expect(helperInfoCalls).toEqual([
      '[HNS helper] Local DNS miss; guard resolver will retry',
    ]);

    jest.setSystemTime(new Date('2026-05-02T12:00:31.000Z'));
    proc.emitStderr(
      'data',
      Buffer.from('2026/05/02 12:00:31 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)\n')
    );

    expect(ctx.log.warn).not.toHaveBeenCalled();
    helperInfoCalls = ctx.log.info.mock.calls
      .map(([message]) => message)
      .filter((message) => message.startsWith('[HNS helper]'));
    expect(helperInfoCalls).toEqual([
      '[HNS helper] Local DNS miss; guard resolver will retry',
      '[HNS helper] Suppressed 1 repeat local DNS misses',
      '[HNS helper] Local DNS miss; guard resolver will retry',
    ]);
    expect(helperInfoCalls.join(' ')).not.toContain('missing.pirate');
  });

  test('stopHns clears proxy and service when no process', async () => {
    const ctx = loadHnsManagerModule();
    await ctx.mod.stopHns();
    expect(ctx.clearHnsProxy).toHaveBeenCalled();
    expect(ctx.clearService).toHaveBeenCalledWith('hns', {
      publicSuffixes: ['.pirate'],
      discovery: { state: 'unavailable', lastSuccessAt: null, origin: null },
      guardRouting: true,
    });
    expect(ctx.rebuild).toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus().status).toBe('stopped');
  });

  test('enrolled sessions receive the CA before routing is activated', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await ctx.mod.registerHnsSession(privateSession);
    await emitHelperReady(ctx);
    expect(privateSession.setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function));
    expect(privateSession.setCertificateVerifyProc.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.setHnsProxy.mock.invocationCallOrder[0]);
    const verify = privateSession.setCertificateVerifyProc.mock.calls[0][0];
    const callback = jest.fn();
    verify({ hostname: 'app.pirate', certificate: { fingerprint: 'sha256/untrusted' } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
    const trusted = ctx.mod.chromiumCertificateFingerprint(Buffer.from('test certificate'));
    verify({ hostname: 'app.pirate', certificate: { issuerCert: { fingerprint: trusted } } }, callback);
    expect(callback).toHaveBeenLastCalledWith(0);
  });

  test('validated readiness waits for connection drainage before applying CA authority', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    let release;
    ctx.beginHnsCertificateUpdate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await emitHelperReady(ctx);
    expect(ctx.beginHnsCertificateUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.session.defaultSession.setCertificateVerifyProc).not.toHaveBeenCalled();
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    release();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(ctx.session.defaultSession.setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.setHnsProxy).toHaveBeenCalledTimes(1);
  });

  test('failed drainage never applies or publishes CA authority', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    ctx.beginHnsCertificateUpdate.mockRejectedValueOnce(new Error('drain failed'));
    await emitHelperReady(ctx);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);
    expect(ctx.session.defaultSession.setCertificateVerifyProc).not.toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
  });

  test('a duplicate helper ready event cannot replace an activating identity', async () => {
    const ctx = loadCertificateSessionFixture();
    let release;
    ctx.beginHnsCertificateUpdate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await emitHelperReady(ctx);
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44042', caPath: '/tmp/other-ca.pem' }));
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    release();
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(ctx.setHnsProxy).toHaveBeenCalledTimes(1);
    expect(ctx.setHnsProxy.mock.calls[0][0]).toBe('127.0.0.1:44041');
    expect(ctx.fsMock.readFileSync).not.toHaveBeenCalledWith('/tmp/other-ca.pem', 'utf-8');
  });

  test('late enrollment installs certificates before adopting routing', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await ctx.mod.registerHnsSession(privateSession);
    expect(privateSession.setCertificateVerifyProc.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.registerProxySession.mock.invocationCallOrder.at(-1));
  });

  test('closed sessions are absent from later certificate updates', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await ctx.mod.registerHnsSession(privateSession);
    ctx.mod.unregisterHnsSession(privateSession);
    await emitHelperReady(ctx);
    expect(ctx.unregisterProxySession).toHaveBeenCalledWith(privateSession);
    expect(privateSession.setCertificateVerifyProc).toHaveBeenCalledTimes(1);
    expect(privateSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
  });

  test('failed enrollment rolls back certificate and proxy membership', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    ctx.registerProxySession.mockRejectedValueOnce(new Error('routing unavailable'));
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await expect(ctx.mod.registerHnsSession(privateSession)).rejects.toThrow('routing unavailable');
    expect(ctx.unregisterProxySession).toHaveBeenCalledWith(privateSession);
    await emitHelperReady(ctx);
    expect(privateSession.setCertificateVerifyProc).toHaveBeenCalledTimes(1);
    expect(privateSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
  });

  test('certificate setup failure refuses enrollment before proxy setup', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const privateSession = { setCertificateVerifyProc: jest.fn().mockImplementationOnce(() => { throw new Error('certificate setup failed'); }) };
    await expect(ctx.mod.registerHnsSession(privateSession)).rejects.toThrow('certificate setup failed');
    expect(ctx.registerProxySession).not.toHaveBeenCalled();
    expect(ctx.unregisterProxySession).toHaveBeenCalledWith(privateSession);
  });

  test('helper exit revokes authority even when one certificate session fails cleanup', async () => {
    const ctx = loadCertificateSessionFixture();
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await ctx.mod.registerHnsSession(privateSession);
    await emitHelperReady(ctx);
    const retained = privateSession.setCertificateVerifyProc.mock.calls[0][0];
    ctx.session.defaultSession.setCertificateVerifyProc.mockImplementationOnce(() => { throw new Error('session closed'); });
    ctx.spawnedProcesses[0].emit('close', 0);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(privateSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
    const callback = jest.fn();
    retained({ certificate: { fingerprint: ctx.mod.chromiumCertificateFingerprint(Buffer.from('test certificate')) } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
    expect(ctx.clearHnsProxy).toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus()).toMatchObject({ status: 'error', localResolverReady: false });
    await ctx.mod.startHns();
    expect(ctx.spawn).toHaveBeenCalledTimes(1);
  });

  test('late activation completion cannot publish authority after helper exit', async () => {
    const ctx = loadCertificateSessionFixture();
    let finishDrain;
    ctx.beginHnsCertificateUpdate.mockImplementationOnce(() => new Promise((resolve) => { finishDrain = resolve; }));
    await emitHelperReady(ctx);
    ctx.spawnedProcesses[0].emit('close', 0);
    finishDrain();
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(ctx.mod.getHnsStatus().status).toBe('stopped');
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    expect(ctx.session.defaultSession.setCertificateVerifyProc).not.toHaveBeenCalledWith(expect.any(Function));
  });

  test('stop reports routing failure when no helper remains', async () => {
    const ctx = loadHnsManagerModule();
    ctx.rebuild.mockRejectedValueOnce(new Error('routing teardown failed'));
    await expect(ctx.mod.stopHns()).rejects.toThrow('routing teardown failed');
  });

  test('routing is withdrawn even when certificate cleanup fails', async () => {
    const ctx = loadHnsManagerModule();
    ctx.session.defaultSession.setCertificateVerifyProc.mockImplementationOnce(() => { throw new Error('session closed'); });
    await expect(ctx.mod.stopHns()).rejects.toThrow('HNS session certificate update failed');
    expect(ctx.rebuild).toHaveBeenCalledTimes(1);
  });

  test('closing during certificate enrollment refuses late completion', async () => {
    const ctx = loadHnsManagerModule();
    let finishRouting;
    ctx.registerProxySession.mockImplementationOnce(() => new Promise((resolve) => { finishRouting = resolve; }));
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    const enrollment = ctx.mod.registerHnsSession(privateSession);
    const refused = expect(enrollment).rejects.toThrow('HNS session enrollment cancelled');
    ctx.mod.unregisterHnsSession(privateSession);
    finishRouting();
    await refused;
    expect(ctx.unregisterProxySession).toHaveBeenCalledTimes(1);
  });

  test('live enrollment failure clears installed authority and revokes retained callbacks', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    ctx.registerProxySession.mockRejectedValueOnce(new Error('routing unavailable'));
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await expect(ctx.mod.registerHnsSession(privateSession)).rejects.toThrow('routing unavailable');
    const retainedVerify = privateSession.setCertificateVerifyProc.mock.calls[0][0];
    expect(privateSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
    const callback = jest.fn();
    retainedVerify({ certificate: { fingerprint: ctx.mod.chromiumCertificateFingerprint(Buffer.from('test certificate')) } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
    privateSession.setCertificateVerifyProc.mockClear();
    ctx.spawnedProcesses[0].emit('close', 0);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(privateSession.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  test('live unregister clears authority even when the helper stays ready', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await ctx.mod.registerHnsSession(privateSession);
    const retainedVerify = privateSession.setCertificateVerifyProc.mock.calls[0][0];
    ctx.mod.unregisterHnsSession(privateSession);
    expect(privateSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
    const callback = jest.fn();
    retainedVerify({ certificate: { fingerprint: ctx.mod.chromiumCertificateFingerprint(Buffer.from('test certificate')) } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
  });

  test('native cleanup failure cannot keep a retired callback authoritative', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const privateSession = { setCertificateVerifyProc: jest.fn() };
    await ctx.mod.registerHnsSession(privateSession);
    const retainedVerify = privateSession.setCertificateVerifyProc.mock.calls[0][0];
    privateSession.setCertificateVerifyProc.mockImplementationOnce(() => { throw new Error('session closed'); });
    expect(() => ctx.mod.unregisterHnsSession(privateSession)).toThrow('session closed');
    const callback = jest.fn();
    retainedVerify({ certificate: { fingerprint: ctx.mod.chromiumCertificateFingerprint(Buffer.from('test certificate')) } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
  });

  test('stop waits for routing withdrawal and certificate cleanup after process exit', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    let finishRouting;
    ctx.rebuild.mockImplementationOnce(() => new Promise((resolve) => { finishRouting = resolve; }));
    let finished = false;
    const stopping = ctx.mod.stopHns().then(() => { finished = true; });
    ctx.spawnedProcesses[0].emit('close', 0);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(finished).toBe(false);
    expect(ctx.session.defaultSession.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
    finishRouting();
    await stopping;
    expect(ctx.session.defaultSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
  });

  test('stop rejects if post-exit routing withdrawal fails', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    ctx.rebuild.mockRejectedValueOnce(new Error('routing teardown failed'));
    const stopping = expect(ctx.mod.stopHns()).rejects.toThrow('routing teardown failed');
    ctx.spawnedProcesses[0].emit('close', 0);
    await stopping;
  });

  test('stdout from an old helper cannot activate a new generation', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const oldLineHandler = ctx.readlineHandlers.get('line');
    ctx.spawnedProcesses[0].emit('close', 0);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await ctx.mod.startHns();
    oldLineHandler(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:45001', caPath: '/tmp/old-ca.pem' }));
    expect(ctx.setHnsProxy).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getHnsStatus().status).toBe('starting');
  });

  test('routing identity freezes its certificate until a fresh helper generation', async () => {
    let certificate = 'first certificate';
    const ctx = loadHnsManagerModule({
      cryptoMock: { X509Certificate: class { constructor(pem) { this.raw = Buffer.from(pem); } } },
      readFileSync: () => certificate,
    });
    await emitHelperReady(ctx);
    const firstIdentity = ctx.setHnsProxy.mock.calls[0][1];
    expect(firstIdentity.caFingerprint).toBe(ctx.mod.chromiumCertificateFingerprint(Buffer.from(certificate)));
    certificate = 'second certificate';
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    expect(ctx.setHnsProxy).toHaveBeenCalledTimes(1);
    expect(firstIdentity.isValid()).toBe(true);
    await ctx.mod.stopHns();
    expect(firstIdentity.isValid()).toBe(false);
    await emitHelperReady(ctx);
    const secondIdentity = ctx.setHnsProxy.mock.calls[1][1];
    expect(secondIdentity.caFingerprint).toBe(ctx.mod.chromiumCertificateFingerprint(Buffer.from(certificate)));
    expect(secondIdentity.caFingerprint).not.toBe(firstIdentity.caFingerprint);
    expect(secondIdentity.generation).toBeGreaterThan(firstIdentity.generation);
  });

  test('a restarted helper has a new routing identity even with the same CA and address', async () => {
    jest.useFakeTimers();
    const ctx = loadCertificateSessionFixture();
    await emitHelperReady(ctx);
    const firstIdentity = ctx.setHnsProxy.mock.calls[0][1];
    ctx.spawnedProcesses[0].emit('close', 0);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await emitHelperReady(ctx);
    const secondIdentity = ctx.setHnsProxy.mock.calls[1][1];
    expect(secondIdentity.caFingerprint).toBe(firstIdentity.caFingerprint);
    expect(secondIdentity.generation).toBeGreaterThan(firstIdentity.generation);
    expect(ctx.setHnsProxy.mock.calls[1][0]).toBe(ctx.setHnsProxy.mock.calls[0][0]);
  });

  test('registers all HNS IPC handlers', () => {
    const ctx = loadHnsManagerModule();
    ctx.mod.registerHnsIpc();
    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual([
      IPC.HNS_GET_STATUS,
      IPC.HNS_START,
      IPC.HNS_STOP,
    ].sort());
  });

  test('HNS_START IPC handler returns status', async () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: false });
    ctx.mod.registerHnsIpc();
    const result = await ctx.ipcMain.invoke(IPC.HNS_START);
    expect(result).toHaveProperty('status');
  });

  test('HNS_GET_STATUS IPC handler returns current status', async () => {
    const ctx = loadHnsManagerModule();
    ctx.mod.registerHnsIpc();
    const result = await ctx.ipcMain.invoke(IPC.HNS_GET_STATUS);
    expect(result.status).toBe('stopped');
  });
});

describe('hns-manager namespace discovery', () => {
  const GENERATED_AT = Date.parse('2026-10-22T07:00:00.000Z');
  const ORIGIN = 'https://api-next.pirate.sc';
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const DAY = 24 * 60 * MINUTE;
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

  // What networkManager.fetchHnsNamespaces resolves with: each root's
  // lifetime on the server's clock, the origin that answered, and the
  // monotonic receipt time.
  const listing = (roots, { generatedAt = GENERATED_AT, lifetimeMs = 5 * DAY, origin = ORIGIN } = {}) => () => ({
    generatedAt,
    roots: new Map(roots.map((root) => (Array.isArray(root) ? root : [root, lifetimeMs]))),
    origin,
    receivedAt: performance.now(),
  });
  const offline = () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };

  // Answers each fetch with the next of `answers`, then fails as if offline.
  function load(answers = [], options = {}) {
    const queue = [...answers];
    const fetchedAt = [];
    const ctx = loadHnsManagerModule({
      cryptoMock: { X509Certificate: class { raw = Buffer.from('test certificate'); } },
      readFileSync: () => 'test certificate',
      fetchHnsNamespaces: async () => {
        fetchedAt.push(performance.now());
        return (queue.shift() || offline)();
      },
      ...options,
    });
    return { ...ctx, fetchedAt };
  }

  async function helperReady(ctx) {
    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    await flush();
  }

  const updates = (ctx, field) => ctx.updateService.mock.calls.filter(([, update]) => field in update);
  const routed = (ctx) => ctx.setImportedHnsRoots.mock.calls.at(-1)?.[0];
  const discovery = (ctx) => updates(ctx, 'discovery').at(-1)?.[1].discovery;
  const published = (ctx) => updates(ctx, 'publicSuffixes').at(-1)?.[1].publicSuffixes;
  const guardRouting = (ctx) => updates(ctx, 'guardRouting').at(-1)?.[1].guardRouting;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('the first fetch starts at helper-ready, before activation, and routes and publishes the list', async () => {
    const ctx = load([listing(['8s28', 'a18n'])]);
    await ctx.mod.startHns();
    expect(ctx.fetchHnsNamespaces).not.toHaveBeenCalled();

    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    await flush();

    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
    expect(ctx.beginHnsCertificateUpdate).not.toHaveBeenCalled();
    expect(ctx.setHnsProxy).not.toHaveBeenCalled();
    expect(routed(ctx)).toEqual(['8s28', 'a18n']);
    expect(published(ctx)).toEqual(['.pirate', '.8s28', '.a18n']);
    expect(discovery(ctx)).toEqual({ state: 'fresh', lastSuccessAt: new Date(Date.now()).toISOString(), origin: ORIGIN });

    // Activation follows on its own schedule and fetches nothing more.
    await jest.advanceTimersByTimeAsync(6 * SECOND);
    expect(ctx.setHnsProxy).toHaveBeenCalledTimes(1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
  });

  test('after a success it refreshes every 10 minutes', async () => {
    const ctx = load([listing(['8s28']), listing(['8s28']), listing(['8s28', 'a18n'])]);
    await helperReady(ctx);
    await jest.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(ctx.fetchedAt).toEqual([0, 10 * MINUTE, 20 * MINUTE].map((at) => ctx.fetchedAt[0] + at));
    // A root added since the last refresh is routed at the next one.
    expect(routed(ctx)).toEqual(['8s28', 'a18n']);
  });

  test.each([
    ['its routing generation changed', (policy) => { policy.generation += 1; }],
    ['routing was withdrawn', (policy) => { policy.allowed = false; }],
  ])('a fetch failing while %s is retried once, after 2 seconds, before backoff', async (_label, transition) => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const policy = { allowed: true, generation: 1, state: 'ready' };
    const cancelled = () => {
      transition(policy);
      throw new Error('net::ERR_ABORTED');
    };
    const ctx = load([cancelled, cancelled], { getProxySessionPolicy: () => ({ ...policy }) });
    await helperReady(ctx);
    expect(ctx.getProxySessionPolicy).toHaveBeenCalledWith(ctx.session.defaultSession);

    await jest.advanceTimersByTimeAsync(2 * SECOND - 1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    // The retry was cancelled too: no second retry, the first backoff instead.
    await jest.advanceTimersByTimeAsync(30 * SECOND - 1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(3);
  });

  test('any other failure goes straight to backoff', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const ctx = load([() => { throw new Error('namespace list answered 503'); }]);
    await helperReady(ctx);
    await jest.advanceTimersByTimeAsync(30 * SECOND - 1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
  });

  // Each step's jitter lands in [step, 1.5 x step), and no delay passes 10 minutes.
  test.each([
    ['at the bottom of its jitter', 0, [30, 60, 120, 240, 480, 600, 600]],
    ['at the top of its jitter', 1 - Number.EPSILON, [45, 90, 180, 360, 600, 600, 600]],
  ])('backoff starts at 30 seconds and doubles to a 10-minute cap, %s, and a success resets it', async (_label, random, seconds) => {
    jest.spyOn(Math, 'random').mockReturnValue(random);
    const failures = Array.from({ length: seconds.length }, () => offline);
    const ctx = load([...failures, listing(['8s28'])]);
    await helperReady(ctx);
    for (let i = 0; i <= seconds.length + 1; i += 1) await jest.advanceTimersByTimeAsync(10 * MINUTE);
    const gaps = ctx.fetchedAt.slice(1).map((at, i) => Math.round((at - ctx.fetchedAt[i]) / SECOND));
    // Seven failures back off; the success after them refreshes 10 minutes
    // later, and the failure after that starts again from 30 seconds.
    expect(gaps.slice(0, seconds.length)).toEqual(seconds);
    expect(gaps[seconds.length]).toBe(600);
    expect(gaps[seconds.length + 1]).toBe(seconds[0]);
  });

  test('a result fetched for a helper that has since restarted is discarded', async () => {
    let answerFirst;
    const ctx = load([
      () => new Promise((resolve) => { answerFirst = resolve; }),
      listing(['a18n'], { generatedAt: GENERATED_AT + 1 }),
    ]);
    await helperReady(ctx);
    await ctx.mod.stopHns();
    await helperReady(ctx);
    expect(routed(ctx)).toEqual(['a18n']);

    answerFirst(listing(['8s28'], { generatedAt: GENERATED_AT + 2 })());
    await flush();

    expect(ctx.setImportedHnsRoots.mock.calls.map(([roots]) => roots)).not.toContainEqual(['8s28']);
    expect(routed(ctx)).toEqual(['a18n']);
    // Nor does it schedule a refresh of its own.
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(3);
  });

  test('a list generated before the one applied is rejected', async () => {
    const ctx = load([
      listing(['8s28'], { generatedAt: GENERATED_AT + MINUTE }),
      listing(['a18n'], { generatedAt: GENERATED_AT }),
      listing(['a18n'], { generatedAt: GENERATED_AT + MINUTE }),
    ]);
    await helperReady(ctx);
    await jest.advanceTimersByTimeAsync(10 * MINUTE);

    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    expect(routed(ctx)).toEqual(['8s28']);
    expect(discovery(ctx).state).toBe('stale');

    // One generated at the same instant as the applied list is not older.
    await jest.advanceTimersByTimeAsync(45 * SECOND);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(3);
    expect(routed(ctx)).toEqual(['a18n']);
  });

  test('a renewal moves the deadline later with no moment the root is unrouted', async () => {
    const ctx = load([
      listing(['8s28'], { lifetimeMs: 15 * MINUTE }),
      listing(['8s28'], { generatedAt: GENERATED_AT + 10 * MINUTE, lifetimeMs: 15 * MINUTE }),
    ]);
    await helperReady(ctx);
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);

    // Past the first list's deadline, with every refresh since failing.
    await jest.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(ctx.setImportedHnsRoots.mock.calls.every(([roots]) => roots.includes('8s28'))).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(routed(ctx)).toEqual([]);
  });

  test('a root expires at its deadline with no refresh, whatever the wall clock says, while the helper restarts', async () => {
    // The server's clock is years ahead of this machine's; only the lifetime counts.
    const ctx = load([listing(['8s28'], { generatedAt: Date.parse('2031-01-01T00:00:00.000Z'), lifetimeMs: 20 * MINUTE })]);
    await helperReady(ctx);
    const receivedAt = ctx.fetchedAt[0];

    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    await ctx.mod.stopHns();
    jest.setSystemTime(Date.now() - 400 * DAY);
    await jest.advanceTimersByTimeAsync(receivedAt + 20 * MINUTE - 1 - performance.now());
    jest.setSystemTime(Date.now() + 800 * DAY);
    expect(routed(ctx)).toEqual(['8s28']);
    expect(published(ctx)).toEqual(['.pirate', '.8s28']);
    expect(discovery(ctx).state).toBe('fresh');

    await jest.advanceTimersByTimeAsync(1);
    expect(routed(ctx)).toEqual([]);
    // The renderer's copy loses it too.
    expect(published(ctx)).toEqual(['.pirate']);
    // A populated list whose every root has expired is not fresh.
    expect(discovery(ctx).state).toBe('unavailable');

    // The restart's own fetch fails, and brings nothing back.
    await helperReady(ctx);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    expect(routed(ctx)).toEqual([]);
    expect(discovery(ctx).state).toBe('unavailable');
  });

  // Contract v4 addendum 1: fresh while every listed root is live; stale while
  // any is; unavailable once none is, however the last attempt went.
  test('an outage keeps unexpired roots, then drops each at its deadline', async () => {
    const ctx = load([listing([['8s28', 5 * MINUTE], ['a18n', 20 * MINUTE]])]);
    await helperReady(ctx);
    const { lastSuccessAt } = discovery(ctx);
    expect(discovery(ctx)).toEqual({ state: 'fresh', lastSuccessAt, origin: ORIGIN });

    // One listed root expired: no longer fresh, though the last attempt succeeded.
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(routed(ctx)).toEqual(['a18n']);
    expect(published(ctx)).toEqual(['.pirate', '.a18n']);
    expect(discovery(ctx)).toEqual({ state: 'stale', lastSuccessAt, origin: ORIGIN });

    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    expect(routed(ctx)).toEqual(['a18n']);
    expect(discovery(ctx)).toEqual({ state: 'stale', lastSuccessAt, origin: ORIGIN });

    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(routed(ctx)).toEqual([]);
    expect(discovery(ctx)).toEqual({ state: 'unavailable', lastSuccessAt, origin: ORIGIN });
  });

  test('a list never received is unavailable, and a successful empty one is fresh', async () => {
    const ctx = load([offline, listing([])]);
    await helperReady(ctx);
    expect(discovery(ctx)).toEqual({ state: 'unavailable', lastSuccessAt: null, origin: null });
    await jest.advanceTimersByTimeAsync(45 * SECOND);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    expect(discovery(ctx)).toEqual({ state: 'fresh', lastSuccessAt: expect.any(String), origin: ORIGIN });
    expect(routed(ctx)).toEqual([]);
  });

  test('a populated list that fully expired is unavailable, and an empty success after it is fresh', async () => {
    const ctx = load([listing(['8s28'], { lifetimeMs: 5 * MINUTE }), listing([], { generatedAt: GENERATED_AT + 10 * MINUTE })]);
    await helperReady(ctx);
    expect(discovery(ctx).state).toBe('fresh');
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(routed(ctx)).toEqual([]);
    expect(discovery(ctx).state).toBe('unavailable');
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    expect(routed(ctx)).toEqual([]);
    expect(discovery(ctx).state).toBe('fresh');
  });

  test('the answering origin is published with the state', async () => {
    const staging = 'https://api-next-staging.pirate.sc';
    const ctx = load([listing(['8s28'], { origin: staging })]);
    await helperReady(ctx);
    expect(discovery(ctx)).toEqual({ state: 'fresh', lastSuccessAt: expect.any(String), origin: staging });
  });

  // Contract v4 addendum 1: never longer than the server's evidence window.
  test('a root routes for at most 7 days from receipt, however far ahead its expiry is', async () => {
    const ctx = load([listing(['8s28', ['a18n', 2 * DAY]], { lifetimeMs: 30 * DAY })]);
    await helperReady(ctx);
    const receivedAt = ctx.fetchedAt[0];
    // Stopped, so only the expiry timer runs through the days that follow.
    await ctx.mod.stopHns();
    await jest.advanceTimersByTimeAsync(receivedAt + 2 * DAY - performance.now());
    expect(routed(ctx)).toEqual(['8s28']);
    await jest.advanceTimersByTimeAsync(receivedAt + 7 * DAY - 1 - performance.now());
    expect(routed(ctx)).toEqual(['8s28']);
    await jest.advanceTimersByTimeAsync(1);
    expect(routed(ctx)).toEqual([]);
  });

  test('history is pruned once per helper generation, after the refresh is armed, and a failed prune stops nothing', async () => {
    const ctx = load([listing(['8s28']), listing(['8s28', 'a18n']), listing(['8s28']), listing(['8s28'])]);
    ctx.pruneUnknownSingleLabelHistory.mockImplementation(() => { throw new Error('database is locked'); });
    await helperReady(ctx);
    expect(ctx.pruneUnknownSingleLabelHistory).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith('[HNS] Single-label history prune failed: database is locked');
    await jest.advanceTimersByTimeAsync(20 * MINUTE);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(3);
    expect(discovery(ctx).state).toBe('fresh');
    expect(ctx.pruneUnknownSingleLabelHistory).toHaveBeenCalledTimes(1);
    // A new helper generation prunes once more.
    await ctx.mod.stopHns();
    await helperReady(ctx);
    expect(ctx.pruneUnknownSingleLabelHistory).toHaveBeenCalledTimes(2);
  });

  test('stopping HNS cancels the refresh and nothing else', async () => {
    const ctx = load([listing(['8s28'], { lifetimeMs: 15 * MINUTE })]);
    await helperReady(ctx);
    await ctx.mod.stopHns();
    // The registry entry is reset with the live list, its state and the
    // routing kept, in that one broadcast and with nothing after it.
    expect(ctx.clearService).toHaveBeenLastCalledWith('hns', {
      publicSuffixes: ['.pirate', '.8s28'],
      discovery: { state: 'fresh', lastSuccessAt: expect.any(String), origin: ORIGIN },
      guardRouting: true,
    });
    const clearedAt = ctx.clearService.mock.invocationCallOrder.at(-1);
    expect(ctx.updateService.mock.invocationCallOrder.filter((order) => order > clearedAt)).toEqual([]);

    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
    expect(routed(ctx)).toEqual(['8s28']);
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(routed(ctx)).toEqual([]);
  });

  test('a retired generation cancels the refresh, and its restart fetches again at helper-ready', async () => {
    const ctx = load([listing(['8s28']), listing(['8s28', 'a18n'])]);
    await helperReady(ctx);
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'error' }));
    await flush();
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(1);
    expect(routed(ctx)).toEqual(['8s28']);

    // The restart reaches helper-ready on its own backoff, well inside the
    // 10 minutes the cancelled refresh would have waited.
    await jest.advanceTimersByTimeAsync(SECOND);
    ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
    await flush();
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    expect(routed(ctx)).toEqual(['8s28', 'a18n']);

    // The retired helper's refresh never fires; the new one's does.
    const [retired, current] = ctx.fetchedAt;
    await jest.advanceTimersByTimeAsync(retired + 10 * MINUTE - performance.now());
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(current + 10 * MINUTE - performance.now());
    expect(ctx.fetchHnsNamespaces).toHaveBeenCalledTimes(3);
  });

  // Contract v4 addendum 1: the renderer's single-label rule follows routing,
  // on a platform that supports Handshake, and not the helper's health.
  describe('guard routing for the renderer', () => {
    test('follows each routing commit', () => {
      const ctx = load();
      expect(ctx.setHnsGuardRoutingObserver).toHaveBeenCalledTimes(1);
      ctx.commitGuardRouting(true);
      expect(guardRouting(ctx)).toBe(true);
      ctx.commitGuardRouting(false);
      expect(guardRouting(ctx)).toBe(false);
    });

    test('is never published where Handshake browsing is unsupported', () => {
      const ctx = load([], { hnsSupported: false });
      ctx.commitGuardRouting(true);
      expect(guardRouting(ctx)).toBe(false);
    });

    // Contract v4 addendum 2: a discovered root's deadline outlives the
    // helper, so the renderer needs routing beside the root set.
    test('a root still listed after the helper stops is published beside routing turned off', async () => {
      const ctx = load([listing(['8s28'])]);
      ctx.commitGuardRouting(true);
      await helperReady(ctx);
      await ctx.mod.stopHns();
      expect(ctx.clearService).toHaveBeenLastCalledWith('hns', expect.objectContaining({
        publicSuffixes: ['.pirate', '.8s28'], guardRouting: true,
      }));
      ctx.commitGuardRouting(false);
      expect(published(ctx)).toEqual(['.pirate', '.8s28']);
      expect(guardRouting(ctx)).toBe(false);
    });

    test('stays on while the helper starts, fails and recovers', async () => {
      const ctx = load([listing(['8s28'])]);
      ctx.commitGuardRouting(true);
      await ctx.mod.startHns();
      expect(guardRouting(ctx)).toBe(true);
      ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041', caPath: '/tmp/hns-ca.pem' }));
      await flush();
      // The helper reports an error and is torn down for a restart.
      ctx.readlineHandlers.get('line')(JSON.stringify({ type: 'error' }));
      await flush();
      expect(ctx.clearService).toHaveBeenLastCalledWith('hns', expect.objectContaining({ guardRouting: true }));
      expect(guardRouting(ctx)).toBe(true);
      expect(updates(ctx, 'guardRouting').every(([, update]) => update.guardRouting === true)).toBe(true);
    });
  });
});

describe('createCertificateVerifier', () => {
  const {
    chromiumCertificateFingerprint,
    createCertificateVerifier,
  } = require('./hns-manager');
  const CA = 'sha256/aa:bb:cc';
  const verify = (request) => {
    let result;
    createCertificateVerifier(CA)(request, (code) => { result = code; });
    return result;
  };

  // Regression: an unconditional "HNS hostname + proxy active -> callback(0)"
  // branch used to accept ANY certificate here. Combined with the guard proxy's
  // unvalidated DoH fallback, that let the resolver operator MITM any HNS name.
  test('rejects an arbitrary certificate for an HNS hostname', () => {
    expect(verify({
      hostname: 'app.pirate',
      certificate: { fingerprint: 'sha256/attacker', issuerCert: null },
    })).toBe(-3);
  });

  test('formats the trusted CA fingerprint exactly as Chromium does', () => {
    expect(chromiumCertificateFingerprint(Buffer.from('test certificate')))
      .toBe('sha256/hq2a+yYryoxWWBBZd9kDX9c3GkKepzw291boR3DcQ1Y=');
  });

  test('rejects a self-signed certificate presented for an HNS hostname', () => {
    expect(verify({
      hostname: 'portal.any-hns-root',
      certificate: { fingerprint: 'sha256/self', issuerCert: { fingerprint: 'sha256/self' } },
    })).toBe(-3);
  });

  // fingertipd performs the DANE check itself and re-issues under the local CA,
  // so that path must keep working or all HNS browsing breaks.
  test('accepts a certificate issued by the local HNS CA', () => {
    expect(verify({
      hostname: 'app.pirate',
      certificate: { fingerprint: CA, issuerCert: null },
    })).toBe(0);
  });

  test('accepts a certificate whose issuer is the local HNS CA', () => {
    expect(verify({
      hostname: 'app.pirate',
      certificate: { fingerprint: 'sha256/leaf', issuerCert: { fingerprint: CA } },
    })).toBe(0);
  });

  test('accepts a certificate whose chain terminates at the local HNS CA', () => {
    expect(verify({
      hostname: 'app.pirate',
      certificate: {
        fingerprint: 'sha256/leaf',
        issuerCert: {
          fingerprint: 'sha256/intermediate',
          issuerCert: { fingerprint: CA, issuerCert: null },
        },
      },
    })).toBe(0);
  });

  test('rejects when no certificate is present', () => {
    expect(verify({ hostname: 'app.pirate', certificate: null })).toBe(-3);
  });
});
