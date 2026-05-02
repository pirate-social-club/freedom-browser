const log = require('./logger');
const { ipcMain, app, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const readline = require('readline');
const IPC = require('../shared/ipc-channels');
const {
  MODE,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const networkManager = require('./network-manager');

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

let proxyAddr = null;
let caPemPath = null;
let caCertFingerprint = null;
let synced = false;
let canaryReady = false;
let height = 0;
let lastLoggedHeight = 0;
let lastHeightChangeAt = 0;
let rootAddr = null;
let recursiveAddr = null;
let lastProcessError = null;
const hnsStderrLogState = new Map();

function isLoopbackHostname(hostname = '') {
  return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
}

function isHnsHostname(hostname = '') {
  if (!hostname || typeof hostname !== 'string') return false;

  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (isLoopbackHostname(normalized)) return false;

  if (!normalized.includes('.')) {
    return /^[a-z0-9-]+$/.test(normalized);
  }

  const labels = normalized.split('.');
  if (labels.length !== 2) return false;
  if (labels[1] !== 'pirate') return false;

  return /^[a-z0-9-]+$/.test(labels[0]);
}

function normalizeHnsStderrLine(line) {
  return line.replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/, '');
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
      log.warn(`[HNS stderr]: suppressed ${previous.suppressed} repeat(s): ${previous.lastLine}`);
    }

    log.warn(`[HNS stderr]: ${line}`);
    hnsStderrLogState.set(key, {
      lastLoggedAt: now,
      lastSeenAt: now,
      suppressed: 0,
      lastLine: line,
    });
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
    win.webContents.send(IPC.HNS_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

function configureCertVerification(targetSession) {
  if (!caCertFingerprint) {
    log.warn('[HNS] Cannot configure cert verification: no CA fingerprint');
    return;
  }

  const trustedFingerprint = caCertFingerprint;

  targetSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (proxyAddr && isHnsHostname(request?.hostname)) {
        callback(0);
        return;
      }

      const cert = request.certificate;
      if (cert && cert.fingerprint === trustedFingerprint) {
        callback(0);
        return;
      }

      for (const issuer of cert.issuerCert ? [cert.issuerCert] : []) {
        if (issuer.fingerprint === trustedFingerprint) {
          callback(0);
          return;
        }
      }
    } catch {
      // fall through to default
    }
    callback(-3);
  });
  log.info('[HNS] Certificate verification configured');
}

function clearCertVerification(targetSession) {
  targetSession.setCertificateVerifyProc(null);
  log.info('[HNS] Certificate verification cleared');
}

function loadCaFingerprint(pemPath) {
  try {
    const pemData = fs.readFileSync(pemPath, 'utf-8');
    const { X509Certificate } = require('crypto');
    const cert = new X509Certificate(pemData);
    caCertFingerprint = cert.fingerprint;
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

  try {
    networkManager.setHnsProxy(proxyAddr);
    await networkManager.rebuild();
    networkManager.refreshImportedHnsSuffixes().catch((err) => {
      log.warn(`[HNS] Imported namespace suffix refresh failed: ${err.message}`);
    });
  } catch (err) {
    updateState(STATUS.ERROR, `Proxy configuration failed: ${err.message}`);
    setErrorState('hns', 'Proxy configuration failed');
    return;
  }

  configureCertVerification(defaultSession);

  updateService('hns', {
    api: proxyAddr ? `http://${proxyAddr}` : null,
    proxy: proxyAddr,
    mode: MODE.BUNDLED,
  });
  setStatusMessage('hns', null);

  updateState(STATUS.RUNNING);
  log.info(`[HNS] Helper ready: proxy=${proxyAddr}, ca=${caPemPath}`);
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

          const helperReady =
            event.canaryReady === true ||
            (event.canaryReady === undefined && event.synced === true);
          const heightReady =
            height > 0 &&
            lastHeightChangeAt > 0 &&
            Date.now() - lastHeightChangeAt >= HNS_SYNC_QUIET_MS;

          synced = helperReady || heightReady;
          canaryReady = helperReady || heightReady;
        }

        updateService('hns', {
          synced,
          canaryReady,
          height,
        });

        if (synced) {
          clearErrorState('hns');
          setStatusMessage('hns', null);
          if (height !== lastLoggedHeight) {
            lastLoggedHeight = height;
            log.info(`[HNS] Synced at height ${height}`);
          }
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
      clearCertVerification(session.defaultSession);
      clearService('hns');
      proxyAddr = null;
      caPemPath = null;
      caCertFingerprint = null;
      synced = false;
      canaryReady = false;
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
  const binPath = getHelperBinaryPath();
  return fs.existsSync(binPath);
}

function getHnsStatus() {
  return {
    status: currentState,
    error: lastError,
    synced,
    canaryReady,
    height,
    proxyAddr,
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
  registerHnsIpc,
  startHns,
  stopHns,
  getHnsStatus,
  checkBinary,
  STATUS,
};
