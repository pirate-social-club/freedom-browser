const log = require('./logger');
const { session } = require('electron');
const http = require('http');
const {
  getHnsPublicSuffixes,
  setDynamicHnsPublicSuffixes,
} = require('../shared/hns-hosts');

const PUBLIC_NAMESPACES_URL = process.env.PIRATE_PUBLIC_NAMESPACES_URL || 'https://api.pirate.sc/public-namespaces';

let hnsProxyAddr = null;
let anyoneProxyHost = null;
let anyoneProxyPort = null;
let dvpnProxyHost = null;
let dvpnProxyPort = null;

let pacServer = null;
let pacPort = null;

function buildHnsHostPredicate() {
  const suffixChecks = getHnsPublicSuffixes()
    .map((suffix) => `dnsDomainIs(host, "${suffix}")`)
    .join(' || ');
  return suffixChecks
    ? `dnsDomainLevels(host) === 0 || ${suffixChecks}`
    : 'dnsDomainLevels(host) === 0';
}

function extractNamespaceSuffixes(payload) {
  const namespaces = Array.isArray(payload?.namespaces) ? payload.namespaces : [];
  return namespaces
    .map((entry) => entry?.root_label)
    .filter((value) => typeof value === 'string' && value.trim());
}

function buildPacScript() {
  const hnsHostPredicate = buildHnsHostPredicate();
  const hnsLine = hnsProxyAddr
    ? `  if (${hnsHostPredicate}) {\n    return "PROXY ${hnsProxyAddr}";\n  }`
    : `  if (${hnsHostPredicate}) {\n    return "DIRECT";\n  }`;

  const transportChain = buildTransportChain();
  const transportLine = transportChain
    ? `  return "${transportChain}; DIRECT";`
    : `  return "DIRECT";`;

  return `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "127.0.0.*") || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
${hnsLine}
${transportLine}
}`;
}

function buildTransportChain() {
  const orderedProxies = [
    anyoneProxyHost && anyoneProxyPort ? `${anyoneProxyHost}:${anyoneProxyPort}` : null,
    dvpnProxyHost && dvpnProxyPort ? `${dvpnProxyHost}:${dvpnProxyPort}` : null,
  ].filter(Boolean);

  if (orderedProxies.length === 0) return null;

  return orderedProxies
    .flatMap((proxy) => [`SOCKS5 ${proxy}`, `SOCKS ${proxy}`])
    .join('; ');
}

async function startPacServer(pacContent) {
  if (pacServer) {
    pacServer.close();
    pacServer = null;
    pacPort = null;
  }

  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      res.end(pacContent);
    });

    srv.listen(0, '127.0.0.1', () => {
      pacServer = srv;
      pacPort = srv.address().port;
      resolve(pacPort);
    });

    srv.on('error', (err) => {
      pacServer = null;
      pacPort = null;
      reject(err);
    });
  });
}

async function stopPacServer() {
  if (!pacServer) return;
  return new Promise((resolve) => {
    pacServer.close(() => {
      pacServer = null;
      pacPort = null;
      resolve();
    });
  });
}

async function applyProxy() {
  const pac = buildPacScript();
  const port = await startPacServer(pac);
  const pacUrl = `http://127.0.0.1:${port}/proxy.pac`;
  await session.defaultSession.setProxy({ pacScript: pacUrl });
  log.info(`[Network] Proxy configured via PAC at ${pacUrl}`);
}

async function clearProxy() {
  await stopPacServer();
  await session.defaultSession.setProxy({ proxyRules: '' });
  log.info('[Network] Proxy configuration cleared');
}

function setHnsProxy(proxyAddr) {
  hnsProxyAddr = proxyAddr;
  log.info(`[Network] HNS proxy set to ${proxyAddr}`);
}

function clearHnsProxy() {
  hnsProxyAddr = null;
  log.info('[Network] HNS proxy cleared');
}

function setAnyoneProxy(host, port) {
  anyoneProxyHost = host;
  anyoneProxyPort = port;
  log.info(`[Network] Anyone proxy set to ${host}:${port}`);
}

function clearAnyoneProxy() {
  anyoneProxyHost = null;
  anyoneProxyPort = null;
  log.info('[Network] Anyone proxy cleared');
}

function setDvpnProxy(host, port) {
  dvpnProxyHost = host;
  dvpnProxyPort = port;
  log.info(`[Network] dVPN proxy set to ${host}:${port}`);
}

function clearDvpnProxy() {
  dvpnProxyHost = null;
  dvpnProxyPort = null;
  log.info('[Network] dVPN proxy cleared');
}

async function rebuild() {
  if (!hnsProxyAddr && !anyoneProxyHost && !dvpnProxyHost) {
    await clearProxy();
    return;
  }
  await applyProxy();
}

async function refreshImportedHnsSuffixes(fetchImpl = fetch, url = PUBLIC_NAMESPACES_URL) {
  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`public namespace fetch failed with ${response.status}`);
    }
    const suffixes = setDynamicHnsPublicSuffixes(extractNamespaceSuffixes(await response.json()));
    log.info(`[Network] Imported HNS suffixes loaded: ${suffixes.join(', ')}`);
    if (hnsProxyAddr || anyoneProxyHost || dvpnProxyHost) {
      await rebuild();
    }
    return suffixes;
  } catch (err) {
    log.warn(`[Network] Imported HNS suffix refresh failed: ${err.message}`);
    return getHnsPublicSuffixes();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function getHnsProxyAddr() {
  return hnsProxyAddr;
}

function getDvpnProxy() {
  if (!dvpnProxyHost || !dvpnProxyPort) return null;
  return { host: dvpnProxyHost, port: dvpnProxyPort };
}

function getAnyoneProxy() {
  if (!anyoneProxyHost || !anyoneProxyPort) return null;
  return { host: anyoneProxyHost, port: anyoneProxyPort };
}

module.exports = {
  setHnsProxy,
  clearHnsProxy,
  setAnyoneProxy,
  clearAnyoneProxy,
  setDvpnProxy,
  clearDvpnProxy,
  rebuild,
  clearProxy,
  getHnsProxyAddr,
  getAnyoneProxy,
  getDvpnProxy,
  buildPacScript,
  refreshImportedHnsSuffixes,
};
