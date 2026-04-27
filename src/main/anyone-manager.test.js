const fs = require('fs');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function loadAnyoneManager(options = {}) {
  const userDataDir = options.userDataDir || '/tmp/freedom-test-anyone';
  const anyoneDataDir = path.join(userDataDir, 'anyone');
  const termsPath = path.join(anyoneDataDir, 'terms-agreement');

  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const setAnyoneProxy = jest.fn();
  const clearAnyoneProxy = jest.fn();
  const rebuild = jest.fn(() => Promise.resolve());
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const ProcessMock = class {
    static killAnonProcess = jest.fn(() => {
      if (options.killError) {
        return Promise.reject(options.killError);
      }
      return Promise.resolve(options.killReturns ?? false);
    });

    constructor() {
      this.running = false;
    }

    async start() {
      this.running = true;
      if (options.startError) {
        throw new Error(options.startError);
      }
    }

    async stop() {
      this.running = false;
    }

    isRunning() {
      return this.running;
    }

    getSOCKSPort() {
      return 9050;
    }

    getControlPort() {
      return 9051;
    }
  };

  const ControlMock = class {
    async authenticate() {}

    async circuitStatus() {
      return [{ state: 'BUILT' }];
    }

    end() {}
  };

  const SocksMock = class {
    async get() {
      if (options.socksGetError) {
        throw new Error(options.socksGetError);
      }
      if (options.socksGetReturnsNull) {
        return { data: { ip: null } };
      }
      return { data: { ip: '102.206.50.215' } };
    }
  };

  const BrowserWindow = {
    getAllWindows: jest.fn(() => options.windows || []),
  };

  const { mod, ipcMain } = loadMainModule(require.resolve('./anyone-manager'), {
    userDataDir,
    BrowserWindow,
    extraMocks: {
      [require.resolve('./logger')]: () => ({
        ...log,
      }),
      [require.resolve('./service-registry')]: () => ({
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
      }),
      [require.resolve('./network-manager')]: () => ({
        setAnyoneProxy,
        clearAnyoneProxy,
        rebuild,
      }),
      '@anyone-protocol/anyone-client': () => ({
        Process: ProcessMock,
        Control: ControlMock,
        Socks: SocksMock,
      }),
      axios: () => ({
        defaults: {},
        get: jest.fn(async () => ({ data: { ip: options.fallbackIp || '198.51.100.24' } })),
      }),
      'socks-proxy-agent': () => ({
        SocksProxyAgent: class {
          constructor(url) {
            this.url = url;
          }
        },
      }),
    },
  });

  return {
    mod,
    ipcMain,
    termsPath,
    updateService,
    setStatusMessage,
    setErrorState,
    clearErrorState,
    setAnyoneProxy,
    clearAnyoneProxy,
    rebuild,
    ProcessMock,
    log,
  };
}

describe('anyone-manager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('initAnyone writes the terms agreement file and clears stale processes', async () => {
    const ctx = loadAnyoneManager({ killReturns: true });

    await ctx.mod.initAnyone();

    expect(fs.readFileSync(ctx.termsPath, 'utf8')).toBe('agreed');
    expect(ctx.ProcessMock.killAnonProcess).toHaveBeenCalled();
    expect(ctx.mod.getStatus().state).toBe(ctx.mod.STATES.OFF);
  });

  test('startAnyone kills stale processes before start and configures the proxy', async () => {
    const ctx = loadAnyoneManager();

    const result = await ctx.mod.startAnyone();

    expect(result.success).toBe(true);
    expect(ctx.ProcessMock.killAnonProcess).toHaveBeenCalled();
    expect(ctx.setAnyoneProxy).toHaveBeenCalledWith('127.0.0.1', 9050);
    expect(ctx.rebuild).toHaveBeenCalled();
    expect(ctx.updateService).toHaveBeenCalledWith(
      'anyone',
      expect.objectContaining({
        proxy: '127.0.0.1:9050',
        connected: true,
        socksPort: 9050,
        controlPort: 9051,
        circuitState: 'BUILT',
      }),
    );
    expect(ctx.mod.getStatus()).toEqual(
      expect.objectContaining({
        state: ctx.mod.STATES.CONNECTED,
        connected: true,
        socksPort: 9050,
        controlPort: 9051,
        circuitState: 'BUILT',
      }),
    );
  });

  test('stopAnyone clears the proxy and kills stale processes', async () => {
    const ctx = loadAnyoneManager();
    await ctx.mod.startAnyone();

    const result = await ctx.mod.stopAnyone();

    expect(result.success).toBe(true);
    expect(ctx.clearAnyoneProxy).toHaveBeenCalled();
    expect(ctx.rebuild).toHaveBeenCalledTimes(2);
    expect(ctx.ProcessMock.killAnonProcess).toHaveBeenCalledTimes(2);
    expect(ctx.mod.getStatus().state).toBe(ctx.mod.STATES.OFF);
  });

  test('startAnyone falls back to axios+socks-proxy-agent when SDK IP lookup returns null', async () => {
    const ctx = loadAnyoneManager({ socksGetReturnsNull: true, fallbackIp: '203.0.113.42' });

    const result = await ctx.mod.startAnyone();

    expect(result.success).toBe(true);
    expect(ctx.mod.getStatus()).toEqual(
      expect.objectContaining({
        state: ctx.mod.STATES.CONNECTED,
        ip: '203.0.113.42',
      }),
    );
  });

  test('startAnyone failure kills stale processes and reports an error state', async () => {
    const ctx = loadAnyoneManager({ startError: 'bootstrapping failed' });

    const result = await ctx.mod.startAnyone();

    expect(result.success).toBe(false);
    expect(ctx.ProcessMock.killAnonProcess).toHaveBeenCalledTimes(2);
    expect(ctx.clearAnyoneProxy).toHaveBeenCalled();
    expect(ctx.setErrorState).toHaveBeenCalledWith('anyone', 'bootstrapping failed');
    expect(ctx.mod.getStatus()).toEqual(
      expect.objectContaining({
        state: ctx.mod.STATES.ERROR,
        error: 'bootstrapping failed',
      }),
    );
  });

  test('initAnyone ignores the expected no-process stale cleanup path without warning', async () => {
    const killError = Object.assign(new Error('Command failed: ps aux | grep anon | grep -v grep'), {
      code: 1,
      stderr: '',
    });
    const ctx = loadAnyoneManager({ killError });

    await ctx.mod.initAnyone();

    expect(ctx.ProcessMock.killAnonProcess).toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed stale-process cleanup during init'),
    );
    expect(ctx.mod.getStatus().state).toBe(ctx.mod.STATES.OFF);
  });

  test('registerAnyoneIpc wires start, stop, and getStatus handlers', async () => {
    const ctx = loadAnyoneManager();
    ctx.mod.registerAnyoneIpc();

    await expect(ctx.ipcMain.invoke(IPC.ANYONE_GET_STATUS)).resolves.toEqual(
      expect.objectContaining({ state: ctx.mod.STATES.OFF }),
    );

    await expect(ctx.ipcMain.invoke(IPC.ANYONE_START)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );

    await expect(ctx.ipcMain.invoke(IPC.ANYONE_STOP)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
  });
});
