const { EventEmitter } = require('events');
const path = require('path');
const { pathToFileURL } = require('url');
const IPC = require('../shared/ipc-channels');
const { registerSessionRoutingFeedback } = require('./session-routing-feedback');
const { createSessionProxyController } = require('./session-proxy-controller');

const indexUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function contents(id, targetSession, type = 'window', host = null) {
  return Object.assign(new EventEmitter(), { id, session: targetSession, hostWebContents: host,
    mainFrame: { url: indexUrl }, isDestroyed: jest.fn(() => false),
    getType: () => type, send: jest.fn() });
}
function fixture() {
  const app = new EventEmitter();
  const main = { setProxy: jest.fn(async () => {}), forceReloadProxyConfig: jest.fn(async () => {}),
    closeAllConnections: jest.fn(async () => {}) };
  const controller = createSessionProxyController(() => main, { onFatal: jest.fn() });
  controller.adoptDefault();
  const host = contents(1, main);
  const other = contents(2, main);
  const guest = contents(3, main, 'webview', host);
  const foreign = contents(4, main, 'webview', other);
  const windows = [host, other].map((webContents) => ({ webContents, isDestroyed: () => false }));
  const dialog = { showMessageBox: jest.fn(async () => ({ response: 0 })) };
  let read;
  registerSessionRoutingFeedback({ app, dialog,
    ipcMain: { handle: (channel, handler) => { expect(channel).toBe(IPC.ROUTING_STATUS_GET); read = handler; } },
    webContents: { getAllWebContents: () => [host, other, guest, foreign] },
    getMainWindows: () => windows, getDefaultSession: () => main,
    getPolicy: controller.policyFor, setPolicyObserver: controller.setPolicyObserver });
  app.emit('web-contents-created', {}, host);
  return { controller, host, guest, foreign, main, dialog, windows,
    read: (sender = host, senderFrame = sender.mainFrame) => read({ sender, senderFrame }) };
}

describe('read-only routing feedback', () => {
  test('returns only real guests belonging to the registered host, with no URL or route', () => {
    const f = fixture();
    const value = f.read();
    expect(value.guests.map((guest) => guest.id)).toEqual([3]);
    expect(Object.keys(value.ui).sort()).toEqual(['allowed', 'generation', 'state']);
    expect(f.read().revision).toBeGreaterThan(value.revision);
  });

  test('rejects remote pages, subframes, foreign guests and unregistered windows', () => {
    const f = fixture();
    expect(() => f.read(f.guest)).toThrow('UI main frame');
    expect(() => f.read(contents(99, f.main))).toThrow('UI main frame');
    expect(() => f.read(f.host, { url: indexUrl })).toThrow('UI main frame');
    f.host.mainFrame.url = 'https://example.com';
    expect(() => f.read()).toThrow('UI main frame');
    f.host.mainFrame.url = indexUrl.replace('index.html', 'pages/home.html');
    expect(() => f.read()).toThrow('UI main frame');
  });

  test('permits the existing initialUrl query but rejects extra parameters and fragments', () => {
    const f = fixture();
    f.host.mainFrame.url = indexUrl + '?initialUrl=https%3A%2F%2Fexample.com';
    expect(f.read().ui.allowed).toBe(true);
    for (const suffix of ['?other=1', '#fragment', '?initialUrl=a&initialUrl=b']) {
      f.host.mainFrame.url = indexUrl + suffix;
      expect(() => f.read()).toThrow('UI main frame');
    }
  });

  test('pushes quarantine and recovery without granting routing authority', async () => {
    const f = fixture();
    f.read();
    await f.controller.quarantineAll();
    await flush();
    expect(f.host.send).toHaveBeenLastCalledWith(IPC.ROUTING_STATUS_UPDATE,
      expect.objectContaining({ ui: expect.objectContaining({ allowed: false, state: 'quarantined' }) }));
    expect(f.main.setProxy).not.toHaveBeenCalled();
    await f.controller.apply({ mode: 'direct' });
    await flush();
    expect(f.host.send).toHaveBeenLastCalledWith(IPC.ROUTING_STATUS_UPDATE,
      expect.objectContaining({ ui: expect.objectContaining({ allowed: true, state: 'ready' }) }));
  });

  test('uses native feedback before UI readiness and after a reload during quarantine', async () => {
    const f = fixture();
    await f.controller.quarantineAll();
    await flush();
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    f.read();
    await f.controller.apply({ mode: 'direct' });
    await flush();
    await f.controller.quarantineAll();
    await flush();
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(2); // Other registered UI is not loaded.
    f.windows.splice(1);
    f.read();
    await f.controller.apply({ mode: 'direct' });
    await flush();
    await f.controller.quarantineAll();
    await flush();
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    f.host.emit('did-start-loading');
    await flush();
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(3);
  });

  test('never sends feedback to a host that navigated away or a destroyed guest', async () => {
    const f = fixture();
    f.read();
    f.guest.isDestroyed.mockReturnValue(true);
    expect(f.read().guests).toEqual([]);
    f.host.mainFrame.url = 'https://example.com';
    await f.controller.quarantineAll();
    await flush();
    expect(f.host.send).not.toHaveBeenCalled();
  });

  test('restores status delivery after unresponsive UI recovers without another GET', async () => {
    const f = fixture();
    f.windows.splice(1);
    f.read();
    f.host.emit('unresponsive');
    await f.controller.quarantineAll();
    await flush();
    expect(f.host.send).not.toHaveBeenCalled();
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    f.host.emit('responsive');
    await flush();
    expect(f.host.send).toHaveBeenLastCalledWith(IPC.ROUTING_STATUS_UPDATE,
      expect.objectContaining({ ui: expect.objectContaining({ allowed: false }) }));
    await f.controller.apply({ mode: 'direct' });
    await flush();
    expect(f.host.send).toHaveBeenLastCalledWith(IPC.ROUTING_STATUS_UPDATE,
      expect.objectContaining({ ui: expect.objectContaining({ allowed: true }) }));
    await f.controller.quarantineAll();
    await flush();
    expect(f.host.send).toHaveBeenLastCalledWith(IPC.ROUTING_STATUS_UPDATE,
      expect.objectContaining({ ui: expect.objectContaining({ allowed: false }) }));
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('explains a startup quarantine before a browser window can load', async () => {
    const f = fixture();
    f.windows.splice(0);
    await f.controller.quarantineAll();
    await flush();
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(f.host.send).not.toHaveBeenCalled();
  });

  test.each(['throw', 'reject'])('an observer that can %s cannot interrupt containment or recovery', async (failure) => {
    const f = fixture();
    const fatal = jest.fn();
    const controller = createSessionProxyController(() => f.main, { onFatal: fatal });
    controller.setPolicyObserver(() => {
      if (failure === 'throw') throw new Error('feedback');
      return Promise.reject(new Error('feedback'));
    });
    controller.adoptDefault();
    await controller.quarantineAll();
    expect(controller.policyFor(f.main).allowed).toBe(false);
    await controller.apply({ mode: 'direct' });
    expect(controller.policyFor(f.main).allowed).toBe(true);
    controller.terminate('guard_resource_failed');
    expect(controller.policyFor(f.main).allowed).toBe(false);
    expect(fatal).toHaveBeenCalledWith('guard_resource_failed');
    await flush();
  });
});
