const path = require('path');
const { pathToFileURL } = require('url');
const IPC = require('../shared/ipc-channels');

const indexUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const states = new Set(['initial', 'ready', 'enrolling', 'updating', 'configured', 'quarantined', 'retired', 'unknown']);

function isBrowserDocument(value, privatePartition) {
  try {
    const url = new URL(value);
    const partitions = url.searchParams.getAll('privatePartition');
    if (url.hash || [...url.searchParams.keys()].some((key) =>
      key !== 'initialUrl' && key !== 'privatePartition') ||
      url.searchParams.getAll('initialUrl').length > 1 || partitions.length > 1) return false;
    if (privatePartition ? partitions[0] !== privatePartition : partitions.length !== 0) return false;
    url.search = '';
    return url.href === indexUrl;
  } catch { return false; }
}

// Read-only feedback. Permission remains entirely with the controller/guard.
function registerSessionRoutingFeedback({ app, ipcMain, webContents, dialog,
  getMainWindows, getPolicy, getDefaultSession, setPolicyObserver,
  getPartitionForWebContents = () => null }) {
  const ready = new WeakSet();
  const unresponsive = new WeakSet();
  let revision = 0;
  let scheduled = false;
  let fallbackShown = false;

  function liveHost(host) {
    return host && !host.isDestroyed() && getMainWindows().some((win) =>
      !win.isDestroyed() && win.webContents === host);
  }
  function trustedHost(host) {
    try {
      return liveHost(host) && isBrowserDocument(host.mainFrame?.url, getPartitionForWebContents(host));
    } catch { return false; }
  }
  function status(targetSession) {
    try {
      const value = getPolicy(targetSession);
      if (states.has(value.state) && Number.isSafeInteger(value.generation) && value.generation >= 0) {
        return { state: value.state, generation: value.generation, allowed: value.allowed === true };
      }
    } catch { /* Observation errors display a refusal, never recovery. */ }
    return { state: 'unknown', generation: 0, allowed: false };
  }
  function snapshot(host) {
    if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Routing feedback revision exhausted');
    return { revision: ++revision, ui: status(host.session), guests: webContents.getAllWebContents()
      .filter((guest) => !guest.isDestroyed() && guest.getType() === 'webview' && guest.hostWebContents === host)
      .map((guest) => ({ id: guest.id, ...status(guest.session) })) };
  }
  function quarantined(value) {
    return value.state === 'quarantined' || value.state === 'retired';
  }
  function publish() {
    scheduled = false;
    try {
      const hosts = getMainWindows().filter((win) => !win.isDestroyed()).map((win) => win.webContents);
      let needsFallback = hosts.length === 0 && quarantined(status(getDefaultSession()));
      for (const host of hosts) {
        if (!liveHost(host)) continue;
        const value = snapshot(host);
        const blocked = quarantined(value.ui) || value.guests.some(quarantined);
        if (trustedHost(host) && ready.has(host) && !unresponsive.has(host)) {
          try { host.send(IPC.ROUTING_STATUS_UPDATE, value); } catch { ready.delete(host); }
        }
        if (blocked && (!trustedHost(host) || !ready.has(host) || unresponsive.has(host))) needsFallback = true;
      }
      if (!needsFallback) { fallbackShown = false; return; }
      if (fallbackShown) return;
      fallbackShown = true;
      Promise.resolve(dialog.showMessageBox({
        type: 'warning', title: 'Browsing paused',
        message: 'Browsing is paused to protect your traffic.',
        detail: 'Freedom could not apply its network protection settings. Requests remain blocked. Restart Freedom to try again.',
        buttons: ['OK'], noLink: true,
      })).catch(() => {});
    } catch { /* Feedback cannot interrupt routing or trigger a retry. */ }
  }
  function schedule() {
    if (!scheduled) { scheduled = true; queueMicrotask(publish); }
  }

  ipcMain.handle(IPC.ROUTING_STATUS_GET, (event) => {
    if (!trustedHost(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Routing status requires the browser UI main frame');
    }
    const value = snapshot(event.sender);
    ready.add(event.sender);
    unresponsive.delete(event.sender);
    return value;
  });
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    for (const event of ['did-start-loading', 'render-process-gone', 'destroyed']) {
      contents.on(event, () => { ready.delete(contents); schedule(); });
    }
    contents.on('unresponsive', () => { unresponsive.add(contents); schedule(); });
    contents.on('responsive', () => { unresponsive.delete(contents); schedule(); });
    contents.on('did-attach-webview', schedule);
    contents.on('did-finish-load', schedule);
  });
  setPolicyObserver(schedule);
  return { schedule };
}

module.exports = { registerSessionRoutingFeedback };
