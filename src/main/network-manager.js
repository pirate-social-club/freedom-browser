const log = require('./logger');
const { app, session } = require('electron');
const http = require('http');
const {
  getHnsPublicSuffixes,
  setDynamicHnsPublicSuffixes,
} = require('../shared/hns-hosts');

const PUBLIC_NAMESPACES_URL = process.env.PIRATE_PUBLIC_NAMESPACES_URL || 'https://api.pirate.sc/public-namespaces';

let hnsProxyAddr = null;
let dvpnProxyHost = null;
let dvpnProxyPort = null;

let pacServer = null;
let pacPort = null;
let apiRequestDiagnosticsRegistered = false;
const apiRequestLogState = new Map();

const API_DIAGNOSTICS_REPEAT_WINDOW_MS = 30 * 1000;
const API_DIAGNOSTICS_URLS = [
  'https://api.pirate.sc/*',
  'https://api-staging.pirate.sc/*',
];

function isApiDiagnosticsEnabled() {
  return !app?.isPackaged || process.env.FREEDOM_API_DIAGNOSTICS === '1';
}

function sanitizeApiRequestUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return 'unknown';
  try {
    const parsed = new URL(rawUrl);
    for (const [key] of parsed.searchParams) {
      if (/(auth|code|secret|session|state|token)/i.test(key)) {
        parsed.searchParams.set(key, '<redacted>');
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return 'unknown';
  }
}

function logRateLimitedApiFailure(message) {
  const now = Date.now();
  const previous = apiRequestLogState.get(message);

  if (previous && now - previous.lastLoggedAt < API_DIAGNOSTICS_REPEAT_WINDOW_MS) {
    previous.suppressed += 1;
    return;
  }

  if (previous?.suppressed > 0) {
    log.warn(`[Network] API request diagnostics suppressed ${previous.suppressed} repeat(s): ${message}`);
  }

  log.warn(message);
  apiRequestLogState.set(message, {
    lastLoggedAt: now,
    suppressed: 0,
  });
}

function registerApiRequestDiagnostics(targetSession = session.defaultSession) {
  if (apiRequestDiagnosticsRegistered || !isApiDiagnosticsEnabled()) return;
  const webRequest = targetSession?.webRequest;
  if (!webRequest?.onCompleted || !webRequest?.onErrorOccurred) return;

  apiRequestDiagnosticsRegistered = true;
  const filter = { urls: API_DIAGNOSTICS_URLS };

  webRequest.onCompleted(filter, (details) => {
    if (!details || details.statusCode < 400) return;
    const url = sanitizeApiRequestUrl(details.url);
    const method = details.method || 'GET';
    logRateLimitedApiFailure(`[Network] API request failed: ${method} ${url} status=${details.statusCode}`);
  });

  webRequest.onErrorOccurred(filter, (details) => {
    if (!details) return;
    const url = sanitizeApiRequestUrl(details.url);
    const method = details.method || 'GET';
    const error = details.error || 'unknown';
    logRateLimitedApiFailure(`[Network] API request error: ${method} ${url} ${error}`);
  });
}

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

  const dvpnLine = dvpnProxyHost && dvpnProxyPort
    ? `  return "SOCKS5 ${dvpnProxyHost}:${dvpnProxyPort}; SOCKS ${dvpnProxyHost}:${dvpnProxyPort}; DIRECT";`
    : `  return "DIRECT";`;

  return `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "127.0.0.*") || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
${hnsLine}
${dvpnLine}
}`;
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
  if (!hnsProxyAddr && !dvpnProxyHost) {
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
    if (hnsProxyAddr || dvpnProxyHost) {
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

module.exports = {
  setHnsProxy,
  clearHnsProxy,
  setDvpnProxy,
  clearDvpnProxy,
  rebuild,
  clearProxy,
  getHnsProxyAddr,
  getDvpnProxy,
  buildPacScript,
  refreshImportedHnsSuffixes,
  registerApiRequestDiagnostics,
  sanitizeApiRequestUrl,
};
