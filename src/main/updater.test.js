const { loadMainModule } = require('../../test/helpers/main-process-test-utils');
const packageConfig = require('../../package.json');

function loadUpdater() {
  const updaterFactory = jest.fn(() => {
    throw new Error('An evaluation build must never load electron-updater');
  });
  const dialog = { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) };
  const log = { info: jest.fn(), warn: jest.fn() };
  // This forbidden dependency is deliberately absent from the package.
  jest.doMock('electron-updater', updaterFactory, { virtual: true });
  const loaded = loadMainModule(require.resolve('./updater'), {
    dialog,
    extraMocks: {
      [require.resolve('./logger')]: () => log,
    },
  });
  return { ...loaded, updaterFactory, log };
}

describe('evaluation updater policy', () => {
  const originalDevUpdater = process.env.ENABLE_DEV_UPDATER;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.ENABLE_DEV_UPDATER = 'true';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalDevUpdater === undefined) delete process.env.ENABLE_DEV_UPDATER;
    else process.env.ENABLE_DEV_UPDATER = originalDevUpdater;
  });

  test('startup schedules no polling and never loads an updater, even with a dev override', () => {
    const { mod, updaterFactory } = loadUpdater();
    mod.initUpdater({ isDestroyed: () => false });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(mod.isUpdateReady()).toBe(false);
    expect(mod.getInstallRelaunchMode().autoRunAfterInstall).toBe(false);
    expect(updaterFactory).not.toHaveBeenCalled();
    expect(packageConfig.build.publish).toBeNull();
  });

  test('menu and IPC checks explain manual replacement; install requests remain inert', async () => {
    const { mod, ipcMain, dialog, updaterFactory } = loadUpdater();
    const window = { isDestroyed: () => false };
    mod.initUpdater(window);
    await mod.checkForUpdates();
    await ipcMain.emit('update:check');
    mod.installUpdate();
    ipcMain.emit('update:restart-and-install');
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({
      message: 'Updates are disabled for this evaluation build.',
    }));
    expect(mod.isUpdateReady()).toBe(false);
    expect(updaterFactory).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('progress IPC and test events cannot enable checking or installation', async () => {
    const { mod, ipcMain, updaterFactory } = loadUpdater();
    const state = mod.getUpdateState();
    expect(state).toMatchObject({ status: 'unsupported', canCheck: false, percent: null });
    expect(await ipcMain.invoke('update:get-state')).toEqual(state);
    for (const event of ['checking', 'available', 'download-progress', 'downloaded', 'error']) {
      expect(mod.dispatchUpdateEvent(event, { version: '99.0.0', percent: 100 })).toEqual(state);
    }
    expect(mod.isUpdateReady()).toBe(false);
    expect(updaterFactory).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('manual checks tolerate a closed window or a failed dialog', async () => {
    const { mod, dialog, updaterFactory, log } = loadUpdater();
    mod.initUpdater({ isDestroyed: () => true });
    await mod.checkForUpdates();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Updates Disabled',
    }));
    dialog.showMessageBox.mockRejectedValueOnce(new Error('Window unavailable'));
    await expect(mod.checkForUpdates()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(updaterFactory).not.toHaveBeenCalled();
  });
});
