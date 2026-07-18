jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
  ipcMain: { handle: jest.fn() },
}));
jest.mock('./profile-paths', () => ({
  getHnsDataDir: jest.fn(() => '/profiles/default/hns-data'),
}));
jest.mock('./service-registry', () => ({
  MODE: { BUNDLED: 'bundled', DISABLED: 'disabled' },
  clearErrorState: jest.fn(),
  clearService: jest.fn(),
  setErrorState: jest.fn(),
  setStatusMessage: jest.fn(),
  updateService: jest.fn(),
}));

const IPC = require('../shared/ipc-channels');
const registry = require('./service-registry');
const { ipcMain } = require('electron');
const manager = require('./hns-manager');

describe('hns-manager lifecycle boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses the active profile HNS data directory', () => {
    expect(manager.getHnsDataPath()).toBe('/profiles/default/hns-data');
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
});
