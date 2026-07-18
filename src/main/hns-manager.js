const log = require('./logger');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const IPC = require('../shared/ipc-channels');
const { refreshHnsPublicSuffixes } = require('../shared/hns-hosts');
const { getHnsDataDir } = require('./profile-paths');
const {
  MODE,
  clearErrorState,
  clearService,
  setErrorState,
  setStatusMessage,
  updateService,
} = require('./service-registry');

const STATUS = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
});

const SUPPORTED_TARGETS = new Set(['linux-x64']);
const MAX_RESTARTS = 5;
const RESTART_RESET_MS = 10 * 60 * 1000;

let currentState = STATUS.STOPPED;
let lastError = null;
let helperProcess = null;
let pendingStart = false;
let forceKillTimeout = null;
let restartCount = 0;
let proxyAddr = null;
let caPemPath = null;
let rootAddr = null;
let recursiveAddr = null;
let height = 0;
let synced = false;
let syncProgress = null;
let lastProcessError = null;
let restartTimer = null;
let restartResetTimer = null;

function getTargetKey() {
  return `${process.platform}-${process.arch}`;
}

function isSupportedPlatform() {
  return SUPPORTED_TARGETS.has(getTargetKey());
}

function getPlatformDirectory() {
  const names = { darwin: 'mac', linux: 'linux', win32: 'win' };
  return `${names[process.platform] || process.platform}-${process.arch}`;
}

function getBinaryPath(binaryName) {
  const executable = process.platform === 'win32' ? `${binaryName}.exe` : binaryName;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'hns-bin', executable);
  }
  return path.join(__dirname, '..', '..', 'hns-bin', getPlatformDirectory(), executable);
}

function getHelperBinaryPath() {
  return getBinaryPath('fingertipd');
}

function getHnsdBinaryPath() {
  return getBinaryPath('hnsd');
}

function checkBinary() {
  if (!isSupportedPlatform()) return false;
  return fs.existsSync(getHelperBinaryPath()) && fs.existsSync(getHnsdBinaryPath());
}

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? address?.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
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
      try { socket.close(); } catch { /* already closed */ }
      resolve(available);
    };
    socket.once('error', () => finish(false));
    socket.bind(port, '127.0.0.1', () => finish(true));
  });
}

async function reserveLoopbackPort(excluded = new Set()) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await reserveTcpPort();
    if (port && !excluded.has(port) && await canBindUdpPort(port)) return port;
  }
  throw new Error('Failed to reserve a loopback TCP/UDP port');
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

function getHnsStatus() {
  return {
    status: currentState,
    error: lastError,
    available: checkBinary(),
    supported: isSupportedPlatform(),
    height,
    synced,
    syncProgress,
    proxyAddr,
    caPemPath,
    rootAddr,
    recursiveAddr,
  };
}

function broadcastStatus() {
  const status = getHnsStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send(IPC.HNS_STATUS_UPDATE, status); } catch { /* closing */ }
  }
}

function updateState(state, error = null) {
  currentState = state;
  lastError = error;
  broadcastStatus();
}

function resetRuntimeState() {
  proxyAddr = null;
  caPemPath = null;
  rootAddr = null;
  recursiveAddr = null;
  height = 0;
  synced = false;
  syncProgress = null;
  lastProcessError = null;
}

function publishSyncState() {
  updateService('hns', {
    api: proxyAddr ? `http://${proxyAddr}` : null,
    gateway: null,
    mode: MODE.BUNDLED,
    height,
    synced,
    syncProgress,
    rootAddr,
    recursiveAddr,
  });
  setStatusMessage('hns', synced ? null : `Syncing HNS headers at block ${height}`);
  broadcastStatus();
}

function parseHelperEvent(line) {
  if (!line?.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }

  if (event.type === 'ready') {
    proxyAddr = event.proxyAddr || null;
    caPemPath = event.caPath || null;
    currentState = STATUS.RUNNING;
    clearErrorState('hns');
    publishSyncState();
    refreshHnsPublicSuffixes().catch((error) => {
      log.warn(`[HNS] Public namespace refresh failed: ${error.message}`);
    });
    return;
  }

  if (event.type === 'sync') {
    height = Number.isSafeInteger(event.height) ? event.height : height;
    synced = event.synced === true || event.canaryReady === true;
    syncProgress = Number.isFinite(event.progress) ? event.progress : null;
    if (synced) clearErrorState('hns');
    publishSyncState();
    return;
  }

  if (event.type === 'error') {
    lastProcessError = event.error || 'Unknown HNS helper error';
    setErrorState('hns', lastProcessError);
  }
}

function scheduleRestart() {
  restartCount += 1;
  if (restartCount > MAX_RESTARTS) {
    updateState(STATUS.ERROR, 'HNS helper crashed repeatedly');
    setErrorState('hns', 'HNS helper crashed repeatedly');
    return;
  }
  const delay = Math.min(1000 * (2 ** (restartCount - 1)), 30_000);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (currentState === STATUS.STOPPED) startHns();
  }, delay);
  if (restartResetTimer) clearTimeout(restartResetTimer);
  restartResetTimer = setTimeout(() => {
    restartResetTimer = null;
    if (currentState === STATUS.RUNNING) restartCount = 0;
  }, RESTART_RESET_MS);
}

async function startHns() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) return getHnsStatus();
  if (currentState === STATUS.STOPPING) {
    pendingStart = true;
    return getHnsStatus();
  }

  if (!isSupportedPlatform()) {
    updateService('hns', { mode: MODE.DISABLED });
    setStatusMessage('hns', 'HNS is currently available on Linux x64 only');
    updateState(STATUS.ERROR, 'Unsupported platform');
    return getHnsStatus();
  }
  if (!checkBinary()) {
    setStatusMessage('hns', 'HNS binaries are not installed');
    updateState(STATUS.ERROR, 'HNS binaries are not installed');
    return getHnsStatus();
  }

  pendingStart = false;
  updateState(STATUS.STARTING);
  let addresses;
  try {
    addresses = await allocateResolverAddrs();
  } catch (error) {
    updateState(STATUS.ERROR, error.message);
    setErrorState('hns', 'HNS resolver ports unavailable');
    return getHnsStatus();
  }
  rootAddr = addresses.rootAddr;
  recursiveAddr = addresses.recursiveAddr;

  const args = [
    '-data-dir', getHnsDataDir(),
    '-hnsd-path', getHnsdBinaryPath(),
    '-root-addr', rootAddr,
    '-recursive-addr', recursiveAddr,
  ];
  try {
    helperProcess = spawn(getHelperBinaryPath(), args);
    readline.createInterface({ input: helperProcess.stdout }).on('line', parseHelperEvent);
    helperProcess.stderr.on('data', (data) => log.warn(`[HNS stderr] ${String(data).trim()}`));
    helperProcess.on('error', (error) => {
      setErrorState('hns', error.message);
      updateState(STATUS.ERROR, error.message);
    });
    helperProcess.on('close', (code) => {
      helperProcess = null;
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      forceKillTimeout = null;
      const wasStopping = currentState === STATUS.STOPPING;
      const exitError = code === 0 ? null : lastProcessError || `Exited with code ${code}`;
      clearService('hns');
      resetRuntimeState();
      updateState(STATUS.STOPPED, wasStopping ? null : exitError);
      if (pendingStart) {
        pendingStart = false;
        setTimeout(startHns, 100);
      } else if (!wasStopping && code !== 0) {
        scheduleRestart();
      }
    });
  } catch (error) {
    helperProcess = null;
    updateState(STATUS.ERROR, error.message);
    setErrorState('hns', error.message);
  }
  return getHnsStatus();
}

function stopHns() {
  return new Promise((resolve) => {
    pendingStart = false;
    restartCount = 0;
    if (restartTimer) clearTimeout(restartTimer);
    if (restartResetTimer) clearTimeout(restartResetTimer);
    restartTimer = null;
    restartResetTimer = null;
    if (!helperProcess) {
      clearService('hns');
      resetRuntimeState();
      updateState(STATUS.STOPPED);
      resolve(getHnsStatus());
      return;
    }
    helperProcess.once('close', () => resolve(getHnsStatus()));
    updateState(STATUS.STOPPING);
    forceKillTimeout = setTimeout(() => {
      helperProcess?.kill('SIGKILL');
      forceKillTimeout = null;
    }, 5000);
    helperProcess.kill('SIGTERM');
  });
}

function resetForTests() {
  if (forceKillTimeout) clearTimeout(forceKillTimeout);
  if (restartTimer) clearTimeout(restartTimer);
  if (restartResetTimer) clearTimeout(restartResetTimer);
  currentState = STATUS.STOPPED;
  lastError = null;
  helperProcess = null;
  pendingStart = false;
  forceKillTimeout = null;
  restartTimer = null;
  restartResetTimer = null;
  restartCount = 0;
  resetRuntimeState();
}

function registerHnsIpc() {
  ipcMain.handle(IPC.HNS_START, startHns);
  ipcMain.handle(IPC.HNS_STOP, stopHns);
  ipcMain.handle(IPC.HNS_GET_STATUS, getHnsStatus);
  ipcMain.handle(IPC.HNS_CHECK_BINARY, () => ({
    available: checkBinary(),
    supported: isSupportedPlatform(),
  }));
}

module.exports = {
  STATUS,
  allocateResolverAddrs,
  checkBinary,
  getHelperBinaryPath,
  getHnsDataPath: getHnsDataDir,
  getHnsStatus,
  getHnsdBinaryPath,
  isSupportedPlatform,
  parseHelperEvent,
  registerHnsIpc,
  _resetForTests: resetForTests,
  startHns,
  stopHns,
};
