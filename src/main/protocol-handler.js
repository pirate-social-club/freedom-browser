const path = require('path');
const internalPages = require('../shared/internal-pages.json');

const FREEDOM_PROTOCOL = 'freedom';
const FREEDOM_SCHEME = `${FREEDOM_PROTOCOL}:`;

function normalizeFreedomUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== FREEDOM_SCHEME) {
      return null;
    }

    const pageName = parsed.hostname.toLowerCase();
    if (!internalPages.routable || !internalPages.routable[pageName]) {
      return null;
    }

    return `freedom://${pageName}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function findFreedomUrl(argv = []) {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeFreedomUrl(argv[index]);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function focusWindow(win) {
  if (!win || win.isDestroyed?.()) {
    return;
  }
  if (win.isMinimized?.()) {
    win.restore?.();
  }
  win.show?.();
  win.focus?.();
}

function registerFreedomProtocolClient({ app, argv = process.argv, execPath = process.execPath, log = console } = {}) {
  if (!app || typeof app.setAsDefaultProtocolClient !== 'function') {
    return false;
  }

  try {
    if (app.isPackaged) {
      return app.setAsDefaultProtocolClient(FREEDOM_PROTOCOL);
    }

    const appPath = argv[1] ? path.resolve(argv[1]) : null;
    return appPath
      ? app.setAsDefaultProtocolClient(FREEDOM_PROTOCOL, execPath, [appPath])
      : app.setAsDefaultProtocolClient(FREEDOM_PROTOCOL);
  } catch (error) {
    log.warn?.('[protocol] failed to register freedom:// handler', error);
    return false;
  }
}

function createFreedomProtocolHandler({
  app,
  createMainWindow,
  getMainWindows,
  log = console,
} = {}) {
  const pendingUrls = [];

  const openUrl = (rawUrl) => {
    const normalized = normalizeFreedomUrl(rawUrl);
    if (!normalized) {
      return false;
    }

    if (typeof app?.isReady === 'function' && !app.isReady()) {
      pendingUrls.push(normalized);
      return true;
    }

    const windows = typeof getMainWindows === 'function'
      ? getMainWindows().filter((win) => !win.isDestroyed?.())
      : [];
    const target = windows[0];

    if (target) {
      focusWindow(target);
      target.webContents?.send?.('navigate-to-url', normalized);
      return true;
    }

    if (typeof createMainWindow === 'function') {
      createMainWindow(normalized);
      return true;
    }

    pendingUrls.push(normalized);
    return true;
  };

  const openFromArgv = (argv = []) => {
    const url = findFreedomUrl(argv);
    return url ? openUrl(url) : false;
  };

  const consumePendingUrl = () => pendingUrls.shift() ?? null;

  const flushPendingUrls = () => {
    while (pendingUrls.length > 0) {
      const next = pendingUrls.shift();
      if (!openUrl(next)) {
        log.warn?.('[protocol] failed to route queued freedom:// URL');
      }
    }
  };

  app?.on?.('open-url', (event, url) => {
    event?.preventDefault?.();
    openUrl(url);
  });

  app?.on?.('second-instance', (_event, argv) => {
    openFromArgv(argv);
  });

  return {
    consumePendingUrl,
    flushPendingUrls,
    openFromArgv,
    openUrl,
  };
}

module.exports = {
  FREEDOM_PROTOCOL,
  createFreedomProtocolHandler,
  findFreedomUrl,
  normalizeFreedomUrl,
  registerFreedomProtocolClient,
};
