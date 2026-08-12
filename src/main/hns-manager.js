const log = require('./logger');
const { ipcMain, app, session } = require('electron');
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
const {
  buildHnsHealthProbeHosts,
  formatHnsHealthSummary,
  probeHnsResolver,
} = require('./hns-health');
const { pruneUnknownSingleLabelHistory } = require('./browser-state-sanitizer');
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
let pendingStart = false;
let forceKillTimeout = null;
let restartCount = 0;
const MAX_RESTARTS = 5;
const RESTART_RESET_MS = 10 * 60 * 1000;
const HNS_SYNC_QUIET_MS = 20 * 1000;
const HNS_STDERR_REPEAT_WINDOW_MS = 30 * 1000;
const HNS_HEALTH_INITIAL_DELAY_MS = 1000;
const HNS_HEALTH_RETRY_BASE_MS = 5000;
const HNS_HEALTH_RETRY_MAX_MS = 60 * 1000;
const HNS_LOCAL_READY_SUCCESS_THRESHOLD = 2;
const HNS_LOCAL_READY_FAILURE_THRESHOLD = 2;
const FORBIDDEN_HELPER_CANARIES = [['shake', 'station'].join('')];
const HNS_HELPER_TUNNEL_DNS_FAILURE_RE = /\[WARN\]\s+tunnel:\s+502\s+CONNECT\s+\S+\s+dns lookup failed/i;

let proxyAddr = null;
let caPemPath = null;
let caCertFingerprint = null;
let synced = false;
let canaryReady = false;
let localResolverReady = false;
let dohFallbackReady = false;
let height = 0;
let lastLoggedHeight = 0;
let lastHeightChangeAt = 0;
let rootAddr = null;
let recursiveAddr = null;
let lastProcessError = null;
const hnsStderrLogState = new Map();
let hnsHealthTimer = null;
let hnsHealthInFlight = false;
let hnsHealthAttempt = 0;
let lastHnsHealthOk = null;
let lastHnsHealthSummary = null;
let localReadySuccessCount = 0;
let localReadyFailureCount = 0;
let lastBroadcastReadiness = {
  dohFallbackReady: null,
  localResolverReady: null,
};

function normalizeHnsStderrLine(line) {
  return line.replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/, '');
}

function isExpectedHelperTunnelDnsFailure(line) {
  return HNS_HELPER_TUNNEL_DNS_FAILURE_RE.test(line);
}

function logHnsStderrLine(line) {
  if (isExpectedHelperTunnelDnsFailure(line)) {
    log.info(`[HNS helper] Local DNS miss; guard resolver will retry: ${line}`);
    return;
  }

  log.warn(`[HNS stderr]: ${line}`);
}

function logSuppressedHnsStderr(previous) {
  const message = isExpectedHelperTunnelDnsFailure(previous.lastLine)
    ? `[HNS helper] suppressed ${previous.suppressed} repeat local DNS miss(es): ${previous.lastLine}`
    : `[HNS stderr]: suppressed ${previous.suppressed} repeat(s): ${previous.lastLine}`;
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
  if (hnsHealthTimer) {
    clearTimeout(hnsHealthTimer);
    hnsHealthTimer = null;
  }
  hnsHealthInFlight = false;
  hnsHealthAttempt = 0;
  lastHnsHealthOk = null;
  lastHnsHealthSummary = null;
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

  hnsHealthInFlight = true;
  try {
    const hosts = buildHnsHealthProbeHosts(getHnsPublicSuffixes());
    const result = await probeHnsResolver({
      hosts,
      recursiveAddr,
    });
    if (!canProbeHnsHealth()) return result;

    const summary = formatHnsHealthSummary(result);
    const appPirateEntry = result.results.find((entry) => entry.host === 'app.pirate');
    let appPirateResolution = null;
    if (!appPirateEntry?.ok) {
      if (typeof networkManager.getHnsResolutionForHost === 'function') {
        appPirateResolution = await networkManager.getHnsResolutionForHost('app.pirate');
      } else if (await networkManager.canResolveHnsFallbackForHost?.('app.pirate') === true) {
        appPirateResolution = { resolverType: 'doh' };
      }
    }
    const appPirateFallbackReady = Boolean(appPirateResolution);
    const appPirateRecursiveReady = Boolean(appPirateEntry?.ok && appPirateEntry.addresses?.length > 0);
    const appPirateLocalReady = Boolean(
      appPirateRecursiveReady ||
      appPirateResolution?.resolverType === 'local'
    );
    updateLocalResolverReadiness(appPirateLocalReady);
    dohFallbackReady = Boolean(
      appPirateResolution?.resolverType === 'doh' ||
      (appPirateFallbackReady && appPirateResolution?.resolverType !== 'local')
    );
    const readyForStatus = localResolverReady || dohFallbackReady;
    if (shouldBroadcastReadiness()) {
      updateService('hns', {
        localResolverReady,
        dohFallbackReady,
      });
    }

    const changed = summary !== lastHnsHealthSummary || result.ok !== lastHnsHealthOk;
    lastHnsHealthSummary = summary;
    lastHnsHealthOk = result.ok;

    if (result.ok || readyForStatus || appPirateLocalReady) {
      hnsHealthAttempt = 0;
      clearErrorState('hns');
      let resolverLabel = 'HTTPS last-resort resolver';
      if (appPirateRecursiveReady) {
        resolverLabel = 'app.pirate local recursive resolver';
      } else if (appPirateResolution?.resolverType === 'local') {
        resolverLabel = 'local delegation resolver';
      }
      const statusMessage = appPirateRecursiveReady
        ? `HNS resolver partially degraded; ${resolverLabel} ready`
        : `HNS recursive resolver recovering; using ${resolverLabel}`;
      setStatusMessage('hns', result.ok ? null : statusMessage);
      if (appPirateLocalReady && !localResolverReady) {
        scheduleHnsHealthRetry();
      }
      if (result.ok && changed) {
        log.info(`[HNS] Resolver health ok (${reason}): ${summary}`);
      } else if (!result.ok) {
        const retryDelayMs = scheduleHnsHealthRetry();
        if (changed) {
          const logPrefix = appPirateRecursiveReady
            ? 'Resolver partially degraded'
            : 'Local recursive resolver unavailable';
          log.info(
            `[HNS] ${logPrefix} (${reason}): ${summary}; ${resolverLabel} ready; retrying in ${retryDelayMs}ms`
          );
        }
      }
      return result;
    }

    hnsHealthAttempt += 1;
    setStatusMessage('hns', 'HNS resolver degraded');
    const retryDelayMs = scheduleHnsHealthRetry();
    if (changed) {
      log.warn(`[HNS] Resolver degraded (${reason}): ${summary}; retrying in ${retryDelayMs}ms`);
    }
    return result;
  } finally {
    hnsHealthInFlight = false;
  }
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

  targetSession.setCertificateVerifyProc(createCertificateVerifier(trustedFingerprint));
  log.info('[HNS] Certificate verification configured');
}

function clearCertVerification(targetSession) {
  targetSession.setCertificateVerifyProc(null);
  log.info('[HNS] Certificate verification cleared');
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

async function handleReady(event) {
  proxyAddr = event.proxyAddr || null;
  caPemPath = event.caPath || null;
  lastProcessError = null;

  if (!caPemPath || !loadCaFingerprint(caPemPath)) {
    updateState(STATUS.ERROR, 'Failed to load HNS CA certificate');
    setErrorState('hns', 'CA certificate missing or invalid');
    return;
  }

  const defaultSession = session.defaultSession;
  let publishedProxyAddr;

  try {
    networkManager.setHnsProxy(proxyAddr);
    networkManager.setHnsResolverAddrs?.({ rootAddr, recursiveAddr });
    await networkManager.rebuild();
    publishedProxyAddr = networkManager.getHnsProxyAddr() || null;
    networkManager.refreshImportedHnsSuffixes()
      .then((suffixes) => {
        updateService('hns', { publicSuffixes: suffixes });
        if (suffixes.length > 1) {
          pruneUnknownSingleLabelHistory();
        }
        scheduleHnsHealthCheck('suffix refresh');
      })
      .catch((err) => {
        log.warn(`[HNS] Imported namespace suffix refresh failed: ${err.message}`);
      });
  } catch (err) {
    updateState(STATUS.ERROR, `Proxy configuration failed: ${err.message}`);
    setErrorState('hns', 'Proxy configuration failed');
    return;
  }

  configureCertVerification(defaultSession);

  updateService('hns', {
    api: publishedProxyAddr ? `http://${publishedProxyAddr}` : null,
    proxy: publishedProxyAddr,
    mode: MODE.BUNDLED,
    publicSuffixes: getHnsPublicSuffixes(),
  });
  setStatusMessage('hns', null);

  updateState(STATUS.RUNNING);
  log.info(`[HNS] Helper ready: proxy=${publishedProxyAddr || 'unavailable'}, upstream=${proxyAddr}, ca=${caPemPath}`);
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
        {
          const nextHeight = event.height || 0;
          if (nextHeight > height) {
            lastHeightChangeAt = Date.now();
          }
          height = nextHeight;

          const helperReady = event.synced === true || event.canaryReady === true;
          const heightReady =
            height > 0 &&
            lastHeightChangeAt > 0 &&
            Date.now() - lastHeightChangeAt >= HNS_SYNC_QUIET_MS;

          const readyNow = helperReady || heightReady;
          synced = synced || readyNow;
          canaryReady = canaryReady || readyNow;
          if (!synced) {
            resetHnsReadiness();
          }
        }

        updateService('hns', {
          synced,
          canaryReady,
          localResolverReady,
          dohFallbackReady,
          height,
        });

        if (synced) {
          clearErrorState('hns');
          setStatusMessage('hns', null);
          if (height !== lastLoggedHeight) {
            lastLoggedHeight = height;
            log.info(`[HNS] Synced at height ${height}`);
          }
          scheduleHnsHealthCheck('sync');
        } else {
          setStatusMessage('hns', `Syncing block ${height}`);
        }
        break;

      case 'error':
        log.error(`[HNS] Helper error: ${event.error}`);
        lastProcessError = event.error || 'Unknown error';
        setErrorState('hns', event.error || 'Unknown error');
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

async function startHns() {
  if (!hnsCapability.supported) {
    log.info(`[HNS] Start blocked on unsupported target ${hnsCapability.target}`);
    setStatusMessage('hns', hnsCapability.unsupportedReason);
    return;
  }

  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[HNS] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[HNS] Currently stopping, queuing start');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  const binPath = getHelperBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Helper binary not found at ${binPath}`);
    setStatusMessage('hns', 'HNS not available');
    return;
  }

  const binaryValidationError = getHelperBinaryValidationError(binPath);
  if (binaryValidationError) {
    log.error(`[HNS] ${binaryValidationError}`);
    updateState(STATUS.ERROR, binaryValidationError);
    setErrorState('hns', 'HNS helper binary is obsolete');
    setStatusMessage('hns', 'HNS helper binary is obsolete');
    return;
  }

  const dataDir = getHnsDataPath();

  const hnsdPath = getHnsdBinaryPath();
  if (!fs.existsSync(hnsdPath)) {
    updateState(STATUS.ERROR, `hnsd binary not found at ${hnsdPath}`);
    setStatusMessage('hns', 'HNS not available');
    return;
  }

  let resolverAddrs;
  try {
    resolverAddrs = await allocateResolverAddrs();
  } catch (err) {
    updateState(STATUS.ERROR, `Resolver port allocation failed: ${err.message}`);
    setErrorState('hns', 'HNS resolver ports unavailable');
    return;
  }

  rootAddr = resolverAddrs.rootAddr;
  recursiveAddr = resolverAddrs.recursiveAddr;
  lastProcessError = null;
  hnsStderrLogState.clear();

  const args = [
    '-data-dir', dataDir,
    '-hnsd-path', hnsdPath,
    '-root-addr', rootAddr,
    '-recursive-addr', recursiveAddr,
  ];

  log.info(`[HNS] Starting: ${binPath} ${args.join(' ')}`);

  try {
    helperProcess = spawn(binPath, args);

    const rl = readline.createInterface({ input: helperProcess.stdout });
    rl.on('line', parseStdoutLine);

    helperProcess.stderr.on('data', logHnsStderr);

    helperProcess.on('close', (code) => {
      log.info(`[HNS] Process exited with code ${code}`);
      helperProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      const exitError =
        code !== 0 ? lastProcessError || `Exited with code ${code}` : null;

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, exitError);
      } else {
        updateState(STATUS.STOPPED);
      }

      networkManager.clearHnsProxy();
      networkManager.rebuild().catch((err) => {
        log.error(`[HNS] Failed to rebuild proxy on process exit: ${err.message}`);
      });
      clearHnsHealthState();
      clearCertVerification(session.defaultSession);
      clearService('hns');
      proxyAddr = null;
      caPemPath = null;
      caCertFingerprint = null;
      synced = false;
      canaryReady = false;
      resetHnsReadiness();
      height = 0;
      rootAddr = null;
      recursiveAddr = null;
      lastHeightChangeAt = 0;
      lastProcessError = null;
      hnsStderrLogState.clear();

      if (pendingStart) {
        log.info('[HNS] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startHns(), 100);
      } else if (currentState === STATUS.STOPPED && code !== 0) {
        maybeRestart();
      }
    });

    helperProcess.on('error', (err) => {
      log.error('[HNS] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('hns', 'HNS failed to start');
    });
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('hns', 'HNS failed to start');
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
    if (currentState === STATUS.STOPPED) {
      startHns();
    }
  }, delay);

  setTimeout(() => {
    if (currentState === STATUS.RUNNING) {
      restartCount = 0;
    }
  }, RESTART_RESET_MS);
}

function stopHns() {
  return new Promise((resolve) => {
    pendingStart = false;
    restartCount = 0;

    if (!helperProcess) {
      updateState(STATUS.STOPPED);
      clearService('hns');
      networkManager.clearHnsProxy();
      clearHnsHealthState();
      rootAddr = null;
      recursiveAddr = null;
      lastHeightChangeAt = 0;
      lastProcessError = null;
      networkManager.rebuild().then(() => resolve());
      clearCertVerification(session.defaultSession);
      return;
    }

    const onExit = () => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      resolve();
    };

    helperProcess.once('close', onExit);

    updateState(STATUS.STOPPING);

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (helperProcess) {
        log.warn('[HNS] Force killing process...');
        helperProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);

    helperProcess.kill('SIGTERM');
  });
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
  registerHnsIpc,
  startHns,
  stopHns,
  getHnsStatus,
  checkBinary,
  STATUS,
  runHnsHealthCheck,
};
