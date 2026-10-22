const log = require('./logger');
const { ipcMain, app, session, net: electronNet, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const readline = require('readline');
const { createHash, X509Certificate } = require('crypto');
const IPC = require('../shared/ipc-channels');
const { getHnsPublicSuffixes } = require('../shared/hns-hosts');
const { getCapabilityStatus } = require('../shared/platform-capabilities');
const { probeHnsChainState, probeHnsValidator, HNS_VALIDATOR_INCOMPLETE_CODES } = require('./hns-health');
const { createHnsAuthority } = require('./hns-authority');
const { createHnsNetworkMonitor } = require('./hns-network-monitor');
const { createHnsValidatorTransport } = require('./hns-validator-transport');
const { pruneUnknownSingleLabelHistory } = require('./browser-state-sanitizer');
const { installHnsCheckpoint } = require('./hns-checkpoint');
const {
  MODE,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const networkManager = require('./network-manager');
const hnsCapability = getCapabilityStatus('hns');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let helperProcess = null;
let helperGeneration = 0;
let helperTeardown = Promise.resolve();
let pendingStart = false;
let encryptedRelay = null;
let startingTransport = null;
let nativeCustody = null;
let authority = null;
let readyPublished = false;
let networkMonitor = null;
let runtimeWanted = false;
let cleanupFailed = false;
let permanentStartupError = null;
let recovery = null;
let activation = null;
let encryptedProbeTimer = null;
let restartCount = 0;
const MAX_RESTARTS = 5;
const RESTART_RESET_MS = 10 * 60 * 1000;
const HNS_CHAIN_POLL_MS = 2000;
const HNS_STDERR_REPEAT_WINDOW_MS = 30 * 1000;
const HNS_HEALTH_INITIAL_DELAY_MS = 1000;
const HNS_HEALTH_RETRY_BASE_MS = 5000;
const HNS_HEALTH_RETRY_MAX_MS = 60 * 1000;
// A published generation's validation probe that could not complete (a query
// timed out or failed to send) is retried this many times, this soon, while
// the existing validation lease still holds. A retry renews nothing: only a
// verified success does, so the lease still expires on schedule.
const HNS_HEALTH_TRANSIENT_RETRIES = 2;
const HNS_HEALTH_TRANSIENT_RETRY_MS = 1000;
const HNS_LOCAL_READY_SUCCESS_THRESHOLD = 2;
const HNS_LOCAL_READY_FAILURE_THRESHOLD = 2;
// Namespace discovery (networkManager.fetchHnsNamespaces): first at
// helper-ready, then every 10 minutes. A failure backs off from 30 seconds,
// doubling with jitter up to 10 minutes; a fetch that a routing transition
// cancelled is first retried once, after 2 seconds.
const HNS_DISCOVERY_REFRESH_MS = 10 * 60 * 1000;
const HNS_DISCOVERY_RETRY_MS = 2000;
const HNS_DISCOVERY_BACKOFF_BASE_MS = 30 * 1000;
// setTimeout's longest delay; a later deadline is simply looked at again then.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const FORBIDDEN_HELPER_CANARIES = [['shake', 'station'].join('')];
const HNS_HELPER_TUNNEL_DNS_FAILURE_RE = /\[WARN\]\s+tunnel:\s+502\s+CONNECT\s+\S+\s+dns lookup failed/i;

let proxyAddr = null;
let caPemPath = null;
let caCertFingerprint = null;
const certificateSessions = new Map();
const childClosures = new WeakMap();
let readyTicket = null;
let synced = false;
let canaryReady = false;
let localResolverReady = false;
let dohFallbackReady = false;
let height = 0;
let lastHeightChangeAt = 0;
let rootAddr = null;
let recursiveAddr = null;
const hnsStderrLogState = new Map();
let hnsChainTimer = null;
let hnsChainGeneration = 0;
let peerCount = 0;
let syncProgress = 0;
let hnsHealthTimer = null;
let hnsHealthInFlight = false;
let hnsHealthAttempt = 0;
let hnsHealthTransientFailures = 0;
let lastHnsHealthOk = null;
let localReadySuccessCount = 0;
let localReadyFailureCount = 0;
let lastBroadcastReadiness = {
  dohFallbackReady: null,
  localResolverReady: null,
};
let hnsDiscoveryTimer = null;
let hnsDiscoveryFailures = 0;
let hnsDiscoveryLastAttemptOk = false;
let hnsDiscoveryLastSuccessAt = null;
// Each listed root's local deadline on the monotonic clock: its receipt time
// plus the server's own `expires_at - generated_at`, so the two clocks are
// never compared. The deadlines and their timer belong to no helper: they keep
// running through restarts and invalidation, and nothing but expiry or a newer
// list removes a root.
const hnsNamespaceDeadlines = new Map();
let hnsNamespaceGeneratedAt = -Infinity;
let hnsNamespaceExpiryTimer = null;

function normalizeHnsStderrLine(line) {
  return line.replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/, '');
}

function isExpectedHelperTunnelDnsFailure(line) {
  return HNS_HELPER_TUNNEL_DNS_FAILURE_RE.test(line);
}

function logHnsStderrLine(line) {
  if (isExpectedHelperTunnelDnsFailure(line)) {
    log.info('[HNS helper] Local DNS miss; guard resolver will retry');
    return;
  }

  log.warn('[HNS helper] Diagnostic received; browsing details withheld');
}

function logSuppressedHnsStderr(previous) {
  const message = isExpectedHelperTunnelDnsFailure(previous.lastLine)
    ? `[HNS helper] Suppressed ${previous.suppressed} repeat local DNS misses`
    : `[HNS helper] Suppressed ${previous.suppressed} repeated diagnostics`;
  const level = isExpectedHelperTunnelDnsFailure(previous.lastLine) ? 'info' : 'warn';
  log[level](message);
}

function logHnsStderr(data) {
  const lines = String(data)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const now = Date.now();
    const key = normalizeHnsStderrLine(line);
    const previous = hnsStderrLogState.get(key);

    if (previous && now - previous.lastLoggedAt < HNS_STDERR_REPEAT_WINDOW_MS) {
      previous.suppressed += 1;
      previous.lastSeenAt = now;
      previous.lastLine = line;
      continue;
    }

    if (previous?.suppressed > 0) {
      logSuppressedHnsStderr(previous);
    }

    logHnsStderrLine(line);
    hnsStderrLogState.set(key, {
      lastLoggedAt: now,
      lastSeenAt: now,
      suppressed: 0,
      lastLine: line,
    });
  }
}

function clearHnsHealthState() {
  hnsChainGeneration += 1;
  if (hnsChainTimer) clearTimeout(hnsChainTimer);
  hnsChainTimer = null;
  peerCount = 0;
  syncProgress = 0;
  if (hnsHealthTimer) {
    clearTimeout(hnsHealthTimer);
    hnsHealthTimer = null;
  }
  if (encryptedProbeTimer) clearTimeout(encryptedProbeTimer);
  encryptedProbeTimer = null;
  hnsHealthInFlight = false;
  hnsHealthAttempt = 0;
  hnsHealthTransientFailures = 0;
  lastHnsHealthOk = null;
  localReadySuccessCount = 0;
  localReadyFailureCount = 0;
}

function resetHnsReadiness() {
  localResolverReady = false;
  dohFallbackReady = false;
  localReadySuccessCount = 0;
  localReadyFailureCount = 0;
  lastBroadcastReadiness = {
    dohFallbackReady: null,
    localResolverReady: null,
  };
}

function shouldBroadcastReadiness() {
  if (
    lastBroadcastReadiness.localResolverReady === localResolverReady &&
    lastBroadcastReadiness.dohFallbackReady === dohFallbackReady
  ) {
    return false;
  }

  lastBroadcastReadiness = {
    dohFallbackReady,
    localResolverReady,
  };
  return true;
}

function updateLocalResolverReadiness(candidateReady) {
  const wasReady = localResolverReady;
  if (candidateReady) {
    localReadySuccessCount += 1;
    localReadyFailureCount = 0;
    if (localReadySuccessCount >= HNS_LOCAL_READY_SUCCESS_THRESHOLD && !wasReady) {
      localResolverReady = true;
      log.info(
        `[HNS] localResolverReady=false->true after ${HNS_LOCAL_READY_SUCCESS_THRESHOLD} consecutive successful probes`
      );
    }
    return;
  }

  localReadyFailureCount += 1;
  localReadySuccessCount = 0;
  if (localReadyFailureCount >= HNS_LOCAL_READY_FAILURE_THRESHOLD && wasReady) {
    localResolverReady = false;
    log.info(
      `[HNS] localResolverReady=true->false after ${HNS_LOCAL_READY_FAILURE_THRESHOLD} consecutive failed probes`
    );
  }
}

function scheduleHnsChainCheck(delayMs = HNS_CHAIN_POLL_MS) {
  if (currentState !== STATUS.RUNNING || !rootAddr || hnsChainTimer) return;
  const generation = hnsChainGeneration;
  hnsChainTimer = setTimeout(async () => {
    hnsChainTimer = null;
    const active = () => generation === hnsChainGeneration && currentState === STATUS.RUNNING;
    try {
      const state = await probeHnsChainState({ rootAddr });
      if (!active()) return;
      if (state.height !== height || !lastHeightChangeAt) lastHeightChangeAt = Date.now();
      height = state.height; peerCount = state.peers; syncProgress = state.progress;
      synced = authority.metadata(state) && networkMonitor.allowed();
      if (!active()) return;
      if (synced) { scheduleHnsHealthCheck('chain fresh'); await activateGeneration(); }
      else {
        resetHnsReadiness();
        setStatusMessage('hns', `Syncing block ${height}; ${peerCount} peers`);
      }
    } catch {
      if (!active()) return;
      synced = false; resetHnsReadiness();
      if (readyPublished) invalidateHnsGeneration('hns_metadata_unavailable');
      else setStatusMessage('hns', 'Waiting for fresh local HNS chain status');
    } finally {
      if (active()) {
        updateService('hns', { synced, canaryReady, localResolverReady, dohFallbackReady, height, peerCount, syncProgress });
        scheduleHnsChainCheck();
      }
    }
  }, delayMs);
}

function canProbeHnsHealth() {
  return currentState === STATUS.RUNNING && synced && Boolean(recursiveAddr);
}

function scheduleHnsHealthCheck(reason = 'scheduled', delayMs = HNS_HEALTH_INITIAL_DELAY_MS) {
  if (!canProbeHnsHealth()) return;
  if (hnsHealthTimer) return;

  hnsHealthTimer = setTimeout(() => {
    hnsHealthTimer = null;
    runHnsHealthCheck(reason).catch((error) => {
      log.warn(`[HNS] Resolver health probe failed: ${error.message}`);
    });
  }, delayMs);
}

function scheduleHnsHealthRetry() {
  const delayMs = Math.min(
    HNS_HEALTH_RETRY_BASE_MS * Math.pow(2, Math.max(0, hnsHealthAttempt - 1)),
    HNS_HEALTH_RETRY_MAX_MS,
  );
  scheduleHnsHealthCheck('retry', delayMs);
  return delayMs;
}

async function runHnsHealthCheck(reason = 'manual') {
  if (!canProbeHnsHealth() || hnsHealthInFlight) return null;
  const generation = helperGeneration;
  const candidate = authority;
  hnsHealthInFlight = true;
  try {
    let result;
    try {
      result = await probeHnsValidator({ recursiveAddr });
    } catch (error) {
      if (!HNS_VALIDATOR_INCOMPLETE_CODES.has(error?.code)) throw error;
      // The probe did not complete; no answer was judged. Within a still-valid
      // lease, look again shortly instead of retiring the generation at once.
      if (generation !== helperGeneration || candidate !== authority) return null;
      if (readyPublished && canProbeHnsHealth() && hnsHealthTransientFailures < HNS_HEALTH_TRANSIENT_RETRIES &&
          candidate.isValid()) {
        hnsHealthTransientFailures += 1;
        log.warn(`[HNS] Validator probe did not complete; retrying within the current lease (${hnsHealthTransientFailures}/${HNS_HEALTH_TRANSIENT_RETRIES})`);
        hnsHealthInFlight = false;
        scheduleHnsHealthCheck('transient retry', HNS_HEALTH_TRANSIENT_RETRY_MS);
        return { ok: false, transient: true };
      }
      throw Object.assign(new Error('Local DNSSEC validation did not complete'), { incomplete: true });
    }
    if (generation !== helperGeneration || candidate !== authority || !canProbeHnsHealth()) return result;
    // An answer that fails validation (SERVFAIL, no AD, missing records) is
    // never retried; neither is a truncated, mismatched or malformed reply.
    if (!result.ok) throw new Error('Local DNSSEC validation unavailable');
    if (!candidate.validation()) return result;
    updateLocalResolverReadiness(true);
    dohFallbackReady = false;
    hnsHealthAttempt = 0;
    hnsHealthTransientFailures = 0;
    if (lastHnsHealthOk !== true) log.info(`[HNS] Local DNSSEC/DANE records validated (${reason})`);
    lastHnsHealthOk = true;
    if (shouldBroadcastReadiness()) updateService('hns', { localResolverReady, dohFallbackReady });
    await activateGeneration();
    scheduleHnsHealthCheck('validation lease', HNS_HEALTH_RETRY_BASE_MS);
    return result;
  } catch (error) {
    if (generation !== helperGeneration || candidate !== authority) return null;
    lastHnsHealthOk = false;
    updateLocalResolverReadiness(false);
    if (readyPublished) invalidateHnsGeneration(error?.incomplete ? 'hns_validation_incomplete' : 'hns_validation_failed');
    else { hnsHealthAttempt += 1; scheduleHnsHealthRetry(); }
    return { ok: false };
  } finally {
    if (generation === helperGeneration) hnsHealthInFlight = false;
  }
}

function scheduleEncryptedProbe(delay = 0) {
  if (encryptedProbeTimer || currentState !== STATUS.RUNNING) return;
  const generation = helperGeneration;
  encryptedProbeTimer = setTimeout(async () => {
    encryptedProbeTimer = null;
    const candidate = authority;
    try {
      await encryptedRelay.probe();
      if (generation !== helperGeneration || candidate !== authority) return;
      if (candidate.transport()) await activateGeneration();
    } catch {
      if (generation === helperGeneration) invalidateHnsGeneration('encrypted_dns_probe_failed');
    } finally {
      if (generation === helperGeneration) scheduleEncryptedProbe(5000);
    }
  }, delay);
}

function invalidateHnsGeneration(reason, startupError = null) {
  if (permanentStartupError && !startupError) return;
  if (startupError) permanentStartupError = startupError;
  authority?.retire();
  readyPublished = false;
  // Only the refresh stops: listed roots keep their own deadlines, and the
  // restart's helper-ready fetches again.
  clearHnsDiscoveryTimer();
  networkManager.clearHnsProxy();
  caCertFingerprint = null;
  resetHnsReadiness();
  if (recovery || !runtimeWanted) return;
  log.warn(`[HNS] Resolver generation retired: ${reason}`);
  const teardown = stopHns({ recovering: true });
  const stoppedGeneration = helperGeneration;
  recovery = teardown.then(() => {
    recovery = null;
    if (cleanupFailed) { updateState(STATUS.ERROR, 'Unresolved HNS resolver custody');
      setErrorState('hns', 'HNS is blocked until unresolved resolver cleanup is verified'); return; }
    if (startupError) {
      if (runtimeWanted && helperGeneration === stoppedGeneration && currentState === STATUS.STOPPED &&
          permanentStartupError === startupError) {
        updateState(STATUS.ERROR, startupError);
        setErrorState('hns', startupError);
        setStatusMessage('hns', startupError);
      }
      return;
    }
    if (runtimeWanted && networkMonitor?.allowed()) maybeRestart();
  }).catch(() => {
    recovery = null;
    updateState(STATUS.ERROR, 'HNS resolver cleanup failed');
    setErrorState('hns', 'HNS resolver cleanup failed');
  });
}

async function activateGeneration() {
  if (readyPublished || activation || !authority?.isValid() || !localResolverReady || !nativeCustody?.isCaptured() || !networkMonitor?.allowed()) return;
  const candidate = authority;
  const generation = helperGeneration;
  activation = (async () => {
    await networkManager.beginHnsCertificateUpdate();
    if (generation !== helperGeneration || candidate !== authority) return;
    if (!candidate.publish()) { invalidateHnsGeneration('hns_activation_lease_expired'); return; }
    readyPublished = true;
    updateSessionCertificates(true);
    networkManager.setHnsProxy(proxyAddr, { generation, caFingerprint: caCertFingerprint,
      isValid: () => candidate === authority && readyPublished && candidate.isValid() && networkMonitor.allowed() });
    networkManager.setHnsResolverAddrs({ rootAddr, recursiveAddr });
    await networkManager.rebuild();
    if (generation !== helperGeneration || candidate !== authority || !candidate.isValid()) return;
    const publishedProxyAddr = networkManager.getHnsProxyAddr();
    updateService('hns', { api: publishedProxyAddr ? `http://${publishedProxyAddr}` : null,
      proxy: publishedProxyAddr, mode: MODE.BUNDLED, publicSuffixes: getHnsPublicSuffixes() });
    clearErrorState('hns'); setStatusMessage('hns', null);
  })();
  try { await activation; }
  catch { if (generation === helperGeneration) invalidateHnsGeneration('hns_activation_failed'); }
  finally { if (generation === helperGeneration) activation = null; }
}

function getHelperBinaryPath() {
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  if (app.isPackaged) {
    const binName = process.platform === 'win32' ? 'fingertipd.exe' : 'fingertipd';
    return path.join(process.resourcesPath, 'hns-bin', binName);
  }

  const binName = process.platform === 'win32' ? 'fingertipd.exe' : 'fingertipd';
  return path.join(__dirname, '..', '..', 'hns-bin', `${platform}-${process.arch}`, binName);
}

function getHnsdBinaryPath() {
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  if (app.isPackaged) {
    const binName = process.platform === 'win32' ? 'hnsd.exe' : 'hnsd';
    return path.join(process.resourcesPath, 'hns-bin', binName);
  }

  const binName = process.platform === 'win32' ? 'hnsd.exe' : 'hnsd';
  return path.join(__dirname, '..', '..', 'hns-bin', `${platform}-${process.arch}`, binName);
}

function getHnsDataPath() {
  if (!app.isPackaged) {
    const devDataDir = path.join(__dirname, '..', '..', 'hns-data');
    if (!fs.existsSync(devDataDir)) {
      fs.mkdirSync(devDataDir, { recursive: true });
    }
    return devDataDir;
  }

  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'hns-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function getHelperBinaryValidationError(binPath) {
  let binaryData;
  try {
    binaryData = fs.readFileSync(binPath);
  } catch (err) {
    log.warn(`[HNS] Could not inspect helper binary ${binPath}: ${err.message}`);
    return null;
  }

  const binaryBuffer = Buffer.isBuffer(binaryData)
    ? binaryData
    : Buffer.from(String(binaryData || ''));

  const forbiddenCanary = FORBIDDEN_HELPER_CANARIES.find((canary) => (
    binaryBuffer.includes(Buffer.from(canary))
  ));

  if (!forbiddenCanary) return null;

  return `HNS helper binary contains obsolete hardcoded canary "${forbiddenCanary}"; replace ${binPath} with a rebuilt fingertipd.`;
}

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? address?.port : null;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error('Failed to reserve TCP port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function canBindUdpPort(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.unref?.();

    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Ignore close errors during probe cleanup.
      }
      resolve(available);
    };

    socket.once('error', () => finish(false));
    socket.bind(port, '127.0.0.1', () => finish(true));
  });
}

async function reserveLoopbackPort(excludedPorts = new Set()) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await reserveTcpPort();
    if (excludedPorts.has(port)) continue;
    if (await canBindUdpPort(port)) {
      return port;
    }
  }

  throw new Error('Failed to reserve a free loopback port for HNS');
}

async function allocateResolverAddrs() {
  const excluded = new Set();
  const rootPort = await reserveLoopbackPort(excluded);
  excluded.add(rootPort);
  const recursivePort = await reserveLoopbackPort(excluded);

  return {
    rootAddr: `127.0.0.1:${rootPort}`,
    recursiveAddr: `127.0.0.1:${recursivePort}`,
  };
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow?.getAllWindows?.() || [];
  for (const win of windows) {
    win.webContents.send(IPC.HNS_STATUS_UPDATE, getHnsStatus());
  }
}

// Extracted so this policy is directly testable: it decides whether an HNS
// connection is trusted, and it previously shipped with no test coverage at all.
function certificateChainContainsFingerprint(certificate, trustedFingerprint) {
  const visited = new Set();
  let current = certificate;

  while (current && !visited.has(current)) {
    if (current.fingerprint === trustedFingerprint) {
      return true;
    }

    visited.add(current);
    current = current.issuerCert;
  }

  return false;
}

function chromiumCertificateFingerprint(der) {
  return `sha256/${createHash('sha256').update(der).digest('base64')}`;
}

function createCertificateVerifier(trustedFingerprint) {
  return (request, callback) => {
    try {
      // There is deliberately NO blanket "this is an HNS hostname, accept any
      // certificate" branch here.
      //
      // Such a branch used to exist, gated only on the HNS proxy being active
      // and the hostname looking like an HNS name. It did not distinguish how
      // the address was obtained. The guard proxy's last-resort path resolves
      // over DoH -- which sets no DO bit and never fetches TLSA -- and then
      // opens a raw TCP connection straight to the returned address, bypassing
      // fingertipd. So on that path neither DANE nor ordinary certificate
      // validation applied, and whoever operated the DoH resolver could point
      // any HNS name at any host and terminate TLS with any certificate.
      //
      // Connections that actually go through fingertipd are unaffected: it
      // performs the DANE check itself and presents a certificate under the
      // local CA, which the fingerprint comparison below accepts.
      //
      // Until a validated TLSA pin is available (DS -> DNSKEY -> RRSIG from the
      // local HNS root trust anchor, then a usage-3/selector-1 SPKI match bound
      // to this hostname and port), anything else must fail closed. A broken
      // page on a DNS-blocked network is the correct trade against silently
      // accepting an arbitrary certificate.
      if (certificateChainContainsFingerprint(request.certificate, trustedFingerprint)) {
        callback(0);
        return;
      }
    } catch {
      // fall through
    }
    callback(-3);
  };
}

function configureCertVerification(targetSession) {
  if (!caCertFingerprint) {
    log.warn('[HNS] Cannot configure cert verification: no CA fingerprint');
    return;
  }

  const trustedFingerprint = caCertFingerprint;
  const generationAuthority = authority;
  const token = certificateSessions.get(targetSession);
  const verify = createCertificateVerifier(trustedFingerprint);
  targetSession.setCertificateVerifyProc((request, callback) => {
    // Retired callbacks cannot retain authority after release or CA rotation,
    // even if clearing a session's native procedure fails during disposal.
    if (authority !== generationAuthority || !readyPublished || !authority?.isValid() || !networkMonitor?.allowed() ||
        caCertFingerprint !== trustedFingerprint ||
        (targetSession !== session.defaultSession && certificateSessions.get(targetSession) !== token)) {
      callback(-3);
      return;
    }
    verify(request, callback);
  });
  log.info('[HNS] Certificate verification configured');
}

function clearCertVerification(targetSession) {
  targetSession.setCertificateVerifyProc(null);
  log.info('[HNS] Certificate verification cleared');
}

function updateSessionCertificates(configure) {
  const failures = [];
  for (const targetSession of new Set([session.defaultSession, ...certificateSessions.keys()])) {
    try {
      if (configure) configureCertVerification(targetSession);
      else clearCertVerification(targetSession);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'HNS session certificate update failed');
  }
}

async function registerHnsSession(targetSession) {
  if (typeof targetSession?.setCertificateVerifyProc !== 'function') {
    throw new TypeError('Session certificate verification is unavailable');
  }
  const token = certificateSessions.get(targetSession) || {};
  certificateSessions.set(targetSession, token);
  try {
    if (caCertFingerprint) configureCertVerification(targetSession);
    // The caller must await routing and certificate setup before navigation.
    await networkManager.registerProxySession(targetSession);
    if (certificateSessions.get(targetSession) !== token) throw new Error('HNS session enrollment cancelled');
  } catch (error) {
    if (certificateSessions.get(targetSession) === token) {
      try {
        unregisterHnsSession(targetSession);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'HNS session enrollment cleanup failed', { cause: cleanupError });
      }
    }
    throw error;
  }
}

function unregisterHnsSession(targetSession) {
  const enrolled = certificateSessions.delete(targetSession);
  networkManager.unregisterProxySession(targetSession);
  if (enrolled) clearCertVerification(targetSession);
}

function loadCaFingerprint(pemPath) {
  try {
    const pemData = fs.readFileSync(pemPath, 'utf-8');
    const cert = new X509Certificate(pemData);
    caCertFingerprint = chromiumCertificateFingerprint(cert.raw);
    log.info(`[HNS] CA fingerprint: ${caCertFingerprint}`);
    return true;
  } catch (err) {
    log.error(`[HNS] Failed to load CA PEM from ${pemPath}:`, err.message);
    return false;
  }
}

// `fresh`: the last attempt succeeded. `stale`: it failed, but a listed root
// is still unexpired. `unavailable`: no listed root is unexpired, or none was
// ever received.
function getHnsDiscovery() {
  let state = 'unavailable';
  if (hnsDiscoveryLastAttemptOk) state = 'fresh';
  else if (hnsNamespaceDeadlines.size > 0) state = 'stale';
  return { state, lastSuccessAt: hnsDiscoveryLastSuccessAt };
}

// Drops every root past its deadline, routes the rest, and republishes them:
// the renderer classifies hosts from its own copy of the set.
function routeHnsNamespaces() {
  const now = performance.now();
  for (const [root, deadline] of hnsNamespaceDeadlines) {
    if (deadline <= now) hnsNamespaceDeadlines.delete(root);
  }
  if (hnsNamespaceExpiryTimer) clearTimeout(hnsNamespaceExpiryTimer);
  hnsNamespaceExpiryTimer = null;
  if (hnsNamespaceDeadlines.size > 0) {
    const delayMs = Math.ceil(Math.min(...hnsNamespaceDeadlines.values()) - now);
    hnsNamespaceExpiryTimer = setTimeout(routeHnsNamespaces, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  }
  const publicSuffixes = networkManager.setImportedHnsRoots([...hnsNamespaceDeadlines.keys()]);
  updateService('hns', { publicSuffixes, discovery: getHnsDiscovery() });
  return publicSuffixes;
}

function clearHnsDiscoveryTimer() {
  if (hnsDiscoveryTimer) clearTimeout(hnsDiscoveryTimer);
  hnsDiscoveryTimer = null;
}

function scheduleHnsDiscovery(delayMs, retryCancelled = true) {
  clearHnsDiscoveryTimer();
  const generation = helperGeneration;
  hnsDiscoveryTimer = setTimeout(() => {
    hnsDiscoveryTimer = null;
    startHnsDiscovery(generation, retryCancelled);
  }, delayMs);
}

function startHnsDiscovery(generation, retryCancelled = true) {
  refreshHnsNamespaces(generation, retryCancelled)
    .catch((error) => log.warn(`[HNS] Namespace discovery failed: ${error.message}`));
}

function failHnsDiscovery(error) {
  hnsDiscoveryLastAttemptOk = false;
  hnsDiscoveryFailures += 1;
  log.warn(`[HNS] Namespace discovery unavailable: ${error.message}`);
  updateService('hns', { discovery: getHnsDiscovery() });
  const boundMs = Math.min(HNS_DISCOVERY_BACKOFF_BASE_MS * 2 ** (hnsDiscoveryFailures - 1), HNS_DISCOVERY_REFRESH_MS);
  scheduleHnsDiscovery(boundMs / 2 + Math.random() * (boundMs / 2));
}

// One discovery attempt for the helper of `generation`. Its list is applied
// only while that helper is still current, and only if it is no older than
// the list applied last; a restart's own helper-ready fetches again.
async function refreshHnsNamespaces(generation, retryCancelled = true) {
  const policy = () => networkManager.getProxySessionPolicy(session.defaultSession);
  const before = policy();
  let list;
  try {
    list = await networkManager.fetchHnsNamespaces();
  } catch (error) {
    if (generation !== helperGeneration) return;
    const after = policy();
    // Activation withdraws every session shortly after helper-ready, which
    // cancels a request in flight. Only that failure is retried at once.
    if (retryCancelled && (!before.allowed || !after.allowed || before.generation !== after.generation)) {
      scheduleHnsDiscovery(HNS_DISCOVERY_RETRY_MS, false);
    } else {
      failHnsDiscovery(error);
    }
    return;
  }
  if (generation !== helperGeneration) return;
  if (list.generatedAt < hnsNamespaceGeneratedAt) {
    failHnsDiscovery(new Error('namespace list is older than the one applied'));
    return;
  }
  // Replaced in one step, so a renewed root is never absent in between.
  hnsNamespaceGeneratedAt = list.generatedAt;
  hnsNamespaceDeadlines.clear();
  for (const [root, lifetimeMs] of list.roots) hnsNamespaceDeadlines.set(root, list.receivedAt + lifetimeMs);
  hnsDiscoveryFailures = 0;
  hnsDiscoveryLastAttemptOk = true;
  hnsDiscoveryLastSuccessAt = new Date().toISOString();
  if (routeHnsNamespaces().length > 1) pruneUnknownSingleLabelHistory();
  scheduleHnsDiscovery(HNS_DISCOVERY_REFRESH_MS);
}

async function handleReady(event) {
  if (currentState !== STATUS.STARTING || !authority || readyTicket) return;
  readyTicket = {};
  proxyAddr = event.proxyAddr || null;
  caPemPath = event.caPath || null;
  if (!/^127\.0\.0\.1:[1-9]\d*$/.test(proxyAddr || '') ||
      Number(proxyAddr.split(':')[1]) > 65535 || !caPemPath || !loadCaFingerprint(caPemPath)) {
    invalidateHnsGeneration('invalid_hns_helper_ready');
    return;
  }
  updateState(STATUS.RUNNING);
  updateService('hns', { mode: MODE.BUNDLED, api: null, proxy: null });
  setStatusMessage('hns', 'Waiting for fresh local validation');
  scheduleHnsChainCheck(0);
  scheduleEncryptedProbe();
  // Discovery starts here, not at activation: on a cold start activation waits
  // out the first chain sync, and it may never come. Until the list arrives,
  // names under imported roots take the system-DNS path.
  clearHnsDiscoveryTimer();
  startHnsDiscovery(helperGeneration);
}

function parseStdoutLine(line) {
  if (!line || !line.trim()) return;

  try {
    const event = JSON.parse(line);

    switch (event.type) {
      case 'ready':
        handleReady(event);
        break;

      case 'sync':
        // fingertipd 0.1.12 calls its app.pirate TLSA canary "synced".
        // Chain synchronization comes only from hnsd's local Hesiod metadata.
        canaryReady = event.synced === true || event.canaryReady === true;
        updateService('hns', { canaryReady });
        break;

      case 'error':
        invalidateHnsGeneration('hns_helper_reported_error');
        break;

      case 'stopping':
        log.info('[HNS] Helper shutting down');
        break;

      default:
        log.debug(`[HNS] Unknown event type: ${event.type}`);
    }
  } catch {
    // Not JSON, ignore
  }
}

async function startHns(recovering = false) {
  if (cleanupFailed) { setErrorState('hns', 'HNS is blocked until unresolved resolver cleanup is verified'); return; }
  if (recovering && permanentStartupError) return;
  if (!recovering) permanentStartupError = null;
  if (!hnsCapability.supported) {
    setStatusMessage('hns', hnsCapability.unsupportedReason);
    return;
  }
  runtimeWanted = true;
  if (!recovering) restartCount = 0;
  networkManager.setHnsProtectionRequired(true);
  if ([STATUS.RUNNING, STATUS.STARTING].includes(currentState)) return;
  if (currentState === STATUS.STOPPING) { pendingStart = true; return; }
  if (!networkMonitor) networkMonitor = createHnsNetworkMonitor({
    net: electronNet, powerMonitor,
    onChange: invalidateHnsGeneration,
    onStable: () => {
      if (runtimeWanted && !recovery && [STATUS.STOPPED, STATUS.ERROR].includes(currentState)) startHns(true);
    },
  });
  if (!networkMonitor.allowed()) {
    await networkManager.rebuild();
    setStatusMessage('hns', 'Waiting for an available network');
    return;
  }
  pendingStart = false;
  const generation = ++helperGeneration;
  const active = () => generation === helperGeneration && currentState === STATUS.STARTING && runtimeWanted;
  updateState(STATUS.STARTING);
  authority = createHnsAuthority({ onInvalid: invalidateHnsGeneration });
  readyTicket = null; readyPublished = false; activation = null;
  const binPath = getHelperBinaryPath();
  const hnsdPath = getHnsdBinaryPath();
  let permanentPreflight = true;
  try {
    if (!fs.existsSync(binPath)) throw new Error(`Helper binary not found: ${binPath}`);
    if (!fs.existsSync(hnsdPath)) throw new Error(`hnsd binary not found: ${hnsdPath}`);
    const binaryValidationError = getHelperBinaryValidationError(binPath);
    if (binaryValidationError) throw new Error(binaryValidationError);
    const dataDir = getHnsDataPath();
    const assetsDir = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', '..', 'assets');
    try { installHnsCheckpoint(path.join(assetsDir, 'hns', 'checkpoint_main.dat'), dataDir); }
    catch { throw new Error('HNS checkpoint unavailable or invalid'); }
    permanentPreflight = false;
    await networkManager.rebuild();
    if (!active()) return;
    const addresses = await allocateResolverAddrs();
    if (!active()) return;
    rootAddr = addresses.rootAddr; recursiveAddr = addresses.recursiveAddr;
    const preparation = createHnsValidatorTransport({ rootAddr, dataDir, binaryPath: hnsdPath, assetsDir,
      onFailure: (reason) => { if (generation === helperGeneration) invalidateHnsGeneration(reason); } });
    startingTransport = preparation;
    const transport = await preparation;
    if (startingTransport === preparation) startingTransport = null;
    if (!active()) { await transport.relay.close(); return; }
    encryptedRelay = transport.relay;
    hnsStderrLogState.clear();
    const args = ['-data-dir', dataDir, '-hnsd-path', transport.launcher,
      '-root-addr', rootAddr, '-recursive-addr', recursiveAddr];
    nativeCustody = transport.custody;
    nativeCustody.prepare();
    let child;
    try { child = spawn(binPath, args, { env: transport.env, shell: false }); }
    catch (error) { nativeCustody.neverSpawned(); nativeCustody = null; throw error; }
    helperProcess = child;
    childClosures.set(child, new Promise((resolve) => child.once('close', resolve)));
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => { if (generation === helperGeneration && child === helperProcess) parseStdoutLine(line); });
    child.stderr.on('data', (data) => { if (generation === helperGeneration) logHnsStderr(data); });
    child.on('close', () => rl.close());
    child.on('exit', () => {
      if (generation === helperGeneration && child === helperProcess) invalidateHnsGeneration('hns_helper_exited');
    });
    child.on('error', () => {
      if (generation === helperGeneration && child === helperProcess) invalidateHnsGeneration('hns_helper_failed');
    });
    if (!Number.isSafeInteger(child.pid)) {
      nativeCustody.neverSpawned(); nativeCustody = null;
      invalidateHnsGeneration('hns_helper_not_spawned'); return;
    }
    nativeCustody.bindParent(child.pid);
    try { await transport.custody.capture(); }
    catch { if (generation === helperGeneration) invalidateHnsGeneration('native_hns_custody_failed'); }
  } catch (error) {
    if (error.code === 'HNS_CUSTODY_UNRESOLVED') cleanupFailed = true;
    if (generation === helperGeneration && runtimeWanted) {
      invalidateHnsGeneration('hns_start_failed', permanentPreflight ? error.message : null);
      if (permanentPreflight) await recovery;
    }
  }
}

function maybeRestart() {
  restartCount++;

  if (restartCount > MAX_RESTARTS) {
    log.error(`[HNS] Exceeded max restarts (${MAX_RESTARTS}), giving up`);
    updateState(STATUS.ERROR, 'HNS helper crashed too many times');
    setErrorState('hns', 'HNS crashed repeatedly');
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, restartCount - 1), 30000);
  log.info(`[HNS] Restarting in ${delay}ms (attempt ${restartCount})`);

  setTimeout(() => {
    if (runtimeWanted && networkMonitor?.allowed() && currentState === STATUS.STOPPED) {
      startHns(true);
    }
  }, delay);

  setTimeout(() => {
    if (currentState === STATUS.RUNNING) {
      restartCount = 0;
    }
  }, RESTART_RESET_MS);
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode != null) return Promise.resolve();
  if (!Number.isSafeInteger(child.pid)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let killTimer;
    const deadline = setTimeout(() => reject(new Error('HNS helper did not exit')), 5000);
    child.once('exit', () => { clearTimeout(deadline); clearTimeout(killTimer); resolve(); });
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2500);
    child.kill('SIGTERM');
  });
}

async function awaitChildClosure(child) {
  if (!child) return;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('HNS helper stdio did not close')), 2000);
  });
  try { await Promise.race([childClosures.get(child), deadline]); }
  finally { clearTimeout(timer); }
}

async function stopHns({ recovering = false } = {}) {
  clearHnsDiscoveryTimer();
  let observerCleanup;
  if (!recovering) {
    runtimeWanted = false; restartCount = 0; permanentStartupError = null;
    observerCleanup = networkMonitor?.close(); networkMonitor = null;
  }
  if (currentState === STATUS.STOPPING) {
    helperTeardown = Promise.all([helperTeardown, observerCleanup]).catch((error) => { cleanupFailed = true; throw error; });
    return helperTeardown;
  }
  pendingStart = false;
  helperGeneration += 1;
  readyPublished = false; readyTicket = null; activation = null;
  authority?.retire(); authority = null;
  networkManager.clearHnsProxy();
  clearHnsHealthState();
  caCertFingerprint = null;
  const child = helperProcess; helperProcess = null;
  const custody = nativeCustody; nativeCustody = null;
  const relay = encryptedRelay; encryptedRelay = null;
  const preparation = startingTransport; startingTransport = null;
  updateState(STATUS.STOPPING);
  helperTeardown = Promise.all([
    stopChild(child).then(() => custody?.terminate()).then(() => awaitChildClosure(child)), relay?.close(), observerCleanup,
    preparation?.then((transport) => transport.relay.close(), () => {}),
    networkManager.rebuild().then(() => updateSessionCertificates(false)),
  ]);
  try {
    let observedBarrier;
    do { observedBarrier = helperTeardown; await observedBarrier; } while (observedBarrier !== helperTeardown);
  }
  catch (error) { cleanupFailed = true; throw error; }
  proxyAddr = null; caPemPath = null; rootAddr = null; recursiveAddr = null;
  synced = false; canaryReady = false; height = 0; lastHeightChangeAt = 0;
  resetHnsReadiness(); hnsStderrLogState.clear();
  clearService('hns');
  // The listed roots outlive the helper, so the renderer's copy does too.
  updateService('hns', { publicSuffixes: getHnsPublicSuffixes(), discovery: getHnsDiscovery() });
  updateState(STATUS.STOPPED);
  if (pendingStart && runtimeWanted && (!networkMonitor || networkMonitor.allowed())) {
    pendingStart = false;
    const startPending = () => {
      if (runtimeWanted && currentState === STATUS.STOPPED && (!networkMonitor || networkMonitor.allowed())) startHns(true);
    };
    // A queued explicit retry must begin after the retiring recovery settles.
    if (recovery) recovery.then(startPending);
    else startPending();
  }
}

function checkBinary() {
  if (!hnsCapability.supported) return false;
  const binPath = getHelperBinaryPath();
  return fs.existsSync(binPath) && !getHelperBinaryValidationError(binPath);
}

function getHnsStatus() {
  const publishedProxyAddr = proxyAddr ? networkManager.getHnsProxyAddr() : null;
  return {
    supported: hnsCapability.supported,
    target: hnsCapability.target,
    unsupportedReason: hnsCapability.unsupportedReason,
    status: currentState,
    error: lastError,
    synced,
    canaryReady,
    localResolverReady,
    dohFallbackReady,
    height,
    peerCount,
    syncProgress,
    proxyAddr: publishedProxyAddr,
    caPemPath,
    rootAddr,
    recursiveAddr,
  };
}

function registerHnsIpc() {
  ipcMain.handle(IPC.HNS_START, async () => {
    await startHns();
    return getHnsStatus();
  });

  ipcMain.handle(IPC.HNS_STOP, async () => {
    await stopHns();
    return getHnsStatus();
  });

  ipcMain.handle(IPC.HNS_GET_STATUS, () => {
    return getHnsStatus();
  });
}

module.exports = {
  certificateChainContainsFingerprint,
  chromiumCertificateFingerprint,
  createCertificateVerifier,
  registerHnsSession,
  unregisterHnsSession,
  registerHnsIpc,
  startHns,
  stopHns,
  getHnsStatus,
  checkBinary,
  STATUS,
  runHnsHealthCheck,
};
