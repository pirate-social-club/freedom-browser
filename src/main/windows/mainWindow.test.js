const { loadMainModule, createAppMock } = require('../../../test/helpers/main-process-test-utils');

function createBrowserWindowMock() {
  const created = [];
  const BrowserWindow = jest.fn((options) => {
    const listeners = new Map();
    const webContentsListeners = new Map();
    const webContents = {
      send: jest.fn(),
      on: jest.fn((event, handler) => {
        webContentsListeners.set(event, handler);
      }),
      setWindowOpenHandler: jest.fn((handler) => {
        webContents.windowOpenHandler = handler;
      }),
      webContentsListeners,
    };
    const win = {
      options,
      webContents,
      listeners,
      loadFile: jest.fn(),
      on: jest.fn((event, handler) => {
        listeners.set(event, handler);
      }),
      setTitle: jest.fn(),
    };
    created.push(win);
    return win;
  });
  BrowserWindow.created = created;
  return BrowserWindow;
}

describe('main window', () => {
  test('creates a sandboxed internal window and denies top-frame navigation', () => {
    const BrowserWindow = createBrowserWindowMock();
    const app = createAppMock({ isPackaged: false });
    const { mod } = loadMainModule(require.resolve('./mainWindow'), {
      app,
      BrowserWindow,
    });

    const win = mod.createMainWindow();

    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      enableRemoteModule: false,
    });
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(win.webContents.windowOpenHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' });

    const event = { preventDefault: jest.fn() };
    win.webContents.webContentsListeners.get('will-navigate')(event, 'https://example.com');
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
