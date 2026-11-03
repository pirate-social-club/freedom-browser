const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');

const PAGE = path.join(__dirname, '..', 'renderer', 'security-key.html');
const PAGE_URL = pathToFileURL(PAGE).href;
const TIMEOUT_MS = 120000;

// Only the native WebAuthn event supplies this context. Never accept an origin
// or RP ID from renderer IPC. Chromium remains responsible for WebAuthn checks.
function requestContext(details, targetSession, webContents, BrowserWindow, getMainWindows) {
  try {
    const frame = details.frame;
    const guest = frame && webContents.fromFrame(frame);
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' ||
        guest.session !== targetSession || guest.mainFrame !== frame || frame.detached) return null;
    const url = new URL(frame.url);
    const rp = details.relyingPartyId;
    if (url.protocol !== 'https:' || url.username || url.password ||
        typeof rp !== 'string' || !rp ||
        (url.hostname !== rp && !url.hostname.endsWith(`.${rp}`))) return null;
    const host = guest.hostWebContents;
    const parent = host && BrowserWindow.fromWebContents(host);
    if (!parent || parent.isDestroyed() || !getMainWindows().includes(parent)) return null;
    return { frame, guest, parent, url: frame.url, origin: url.origin, rp };
  } catch { return null; }
}

function registerWebauthnPrompts({ app, session, webContents, BrowserWindow,
  MessageChannelMain, getMainWindows, getTheme = () => 'dark', timeoutMs = TIMEOUT_MS }) {
  const attached = new WeakSet();
  const active = new Map();

  function prompt(targetSession, details, callback, kind) {
    const context = requestContext(details, targetSession, webContents, BrowserWindow, getMainWindows);
    // This feature authenticates with an existing PIN. Setting or changing the
    // key's PIN is a separate device-management operation.
    if (!context || (kind === 'pin' && (details.reason !== 'challenge' ||
        !Number.isSafeInteger(details.attemptsRemaining) || details.attemptsRemaining <= 0))) {
      callback();
      return;
    }
    const { guest, frame, parent, origin, rp } = context;
    active.get(guest)?.();
    let win;
    let port;
    let timer;
    let ended = false;
    const cleanups = [];
    const listen = (emitter, event, handler) => {
      emitter.on(event, handler);
      cleanups.push(() => emitter.removeListener(event, handler));
    };
    const finish = (value) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      cleanups.forEach((cleanup) => cleanup());
      port?.close();
      if (active.get(guest) === cancel) active.delete(guest);
      if (win && !win.isDestroyed()) win.destroy();
      // Remove UI state before calling native code, which may synchronously
      // request a new PIN after rejecting this one.
      callback(value);
    };
    const cancel = () => finish();
    const stillCurrent = () => {
      const now = requestContext(details, targetSession, webContents, BrowserWindow, getMainWindows);
      return now && now.frame === frame && now.url === context.url;
    };
    active.set(guest, cancel);
    try {
      const accounts = kind === 'account' ? details.accounts : null;
      if (kind === 'account' && (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 100 ||
          accounts.some((a) => typeof a.credentialId !== 'string' || !a.credentialId ||
            a.credentialId.length > 4096))) { cancel(); return; }
      win = new BrowserWindow({
        parent, modal: true, show: false, width: 460, height: 490, resizable: false,
        title: 'Security key — Freedom', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'webauthn-prompt-preload.js'),
          partition: `webauthn-prompt-${randomUUID()}`, nodeIntegration: false,
          contextIsolation: true, sandbox: true, webviewTag: false, devTools: false },
      });
      win.setMenu(null);
      const channel = new MessageChannelMain();
      port = channel.port1;
      listen(port, 'message', ({ data }) => {
        if (!stillCurrent() || !data || typeof data !== 'object') { cancel(); return; }
        if (data.action === 'cancel') { cancel(); return; }
        if (kind === 'pin' && data.action === 'submit' && typeof data.value === 'string' &&
            data.value.length > 0 && Buffer.byteLength(data.value, 'utf8') <= 256) {
          finish(data.value); // Native Chromium validates the PIN; no retries here.
        } else if (kind === 'account' && data.action === 'submit' &&
            accounts.some((a) => a.credentialId === data.value)) {
          finish(data.value);
        } else { cancel(); }
      });
      listen(port, 'close', cancel);
      port.start();
      listen(win, 'closed', cancel);
      for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) listen(guest, event, cancel);
      listen(parent, 'closed', cancel);
      listen(win.webContents, 'render-process-gone', cancel);
      listen(win.webContents, 'will-navigate', (event) => { event.preventDefault(); cancel(); });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      listen(win.webContents, 'did-finish-load', () => {
        if (ended) return;
        if (!stillCurrent() || win.webContents.getURL() !== PAGE_URL) { cancel(); return; }
        const theme = getTheme();
        win.webContents.postMessage('webauthn:prompt', {
          kind, origin, rp, theme: theme === 'light' ? 'light' : 'dark',
          error: kind === 'pin' ? details.error : null,
          attemptsRemaining: kind === 'pin' ? details.attemptsRemaining : null,
          accounts: accounts?.map((a) => ({ id: a.credentialId,
            name: typeof a.name === 'string' ? a.name.slice(0, 256) : '',
            displayName: typeof a.displayName === 'string' ? a.displayName.slice(0, 256) : '' })),
        }, [channel.port2]);
        win.show();
      });
      timer = setTimeout(cancel, timeoutMs);
      Promise.resolve(win.loadFile(PAGE)).catch(cancel);
    } catch { cancel(); }
  }

  function attach(targetSession) {
    if (!targetSession || attached.has(targetSession)) return;
    attached.add(targetSession);
    targetSession.on('collect-webauthn-pin', (_event, details, callback) => prompt(targetSession, details, callback, 'pin'));
    targetSession.on('select-webauthn-account', (_event, details, callback) => prompt(targetSession, details, callback, 'account'));
  }
  app.on('session-created', attach);
  app.on('before-quit', () => { for (const cancel of [...active.values()]) cancel(); });
  attach(session.defaultSession);
  for (const contents of webContents.getAllWebContents()) attach(contents.session);
}

module.exports = { registerWebauthnPrompts, requestContext };
