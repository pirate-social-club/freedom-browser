const { isHnsHost } = require('../shared/hns-hosts');
const { getService, MODE } = require('./service-registry');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');

function isHnsServiceReady(service = getService('hns')) {
  return service?.mode === MODE.BUNDLED &&
    service.synced === true &&
    typeof service.api === 'string' &&
    service.api.length > 0;
}

function getHttpHostname(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

function gateHnsRequest(details) {
  const hostname = getHttpHostname(details?.url);
  if (!hostname || !isHnsHost(hostname)) return null;
  return isHnsServiceReady() ? null : { cancel: true };
}

function installHnsRequestGate() {
  registerWebRequestHandler('onBeforeRequest', 'hns-readiness-gate', gateHnsRequest);
}

module.exports = {
  gateHnsRequest,
  getHttpHostname,
  installHnsRequestGate,
  isHnsServiceReady,
};
