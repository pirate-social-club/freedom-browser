const {
  createFreedomProtocolHandler,
  findFreedomUrl,
  normalizeFreedomUrl,
  registerFreedomProtocolClient,
} = require('./protocol-handler');

function createAppMock(options = {}) {
  const listeners = new Map();
  return {
    isPackaged: options.isPackaged ?? true,
    isReady: jest.fn(() => options.isReady ?? true),
    on: jest.fn((event, handler) => {
      listeners.set(event, handler);
    }),
    emit(event, ...args) {
      return listeners.get(event)?.(...args);
    },
    setAsDefaultProtocolClient: jest.fn(() => true),
  };
}

function createWindowMock() {
  return {
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => false),
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    webContents: {
      send: jest.fn(),
    },
  };
}

describe('protocol-handler', () => {
  test('normalizes only routable freedom URLs and preserves live-room params', () => {
    expect(normalizeFreedomUrl('freedom://live-room?roomId=lr_1&communityId=cmt_1')).toBe(
      'freedom://live-room?roomId=lr_1&communityId=cmt_1'
    );
    expect(normalizeFreedomUrl('freedom://HISTORY#top')).toBe('freedom://history#top');
    expect(normalizeFreedomUrl('https://example.com')).toBeNull();
    expect(normalizeFreedomUrl('freedom://not-a-page')).toBeNull();
  });

  test('finds a freedom URL in process argv', () => {
    expect(findFreedomUrl(['/usr/bin/freedom', '--flag', 'freedom://live-room?roomId=lr_1'])).toBe(
      'freedom://live-room?roomId=lr_1'
    );
    expect(findFreedomUrl(['/usr/bin/freedom', '--flag'])).toBeNull();
  });

  test('registers packaged and development protocol clients', () => {
    const packagedApp = createAppMock({ isPackaged: true });
    expect(registerFreedomProtocolClient({ app: packagedApp })).toBe(true);
    expect(packagedApp.setAsDefaultProtocolClient).toHaveBeenCalledWith('freedom');

    const devApp = createAppMock({ isPackaged: false });
    expect(registerFreedomProtocolClient({
      app: devApp,
      argv: ['/electron', '.'],
      execPath: '/usr/bin/electron',
    })).toBe(true);
    expect(devApp.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      'freedom',
      '/usr/bin/electron',
      [expect.stringMatching(/freedom-browser$/)]
    );
  });

  test('routes second-instance URLs into an existing window', () => {
    const app = createAppMock();
    const win = createWindowMock();
    const createMainWindow = jest.fn();
    createFreedomProtocolHandler({
      app,
      createMainWindow,
      getMainWindows: () => [win],
    });

    app.emit('second-instance', {}, ['/usr/bin/freedom', 'freedom://live-room?roomId=lr_1']);

    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(
      'navigate-to-url',
      'freedom://live-room?roomId=lr_1'
    );
    expect(createMainWindow).not.toHaveBeenCalled();
  });

  test('queues early open-url events and exposes them for initial window load', () => {
    const app = createAppMock({ isReady: false });
    const handler = createFreedomProtocolHandler({
      app,
      createMainWindow: jest.fn(),
      getMainWindows: () => [],
    });
    const event = { preventDefault: jest.fn() };

    app.emit('open-url', event, 'freedom://live-room?roomId=lr_early');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(handler.consumePendingUrl()).toBe('freedom://live-room?roomId=lr_early');
    expect(handler.consumePendingUrl()).toBeNull();
  });

  test('creates a main window when no existing window can receive the URL', () => {
    const app = createAppMock();
    const createMainWindow = jest.fn();
    const handler = createFreedomProtocolHandler({
      app,
      createMainWindow,
      getMainWindows: () => [],
    });

    expect(handler.openUrl('freedom://history')).toBe(true);
    expect(createMainWindow).toHaveBeenCalledWith('freedom://history');
  });
});
