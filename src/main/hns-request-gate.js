const { isHnsHost } = require('../shared/hns-hosts');
const { getService, MODE } = require('./service-registry');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');
const path = require('path');
const { pathToFileURL } = require('url');
const IPC = require('../shared/ipc-channels');

const pendingNavigations = new Map();
const syncingPageUrl = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'pages', 'hns-syncing.html')
).toString();

function isHnsServiceReady(service = getService('hns')) {
  return service?.mode === MODE.BUNDLED &&
    service.synced === true &&
    typeof service.api === 'string' &&
    service.api.length > 0;
}

function getNetworkHostname(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

function gateHnsRequest(details) {
  const hostname = getNetworkHostname(details?.url);
  if (!hostname || !isHnsHost(hostname)) return null;
  if (isHnsServiceReady()) return null;
  if (details.resourceType === 'mainFrame' && Number.isInteger(details.webContentsId)) {
    pendingNavigations.set(details.webContentsId, details.url);
    return { redirectURL: syncingPageUrl };
  }
  return { cancel: true };
}

function installHnsRequestGate() {
  registerWebRequestHandler('onBeforeRequest', 'hns-readiness-gate', gateHnsRequest);
}

function registerHnsRequestGateIpc(ipcMain) {
  ipcMain.handle(IPC.HNS_GET_PENDING_NAVIGATION, (event) => {
    const webContentsId = event.sender?.id;
    const url = pendingNavigations.get(webContentsId) || null;
    pendingNavigations.delete(webContentsId);
    return url;
  });
}

module.exports = {
  gateHnsRequest,
  getNetworkHostname,
  installHnsRequestGate,
  isHnsServiceReady,
  registerHnsRequestGateIpc,
  syncingPageUrl,
};
