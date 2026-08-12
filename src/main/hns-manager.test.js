const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function createProcessMock() {
  const listeners = new Map();
  const onceListeners = new Map();
  const stdoutListeners = new Map();
  const stderrListeners = new Map();

  const emitAll = (store, event, args) => {
    for (const handler of store.get(event) || []) {
      handler(...args);
    }
  };

  return {
    stdout: {
      on: jest.fn((event, handler) => {
        if (!stdoutListeners.has(event)) {
          stdoutListeners.set(event, []);
        }
        stdoutListeners.get(event).push(handler);
      }),
    },
    stderr: {
      on: jest.fn((event, handler) => {
        if (!stderrListeners.has(event)) {
          stderrListeners.set(event, []);
        }
        stderrListeners.get(event).push(handler);
      }),
    },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceListeners.has(event)) {
        onceListeners.set(event, []);
      }
      onceListeners.get(event).push(handler);
    }),
    emit(event, ...args) {
      emitAll(listeners, event, args);
      const oneTimeHandlers = onceListeners.get(event) || [];
      onceListeners.delete(event);
      oneTimeHandlers.forEach((handler) => handler(...args));
    },
    emitStdout(event, ...args) {
      emitAll(stdoutListeners, event, args);
    },
    emitStderr(event, ...args) {
      emitAll(stderrListeners, event, args);
    },
    kill: jest.fn(() => true),
  };
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

  const setHnsProxy = jest.fn();
  const setHnsResolverAddrs = jest.fn();
  const clearHnsProxy = jest.fn();
  const rebuild = jest.fn(() => Promise.resolve());
  const getHnsProxyAddr = jest.fn(() => options.effectiveHnsProxyAddr ?? '127.0.0.1:55000');
  const refreshImportedHnsSuffixes = jest.fn(() => Promise.resolve(['.pirate']));
  const canResolveHnsFallbackForHost = jest.fn(() => Promise.resolve(options.canResolveHnsFallbackForHost ?? false));
  const getHnsResolutionForHost = jest.fn(() => {
    if (Object.prototype.hasOwnProperty.call(options, 'hnsResolutionForHost')) {
      return Promise.resolve(options.hnsResolutionForHost);
    }
    return Promise.resolve(options.canResolveHnsFallbackForHost ? { resolverType: 'doh' } : null);
  });
  const isHnsProxyHost = jest.fn(() => options.isHnsProxyHost ?? false);
  const pruneUnknownSingleLabelHistory = jest.fn();
  const spawnedProcesses = [];
  const tcpPorts = [...(options.tcpPorts || [41001, 41002, 41003, 41004])];
  const unavailableUdpPorts = new Set(options.unavailableUdpPorts || []);
  const spawn = jest.fn((binary, args = []) => {
    const proc = (options.createProcess || createProcessMock)();
    proc.binary = binary;
    proc.args = args;
    spawnedProcesses.push(proc);
    return proc;
  });
  const readlineHandlers = new Map();
  const readlineInterface = {
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
        setHnsProxy,
        setHnsResolverAddrs,
        clearHnsProxy,
        rebuild,
        getHnsProxyAddr,
        refreshImportedHnsSuffixes,
        getHnsResolutionForHost,
        canResolveHnsFallbackForHost,
        isHnsProxyHost,
      }),
      [require.resolve('./browser-state-sanitizer')]: () => ({
        pruneUnknownSingleLabelHistory,
      }),
      [require.resolve('./hns-health')]: () => options.hnsHealth || jest.requireActual('./hns-health'),
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
    log,
    updateService,
    setStatusMessage,
    setErrorState,
    clearErrorState,
    clearService,
    setHnsProxy,
    setHnsResolverAddrs,
    clearHnsProxy,
    rebuild,
    getHnsProxyAddr,
    refreshImportedHnsSuffixes,
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

describe('hns-manager', () => {
  afterEach(() => {
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
      proxyAddr: null,
      caPemPath: null,
      rootAddr: null,
      recursiveAddr: null,
    });
  });

  test('localResolverReady follows app.pirate health instead of aggregate suffix health', async () => {
    jest.useFakeTimers();
    const probeResults = [
      {
        ok: false,
        results: [
          { host: 'pirate', ok: true, addresses: ['173.199.93.117'] },
          { host: 'app.pirate', ok: true, addresses: ['173.199.93.117'] },
          { host: 'baddie', ok: false, code: 'ETIMEOUT' },
        ],
      },
      {
        ok: false,
        results: [
          { host: 'pirate', ok: true, addresses: ['173.199.93.117'] },
          { host: 'app.pirate', ok: true, addresses: ['173.199.93.117'] },
          { host: 'baddie', ok: false, code: 'ETIMEOUT' },
        ],
      },
      {
        ok: false,
        results: [
          { host: 'pirate', ok: false, code: 'ESERVFAIL' },
          { host: 'app.pirate', ok: false, code: 'ESERVFAIL' },
        ],
      },
      {
        ok: false,
        results: [
          { host: 'pirate', ok: false, code: 'ESERVFAIL' },
          { host: 'app.pirate', ok: false, code: 'ESERVFAIL' },
        ],
      },
    ];
    const ctx = loadHnsManagerModule({
      cryptoMock: {
        X509Certificate: class {
          raw = Buffer.from('test certificate');
        },
      },
      hnsHealth: {
        buildHnsHealthProbeHosts: jest.fn(() => ['pirate', 'app.pirate', 'baddie']),
        formatHnsHealthSummary: jest.fn((result) => result.results.map((entry) => entry.host).join(', ')),
        probeHnsResolver: jest.fn(() => Promise.resolve(probeResults.shift())),
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
    expect(ctx.updateService).toHaveBeenCalledWith('hns', expect.objectContaining({
      localResolverReady: false,
    }));
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);

    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.updateService).toHaveBeenCalledWith('hns', expect.objectContaining({
      localResolverReady: true,
    }));
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);

    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(true);

    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.updateService).toHaveBeenLastCalledWith('hns', expect.objectContaining({
      localResolverReady: false,
    }));
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);
    expect(ctx.updateService.mock.calls.filter(([_service, updates]) => (
      Object.prototype.hasOwnProperty.call(updates, 'dohFallbackReady') &&
      !Object.prototype.hasOwnProperty.call(updates, 'synced')
    ))).toHaveLength(3);
    expect(ctx.log.info).toHaveBeenCalledWith(
      '[HNS] localResolverReady=false->true after 2 consecutive successful probes'
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      '[HNS] localResolverReady=true->false after 2 consecutive failed probes'
    );
  });

  test('dohFallbackReady stays true when app.pirate DoH last-resort resolution is available', async () => {
    jest.useFakeTimers();
    const ctx = loadHnsManagerModule({
      hnsResolutionForHost: { resolverType: 'doh' },
      cryptoMock: {
        X509Certificate: class {
          raw = Buffer.from('test certificate');
        },
      },
      hnsHealth: {
        buildHnsHealthProbeHosts: jest.fn(() => ['pirate', 'app.pirate']),
        formatHnsHealthSummary: jest.fn(() => 'pirate=FAIL(ESERVFAIL), app.pirate=FAIL(ESERVFAIL)'),
        probeHnsResolver: jest.fn(() => Promise.resolve({
          ok: false,
          results: [
            { host: 'pirate', ok: false, code: 'ESERVFAIL' },
            { host: 'app.pirate', ok: false, code: 'ESERVFAIL' },
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

    expect(ctx.getHnsResolutionForHost).toHaveBeenCalledWith('app.pirate');
    expect(ctx.canResolveHnsFallbackForHost).not.toHaveBeenCalled();
    expect(ctx.updateService).toHaveBeenCalledWith('hns', expect.objectContaining({
      dohFallbackReady: true,
      localResolverReady: false,
    }));
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);
    expect(ctx.mod.getHnsStatus().dohFallbackReady).toBe(true);
    expect(ctx.setStatusMessage).toHaveBeenCalledWith(
      'hns',
      'HNS recursive resolver recovering; using HTTPS last-resort resolver'
    );
  });

  test('skips readiness broadcasts when readiness state is unchanged', async () => {
    jest.useFakeTimers();
    const ctx = loadHnsManagerModule({
      hnsResolutionForHost: { resolverType: 'doh' },
      cryptoMock: {
        X509Certificate: class {
          raw = Buffer.from('test certificate');
        },
      },
      hnsHealth: {
        buildHnsHealthProbeHosts: jest.fn(() => ['pirate', 'app.pirate']),
        formatHnsHealthSummary: jest.fn(() => 'pirate=FAIL(ESERVFAIL), app.pirate=FAIL(ESERVFAIL)'),
        probeHnsResolver: jest.fn(() => Promise.resolve({
          ok: false,
          results: [
            { host: 'pirate', ok: false, code: 'ESERVFAIL' },
            { host: 'app.pirate', ok: false, code: 'ESERVFAIL' },
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

    expect(ctx.updateService.mock.calls.filter(([_service, updates]) => (
      Object.prototype.hasOwnProperty.call(updates, 'dohFallbackReady') &&
      !Object.prototype.hasOwnProperty.call(updates, 'synced')
    ))).toHaveLength(1);
  });

  test('sync height progress does not reset established local resolver readiness', async () => {
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

  test('localResolverReady reports local delegation when recursive DNS is unavailable', async () => {
    jest.useFakeTimers();
    const ctx = loadHnsManagerModule({
      hnsResolutionForHost: { resolverType: 'local' },
      cryptoMock: {
        X509Certificate: class {
          raw = Buffer.from('test certificate');
        },
      },
      hnsHealth: {
        buildHnsHealthProbeHosts: jest.fn(() => ['pirate', 'app.pirate']),
        formatHnsHealthSummary: jest.fn(() => 'pirate=FAIL(ETIMEOUT), app.pirate=FAIL(ETIMEOUT)'),
        probeHnsResolver: jest.fn(() => Promise.resolve({
          ok: false,
          results: [
            { host: 'pirate', ok: false, code: 'ETIMEOUT' },
            { host: 'app.pirate', ok: false, code: 'ETIMEOUT' },
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
    expect(ctx.mod.getHnsStatus().localResolverReady).toBe(false);

    await jest.advanceTimersByTimeAsync(5000);

    expect(ctx.updateService).toHaveBeenCalledWith('hns', expect.objectContaining({
      dohFallbackReady: false,
      localResolverReady: true,
    }));
    expect(ctx.setStatusMessage).toHaveBeenCalledWith(
      'hns',
      'HNS recursive resolver recovering; using local delegation resolver'
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      '[HNS] Local recursive resolver unavailable (sync): pirate=FAIL(ETIMEOUT), app.pirate=FAIL(ETIMEOUT); local delegation resolver ready; retrying in 5000ms'
    );
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

    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({
      type: 'ready',
      proxyAddr: '127.0.0.1:44041',
      caPath: '/tmp/hns-ca.pem',
    }));
    await Promise.resolve();

    expect(ctx.setHnsProxy).toHaveBeenCalledWith('127.0.0.1:44041');
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

  test('uses helper sync status even when obsolete canary is unavailable', async () => {
    const ctx = loadHnsManagerModule();

    await ctx.mod.startHns();
    ctx.readlineHandlers.get('line')?.(JSON.stringify({
      type: 'sync',
      synced: true,
      canaryReady: false,
      height: 326149,
    }));

    expect(ctx.mod.getHnsStatus()).toEqual(expect.objectContaining({
      synced: true,
      canaryReady: true,
      height: 326149,
    }));
    expect(ctx.setStatusMessage).toHaveBeenLastCalledWith('hns', null);
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
    expect(ctx.setErrorState).toHaveBeenCalledWith('hns', 'HNS helper binary is obsolete');
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
      '[HNS helper] Local DNS miss; guard resolver will retry: 2026/05/02 12:00:00 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)',
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
      '[HNS helper] Local DNS miss; guard resolver will retry: 2026/05/02 12:00:00 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)',
      '[HNS helper] suppressed 1 repeat local DNS miss(es): 2026/05/02 12:00:05 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)',
      '[HNS helper] Local DNS miss; guard resolver will retry: 2026/05/02 12:00:31 [WARN] tunnel: 502 CONNECT missing.pirate:443 dns lookup failed (rcode: servfail)',
    ]);
  });

  test('stopHns clears proxy and service when no process', async () => {
    const ctx = loadHnsManagerModule();
    await ctx.mod.stopHns();
    expect(ctx.clearHnsProxy).toHaveBeenCalled();
    expect(ctx.clearService).toHaveBeenCalledWith('hns');
    expect(ctx.rebuild).toHaveBeenCalled();
    expect(ctx.mod.getHnsStatus().status).toBe('stopped');
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
