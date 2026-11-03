const { EventEmitter } = require('events');
const { registerWebauthnPrompts } = require('./webauthn-prompts');

function fixture() {
  const app = new EventEmitter();
  const target = new EventEmitter();
  const frame = { url: 'https://news.web3/_emdash/admin/setup', detached: false };
  const host = {};
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, hostWebContents: host,
    session: target, getType: () => 'webview', isDestroyed: () => false });
  const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const windows = [];
  const ports = [];
  class Port extends EventEmitter {
    start() {}
    close() { this.emit('close'); }
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = {}; ports.push(this.port1); }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), { getURL: () => this.url,
        postMessage: jest.fn(), setWindowOpenHandler: jest.fn() });
      windows.push(this);
    }
    static fromWebContents(value) { return value === host ? parent : null; }
    setMenu() {}
    show() { this.shown = true; }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    loadFile(file) {
      this.url = require('url').pathToFileURL(file).href;
      this.webContents.emit('did-finish-load');
      return Promise.resolve();
    }
  }
  const webContents = { fromFrame: (f) => f === frame ? guest : null,
    getAllWebContents: () => [guest] };
  registerWebauthnPrompts({ app, session: { defaultSession: target }, webContents,
    BrowserWindow: Window, MessageChannelMain: Channel, getMainWindows: () => [parent], timeoutMs: 1000 });
  const details = { frame, relyingPartyId: 'news.web3', reason: 'challenge',
    error: null, attemptsRemaining: 8 };
  const ask = (overrides = {}, kind = 'pin') => {
    const callback = jest.fn();
    target.emit(kind === 'pin' ? 'collect-webauthn-pin' : 'select-webauthn-account',
      {}, { ...details, ...overrides }, callback);
    return callback;
  };
  return { app, target, frame, guest, parent, windows, ports, ask, webContents };
}

describe('trusted WebAuthn security key prompts', () => {
  let f;
  beforeEach(() => { jest.useFakeTimers(); f = fixture(); });
  afterEach(() => { f.app.emit('before-quit'); jest.useRealTimers(); });

  test('shows the native requester and a PIN field in an isolated modal', () => {
    const callback = f.ask();
    const win = f.windows[0];
    expect(win.shown).toBe(true);
    expect(win.options.parent).toBe(f.parent);
    expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false, devTools: false });
    expect(win.options.webPreferences.partition).not.toMatch(/^persist:/);
    const [channel, payload, transfer] = win.webContents.postMessage.mock.calls[0];
    expect(channel).toBe('webauthn:prompt');
    expect(payload).toMatchObject({ origin: 'https://news.web3', rp: 'news.web3', attemptsRemaining: 8 });
    expect(transfer).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled();
  });

  test('answers native code once, destroys the dialog and ignores replays', () => {
    const callback = f.ask();
    f.ports[0].emit('message', { data: { action: 'submit', value: 'test-pin' } });
    f.ports[0].emit('message', { data: { action: 'submit', value: 'replay' } });
    expect(callback.mock.calls).toEqual([['test-pin']]);
    expect(f.windows[0].dead).toBe(true);
  });

  test.each(['cancel', 'close', 'timeout', 'navigation', 'crash', 'parent-close', 'quit'])(
    '%s cancels without answering with a PIN', (cause) => {
      const callback = f.ask();
      if (cause === 'cancel') f.ports[0].emit('message', { data: { action: 'cancel' } });
      if (cause === 'close') f.windows[0].destroy();
      if (cause === 'timeout') jest.advanceTimersByTime(1001);
      if (cause === 'navigation') f.guest.emit('did-start-navigation');
      if (cause === 'crash') f.guest.emit('render-process-gone');
      if (cause === 'parent-close') f.parent.emit('closed');
      if (cause === 'quit') f.app.emit('before-quit');
      expect(callback.mock.calls).toEqual([[undefined]]);
      expect(f.windows[0].dead).toBe(true);
      expect(f.guest.listenerCount('did-start-navigation')).toBe(0);
    });

  test.each([
    { frame: null }, { relyingPartyId: 'evil.example' }, { reason: 'set' },
    { reason: 'change' }, { attemptsRemaining: 0 }, { attemptsRemaining: null },
  ])('refuses invalid native context %p', (overrides) => {
    const callback = f.ask(overrides);
    expect(callback).toHaveBeenCalledWith();
    expect(f.windows).toHaveLength(0);
  });

  test.each(['http://news.web3/', 'bzz://news.web3/', 'https://attacker.example/'])(
    'refuses an unsuitable requesting origin %s', (url) => {
      f.frame.url = url;
      expect(f.ask()).toHaveBeenCalledWith();
      expect(f.windows).toHaveLength(0);
    });

  test('refuses subframes, detached frames and session mismatches', () => {
    f.guest.mainFrame = {};
    expect(f.ask()).toHaveBeenCalledWith();
    f.guest.mainFrame = f.frame;
    f.frame.detached = true;
    expect(f.ask()).toHaveBeenCalledWith();
    f.frame.detached = false;
    f.guest.session = {};
    expect(f.ask()).toHaveBeenCalledWith();
    expect(f.windows).toHaveLength(0);
  });

  test('rechecks the requesting document when a response arrives', () => {
    const callback = f.ask();
    f.frame.url = 'https://news.web3/other-document';
    f.ports[0].emit('message', { data: { action: 'submit', value: 'test-pin' } });
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  test('a superseded dialog cannot answer the new request', () => {
    const old = f.ask();
    const current = f.ask({ error: 'wrong-pin', attemptsRemaining: 7 });
    expect(old.mock.calls).toEqual([[undefined]]);
    f.ports[0].emit('message', { data: { action: 'submit', value: 'stale-pin' } });
    expect(current).not.toHaveBeenCalled();
    f.ports[1].emit('message', { data: { action: 'submit', value: 'new-pin' } });
    expect(current.mock.calls).toEqual([['new-pin']]);
  });

  test('wrong PIN retries remain controlled by Chromium and require another user action', () => {
    const first = f.ask();
    f.ports[0].emit('message', { data: { action: 'submit', value: 'test-pin' } });
    expect(first).toHaveBeenCalledTimes(1);
    const retry = f.ask({ error: 'wrong-pin', attemptsRemaining: 7 });
    expect(retry).not.toHaveBeenCalled();
    expect(f.windows[1].webContents.postMessage.mock.calls[0][1]).toMatchObject({ error: 'wrong-pin', attemptsRemaining: 7 });
  });

  test('account selection accepts only an offered credential', () => {
    const accounts = [{ credentialId: 'credential-a', name: 'owner' }];
    const valid = f.ask({ accounts }, 'account');
    f.ports[0].emit('message', { data: { action: 'submit', value: 'credential-a' } });
    expect(valid.mock.calls).toEqual([['credential-a']]);
    const invalid = f.ask({ accounts }, 'account');
    f.ports[1].emit('message', { data: { action: 'submit', value: 'not-offered' } });
    expect(invalid.mock.calls).toEqual([[undefined]]);
  });

  test.each([undefined, null, [], [{}]])('refuses malformed account lists %p', (accounts) => {
    expect(f.ask({ accounts }, 'account')).toHaveBeenCalledWith(undefined);
    expect(f.windows).toHaveLength(0);
  });

  test('rejects malformed and oversized responses', () => {
    for (const data of [null, {}, { action: 'submit', value: 123 }, { action: 'submit', value: 'x'.repeat(257) }]) {
      const callback = f.ask();
      f.ports.at(-1).emit('message', { data });
      expect(callback.mock.calls).toEqual([[undefined]]);
    }
  });

  test('attaches once to existing and newly created sessions', () => {
    expect(f.target.listenerCount('collect-webauthn-pin')).toBe(1);
    f.app.emit('session-created', f.target);
    expect(f.target.listenerCount('collect-webauthn-pin')).toBe(1);
    const other = new EventEmitter();
    f.app.emit('session-created', other);
    expect(other.listenerCount('collect-webauthn-pin')).toBe(1);
  });
});
