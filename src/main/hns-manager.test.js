const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function createProcessMock() {
  const listeners = new Map();
  const onceListeners = new Map();

  const emitAll = (store, event, args) => {
    for (const handler of store.get(event) || []) {
      handler(...args);
    }
  };

  return {
    stdout: {
      on: jest.fn(),
    },
    stderr: {
      on: jest.fn(),
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
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
  };

  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const clearService = jest.fn();

  const setHnsProxy = jest.fn();
  const clearHnsProxy = jest.fn();
  const rebuild = jest.fn(() => Promise.resolve());
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
  const readlineInterface = {
    on: jest.fn(),
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
        clearHnsProxy,
        rebuild,
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
    clearHnsProxy,
    rebuild,
    spawn,
    spawnedProcesses,
    readlineInterface,
    windowMock,
  };
}

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
      status: 'stopped',
      error: null,
      synced: false,
      canaryReady: false,
      height: 0,
      proxyAddr: null,
      caPemPath: null,
      rootAddr: null,
      recursiveAddr: null,
    });
  });

  test('isHnsHostname accepts supported HNS public host suffixes', () => {
    const ctx = loadHnsManagerModule();
    expect(ctx.mod.isHnsHostname('captain.pirate')).toBe(true);
    expect(ctx.mod.isHnsHostname('night-signal.clawitzer')).toBe(false);
    expect(ctx.mod.isHnsHostname('localhost')).toBe(false);
    expect(ctx.mod.isHnsHostname('night-signal.pirate.sc')).toBe(false);
  });

  test('isHnsHostname still accepts bare Handshake roots and rejects unsupported suffixes', () => {
    const ctx = loadHnsManagerModule();
    expect(ctx.mod.isHnsHostname('clawitzer')).toBe(true);
    expect(ctx.mod.isHnsHostname('captain.example')).toBe(false);
    expect(ctx.mod.isHnsHostname('captain.foo.bar')).toBe(false);
  });

  test('checkBinary returns true when fingertipd exists', () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: true });
    expect(ctx.mod.checkBinary()).toBe(true);
  });

  test('checkBinary returns false when fingertipd missing', () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: false });
    expect(ctx.mod.checkBinary()).toBe(false);
  });

  test('startHns sets error when fingertipd binary not found', async () => {
    const ctx = loadHnsManagerModule({ fingertipdExists: false });
    await ctx.mod.startHns();
    expect(ctx.mod.getHnsStatus().status).toBe('error');
    expect(ctx.mod.getHnsStatus().error).toContain('Helper binary not found');
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
