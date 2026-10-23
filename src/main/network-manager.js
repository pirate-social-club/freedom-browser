const log = require('./logger');
const { app, session } = require('electron');
const http = require('http');
const net = require('net');
const { normalizeSocksEndpoint } = require('../shared/socks-endpoint');
const { createSessionProxyController } = require('./session-proxy-controller');
const { registerWebRequestHandler, attachWebRequestDispatcher } = require('./webrequest-dispatcher');
const { createSessionRoutingCoordinator } = require('./session-routing-coordinator');
const { createHnsGuardResources } = require('./hns-guard-resources');
const { createHnsGuardForwarding, HNS_PROXY_CONNECT_TIMEOUT_MS } = require('./hns-guard-forwarding');
const { runRoutingOperation } = require('./session-routing-operation');
const { resolveHnsDohAddresses } = require('./hns-doh-resolver');
const { resolveHnsLocalAddresses } = require('./hns-local-resolver');
const { getActiveProfile } = require('./profile-resolver');
const {
  getHnsPublicSuffixes,
  isHnsHost,
  isReservedHnsRoot,
  isValidHostnameLabel,
  setDynamicHnsPublicSuffixes,
} = require('../shared/hns-hosts');

// Namespace discovery reads the roots whose zones Pirate currently serves
// (api-next ListHnsNamespaces), so names under them go to the Handshake
// resolver without a system-DNS probe first. The list decides routing only:
// DNSSEC, DANE and certificates stay with native HNS verification.
const HNS_DISCOVERY_ORIGIN = 'https://api-next.pirate.sc';
const HNS_DISCOVERY_STAGING_ORIGIN = 'https://api-next-staging.pirate.sc';
const HNS_DISCOVERY_PATH = '/public/hns/namespaces/v1';
// A scratch test profile (FREEDOM_TEST_USER_DATA) has no catalog metadata.
// FREEDOM_TEST_HNS_DISCOVERY_ORIGIN gives that profile, and only that profile,
// the staging list instead, so installed acceptance can drive the staging
// roots (test-e2e/packaged-live/hns-browsing.spec.js). Any other value, and
// the variable on a catalog profile, leaves the production list.
const TEST_HNS_DISCOVERY_ORIGIN_VAR = 'FREEDOM_TEST_HNS_DISCOVERY_ORIGIN';
const HNS_DISCOVERY_DEADLINE_MS = 3000;
const HNS_DISCOVERY_MAX_BYTES = 64 * 1024;
// api-next's HnsNamespaceInstantV1: one database instant, in milliseconds.
const HNS_DISCOVERY_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function getHnsDiscoveryUrl(profile = getActiveProfile(), env = process.env) {
  const origin = profile?.source === 'test-user-data' && env[TEST_HNS_DISCOVERY_ORIGIN_VAR] === HNS_DISCOVERY_STAGING_ORIGIN
    ? HNS_DISCOVERY_STAGING_ORIGIN
    : HNS_DISCOVERY_ORIGIN;
  return `${origin}${HNS_DISCOVERY_PATH}`;
}

let hnsProxyAddr = null;
let hnsUpstreamProxyAddr = null;
let hnsTrustIdentity = null;
let hnsCertificateUpdating = false;
let hnsRequired = false;
let hnsAuthorityCheck = () => false;
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
    } catch {
      log.info('[Network] Local HNS delegation lookup failed');
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
    log.warn(`[Network] Refusing unvalidated HNS CONNECT (${reason})`);
    writeProxyError(clientSocket, 502, HNS_UNVALIDATED_FALLBACK_MESSAGE);
    return;
  }

  let target;
  try {
    target = await resolveHnsFallbackTarget(req.url, 443);
  } catch {
    log.warn('[Network] HNS resolution failed');
    writeProxyError(clientSocket, 502, 'HNS lookup failed');
    return;
  }

  if (!target) {
    writeProxyError(clientSocket, 502, 'HNS lookup failed');
    return;
  }

  const resolverLabel = target.resolverType === 'local' ? 'local delegation' : 'DoH last-resort';
  log.info(
    `[Network] HNS ${resolverLabel} CONNECT (${reason})`
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
    log.warn(`[Network] Refusing unvalidated HNS request (${reason})`);
    res.writeHead(502);
    res.end(HNS_UNVALIDATED_FALLBACK_MESSAGE);
    return;
  }

  let target;
  try {
    target = await resolveHnsFallbackTarget(host, defaultPort);
  } catch {
    log.warn('[Network] HNS resolution failed');
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
    `[Network] HNS ${resolverLabel} request (${reason})`
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
  getRoute: () => {
    if (!guardAllowed || !guardRoute) return null;
    try { return hnsAuthorityCheck() ? guardRoute : null; } catch { return null; }
  },
  isAllowed: isAllowedHnsProxyTarget, markHost: markHnsProxyHost,
  parseAuthority, writeError: writeProxyError,
  fallbackConnect: forwardConnectToDohFallback, fallbackHttp: forwardHttpToDohFallback,
  log, timeoutMs: HNS_PROXY_CONNECT_TIMEOUT_MS,
});

function parseHnsDiscoveryInstant(value) {
  const instant = typeof value === 'string' && HNS_DISCOVERY_INSTANT_RE.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(instant)) throw new Error('namespace list carries an invalid time');
  return instant;
}

// The list api-next's HnsNamespaceDiscoveryV1 describes, as each root's
// lifetime on the server's own clock: `expires_at - generated_at`. Anything
// the list cannot vouch for makes the whole response unavailable, never partly
// applied, because applying a list also removes every root it omits. A reserved
// root is the one entry dropped instead, so no server mistake captures a TLD.
function parseHnsNamespaceList(payload) {
  if (payload?.version !== 1) throw new Error('namespace list has an unknown version');
  const generatedAt = parseHnsDiscoveryInstant(payload.generated_at);
  if (!Array.isArray(payload.roots)) throw new Error('namespace list has no roots');
  const roots = new Map();
  for (const entry of payload.roots) {
    if (typeof entry?.root !== 'string' || !isValidHostnameLabel(entry.root)) {
      throw new Error('namespace list carries an invalid root');
    }
    const lifetimeMs = parseHnsDiscoveryInstant(entry.expires_at) - generatedAt;
    if (!(lifetimeMs > 0)) throw new Error('namespace list carries a root that expired when it was generated');
    if (!isReservedHnsRoot(entry.root)) {
      roots.set(entry.root, Math.min(lifetimeMs, roots.get(entry.root) ?? Infinity));
    }
  }
  return { generatedAt, roots };
}

function buildPacScript(intent = getRoutingIntent()) {
  const hnsHostPredicate = buildHnsHostPredicate();
  const hnsRootMap = buildPacHnsRootMap(intent.suffixes);
  const effectiveHnsProxyAddr = (intent.hnsRequired || intent.hnsUpstream) ? (hnsProxyAddr || '127.0.0.1:9') : null;
  const hnsLine = effectiveHnsProxyAddr
    ? `  if (${hnsHostPredicate}) {\n    return "PROXY ${effectiveHnsProxyAddr}";\n  }`
    : `  if (${hnsHostPredicate}) {\n    return "DIRECT";\n  }`;

  const ordinaryOnionRoute = intent.dvpnHost && intent.dvpnPort
    ? `SOCKS5 ${intent.dvpnHost}:${intent.dvpnPort}; SOCKS ${intent.dvpnHost}:${intent.dvpnPort}; DIRECT`
    : 'DIRECT';
  const onionRoute = intent.torRoutingConfigured
    ? (intent.torSocksEndpoint ? `SOCKS5 ${intent.torSocksEndpoint}` : 'PROXY 127.0.0.1:9')
    : ordinaryOnionRoute;
  const onionLine = `  if (host === "onion" || host.slice(-6) === ".onion") return "${onionRoute}";`;

  const dvpnLine = intent.dvpnHost && intent.dvpnPort
    ? `  return "SOCKS5 ${intent.dvpnHost}:${intent.dvpnPort}; SOCKS ${intent.dvpnHost}:${intent.dvpnPort}; DIRECT";`
    : `  return "DIRECT";`;

  return `var hnsRoots = ${hnsRootMap};

function FindProxyForURL(url, host) {
${onionLine}
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
    hnsCertificateUpdating, hnsRequired,
    trustIdentity: hnsUpstreamProxyAddr ? hnsTrustIdentity : null,
    dvpnHost: dvpnProxyHost, dvpnPort: dvpnProxyPort,
    torSocksEndpoint, torRoutingConfigured,
    suffixes: [...getHnsPublicSuffixes()].sort() };
}

async function prepareProxyPolicy(intent) {
  if (intent.hnsCertificateUpdating) throw new Error('HNS certificate update in progress');
  // Existing Node operations cannot inherit a different helper or trust key.
  // Electron requests were withdrawn before this shared preparation began.
  await drainGuardResources();
  guardRoute = intent.hnsUpstream ? parseProxyAddress(intent.hnsUpstream) : null;
  const guardNeeded = Boolean(intent.hnsRequired || intent.hnsUpstream);
  if (!guardNeeded && !intent.dvpnHost && !intent.torRoutingConfigured) {
    return { configuration: { mode: 'direct' }, key: 'direct', guardNeeded: false };
  }
  if (guardNeeded) await startHnsGuardProxy();
  const pac = buildPacScript(intent);
  const port = await startPacServer(pac);
  const configuration = { mode: 'pac_script', pacScript: `http://127.0.0.1:${port}/proxy.pac` };
  return { configuration, key: JSON.stringify([configuration, pac, intent]),
    content: pac, pacServer, guardServer: guardNeeded ? hnsGuardServer : null,
    guardNeeded };
}

let torSocksEndpoint = null;
let torRoutingConfigured = false;
// Whether the committed policy sends Handshake names, single labels included,
// to the guard. It follows routing, not the helper: a starting or recovering
// helper is still behind the guard.
let hnsGuardRouting = false;
let hnsGuardRoutingObserver = null;

function isHnsGuardRouting() {
  return hnsGuardRouting;
}

function setHnsGuardRoutingObserver(observer) {
  if (typeof observer !== 'function' || hnsGuardRoutingObserver) throw new TypeError('Invalid HNS guard routing observer');
  hnsGuardRoutingObserver = observer;
}

const sessionDispatcherOptions = new WeakMap();

function setProxySessionDispatcherOptions(targetSession, options) {
  if (sessionDispatcherOptions.has(targetSession)) throw new Error('Session dispatcher options already set');
  sessionDispatcherOptions.set(targetSession, { ...options });
}

const routing = createSessionRoutingCoordinator(proxySessions, {
  getIntent: getRoutingIntent,
  withdraw: () => { guardAllowed = false; guardResources.withdraw(); },
  prepare: prepareProxyPolicy,
  isValid: (policy) => policy.configuration.mode === 'direct' ||
    (pacServer === policy.pacServer && Boolean(pacServer && pacPort) && currentPacContent === policy.content &&
      (!policy.guardNeeded || (hnsGuardServer === policy.guardServer && Boolean(hnsGuardServer && hnsGuardPort)))),
  isInitialDirect: (intent) => !intent.hnsCertificateUpdating && !intent.hnsRequired && !intent.hnsUpstream && !intent.dvpnHost && !intent.torRoutingConfigured && !pacServer && !hnsGuardServer,
  retire: async (policy) => {
    if (!policy.guardNeeded) await stopHnsGuardProxy();
    if (policy.configuration.mode === 'direct') await stopPacServer();
  },
  publish: (policy) => {
    guardAllowed = policy.guardNeeded;
    if (guardAllowed) guardResources.publish();
    if (hnsGuardRouting !== policy.guardNeeded) {
      hnsGuardRouting = policy.guardNeeded;
      try { hnsGuardRoutingObserver?.(hnsGuardRouting); } catch { /* Feedback has no routing authority. */ }
    }
  },
  attach: (targetSession, getRequestPolicy) => attachWebRequestDispatcher(targetSession, { ...sessionDispatcherOptions.get(targetSession), getRequestPolicy }),
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

function setHnsProtectionRequired(required) {
  hnsRequired = required === true;
  routing.intentChanged();
}

function setHnsProxy(proxyAddr, trustIdentity = null) {
  hnsAuthorityCheck = typeof trustIdentity?.isValid === 'function'
    ? trustIdentity.isValid : () => !hnsRequired;
  hnsCertificateUpdating = false;
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
  hnsAuthorityCheck = () => false;
  hnsCertificateUpdating = false;
  hnsUpstreamProxyAddr = null;
  hnsTrustIdentity = null;
  hnsRootResolverAddr = null;
  hnsProxyAddr = hnsGuardServer && hnsGuardPort ? `127.0.0.1:${hnsGuardPort}` : null;
  hnsProxyHosts.clear();
  routing.intentChanged();
  log.info('[Network] HNS proxy cleared');
}

function beginHnsCertificateUpdate() {
  hnsCertificateUpdating = true;
  routing.intentChanged();
  return proxySessions.enqueue(async () => {
    try {
      await Promise.all([proxySessions.pauseAll(), drainGuardResources()]);
    } catch (error) {
      proxySessions.terminate('hns_trust_transition_failed');
      throw error;
    }
  });
}

function setTorProxy(endpoint) {
  const normalized = normalizeSocksEndpoint(endpoint);
  if (!normalized || !/^[a-zA-Z0-9.:[\]-]+$/.test(normalized)) {
    throw new Error('Invalid Tor SOCKS endpoint');
  }
  torRoutingConfigured = true;
  torSocksEndpoint = normalized;
  routing.intentChanged();
  return routing.rebuild();
}

function clearTorProxy() {
  torRoutingConfigured = false;
  torSocksEndpoint = null;
  routing.intentChanged();
  return routing.rebuild();
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

// The default session, so the request follows the browser's own proxy policy
// (the dVPN when it is up) instead of Node's direct dial. It never falls back
// to Node fetch, not even while that session is withdrawn: hns-manager.js
// retries instead. It keeps custom protocol handlers: production registers
// none for https, and the test harness's https stub keeps test runs offline.
function fetchOnDefaultSession(url, init) {
  return session.defaultSession.fetch(url, init);
}

// Reads the body, refusing it past HNS_DISCOVERY_MAX_BYTES rather than holding
// more. The caller's abort cancels the reader, which is what releases a body
// that stalls part way.
async function readHnsDiscoveryBody(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('namespace list has no body');
  signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (signal.aborted) throw new Error('namespace list request aborted');
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > HNS_DISCOVERY_MAX_BYTES) throw new Error('namespace list exceeds 64 KiB');
    chunks.push(value);
  }
}

// One discovery request: no cookies or other credentials, no HTTP cache, no
// redirect taken, no identifying headers of its own. A single deadline covers
// the headers and the whole body. Any failure rejects, and the caller counts
// it as unavailable. The result carries its monotonic receipt time, which
// local deadlines are measured from.
async function fetchHnsNamespaces({ fetchImpl = fetchOnDefaultSession, url = getHnsDiscoveryUrl() } = {}) {
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('namespace list deadline exceeded'));
      controller.abort();
    }, HNS_DISCOVERY_DEADLINE_MS);
  });
  const read = (async () => {
    const response = await fetchImpl(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`namespace list answered ${response.status}`);
    const list = parseHnsNamespaceList(JSON.parse(await readHnsDiscoveryBody(response, controller.signal)));
    return { ...list, origin: new URL(url).origin, receivedAt: performance.now() };
  })();
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Routes exactly these imported roots, beside the built-in `.pirate`. Only a
// changed root set changes the routing intent, so an unchanged one withdraws
// no session and drains no guard connection. The rebuild still runs while a
// helper or the dVPN is up: with nothing changed it re-applies nothing, and
// it recovers a policy that was lost.
function setImportedHnsRoots(roots = []) {
  const suffixes = setDynamicHnsPublicSuffixes(roots);
  const changed = routing.intentChanged();
  if (changed) log.info(`[Network] Imported HNS suffixes loaded: ${formatImportedHnsSuffixesLog(suffixes)}`);
  if (changed || hnsUpstreamProxyAddr || dvpnProxyHost) {
    rebuild().catch((err) => log.warn(`[Network] Routing rebuild after a namespace change failed: ${err.message}`));
  }
  return suffixes;
}

function getHnsProxyAddr() {
  return hnsProxyAddr;
}

function getDvpnProxy() {
  if (!dvpnProxyHost || !dvpnProxyPort) return null;
  return { host: dvpnProxyHost, port: dvpnProxyPort };
}

module.exports = {
  HNS_PROXY_CONNECT_TIMEOUT_MS,
  setTorProxy,
  clearTorProxy,
  setProxySessionDispatcherOptions,
  initializeSessionRouting,
  getProxySessionPolicy: proxySessions.policyFor,
  setProxySessionPolicyObserver: proxySessions.setPolicyObserver,
  setHnsProtectionRequired,
  setHnsProxy,
  beginHnsCertificateUpdate,
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
  isHnsGuardRouting,
  setHnsGuardRoutingObserver,
  buildPacScript,
  getHnsDiscoveryUrl,
  fetchHnsNamespaces,
  setImportedHnsRoots,
  registerApiRequestDiagnostics,
  sanitizeApiRequestUrl,
  getHnsResolutionForHost,
  canResolveHnsFallbackForHost,
  isHnsProxyHost,
};
