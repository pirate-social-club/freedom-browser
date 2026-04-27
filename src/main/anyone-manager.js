const log = require('./logger');
const { ipcMain, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const IPC = require('../shared/ipc-channels');
const {
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
} = require('./service-registry');
const networkManager = require('./network-manager');

const STATES = {
  OFF: 'off',
  STARTING: 'starting',
  CONNECTED: 'connected',
  STOPPING: 'stopping',
  ERROR: 'error',
};

const ANYONE_IP_CHECK_URL = 'https://api.ipify.org?format=json';
const ANYONE_IP_CHECK_TIMEOUT = 10000;
const ANYONE_IP_CHECK_ATTEMPTS = 3;
const ANYONE_IP_CHECK_DELAY_MS = 750;

let currentState = STATES.OFF;
let lastError = null;
let sdk = null;
let anyoneProcess = null;
let connectResult = null;

function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'anyone');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getTermsAgreementPath() {
  return path.join(getDataDir(), 'terms-agreement');
}

function getStatePath() {
  return path.join(getDataDir(), 'state.json');
}

function persistState() {
  fs.writeFileSync(
    getStatePath(),
    JSON.stringify(
      {
        lastState: currentState,
        lastError,
        connectResult,
      },
      null,
      2,
    ),
  );
}

function writeTermsAgreementFile() {
  fs.writeFileSync(getTermsAgreementPath(), 'agreed', 'utf8');
}

async function loadSdk() {
  if (sdk) return sdk;
  try {
    log.info('[Anyone] Loading @anyone-protocol/anyone-client SDK...');
    sdk = await import('@anyone-protocol/anyone-client');
    log.info(`[Anyone] SDK loaded: ${Object.keys(sdk).length} exports`);
    return sdk;
  } catch (err) {
    log.error('[Anyone] Failed to load SDK:', err);
    throw new Error('Anyone SDK not available', { cause: err });
  }
}

function summarizeCircuits(circuits) {
  if (!Array.isArray(circuits) || circuits.length === 0) return null;
  const built = circuits.find((circuit) => circuit?.state === 'BUILT');
  return built?.state || circuits[0]?.state || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryUntilValue(operation, attempts = ANYONE_IP_CHECK_ATTEMPTS) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await operation();
    if (value) return value;
    if (attempt < attempts - 1) {
      await sleep(ANYONE_IP_CHECK_DELAY_MS);
    }
  }
  return null;
}

async function resolveConnectedIpViaSdk(sdkModule, processInstance) {
  try {
    const socks = new sdkModule.Socks(processInstance);
    const response = await socks.get(ANYONE_IP_CHECK_URL, { timeout: ANYONE_IP_CHECK_TIMEOUT });
    return response?.data?.ip || null;
  } catch {
    return null;
  }
}

async function resolveConnectedIpViaProxy(socksPort) {
  if (!socksPort) return null;

  try {
    axios.defaults = axios.defaults || {};
    axios.defaults.adapter = 'http';
    axios.defaults.proxy = false;

    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);
    const response = await axios.get(ANYONE_IP_CHECK_URL, {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: ANYONE_IP_CHECK_TIMEOUT,
      adapter: 'http',
      proxy: false,
    });

    return response?.data?.ip || null;
  } catch {
    return null;
  }
}

async function resolveConnectedIp(sdkModule, processInstance) {
  const socksPort = processInstance?.getSOCKSPort?.();

  return retryUntilValue(async () => {
    const sdkIp = await resolveConnectedIpViaSdk(sdkModule, processInstance);
    if (sdkIp) return sdkIp;
    return resolveConnectedIpViaProxy(socksPort);
  });
}

async function resolveCircuitState(sdkModule, processInstance) {
  let control = null;
  try {
    control = new sdkModule.Control('127.0.0.1', processInstance.getControlPort());
    await control.authenticate();
    const circuits = await control.circuitStatus();
    return summarizeCircuits(circuits);
  } catch (err) {
    log.warn(`[Anyone] Failed to inspect circuit state: ${err.message}`);
    return null;
  } finally {
    control?.end?.();
  }
}

function isSuppressedKillWarning(message) {
  return typeof message === 'string'
    && message.startsWith('Error killing Anon processes:');
}

function isNoStaleProcessError(err) {
  const combined = `${err?.message || ''} ${err?.stderr || ''}`;
  return err?.code === 1 || combined.includes('ps aux | grep anon | grep -v grep');
}

async function withMutedKillWarnings(operation) {
  const originalError = console.error;
  console.error = (...args) => {
    if (isSuppressedKillWarning(args[0])) {
      return;
    }
    return originalError(...args);
  };

  try {
    return await operation();
  } finally {
    console.error = originalError;
  }
}

async function killStaleProcess(sdkModule, reason) {
  if (!sdkModule?.Process?.killAnonProcess) return false;
  try {
    const killed = await withMutedKillWarnings(() => sdkModule.Process.killAnonProcess());
    if (killed) {
      log.warn(`[Anyone] Killed stale anon process during ${reason}`);
    }
    return killed;
  } catch (err) {
    if (isNoStaleProcessError(err)) {
      return false;
    }
    log.warn(`[Anyone] Failed stale-process cleanup during ${reason}: ${err.message}`);
    return false;
  }
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  persistState();

  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.ANYONE_STATUS_UPDATE, getStatus());
  }
}

function getStatus() {
  return {
    state: currentState,
    connected: currentState === STATES.CONNECTED,
    proxy: connectResult?.proxy || null,
    socksPort: connectResult?.socksPort || null,
    controlPort: connectResult?.controlPort || null,
    circuitState: connectResult?.circuitState || null,
    ip: connectResult?.ip || null,
    error: lastError,
  };
}

async function startAnyone() {
  if (currentState === STATES.STARTING || currentState === STATES.CONNECTED) {
    return { success: false, error: 'Already connected or starting', status: getStatus() };
  }

  const sdkModule = await loadSdk();
  writeTermsAgreementFile();
  await killStaleProcess(sdkModule, 'start');

  lastError = null;
  connectResult = null;
  updateState(STATES.STARTING, null);

  try {
    anyoneProcess = new sdkModule.Process({
      displayLog: false,
      autoTermsAgreement: true,
      termsFilePath: getTermsAgreementPath(),
    });

    await anyoneProcess.start();

    const socksPort = anyoneProcess.getSOCKSPort();
    const controlPort = anyoneProcess.getControlPort();
    const ip = await resolveConnectedIp(sdkModule, anyoneProcess);
    const circuitState = await resolveCircuitState(sdkModule, anyoneProcess);

    connectResult = {
      proxy: `127.0.0.1:${socksPort}`,
      socksPort,
      controlPort,
      circuitState,
      ip,
    };

    networkManager.setAnyoneProxy('127.0.0.1', socksPort);
    await networkManager.rebuild();

    updateService('anyone', {
      proxy: connectResult.proxy,
      connected: true,
      socksPort,
      controlPort,
      circuitState,
      error: null,
    });
    clearErrorState('anyone');
    setStatusMessage('anyone', null);

    updateState(STATES.CONNECTED, null);
    log.info(`[Anyone] Connected: socks=${socksPort} control=${controlPort} ip=${ip}`);
    return { success: true, status: getStatus() };
  } catch (err) {
    log.error('[Anyone] Start failed:', err.message);
    await killStaleProcess(sdkModule, 'start_failure');
    anyoneProcess = null;
    connectResult = null;
    networkManager.clearAnyoneProxy();
    await networkManager.rebuild();
    setErrorState('anyone', err.message);
    updateService('anyone', {
      proxy: null,
      connected: false,
      socksPort: null,
      controlPort: null,
      circuitState: null,
      error: err.message,
    });
    updateState(STATES.ERROR, err.message);
    return { success: false, error: err.message, status: getStatus() };
  }
}

async function stopAnyone() {
  if (currentState === STATES.OFF) {
    return { success: true, status: getStatus() };
  }

  updateState(STATES.STOPPING, null);

  const sdkModule = await loadSdk();
  try {
    if (anyoneProcess?.isRunning()) {
      await anyoneProcess.stop();
    }
  } catch (err) {
    log.warn(`[Anyone] Stop signaled with error: ${err.message}`);
  }

  await killStaleProcess(sdkModule, 'stop');

  anyoneProcess = null;
  connectResult = null;

  networkManager.clearAnyoneProxy();
  await networkManager.rebuild();

  updateService('anyone', {
    proxy: null,
    connected: false,
    socksPort: null,
    controlPort: null,
    circuitState: null,
    error: null,
  });
  clearErrorState('anyone');
  updateState(STATES.OFF, null);

  log.info('[Anyone] Stopped');
  return { success: true, status: getStatus() };
}

async function initAnyone() {
  writeTermsAgreementFile();
  const sdkModule = await loadSdk();
  await killStaleProcess(sdkModule, 'init');

  connectResult = null;
  updateService('anyone', {
    proxy: null,
    connected: false,
    socksPort: null,
    controlPort: null,
    circuitState: null,
    error: null,
  });
  clearErrorState('anyone');
  updateState(STATES.OFF, null);
  log.info('[Anyone] Initialized');
}

function registerAnyoneIpc() {
  ipcMain.handle(IPC.ANYONE_START, async () => startAnyone());
  ipcMain.handle(IPC.ANYONE_STOP, async () => stopAnyone());
  ipcMain.handle(IPC.ANYONE_GET_STATUS, () => getStatus());
}

module.exports = {
  registerAnyoneIpc,
  initAnyone,
  startAnyone,
  stopAnyone,
  getStatus,
  getTermsAgreementPath,
  STATES,
};
