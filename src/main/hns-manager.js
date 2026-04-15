const log = require('./logger');
const { ipcMain, app, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
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

let proxyAddr = null;
let caPemPath = null;
let caCertFingerprint = null;
let synced = false;
let height = 0;

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

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.HNS_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

let pacServer = null;
let pacPort = null;

function buildPacScript(proxyAddress) {
  return `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "127.0.0.*") || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
  if (dnsDomainLevels(host) === 0) {
    return "PROXY ${proxyAddress}";
  }
  return "DIRECT";
}`;
}

async function startPacServer(pacContent) {
  if (pacServer) {
    pacServer.close();
    pacServer = null;
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

async function configureProxy(targetSession) {
  if (!proxyAddr) {
    log.warn('[HNS] Cannot configure proxy: no proxy address');
    return;
  }

  const pac = buildPacScript(proxyAddr);
  const port = await startPacServer(pac);
  const pacUrl = `http://127.0.0.1:${port}/proxy.pac`;
  await targetSession.setProxy({ pacScript: pacUrl });
  log.info(`[HNS] Proxy configured via PAC at ${pacUrl}`);
}

async function clearProxy(targetSession) {
  await stopPacServer();
  await targetSession.setProxy({ proxyRules: '' });
  log.info('[HNS] Proxy configuration cleared');
}

function configureCertVerification(targetSession) {
  if (!caCertFingerprint) {
    log.warn('[HNS] Cannot configure cert verification: no CA fingerprint');
    return;
  }

  const trustedFingerprint = caCertFingerprint;

  targetSession.setCertificateVerifyProc((request, callback) => {
    try {
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

  if (!caPemPath || !loadCaFingerprint(caPemPath)) {
    updateState(STATUS.ERROR, 'Failed to load HNS CA certificate');
    setErrorState('hns', 'CA certificate missing or invalid');
    return;
  }

  const defaultSession = session.defaultSession;

  try {
    await configureProxy(defaultSession);
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
        synced = event.synced || false;
        height = event.height || 0;

        updateService('hns', {
          synced,
          height,
        });

        if (synced) {
          clearErrorState('hns');
          setStatusMessage('hns', null);
          log.info(`[HNS] Synced at height ${height}`);
        } else {
          setStatusMessage('hns', `Syncing block ${height}`);
          log.info(`[HNS] Syncing: height ${height}`);
        }
        break;

      case 'error':
        log.error(`[HNS] Helper error: ${event.error}`);
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

  const args = [
    '-data-dir', dataDir,
    '-hnsd-path', hnsdPath,
  ];

  log.info(`[HNS] Starting: ${binPath} ${args.join(' ')}`);

  try {
    helperProcess = spawn(binPath, args);

    const rl = readline.createInterface({ input: helperProcess.stdout });
    rl.on('line', parseStdoutLine);

    helperProcess.stderr.on('data', (data) => {
      log.error(`[HNS stderr]: ${data}`);
    });

    helperProcess.on('close', (code) => {
      log.info(`[HNS] Process exited with code ${code}`);
      helperProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `Exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }

      clearProxy(session.defaultSession).catch((err) => {
        log.error(`[HNS] Failed to clear proxy on process exit: ${err.message}`);
      });
      clearCertVerification(session.defaultSession);
      clearService('hns');
      proxyAddr = null;
      caPemPath = null;
      caCertFingerprint = null;
      synced = false;
      height = 0;

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
      clearProxy(session.defaultSession).then(() => resolve());
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
    height,
    proxyAddr,
    caPemPath,
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
