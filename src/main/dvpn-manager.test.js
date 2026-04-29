const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createSafeStorageMock(options = {}) {
  return {
    isEncryptionAvailable: jest.fn(() => options.available ?? true),
    encryptString: jest.fn(() => Buffer.from('encrypted')),
    decryptString: jest.fn(() => options.mnemonic ?? 'word word word word word word word word word word word word'),
  };
}

function createFsMock(options = {}) {
  const walletPath = options.walletPath || path.join('/tmp/freedom-test-dvpn', 'dvpn', 'wallet.enc');
  const statePath = options.statePath || path.join('/tmp/freedom-test-dvpn', 'dvpn', 'state.json');
  const dvpnDataDir = path.join('/tmp/freedom-test-dvpn', 'dvpn');

  return {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') {
        return options.existsSync(target);
      }
      if (options.walletExists && target === walletPath) return true;
      if (options.stateExists && target === statePath) return true;
      if (target === dvpnDataDir) return true;
      return false;
    }),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn((target) => {
      if (typeof options.readFileSync === 'function') {
        return options.readFileSync(target);
      }
      if (target === walletPath) return Buffer.from('encrypted');
      if (target === statePath) return JSON.stringify(options.stateContents || {});
      return '';
    }),
    writeFileSync: jest.fn(),
  };
}

function createSdkMock(options = {}) {
  return {
    createWallet: jest.fn(() => options.createWalletResult || {
      address: 'sent1testaddress',
      mnemonic: 'word word word word word word word word word word word word',
    }),
    importWallet: jest.fn(() => options.importWalletResult || {
      address: 'sent1testaddress',
    }),
    getBalance: jest.fn(() => options.getBalanceResult || {
      p2p: 10,
      udvpn: 5000000,
      funded: true,
    }),
    connect: jest.fn(() => options.connectResult || {
      sessionId: 'session-1',
      protocol: 'v2ray',
      nodeAddress: 'sent1node',
      country: 'US',
      ip: '1.2.3.4',
      socksPort: 10808,
    }),
    disconnect: jest.fn(() => options.disconnectResult || {}),
    estimateCost: jest.fn(() => options.estimateCostResult || {
      perGb: { udvpn: 500000 },
    }),
  };
}

function loadDvpnManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = options.app || createAppMock({
    isPackaged: options.isPackaged ?? false,
    userDataDir: options.userDataDir || '/tmp/freedom-test-dvpn',
  });
  const windows = options.windows || [];
  const windowMock = {
    webContents: { send: jest.fn() },
  };
  const allWindows = windows.length > 0 ? windows : [windowMock];
  const BrowserWindow = {
    getAllWindows: jest.fn(() => allWindows),
  };
  const safeStorage = createSafeStorageMock(options.safeStorage || {});
  const fsMock = createFsMock(options);
  const sdkMock = createSdkMock(options);
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();

  const setDvpnProxy = jest.fn();
  const clearDvpnProxy = jest.fn();
  const rebuild = jest.fn();

  const loadSettings = jest.fn(() => ({
    showDvpnControls: true,
    dvpnMaxSpendP2P: options.maxSpendP2P ?? 1.0,
    dvpnLowBalanceStop: options.lowBalanceStop ?? 0.5,
    dvpnMaxDurationMinutes: options.maxDurationMinutes ?? 120,
  }));

  const { mod } = loadMainModule(require.resolve('./dvpn-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    virtualMocks: ['sentinel-ai-connect', 'sentinel-ai-connect/package.json'],
    extraMocks: {
      electron: () => ({
        app,
        ipcMain,
        BrowserWindow,
        safeStorage,
        session: { defaultSession: { setProxy: jest.fn(() => Promise.resolve()) } },
      }),
      fs: () => fsMock,
      [require.resolve('./logger')]: () => log,
      [require.resolve('./service-registry')]: () => ({
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
      }),
      [require.resolve('./network-manager')]: () => ({
        setDvpnProxy,
        clearDvpnProxy,
        rebuild,
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings,
      }),
      'sentinel-ai-connect': () => sdkMock,
      'sentinel-ai-connect/package.json': () => ({ version: '1.2.2' }),
    },
  });

  return {
    mod,
    app,
    ipcMain,
    BrowserWindow,
    safeStorage,
    fsMock,
    sdkMock,
    log,
    updateService,
    setStatusMessage,
    setErrorState,
    clearErrorState,
    setDvpnProxy,
    clearDvpnProxy,
    rebuild,
    loadSettings,
    windowMock,
  };
}

describe('dvpn-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('init with no wallet sets state to OFF', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.endsWith('/dvpn')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();

    expect(ctx.mod.getStatus().state).toBe('off');
    expect(ctx.mod.getStatus().walletAddress).toBeNull();
    expect(ctx.mod.getStatus().prerequisites).toEqual(expect.objectContaining({
      ok: true,
      v2rayFound: true,
      sdkFound: true,
    }));
  });

  test('wallet creation via IPC calls SDK and returns address', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('dvpn')) return true;
        return false;
      },
    });
    ctx.mod.registerDvpnIpc();

    const result = await ctx.ipcMain.invoke(IPC.DVPN_CREATE_WALLET);

    expect(result.success).toBe(true);
    expect(result.address).toBe('sent1testaddress');
    expect(ctx.sdkMock.createWallet).toHaveBeenCalled();
    expect(ctx.safeStorage.encryptString).toHaveBeenCalled();
    expect(ctx.fsMock.writeFileSync).toHaveBeenCalled();
  });

  test('wallet creation fails when safeStorage is unavailable', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
      safeStorage: { available: false },
    });
    ctx.mod.registerDvpnIpc();

    const result = await ctx.ipcMain.invoke(IPC.DVPN_CREATE_WALLET);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Device encryption not available');
  });

  test('wallet rehydration on init calls importWallet not createWallet', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });

    await ctx.mod.initDvpn();

    expect(ctx.sdkMock.importWallet).toHaveBeenCalled();
    expect(ctx.sdkMock.createWallet).not.toHaveBeenCalled();
    expect(ctx.mod.getStatus().state).toBe('wallet_ready');
    expect(ctx.mod.getStatus().walletAddress).toBe('sent1testaddress');
  });

  test('wallet rehydration fails gracefully when safeStorage unavailable', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      safeStorage: { available: false },
    });

    await ctx.mod.initDvpn();

    expect(ctx.setErrorState).toHaveBeenCalledWith('dvpn', 'Device encryption not available');
    expect(ctx.mod.getStatus().state).toBe('error');
  });

  test('start with insufficient balance rejects with error', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });

    await ctx.mod.initDvpn();

    ctx.sdkMock.getBalance.mockResolvedValueOnce({
      p2p: 0,
      udvpn: 0,
      funded: false,
    });

    const result = await ctx.mod.startDvpn();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
    expect(ctx.mod.getStatus().state).toBe('wallet_ready');
  });

  test('spend-cap derives session gigabytes from cost estimate', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      maxSpendP2P: 2.0,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();

    ctx.sdkMock.estimateCost.mockResolvedValueOnce({
      perGb: { udvpn: 500000 },
    });

    const result = await ctx.mod.startDvpn();

    expect(result.success).toBe(true);
    expect(ctx.sdkMock.connect).toHaveBeenCalledWith(expect.objectContaining({
      gigabytes: 4,
    }));
  });

  test('connect fails when V2Ray binary is not found', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      isPackaged: false,
      existsSync: (target) => {
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();

    const result = await ctx.mod.startDvpn();

    expect(result.success).toBe(false);
    expect(result.error).toContain('V2Ray binary not found');
  });

  test('successful connect sets dVPN proxy and rebuilds PAC', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();
    const result = await ctx.mod.startDvpn();

    expect(result.success).toBe(true);
    expect(ctx.sdkMock.connect).toHaveBeenCalledWith(expect.objectContaining({
      maxAttempts: 7,
    }));
    expect(ctx.setDvpnProxy).toHaveBeenCalledWith('127.0.0.1', 10808);
    expect(ctx.rebuild).toHaveBeenCalled();
    expect(ctx.mod.getStatus().state).toBe('connected');
    expect(ctx.mod.getStatus().connected).toBe(true);
    expect(ctx.mod.getStatus().socksPort).toBe(10808);
  });

  test('disconnect clears proxy and rebuilds PAC', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();
    await ctx.mod.startDvpn();
    const result = await ctx.mod.stopDvpn();

    expect(result.success).toBe(true);
    expect(ctx.clearDvpnProxy).toHaveBeenCalled();
    expect(ctx.rebuild).toHaveBeenCalled();
    expect(ctx.mod.getStatus().state).toBe('wallet_ready');
    expect(ctx.mod.getStatus().connected).toBe(false);
  });

  test('disconnect failure transitions to REMOTE_PENDING', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();
    await ctx.mod.startDvpn();

    ctx.sdkMock.disconnect.mockRejectedValueOnce(new Error('network error'));

    const result = await ctx.mod.stopDvpn();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Session end pending');
    expect(ctx.mod.getStatus().state).toBe('local_off_remote_pending');
  });

  test('startup recovery retries pending disconnect', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: true,
      stateContents: {
        lastState: 'local_off_remote_pending',
        pendingSessionEnd: 'session-1',
        lastSocksPort: 10808,
      },
    });

    await ctx.mod.initDvpn();

    expect(ctx.sdkMock.disconnect).toHaveBeenCalled();
  });

  test('getStatus includes error, balance, and funded fields', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });

    await ctx.mod.initDvpn();

    const status = ctx.mod.getStatus();

    expect(status).toMatchObject({
      state: 'wallet_ready',
      walletAddress: 'sent1testaddress',
      connected: false,
      balance: 10,
      funded: true,
      error: null,
      lastDisconnectReason: null,
      sessionId: null,
      protocol: null,
      nodeAddress: null,
      country: null,
      ip: null,
      socksPort: null,
    });
  });

  test('low-balance auto-disconnect triggers when balance drops below threshold', async () => {
    jest.useFakeTimers();

    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      lowBalanceStop: 5.0,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();
    await ctx.mod.startDvpn();

    ctx.sdkMock.getBalance.mockResolvedValue({
      p2p: 2,
      udvpn: 2000000,
      funded: true,
    });

    jest.advanceTimersByTime(60000);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.mod.getStatus().lastDisconnectReason).toBe('low_balance');
  });

  test('max-duration auto-disconnect triggers after configured time', async () => {
    jest.useFakeTimers();

    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      maxDurationMinutes: 1,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();
    await ctx.mod.startDvpn();

    jest.advanceTimersByTime(60000);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.mod.getStatus().lastDisconnectReason).toBe('max_duration');
  });

  test('registers all dVPN IPC handlers', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
    });

    ctx.mod.registerDvpnIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual([
      IPC.DVPN_CREATE_WALLET,
      IPC.DVPN_CHECK_PREREQUISITES,
      IPC.DVPN_EXPORT_MNEMONIC,
      IPC.DVPN_GENERATE_QR,
      IPC.DVPN_GET_BALANCE,
      IPC.DVPN_GET_STATUS,
      IPC.DVPN_GET_WALLET_ADDRESS,
      IPC.DVPN_START,
      IPC.DVPN_STOP,
    ].sort());
  });

  test('checks prerequisites before wallet funding flow', async () => {
    const okCtx = loadDvpnManagerModule({
      walletExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('dvpn')) return true;
        return false;
      },
    });
    okCtx.mod.registerDvpnIpc();

    await expect(okCtx.ipcMain.invoke(IPC.DVPN_CHECK_PREREQUISITES)).resolves.toEqual(
      expect.objectContaining({
        success: true,
        ok: true,
        v2rayFound: true,
        sdkFound: true,
      })
    );

    const missingCtx = loadDvpnManagerModule({
      walletExists: false,
    });
    missingCtx.mod.registerDvpnIpc();

    const result = await missingCtx.ipcMain.invoke(IPC.DVPN_CHECK_PREREQUISITES);
    expect(result).toEqual(expect.objectContaining({
      success: true,
      ok: false,
      v2rayFound: false,
      sdkFound: true,
    }));
  });

  test('exports Sentinel mnemonic for wallet backup', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });
    ctx.mod.registerDvpnIpc();
    await ctx.mod.initDvpn();

    const result = await ctx.ipcMain.invoke(IPC.DVPN_EXPORT_MNEMONIC);

    expect(result).toEqual({
      success: true,
      mnemonic: 'word word word word word word word word word word word word',
    });
  });

  test('walletExists returns false when no wallet file', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
    });

    expect(ctx.mod.walletExists()).toBe(false);
  });

  test('STATES exports all expected states', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
    });

    expect(ctx.mod.STATES).toHaveProperty('OFF');
    expect(ctx.mod.STATES).toHaveProperty('WALLET_READY');
    expect(ctx.mod.STATES).toHaveProperty('CONNECTING');
    expect(ctx.mod.STATES).toHaveProperty('CONNECTED');
    expect(ctx.mod.STATES).toHaveProperty('DISCONNECTING');
    expect(ctx.mod.STATES).toHaveProperty('REMOTE_PENDING');
    expect(ctx.mod.STATES).toHaveProperty('ERROR');
  });

  test('connect rejects when already connecting', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
      existsSync: (target) => {
        if (target.includes('dvpn-bin') && target.includes('v2ray')) return true;
        if (target.includes('wallet.enc')) return true;
        if (target.includes('dvpn') && !target.includes('v2ray') && !target.includes('sentinel')) return true;
        return false;
      },
    });

    await ctx.mod.initDvpn();

    let resolveConnect;
    ctx.sdkMock.connect.mockImplementation(() => new Promise((resolve) => { resolveConnect = resolve; }));

    const firstCall = ctx.mod.startDvpn();
    await flushMicrotasks();

    expect(ctx.mod.getStatus().state).toBe('connecting');

    const result = await ctx.mod.startDvpn();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Already connected');

    resolveConnect({});
    await firstCall;
  });

  test('getBalance via IPC returns balance data', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });
    ctx.mod.registerDvpnIpc();
    await ctx.mod.initDvpn();

    const result = await ctx.ipcMain.invoke(IPC.DVPN_GET_BALANCE);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('p2p');
    expect(result).toHaveProperty('udvpn');
    expect(result).toHaveProperty('funded');
  });

  test('getWalletAddress via IPC returns address after init', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });
    ctx.mod.registerDvpnIpc();
    await ctx.mod.initDvpn();

    const result = await ctx.ipcMain.invoke(IPC.DVPN_GET_WALLET_ADDRESS);

    expect(result.success).toBe(true);
    expect(result.address).toBe('sent1testaddress');
  });

  test('status broadcast sent to all windows on state change', async () => {
    const win1 = { webContents: { send: jest.fn() } };
    const win2 = { webContents: { send: jest.fn() } };
    const ctx = loadDvpnManagerModule({
      walletExists: false,
      windows: [win1, win2],
    });

    await ctx.mod.initDvpn();

    expect(win1.webContents.send).toHaveBeenCalledWith(IPC.DVPN_STATUS_UPDATE, expect.any(Object));
    expect(win2.webContents.send).toHaveBeenCalledWith(IPC.DVPN_STATUS_UPDATE, expect.any(Object));
  });

  test('state is persisted after each state change', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: true,
      stateExists: false,
    });

    await ctx.mod.initDvpn();

    expect(ctx.fsMock.writeFileSync).toHaveBeenCalled();
    const stateWrites = ctx.fsMock.writeFileSync.mock.calls.filter(
      call => typeof call[1] === 'string' && call[1].includes('"lastState"')
    );
    expect(stateWrites.length).toBeGreaterThan(0);
  });

  test('withMutedSdkWarnings suppresses known sentinel-ai IP-check warnings only', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await ctx.mod.withMutedSdkWarnings(async () => {
      console.warn('[sentinel-ai] IP check skipped: missing dependency — /tmp/example');
      console.warn('keep this warning');
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('keep this warning');
  });

  test('resolveConnectedIp returns SOCKS-routed IP when axios and agent modules are available', async () => {
    const ctx = loadDvpnManagerModule({
      walletExists: false,
    });
    const packageRoot = '/virtual/sentinel-ai-connect';

    const fakeAxios = {
      defaults: {},
      get: jest.fn().mockResolvedValue({ data: { ip: '91.148.135.233' } }),
    };
    const fakeLoader = jest.fn(async (modulePath) => {
      if (modulePath.includes('axios')) {
        return { default: fakeAxios };
      }
      return {
        SocksProxyAgent: jest.fn((url) => ({ url })),
      };
    });

    jest.spyOn(ctx.fsMock, 'existsSync').mockImplementation((target) => (
      target.includes(`${packageRoot}/node_modules/axios/index.js`)
      || target.includes(`${packageRoot}/node_modules/socks-proxy-agent/dist/index.js`)
    ));

    const ip = await ctx.mod.resolveConnectedIp(10954, fakeLoader, packageRoot);

    expect(ip).toBe('91.148.135.233');
    expect(fakeAxios.get).toHaveBeenCalledWith(
      'https://api.ipify.org?format=json',
      expect.objectContaining({
        timeout: 10000,
        proxy: false,
        adapter: 'http',
      })
    );
  });
});
