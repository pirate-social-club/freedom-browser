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
  const session = { defaultSession: target, fromPartition: jest.fn(() => new EventEmitter()) };
  registerWebauthnPrompts({ app, session, webContents,
    BrowserWindow: Window, MessageChannelMain: Channel, getMainWindows: () => [parent], timeoutMs: 1000 });
  const details = { frame, relyingPartyId: 'news.web3', reason: 'challenge',
    error: null, attemptsRemaining: 8, minPinLength: 4 };
  const ask = (overrides = {}, kind = 'pin') => {
    const callback = jest.fn();
    target.emit(kind === 'pin' ? 'collect-webauthn-pin' : 'select-webauthn-account',
      {}, { ...details, ...overrides }, callback);
    return callback;
  };
  return { app, target, frame, guest, parent, windows, ports, ask, webContents, session };
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
    expect(f.session.fromPartition.mock.calls[0][0]).not.toMatch(/^persist:/);
    expect(win.options.webPreferences.session).toBe(f.session.fromPartition.mock.results[0].value);
    const [channel, payload, transfer] = win.webContents.postMessage.mock.calls[0];
    expect(channel).toBe('webauthn:prompt');
    expect(payload).toMatchObject({ origin: 'https://news.web3', rp: 'news.web3', attemptsRemaining: 8, minPinLength: 4 });
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
      if (cause === 'navigation') f.guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
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

  test('rechecks the requesting origin when a response arrives', () => {
    const callback = f.ask();
    f.frame.url = 'https://other.news.web3/other-document';
    f.ports[0].emit('message', { data: { action: 'submit', value: 'test-pin' } });
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  test.each([
    { isMainFrame: false, isSameDocument: false },
    { isMainFrame: false, isSameDocument: true },
    { isMainFrame: true, isSameDocument: true },
  ])('keeps the prompt across subframe or same-document navigation %p', (navigation) => {
    const callback = f.ask();
    f.guest.emit('did-start-navigation', navigation);
    if (navigation.isMainFrame) f.frame.url = 'https://news.web3/admin?view=posts#editor';
    expect(callback).not.toHaveBeenCalled();
    f.ports[0].emit('message', { data: { action: 'submit', value: 'test-pin' } });
    expect(callback.mock.calls).toEqual([['test-pin']]);
  });

  test.each([
    { args: [{ isMainFrame: true, isSameDocument: false }] },
    { args: [{}, 'https://news.web3/', false, true] },
    { args: [{}] },
  ])('a new main-frame document or missing metadata cancels %p', ({ args }) => {
    const callback = f.ask();
    f.guest.emit('did-start-navigation', ...args);
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  test('retains the prompt for legacy same-document and child-frame event arguments', () => {
    const callback = f.ask();
    f.guest.emit('did-start-navigation', {}, 'https://news.web3/#x', true, true);
    f.guest.emit('did-start-navigation', {}, 'https://embed.test/', false, false);
    expect(callback).not.toHaveBeenCalled();
  });

  test('refuses a replaced main-frame identity even if the origin matches', () => {
    const callback = f.ask();
    f.guest.mainFrame = { ...f.frame };
    f.ports[0].emit('message', { data: { action: 'submit', value: 'test-pin' } });
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  test('reuses one in-memory prompt session across dialogs and PIN retries', () => {
    f.ask();
    f.ask({ error: 'wrong-pin', attemptsRemaining: 7 });
    f.ask({ accounts: [{ credentialId: 'credential-a' }] }, 'account');
    expect(f.session.fromPartition).toHaveBeenCalledTimes(1);
    expect(new Set(f.windows.map((w) => w.options.webPreferences.session)).size).toBe(1);
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
