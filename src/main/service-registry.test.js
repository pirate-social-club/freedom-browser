const IPC = require('../shared/ipc-channels');
const {
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function loadServiceRegistry(options = {}) {
  return loadMainModule(require.resolve('./service-registry'), options);
}

describe('service-registry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('returns default service URLs when registry is empty', () => {
    const { mod } = loadServiceRegistry();

    expect(mod.getIpfsApiUrl()).toBe('http://127.0.0.1:5001');
    expect(mod.getIpfsGatewayUrl()).toBe('http://127.0.0.1:8080');
    expect(mod.getBeeApiUrl()).toBe('http://127.0.0.1:1633');
    expect(mod.getBeeGatewayUrl()).toBe('http://127.0.0.1:1633');
    expect(mod.getRadicleApiUrl()).toBe('http://127.0.0.1:8780');
  });

  test('updates a service and broadcasts the new registry state', () => {
    const firstWindow = { webContents: { send: jest.fn() } };
    const closingWindow = {
      webContents: {
        send: jest.fn(() => {
          throw new Error('window closing');
        }),
      },
    };
    const { mod } = loadServiceRegistry({ windows: [firstWindow, closingWindow] });

    mod.updateService('ipfs', {
      api: 'http://127.0.0.1:5999',
      gateway: 'http://127.0.0.1:8999',
      mode: mod.MODE.EXTERNAL,
    });

    expect(mod.getService('ipfs')).toEqual(
      expect.objectContaining({
        api: 'http://127.0.0.1:5999',
        gateway: 'http://127.0.0.1:8999',
        mode: mod.MODE.EXTERNAL,
      })
    );
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SERVICE_REGISTRY_UPDATE,
      expect.objectContaining({
        ipfs: expect.objectContaining({
          api: 'http://127.0.0.1:5999',
          gateway: 'http://127.0.0.1:8999',
          mode: mod.MODE.EXTERNAL,
        }),
      })
    );
    expect(closingWindow.webContents.send).toHaveBeenCalled();
  });

  test('temporary messages override status and auto-clear back to the permanent message', () => {
    const { mod } = loadServiceRegistry();

    mod.setStatusMessage('bee', 'Bee ready');
    mod.setTempStatusMessage('bee', 'Reconnecting', 50);

    expect(mod.getDisplayMessage('bee')).toBe('Reconnecting');

    jest.advanceTimersByTime(50);

    expect(mod.getDisplayMessage('bee')).toBe('Bee ready');
  });

  test('error state can be cleared back to the permanent status message', () => {
    const { mod } = loadServiceRegistry();

    mod.setStatusMessage('radicle', 'Running');
    mod.setErrorState('radicle', 'Connection failed');
    expect(mod.getDisplayMessage('radicle')).toBe('Connection failed');

    mod.clearErrorState('radicle');
    expect(mod.getDisplayMessage('radicle')).toBe('Running');
  });

  test('clearService resets service state back to defaults', () => {
    const { mod } = loadServiceRegistry();

    mod.updateService('bee', {
      api: 'http://127.0.0.1:1999',
      gateway: 'http://127.0.0.1:1999',
      mode: mod.MODE.BUNDLED,
    });
    mod.setStatusMessage('bee', 'Online');

    mod.clearService('bee');

    expect(mod.getService('bee')).toEqual({
      api: null,
      gateway: null,
      mode: mod.MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
    });
  });

  test('clearService preserves HNS-specific fields', () => {
    const { mod } = loadServiceRegistry();

    mod.updateService('hns', {
      api: 'http://127.0.0.1:5380',
      proxy: '127.0.0.1:5380',
      mode: mod.MODE.BUNDLED,
      synced: true,
      canaryReady: true,
      height: 42000,
    });

    mod.clearService('hns');

    const hns = mod.getService('hns');
    expect(hns).toEqual({
      api: null,
      proxy: null,
      mode: mod.MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
      synced: false,
      canaryReady: false,
      height: 0,
    });
  });

  test('clearService preserves dVPN-specific fields', () => {
    const { mod } = loadServiceRegistry();

    mod.updateService('dvpn', {
      api: 'http://127.0.0.1:9999',
      proxy: '127.0.0.1:10808',
      mode: mod.MODE.BUNDLED,
      walletAddress: 'sent1test',
      balance: 10,
      funded: true,
      connected: true,
      sessionId: 'session-1',
      protocol: 'v2ray',
      nodeAddress: 'sent1node',
      country: 'US',
      ip: '1.2.3.4',
      lastDisconnectReason: null,
    });

    mod.clearService('dvpn');

    const dvpn = mod.getService('dvpn');
    expect(dvpn).toEqual({
      api: null,
      proxy: null,
      mode: mod.MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
      walletAddress: null,
      balance: null,
      funded: false,
      connected: false,
      sessionId: null,
      protocol: null,
      nodeAddress: null,
      country: null,
      ip: null,
      lastDisconnectReason: null,
    });
  });

  test('clearService preserves Anyone-specific fields', () => {
    const { mod } = loadServiceRegistry();

    mod.updateService('anyone', {
      proxy: '127.0.0.1:9050',
      mode: mod.MODE.BUNDLED,
      connected: true,
      socksPort: 9050,
      controlPort: 9051,
      circuitState: 'BUILT',
      error: null,
    });

    mod.clearService('anyone');

    const anyone = mod.getService('anyone');
    expect(anyone).toEqual({
      proxy: null,
      mode: mod.MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
      connected: false,
      socksPort: null,
      controlPort: null,
      circuitState: null,
      error: null,
    });
  });

  test('registers an IPC handler that returns the current registry state', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadServiceRegistry({ ipcMain });

    mod.updateService('radicle', {
      api: 'http://127.0.0.1:8781',
      gateway: 'http://127.0.0.1:8781',
      mode: mod.MODE.REUSED,
    });
    mod.registerServiceRegistryIpc();

    await expect(ipcMain.invoke(IPC.SERVICE_REGISTRY_GET)).resolves.toEqual(
      expect.objectContaining({
        radicle: expect.objectContaining({
          api: 'http://127.0.0.1:8781',
          gateway: 'http://127.0.0.1:8781',
          mode: mod.MODE.REUSED,
        }),
      })
    );
  });
});
