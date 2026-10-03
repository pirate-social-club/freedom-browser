const log = require('./logger');
const { app, session } = require('electron');
const http = require('http');
const net = require('net');
const { createSessionProxyController } = require('./session-proxy-controller');
const { registerWebRequestHandler, attachWebRequestDispatcher } = require('./webrequest-dispatcher');
const { createSessionRoutingCoordinator } = require('./session-routing-coordinator');
const { createHnsGuardResources } = require('./hns-guard-resources');
const { createHnsGuardForwarding } = require('./hns-guard-forwarding');
const { runRoutingOperation } = require('./session-routing-operation');
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
let hnsTrustIdentity = null;
let hnsTrustRevision = 0;
let hnsRootResolverAddr = null;
let hnsGuardServer = null;
let hnsGuardPort = null;
let dvpnProxyHost = null;
let dvpnProxyPort = null;

let pacServer = null;
let pacPort = null;
let currentPacContent = null;
let guardAllowed = false;
let guardRoute = null;
const guardResources = createHnsGuardResources();
const proxySessions = createSessionProxyController(() => session.defaultSession);
let apiRequestDiagnosticsRegistered = false;
const apiRequestLogState = new Map();
const hnsProxyHosts = new Set();

const API_DIAGNOSTICS_REPEAT_WINDOW_MS = 30 * 1000;
const API_DIAGNOSTICS_HOSTS = new Set(['api.pirate.sc', 'api-staging.pirate.sc']);
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

function isApiDiagnosticsUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && API_DIAGNOSTICS_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function registerApiRequestDiagnostics(targetSession = session.defaultSession) {
  if (apiRequestDiagnosticsRegistered || !isApiDiagnosticsEnabled()) return;
  const webRequest = targetSession?.webRequest;
  if (typeof webRequest?.onCompleted !== 'function' || typeof webRequest?.onErrorOccurred !== 'function') return;

  registerWebRequestHandler('onCompleted', 'api-diagnostics-completed', (details) => {
    if (!details || !isApiDiagnosticsUrl(details.url) || details.statusCode < 400) return;
    const url = sanitizeApiRequestUrl(details.url);
    const method = details.method || 'GET';
    logRateLimitedApiFailure(`[Network] API request failed: ${method} ${url} status=${details.statusCode}`);
  }, { session: targetSession });

  registerWebRequestHandler('onErrorOccurred', 'api-diagnostics-error', (details) => {
    if (!details || !isApiDiagnosticsUrl(details.url)) return;
    const url = sanitizeApiRequestUrl(details.url);
    const method = details.method || 'GET';
    const error = details.error || 'unknown';
    logRateLimitedApiFailure(`[Network] API request error: ${method} ${url} ${error}`);
  }, { session: targetSession });
  apiRequestDiagnosticsRegistered = true;
}

function formatImportedHnsSuffixesLog(suffixes = []) {
  const preview = suffixes.slice(0, 8).join(', ');
  const remainder = suffixes.length - Math.min(suffixes.length, 8);
  return remainder > 0
    ? `${suffixes.length} suffixes (${preview}, +${remainder} more)`
    : `${suffixes.length} suffixes${preview ? ` (${preview})` : ''}`;
}

function buildPacHnsRootMap(suffixes = getHnsPublicSuffixes()) {
  const entries = suffixes
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

// The guard proxy's last-resort path resolves an HNS name and then connects
// directly to the returned address, bypassing fingertipd. Nothing on that path
// validates DNSSEC or DANE, and the browser-side certificate check cannot
// compensate: it only sees a hostname, not how the address was obtained.
//
// Until validation lands (validate DS -> DNSKEY -> RRSIG from the local HNS
// root trust anchor, then the A/AAAA and TLSA RRsets, and permit only a
// usage-3/selector-1 TLSA SPKI match bound to this hostname and port, all
// BEFORE returning "200 Connection Established"), this path must refuse rather
// than tunnel. That costs fallback browsing on port-53-blocked networks and
// keeps arbitrary certificates from being accepted silently.
const HNS_UNVALIDATED_FALLBACK_ENABLED = false;
const HNS_UNVALIDATED_FALLBACK_MESSAGE =
  'HNS fallback disabled: this path cannot yet prove the DNSSEC/DANE chain for the name';

async function forwardConnectToDohFallback(req, clientSocket, head = Buffer.alloc(0), reason = 'unavailable') {
  if (!HNS_UNVALIDATED_FALLBACK_ENABLED) {
    log.warn(`[Network] refusing unvalidated HNS CONNECT (${reason}): ${req.url}`);
    writeProxyError(clientSocket, 502, HNS_UNVALIDATED_FALLBACK_MESSAGE);
    return;
  }

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
  if (!HNS_UNVALIDATED_FALLBACK_ENABLED) {
    log.warn(`[Network] refusing unvalidated HNS request (${reason}): ${host}`);
    res.writeHead(502);
    res.end(HNS_UNVALIDATED_FALLBACK_MESSAGE);
    return;
  }

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

const guardForwarding = createHnsGuardForwarding({
  net, http, resources: guardResources,
  getRoute: () => guardAllowed ? guardRoute : null,
  isAllowed: isAllowedHnsProxyTarget, markHost: markHnsProxyHost,
  parseAuthority, writeError: writeProxyError,
  fallbackConnect: forwardConnectToDohFallback, fallbackHttp: forwardHttpToDohFallback,
  log, timeoutMs: HNS_PROXY_CONNECT_TIMEOUT_MS,
});

function extractNamespaceSuffixes(payload) {
  const namespaces = Array.isArray(payload?.namespaces) ? payload.namespaces : [];
  return namespaces
    .map((entry) => entry?.root_label)
    .filter((value) => typeof value === 'string' && value.trim());
}

function buildPacScript(intent = getRoutingIntent()) {
  const hnsHostPredicate = buildHnsHostPredicate();
  const hnsRootMap = buildPacHnsRootMap(intent.suffixes);
  const effectiveHnsProxyAddr = intent.hnsUpstream ? (hnsProxyAddr || intent.hnsUpstream) : null;
  const hnsLine = effectiveHnsProxyAddr
    ? `  if (${hnsHostPredicate}) {\n    return "PROXY ${effectiveHnsProxyAddr}";\n  }`
    : `  if (${hnsHostPredicate}) {\n    return "DIRECT";\n  }`;

  const dvpnLine = intent.dvpnHost && intent.dvpnPort
    ? `  return "SOCKS5 ${intent.dvpnHost}:${intent.dvpnPort}; SOCKS ${intent.dvpnHost}:${intent.dvpnPort}; DIRECT";`
    : `  return "DIRECT";`;

  return `var hnsRoots = ${hnsRootMap};

function FindProxyForURL(url, host) {
  function parseIPv4(value) {
    var match = /^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/.exec(value);
    if (!match) return null;
    var octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    for (var index = 0; index < octets.length; index += 1) {
      if (octets[index] > 255) return null;
    }
    return octets;
  }

  function normalizeIPv6(value) {
    var normalized = String(value || "").toLowerCase();
    if (normalized.charAt(0) === "[" && normalized.charAt(normalized.length - 1) === "]") {
      normalized = normalized.slice(1, -1);
    }
    return normalized;
  }

  function isIPv6Literal(value) {
    var normalized = normalizeIPv6(value);
    if (normalized.indexOf(":") === -1 || !/^[0-9a-f:.]+$/.test(normalized)) return false;
    if ((normalized.match(/::/g) || []).length > 1) return false;

    var parts = normalized.split(":");
    var hasCompression = normalized.indexOf("::") !== -1;
    var units = 0;
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index];
      if (!part) continue;
      if (part.indexOf(".") !== -1) {
        if (index !== parts.length - 1 || !parseIPv4(part)) return false;
        units += 2;
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return false;
        units += 1;
      }
    }
    return hasCompression ? units < 8 : units === 8;
  }

  function isDirectIPv4(octets) {
    return octets[0] === 127 ||
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254);
  }

  function isDirectIPv6(value) {
    var normalized = normalizeIPv6(value);
    if (normalized === "::1") return true;
    if (normalized.indexOf("::ffff:") === 0) {
      var mappedIPv4 = parseIPv4(normalized.slice(7));
      return mappedIPv4 ? isDirectIPv4(mappedIPv4) : false;
    }
    var firstPart = normalized.split(":")[0];
    if (!firstPart) return false;
    var firstUnit = parseInt(firstPart, 16);
    return (firstUnit >= 0xfc00 && firstUnit <= 0xfdff) ||
      (firstUnit >= 0xfe80 && firstUnit <= 0xfebf);
  }

  var ipv4 = parseIPv4(host);
  var ipv6 = isIPv6Literal(host);
  if (host.toLowerCase() === "localhost") {
    return "DIRECT";
  }
  if (ipv4 || ipv6) {
    if ((ipv4 && isDirectIPv4(ipv4)) || (ipv6 && isDirectIPv6(host))) {
      return "DIRECT";
    }
${dvpnLine}
  }
${hnsLine}
${dvpnLine}
}`;
}

async function startPacServer(pacContent) {
  currentPacContent = pacContent;
  // Keep the URL valid for every enrolled session throughout a policy update.
  if (pacServer) return pacPort;

  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      res.end(currentPacContent);
    });

    srv.listen(0, '127.0.0.1', () => {
      pacServer = srv;
      pacPort = srv.address().port;
      resolve(pacPort);
    });

    srv.on('error', (err) => {
      if (pacServer === srv) {
        pacServer = null;
        pacPort = null;
        guardAllowed = false;
        proxySessions.terminate('pac_resource_failed');
      }
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
    const srv = http.createServer(guardForwarding.request);
    srv.on('connect', guardForwarding.connect);
    srv.on('connection', (socket) => {
      socket.on('error', () => {});
      guardResources.track(socket);
    });
    srv.on('error', (err) => {
      if (hnsGuardServer === srv) {
        hnsGuardServer = null;
        hnsGuardPort = null;
        hnsProxyAddr = null;
        guardAllowed = false;
        proxySessions.terminate('guard_resource_failed');
      }
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

  const retiring = hnsGuardServer;
  const closing = new Promise((resolve, reject) => {
    retiring.close((error) => {
      if (error) { reject(error); return; }
      if (hnsGuardServer === retiring) {
        hnsGuardServer = null;
        hnsGuardPort = null;
        hnsProxyAddr = null;
      }
      resolve();
    });
  });
  await Promise.all([closing, drainGuardResources()]);
}

async function stopPacServer() {
  if (!pacServer) return;
  const retiring = pacServer;
  return new Promise((resolve, reject) => {
    retiring.close((error) => {
      if (error) { reject(error); return; }
      if (pacServer === retiring) {
        pacServer = null;
        pacPort = null;
        currentPacContent = null;
      }
      resolve();
    });
  });
}

function getRoutingIntent() {
  return { hnsUpstream: hnsUpstreamProxyAddr, rootResolver: hnsRootResolverAddr,
    trustIdentity: hnsUpstreamProxyAddr ? hnsTrustIdentity : null,
    dvpnHost: dvpnProxyHost, dvpnPort: dvpnProxyPort,
    suffixes: [...getHnsPublicSuffixes()].sort() };
}

async function prepareProxyPolicy(intent) {
  // Existing Node operations cannot inherit a different helper or trust key.
  // Electron requests were withdrawn before this shared preparation began.
  await drainGuardResources();
  guardRoute = intent.hnsUpstream ? parseProxyAddress(intent.hnsUpstream) : null;
  if (!intent.hnsUpstream && !intent.dvpnHost) {
    return { configuration: { mode: 'direct' }, key: 'direct', guardNeeded: false };
  }
  if (intent.hnsUpstream) await startHnsGuardProxy();
  const pac = buildPacScript(intent);
  const port = await startPacServer(pac);
  const configuration = { mode: 'pac_script', pacScript: `http://127.0.0.1:${port}/proxy.pac` };
  return { configuration, key: JSON.stringify([configuration, pac, intent]),
    content: pac, pacServer, guardServer: intent.hnsUpstream ? hnsGuardServer : null,
    guardNeeded: Boolean(intent.hnsUpstream) };
}

const routing = createSessionRoutingCoordinator(proxySessions, {
  getIntent: getRoutingIntent,
  withdraw: () => { guardAllowed = false; guardResources.withdraw(); },
  prepare: prepareProxyPolicy,
  isValid: (policy) => policy.configuration.mode === 'direct' ||
    (pacServer === policy.pacServer && Boolean(pacServer && pacPort) && currentPacContent === policy.content &&
      (!policy.guardNeeded || (hnsGuardServer === policy.guardServer && Boolean(hnsGuardServer && hnsGuardPort)))),
  isInitialDirect: (intent) => !intent.hnsUpstream && !intent.dvpnHost && !pacServer && !hnsGuardServer,
  retire: async (policy) => {
    if (!policy.guardNeeded) await stopHnsGuardProxy();
    if (policy.configuration.mode === 'direct') await stopPacServer();
  },
  publish: (policy) => {
    guardAllowed = policy.guardNeeded;
    if (guardAllowed) guardResources.publish();
  },
  attach: (targetSession, getRequestPolicy) => attachWebRequestDispatcher(targetSession, { getRequestPolicy }),
});

function drainGuardResources() {
  return runRoutingOperation(() => guardResources.drain(), 'guard_drain', 15000);
}

function initializeSessionRouting(onFatal) {
  proxySessions.setFatalHandler(onFatal);
  const getRequestPolicy = proxySessions.adoptDefault();
  attachWebRequestDispatcher(session.defaultSession, { getRequestPolicy });
}

function clearProxy() {
  clearHnsProxy();
  clearDvpnProxy();
  return routing.rebuild();
}

function setHnsProxy(proxyAddr, trustIdentity = null) {
  hnsUpstreamProxyAddr = proxyAddr;
  // A new CA or helper can invalidate live TLS even when addresses are reused.
  // Legacy callers without identity require a fresh application on every set.
  hnsTrustIdentity = Number.isSafeInteger(trustIdentity?.generation) && trustIdentity.generation >= 0 &&
    typeof trustIdentity?.caFingerprint === 'string' && trustIdentity.caFingerprint.length > 0
    ? { generation: trustIdentity.generation, caFingerprint: trustIdentity.caFingerprint }
    : { revision: ++hnsTrustRevision };
  hnsProxyAddr = hnsGuardServer && hnsGuardPort ? `127.0.0.1:${hnsGuardPort}` : null;
  routing.intentChanged();
  log.info(`[Network] HNS proxy upstream set to ${proxyAddr}`);
}

function setHnsResolverAddrs({ rootAddr } = {}) {
  hnsRootResolverAddr = rootAddr || null;
  routing.intentChanged();
}

function clearHnsProxy() {
  hnsUpstreamProxyAddr = null;
  hnsTrustIdentity = null;
  hnsRootResolverAddr = null;
  hnsProxyAddr = null;
  hnsProxyHosts.clear();
  routing.intentChanged();
  log.info('[Network] HNS proxy cleared');
}

function setDvpnProxy(host, port) {
  dvpnProxyHost = host;
  dvpnProxyPort = port;
  routing.intentChanged();
  log.info(`[Network] dVPN proxy set to ${host}:${port}`);
}

function clearDvpnProxy() {
  dvpnProxyHost = null;
  dvpnProxyPort = null;
  routing.intentChanged();
  log.info('[Network] dVPN proxy cleared');
}

function rebuild() {
  return routing.rebuild();
}

function registerProxySession(targetSession) {
  return routing.enroll(targetSession);
}

function unregisterProxySession(targetSession) {
  proxySessions.unregister(targetSession);
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
    const changed = routing.intentChanged();
    log.info(`[Network] Imported HNS suffixes loaded: ${formatImportedHnsSuffixesLog(suffixes)}`);
    if (changed || hnsUpstreamProxyAddr || dvpnProxyHost) {
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
  initializeSessionRouting,
  getProxySessionPolicy: proxySessions.policyFor,
  setProxySessionPolicyObserver: proxySessions.setPolicyObserver,
  setHnsProxy,
  setHnsResolverAddrs,
  clearHnsProxy,
  setDvpnProxy,
  clearDvpnProxy,
  rebuild,
  clearProxy,
  registerProxySession,
  unregisterProxySession,
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
