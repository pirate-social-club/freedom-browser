const log = require('./logger');
const { app, session } = require('electron');
const http = require('http');
const net = require('net');
const { resolveHnsDohAddresses } = require('./hns-doh-resolver');
const { resolveHnsLocalAddresses } = require('./hns-local-resolver');
const {
  getHnsPublicSuffixes,
  isHnsHost,
  setDynamicHnsPublicSuffixes,
} = require('../shared/hns-hosts');

const PUBLIC_NAMESPACES_URL = process.env.PIRATE_PUBLIC_NAMESPACES_URL || 'https://api.pirate.sc/public-namespaces';

let hnsProxyAddr = null;
let hnsUpstreamProxyAddr = null;
let hnsRootResolverAddr = null;
let hnsGuardServer = null;
let hnsGuardPort = null;
let dvpnProxyHost = null;
let dvpnProxyPort = null;

let pacServer = null;
let pacPort = null;
let apiRequestDiagnosticsRegistered = false;
const apiRequestLogState = new Map();
const hnsProxyHosts = new Set();

const API_DIAGNOSTICS_REPEAT_WINDOW_MS = 30 * 1000;
const API_DIAGNOSTICS_URLS = [
  'https://api.pirate.sc/*',
  'https://api-staging.pirate.sc/*',
];
const HNS_PROXY_CONNECT_TIMEOUT_MS = 5000;

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

function formatImportedHnsSuffixesLog(suffixes = []) {
  const preview = suffixes.slice(0, 8).join(', ');
  const remainder = suffixes.length - Math.min(suffixes.length, 8);
  return remainder > 0
    ? `${suffixes.length} suffixes (${preview}, +${remainder} more)`
    : `${suffixes.length} suffixes${preview ? ` (${preview})` : ''}`;
}

function buildPacHnsRootMap() {
  const entries = getHnsPublicSuffixes()
    .map((suffix) => suffix.replace(/^\./, ''))
    .filter(Boolean)
    .map((tld) => `${JSON.stringify(tld)}:1`)
    .join(',');
  return `{${entries}}`;
}

function buildHnsHostPredicate() {
  return [
    'dnsDomainLevels(host) === 0',
    'hnsRoots[host.toLowerCase()] === 1',
    '(dnsDomainLevels(host) > 0 && hnsRoots[host.substring(host.lastIndexOf(".") + 1).toLowerCase()] === 1)',
    '(dnsDomainLevels(host) > 0 && !isResolvable(host))',
  ].join(' || ');
}

function parseAuthority(authority = '') {
  const value = String(authority || '').trim();
  if (!value) return { host: '', port: null };
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    const host = end === -1 ? value.slice(1) : value.slice(1, end);
    const rest = end === -1 ? '' : value.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null;
    return { host: host.toLowerCase(), port: Number.isFinite(port) ? port : null };
  }
  const [host, portValue] = value.split(':');
  const port = portValue ? Number(portValue) : null;
  return { host: host.toLowerCase(), port: Number.isFinite(port) ? port : null };
}

function parseHostFromAuthority(authority = '') {
  return parseAuthority(authority).host;
}

function isLoopbackHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized);
}

function isValidProxyHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized || isLoopbackHostname(normalized) || net.isIP(normalized)) return false;
  return normalized
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function parseProxyAddress(proxyAddr = '') {
  const [host, port] = String(proxyAddr).split(':');
  return {
    host,
    port: Number(port),
  };
}

function isAllowedHnsProxyTarget(authority = '') {
  return isValidProxyHostname(parseHostFromAuthority(authority));
}

function markHnsProxyHost(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (isValidProxyHostname(normalized)) {
    hnsProxyHosts.add(normalized);
  }
}

function isHnsProxyHost(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  return hnsProxyHosts.has(normalized) || isHnsHost(normalized);
}

async function resolveHnsFallbackTarget(authority = '', defaultPort = 443) {
  const parsed = parseAuthority(authority);
  if (!isValidProxyHostname(parsed.host)) return null;
  let result;
  let resolverType = 'doh';
  if (hnsRootResolverAddr) {
    try {
      result = await resolveHnsLocalAddresses(parsed.host, {
        rootAddr: hnsRootResolverAddr,
      });
      resolverType = 'local';
    } catch (error) {
      log.info(`[Network] Local HNS delegation lookup failed for ${parsed.host}: ${error.message}`);
    }
  }
  if (!result) {
    result = await resolveHnsDohAddresses(parsed.host);
  }
  const target = result.addresses.find((entry) => entry.family === 4) || result.addresses[0];
  if (!target?.address) return null;

  return {
    hostname: parsed.host,
    address: target.address,
    port: parsed.port || defaultPort,
    resolverType,
    resolver: result.endpoint,
  };
}

async function getHnsResolutionForHost(hostname = '') {
  try {
    return await resolveHnsFallbackTarget(hostname, 443);
  } catch {
    return null;
  }
}

async function canResolveHnsFallbackForHost(hostname = '') {
  return Boolean(await getHnsResolutionForHost(hostname));
}

function writeProxyError(socket, statusCode, reason) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function forwardConnectToDohFallback(req, clientSocket, head = Buffer.alloc(0), reason = 'unavailable') {
  let target;
  try {
    target = await resolveHnsFallbackTarget(req.url, 443);
  } catch (error) {
    log.warn(`[Network] HNS resolution failed for ${req.url}: ${error.message}`);
    writeProxyError(clientSocket, 502, 'HNS lookup failed');
    return;
  }

  if (!target) {
    writeProxyError(clientSocket, 502, 'HNS lookup failed');
    return;
  }

  const resolverLabel = target.resolverType === 'local' ? 'local delegation' : 'DoH last-resort';
  log.info(
    `[Network] HNS ${resolverLabel} CONNECT (${reason}): ${req.url} -> ${target.address}:${target.port}`
  );
  const upstreamSocket = net.connect(target.port, target.address, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n');
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => {
    writeProxyError(clientSocket, 502, 'HNS fallback upstream failed');
  });
  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
}

function formatFallbackHostHeader(target) {
  if ((target.port === 80) || (target.port === 443)) return target.hostname;
  return `${target.hostname}:${target.port}`;
}

async function forwardHttpToDohFallback(req, res, host, defaultPort, requestPath, reason = 'unavailable') {
  let target;
  try {
    target = await resolveHnsFallbackTarget(host, defaultPort);
  } catch (error) {
    log.warn(`[Network] HNS resolution failed for ${host}: ${error.message}`);
    res.writeHead(502);
    res.end('HNS lookup failed');
    return;
  }

  if (!target) {
    res.writeHead(502);
    res.end('HNS lookup failed');
    return;
  }

  const resolverLabel = target.resolverType === 'local' ? 'local delegation' : 'DoH last-resort';
  log.info(
    `[Network] HNS ${resolverLabel} request (${reason}): ${req.method} ${target.hostname} -> ${target.address}:${target.port}`
  );
  const proxyReq = http.request(
    {
      host: target.address,
      port: target.port,
      method: req.method,
      path: requestPath,
      headers: {
        ...req.headers,
        host: formatFallbackHostHeader(target),
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    res.writeHead(502);
    res.end('HNS fallback upstream failed');
  });
  req.pipe(proxyReq);
}

function forwardConnectToHnsProxy(req, clientSocket, head = Buffer.alloc(0)) {
  if (!isAllowedHnsProxyTarget(req.url)) {
    log.warn(`[Network] Blocked non-HNS proxy CONNECT: ${req.url}`);
    writeProxyError(clientSocket, 502, 'HNS host not allowed');
    return;
  }

  const targetHost = parseHostFromAuthority(req.url);
  markHnsProxyHost(targetHost);

  if (!hnsUpstreamProxyAddr) {
    forwardConnectToDohFallback(req, clientSocket, head, 'no local upstream');
    return;
  }

  const upstream = parseProxyAddress(hnsUpstreamProxyAddr);
  let settled = false;
  let buffered = Buffer.alloc(0);
  const finishWithFallback = (reason) => {
    if (settled) return;
    settled = true;
    upstreamSocket.destroy();
    forwardConnectToDohFallback(req, clientSocket, head, reason).catch((error) => {
      log.warn(`[Network] HNS resolution failed for ${req.url}: ${error.message}`);
      writeProxyError(clientSocket, 502, 'HNS lookup failed');
    });
  };

  const upstreamSocket = net.connect(upstream.port, upstream.host, () => {
    const headerLines = [`CONNECT ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(req.headers || {})) {
      headerLines.push(`${name}: ${value}`);
    }
    upstreamSocket.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
  });

  upstreamSocket.setTimeout(HNS_PROXY_CONNECT_TIMEOUT_MS, () => {
    finishWithFallback('local upstream timeout');
  });

  upstreamSocket.on('data', (chunk) => {
    if (settled) return;
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (buffered.length > 64 * 1024) {
        finishWithFallback('local upstream invalid response');
      }
      return;
    }

    const header = buffered.subarray(0, headerEnd).toString('latin1');
    const statusCode = Number((header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i) || [])[1]);
    if (statusCode >= 200 && statusCode < 300) {
      settled = true;
      upstreamSocket.setTimeout(0);
      clientSocket.write(buffered);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      return;
    }

    if (statusCode >= 500 || statusCode === 0 || Number.isNaN(statusCode)) {
      finishWithFallback(`local upstream ${Number.isNaN(statusCode) ? 'invalid response' : statusCode}`);
      return;
    }

    settled = true;
    clientSocket.write(buffered);
    clientSocket.destroy();
    upstreamSocket.destroy();
  });

  upstreamSocket.on('error', () => {
    finishWithFallback('local upstream error');
  });
  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
}

function isReplayableHttpProxyRequest(req) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
}

function forwardHttpToHnsProxy(req, res) {
  let host = req.headers.host || '';
  let requestPath = req.url || '/';
  let defaultPort = 80;
  try {
    const parsedUrl = new URL(req.url);
    host = parsedUrl.host || host;
    requestPath = `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`;
    defaultPort = parsedUrl.protocol === 'https:' ? 443 : 80;
  } catch {
    // Proxy requests may occasionally arrive as origin-form; fall back to Host.
  }

  if (!isAllowedHnsProxyTarget(host)) {
    log.warn(`[Network] Blocked non-HNS proxy request: ${req.method} ${host}`);
    res.writeHead(502);
    res.end('HNS host not allowed');
    return;
  }

  markHnsProxyHost(parseHostFromAuthority(host));

  if (!hnsUpstreamProxyAddr) {
    return forwardHttpToDohFallback(req, res, host, defaultPort, requestPath, 'no local upstream');
  }

  const upstream = parseProxyAddress(hnsUpstreamProxyAddr);
  const proxyReq = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
    headers: req.headers,
    },
    (proxyRes) => {
      if ((proxyRes.statusCode || 0) >= 500 && isReplayableHttpProxyRequest(req)) {
        proxyRes.resume();
        return forwardHttpToDohFallback(req, res, host, defaultPort, requestPath, `local upstream ${proxyRes.statusCode}`);
      }
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    if (isReplayableHttpProxyRequest(req)) {
      return forwardHttpToDohFallback(req, res, host, defaultPort, requestPath, 'local upstream error');
    }
    res.writeHead(502);
    res.end('HNS proxy upstream failed');
  });
  req.pipe(proxyReq);
}

function extractNamespaceSuffixes(payload) {
  const namespaces = Array.isArray(payload?.namespaces) ? payload.namespaces : [];
  return namespaces
    .map((entry) => entry?.root_label)
    .filter((value) => typeof value === 'string' && value.trim());
}

function buildPacScript() {
  const hnsHostPredicate = buildHnsHostPredicate();
  const hnsRootMap = buildPacHnsRootMap();
  const effectiveHnsProxyAddr = hnsProxyAddr || hnsUpstreamProxyAddr;
  const hnsLine = effectiveHnsProxyAddr
    ? `  if (${hnsHostPredicate}) {\n    return "PROXY ${effectiveHnsProxyAddr}";\n  }`
    : `  if (${hnsHostPredicate}) {\n    return "DIRECT";\n  }`;

  const dvpnLine = dvpnProxyHost && dvpnProxyPort
    ? `  return "SOCKS5 ${dvpnProxyHost}:${dvpnProxyPort}; SOCKS ${dvpnProxyHost}:${dvpnProxyPort}; DIRECT";`
    : `  return "DIRECT";`;

  return `var hnsRoots = ${hnsRootMap};

function FindProxyForURL(url, host) {
  if (shExpMatch(host, "127.0.0.*") || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
  if (/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(host) || host.indexOf(":") !== -1) {
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

async function startHnsGuardProxy() {
  if (hnsGuardServer && hnsGuardPort) {
    hnsProxyAddr = `127.0.0.1:${hnsGuardPort}`;
    return hnsProxyAddr;
  }

  if (!hnsUpstreamProxyAddr) return null;

  return new Promise((resolve, reject) => {
    const srv = http.createServer(forwardHttpToHnsProxy);
    srv.on('connect', forwardConnectToHnsProxy);
    srv.on('error', (err) => {
      hnsGuardServer = null;
      hnsGuardPort = null;
      hnsProxyAddr = null;
      reject(err);
    });
    srv.listen(0, '127.0.0.1', () => {
      hnsGuardServer = srv;
      hnsGuardPort = srv.address().port;
      hnsProxyAddr = `127.0.0.1:${hnsGuardPort}`;
      log.info(`[Network] HNS guard proxy listening at ${hnsProxyAddr}, upstream=${hnsUpstreamProxyAddr}`);
      resolve(hnsProxyAddr);
    });
  });
}

async function stopHnsGuardProxy() {
  if (!hnsGuardServer) {
    hnsGuardPort = null;
    hnsProxyAddr = null;
    return;
  }

  return new Promise((resolve) => {
    hnsGuardServer.close(() => {
      hnsGuardServer = null;
      hnsGuardPort = null;
      hnsProxyAddr = null;
      resolve();
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
  if (hnsUpstreamProxyAddr) {
    await startHnsGuardProxy();
  } else {
    await stopHnsGuardProxy();
  }
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
  hnsUpstreamProxyAddr = proxyAddr;
  hnsProxyAddr = null;
  log.info(`[Network] HNS proxy upstream set to ${proxyAddr}`);
}

function setHnsResolverAddrs({ rootAddr } = {}) {
  hnsRootResolverAddr = rootAddr || null;
}

function clearHnsProxy() {
  hnsUpstreamProxyAddr = null;
  hnsRootResolverAddr = null;
  hnsProxyAddr = null;
  hnsProxyHosts.clear();
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
  if (!hnsUpstreamProxyAddr && !dvpnProxyHost) {
    await stopHnsGuardProxy();
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
    log.info(`[Network] Imported HNS suffixes loaded: ${formatImportedHnsSuffixesLog(suffixes)}`);
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
  setHnsResolverAddrs,
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
  getHnsResolutionForHost,
  canResolveHnsFallbackForHost,
  isHnsProxyHost,
};
