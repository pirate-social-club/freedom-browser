jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
  ipcMain: { handle: jest.fn() },
  session: { defaultSession: {} },
}));
jest.mock('./profile-paths', () => ({
  getHnsDataDir: jest.fn(() => '/profiles/default/hns-data'),
}));
jest.mock('../shared/hns-hosts', () => ({
  refreshHnsPublicSuffixes: jest.fn(() => Promise.resolve(['.pirate'])),
}));
jest.mock('./hns-cert-verifier', () => ({
  clearHnsCertificateVerifier: jest.fn(),
  configureHnsCertificateVerifier: jest.fn(() => 'AA:BB'),
}));
jest.mock('./service-registry', () => ({
  MODE: { BUNDLED: 'bundled', DISABLED: 'disabled' },
  clearErrorState: jest.fn(),
  clearService: jest.fn(),
  setErrorState: jest.fn(),
  setStatusMessage: jest.fn(),
  updateService: jest.fn(),
}));
jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));

const mockSpawned = [];
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    mockSpawned.push(child);
    return child;
  }),
}));

let mockNextPort = 41000;
jest.mock('net', () => ({
  createServer: jest.fn(() => {
    const { EventEmitter } = require('events');
    const server = new EventEmitter();
    server.unref = jest.fn();
    server.address = jest.fn(() => ({ port: mockNextPort++ }));
    server.listen = jest.fn((_port, _host, callback) => callback());
    server.close = jest.fn((callback) => callback());
    return server;
  }),
}));
jest.mock('dgram', () => ({
  createSocket: jest.fn(() => {
    const { EventEmitter } = require('events');
    const socket = new EventEmitter();
    socket.unref = jest.fn();
    socket.bind = jest.fn((_port, _host, callback) => callback());
    socket.close = jest.fn();
    return socket;
  }),
}));
jest.mock('readline', () => ({
  createInterface: jest.fn(() => ({ on: jest.fn() })),
}));

const IPC = require('../shared/ipc-channels');
const registry = require('./service-registry');
const certVerifier = require('./hns-cert-verifier');
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const manager = require('./hns-manager');

describe('hns-manager lifecycle boundary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSpawned.length = 0;
    manager._resetForTests();
  });

  afterEach(() => {
    delete process.env.FREEDOM_HNS_TEST_BIN_DIR;
    delete process.env.FREEDOM_HNS_TEST_SEED;
    delete process.env.FREEDOM_TEST_MODE;
    manager._resetForTests();
    jest.useRealTimers();
  });

  test('uses the active profile HNS data directory', () => {
    expect(manager.getHnsDataPath()).toBe('/profiles/default/hns-data');
  });

  test('uses fixture binaries and seed only in explicit test mode', async () => {
    process.env.FREEDOM_TEST_MODE = '1';
    process.env.FREEDOM_HNS_TEST_BIN_DIR = '/fixtures/hns-bin';
    process.env.FREEDOM_HNS_TEST_SEED = '127.0.0.1:10000';

    await manager.startHns();

    expect(spawn).toHaveBeenCalledWith('/fixtures/hns-bin/fingertipd', expect.arrayContaining([
      '-hnsd-path', '/fixtures/hns-bin/hnsd',
      '-hnsd-seed', '127.0.0.1:10000',
    ]));
  });

  test('publishes sync progress without installing request routing', () => {
    manager.parseHelperEvent(JSON.stringify({
      type: 'sync',
      height: 12345,
      progress: 0.42,
      synced: false,
    }));

    expect(registry.updateService).toHaveBeenCalledWith(
      'hns',
      expect.objectContaining({
        height: 12345,
        mode: 'bundled',
        synced: false,
        syncProgress: 0.42,
      })
    );
    expect(registry.setStatusMessage).toHaveBeenCalledWith(
      'hns',
      'Syncing HNS headers at block 12345'
    );
  });

  test('registers lifecycle and binary-availability IPC', () => {
    manager.registerHnsIpc();
    const channels = ipcMain.handle.mock.calls.map(([channel]) => channel);
    expect(channels).toEqual(expect.arrayContaining([
      IPC.HNS_START,
      IPC.HNS_STOP,
      IPC.HNS_GET_STATUS,
      IPC.HNS_CHECK_BINARY,
    ]));
  });

  test('keeps registry fail-closed when the helper CA cannot be pinned', () => {
    certVerifier.configureHnsCertificateVerifier.mockImplementationOnce(() => {
      throw new Error('invalid CA');
    });
    manager.parseHelperEvent(JSON.stringify({
      type: 'ready',
      proxyAddr: '127.0.0.1:44041',
      caPath: '/profile/hns-data/ca.pem',
    }));
    expect(manager.getHnsStatus().status).toBe(manager.STATUS.ERROR);
    expect(registry.clearService).toHaveBeenCalledWith('hns');
    expect(registry.setErrorState).toHaveBeenCalledWith(
      'hns',
      'HNS certificate trust failed: invalid CA'
    );

    registry.updateService.mockClear();
    manager.parseHelperEvent(JSON.stringify({ type: 'sync', synced: true, height: 999 }));
    expect(registry.updateService).not.toHaveBeenCalled();
  });

  test('restarts after an unexpected exit and resets backoff after recovery', async () => {
    await manager.startHns();
    expect(mockSpawned).toHaveLength(1);

    mockSpawned[0].emit('close', 1);
    await jest.advanceTimersByTimeAsync(999);
    expect(mockSpawned).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSpawned).toHaveLength(2);

    manager.parseHelperEvent(JSON.stringify({ type: 'ready', proxyAddr: '127.0.0.1:44041' }));
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    mockSpawned[1].emit('close', 1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockSpawned).toHaveLength(3);
  });

  test('stops restart attempts after the crash cap and reports the failure', async () => {
    await manager.startHns();

    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      mockSpawned.at(-1).emit('close', 1);
      await jest.advanceTimersByTimeAsync(delay);
    }
    mockSpawned.at(-1).emit('close', 1);

    expect(manager.getHnsStatus()).toEqual(expect.objectContaining({
      status: manager.STATUS.ERROR,
      error: 'HNS helper crashed repeatedly',
    }));
    expect(registry.setErrorState).toHaveBeenCalledWith(
      'hns',
      'HNS helper crashed repeatedly'
    );
    await jest.advanceTimersByTimeAsync(30000);
    expect(mockSpawned).toHaveLength(6);
  });

  test('escalates a stuck graceful stop from SIGTERM to SIGKILL', async () => {
    await manager.startHns();
    const child = mockSpawned[0];

    const stopping = manager.stopHns();
    expect(registry.clearService).toHaveBeenCalledWith('hns');
    expect(certVerifier.clearHnsCertificateVerifier).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await jest.advanceTimersByTimeAsync(4999);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    await jest.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', 0);
    await expect(stopping).resolves.toEqual(expect.objectContaining({ status: 'stopped' }));
  });
});
