const { registerAcceptanceHttpCache, CHANNEL } = require('./acceptance-http-cache');

function setup(overrides = {}) {
  const cache = {
    getCacheSize: jest.fn().mockResolvedValue(0),
    isPersistent: jest.fn(() => true),
    getStoragePath: jest.fn(() => '/scratch/profile'),
  };
  const contents = [
    { id: 11, session: cache, isDestroyed: () => false, getType: () => 'window' },
    { id: 12, session: cache, isDestroyed: () => false, getType: () => 'webview' },
  ];
  const options = {
    app: {
      isPackaged: true,
      commandLine: { hasSwitch: () => true, getSwitchValue: () => '0' },
    },
    profile: { source: 'test-user-data' },
    env: { FREEDOM_E2E_ACCEPTANCE: '1', FREEDOM_TEST_USER_DATA: '/scratch/profile' },
    ipcMain: { handle: jest.fn() },
    webContents: { getAllWebContents: () => contents },
    ...overrides,
  };
  return { options, cache, contents, register: () => registerAcceptanceHttpCache(options) };
}

describe('installed acceptance HTTP cache diagnostic', () => {
  test.each(['catalog', 'profile-dir', undefined])('refuses profile source %s', (source) => {
    const { options, register } = setup({ profile: { source } });
    expect(register()).toBe(false);
    expect(options.ipcMain.handle).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { FREEDOM_TEST_USER_DATA: '/scratch/profile' },
    { FREEDOM_TEST_USER_DATA: '/scratch/profile', FREEDOM_E2E_ACCEPTANCE: '1', FREEDOM_TEST_MODE: '1' },
    { FREEDOM_E2E_ACCEPTANCE: '1' },
  ])('requires acceptance and an honoured debug port on a scratch profile: %j', (env) => {
    const { options, register } = setup({ env });
    expect(register()).toBe(false);
    expect(options.ipcMain.handle).not.toHaveBeenCalled();
  });

  test('refuses a launch without a debug port', () => {
    const { options, register } = setup({
      app: { isPackaged: true, commandLine: { hasSwitch: () => false } },
    });
    expect(register()).toBe(false);
    expect(options.ipcMain.handle).not.toHaveBeenCalled();
  });

  test('measures each actual session once and maps the guest to it', async () => {
    const { options, cache, contents, register } = setup();
    const memory = {
      getCacheSize: jest.fn().mockResolvedValue(1234),
      isPersistent: () => false,
      getStoragePath: () => null,
    };
    contents.push({ id: 13, session: memory, isDestroyed: () => false, getType: () => 'webview' });
    contents.push({ id: 14, isDestroyed: () => true });
    expect(register()).toBe(true);
    expect(options.ipcMain.handle).toHaveBeenCalledWith(CHANNEL, expect.any(Function));
    const handler = options.ipcMain.handle.mock.calls[0][1];
    const state = await handler();
    expect(cache.getCacheSize).toHaveBeenCalledTimes(1);
    expect(memory.getCacheSize).toHaveBeenCalledTimes(1);
    expect(state.contents).toEqual([
      { id: 11, type: 'window', sessionIndex: 0 },
      { id: 12, type: 'webview', sessionIndex: 0 },
      { id: 13, type: 'webview', sessionIndex: 1 },
    ]);
    expect(state.caches).toEqual([
      { sizeBytes: 0, persistent: true, storagePath: '/scratch/profile' },
      { sizeBytes: 1234, persistent: false, storagePath: null },
    ]);
    cache.getCacheSize.mockResolvedValue(222);
    expect((await handler()).caches[0].sizeBytes).toBe(222);
  });

  test.each([-1, NaN, 1.5, '0'])('refuses an invalid cache size %s', async (size) => {
    const { options, cache, register } = setup();
    cache.getCacheSize.mockResolvedValue(size);
    register();
    await expect(options.ipcMain.handle.mock.calls[0][1]()).rejects.toThrow('Invalid HTTP cache size');
  });

  test('does not turn a measurement failure into an empty cache', async () => {
    const { options, cache, register } = setup();
    cache.getCacheSize.mockRejectedValue(new Error('cache backend unavailable'));
    register();
    await expect(options.ipcMain.handle.mock.calls[0][1]()).rejects.toThrow('cache backend unavailable');
  });
});
