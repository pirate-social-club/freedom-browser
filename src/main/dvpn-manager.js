const log = require('./logger');
const { ipcMain, app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');
const IPC = require('../shared/ipc-channels');
const {
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
} = require('./service-registry');
const networkManager = require('./network-manager');
const { loadSettings } = require('./settings-store');

const STATES = {
  OFF: 'off',
  WALLET_READY: 'wallet_ready',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTING: 'disconnecting',
  REMOTE_PENDING: 'local_off_remote_pending',
  ERROR: 'error',
};

let currentState = STATES.OFF;
let walletAddress = null;
let connectResult = null;
let balancePollTimer = null;
let durationTimer = null;
let lastDisconnectReason = null;
let lastError = null;
let cachedBalance = null;
let cachedFunded = false;

let sdk = null;
let sdkHttpHardened = false;
const DVPN_MAX_CONNECT_ATTEMPTS = 7;
const DVPN_IP_CHECK_URL = 'https://api.ipify.org?format=json';
const DVPN_IP_CHECK_TIMEOUT = 10000;

function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'dvpn');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getWalletPath() {
  return path.join(getDataDir(), 'wallet.enc');
}

function getStatePath() {
  return path.join(getDataDir(), 'state.json');
}

function walletExists() {
  return fs.existsSync(getWalletPath());
}

async function loadSdk() {
  if (sdk) return sdk;
  try {
    log.info('[dVPN] Loading sentinel-ai-connect SDK...');
    sdk = await import('sentinel-ai-connect');
    log.info(`[dVPN] SDK loaded: ${Object.keys(sdk).length} exports`);
    await hardenSdkHttpStack();
    return sdk;
  } catch (err) {
    log.error('[dVPN] Failed to load sentinel-ai-connect SDK:', err);
    throw new Error('dVPN SDK not available', { cause: err });
  }
}

function getSdkPackageRoot() {
  return path.dirname(require.resolve('sentinel-ai-connect/package.json'));
}

async function importModuleFromFile(modulePath) {
  return import(pathToFileURL(modulePath).href);
}

async function hardenSdkHttpStack() {
  if (sdkHttpHardened) return;

  let packageRoot;
  try {
    packageRoot = getSdkPackageRoot();
  } catch (err) {
    log.warn('[dVPN] Could not resolve sentinel-ai-connect package root:', err.message);
    return;
  }

  const candidateModules = [
    path.join(packageRoot, 'node_modules', 'axios', 'index.js'),
    path.join(packageRoot, 'node_modules', 'sentinel-dvpn-sdk', 'node_modules', 'axios', 'index.js'),
  ];

  const patched = [];

  for (const modulePath of candidateModules) {
    if (!fs.existsSync(modulePath)) continue;

    try {
      const axiosModule = await import(pathToFileURL(modulePath).href);
      const axios = axiosModule.default || axiosModule;
      if (!axios?.defaults) continue;
      axios.defaults.adapter = 'http';
      axios.defaults.proxy = false;
      patched.push(modulePath);
    } catch (err) {
      log.warn(`[dVPN] Failed to harden axios at ${modulePath}: ${err.message}`);
    }
  }

  if (patched.length > 0) {
    sdkHttpHardened = true;
    log.info(`[dVPN] Hardened SDK HTTP clients (${patched.length} axios module${patched.length === 1 ? '' : 's'})`);
  } else {
    log.warn('[dVPN] No SDK axios modules were patched');
  }
}

function isSuppressedSdkWarning(message) {
  return typeof message === 'string'
    && message.startsWith('[sentinel-ai] IP check skipped: missing dependency');
}

async function withMutedSdkWarnings(operation) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (isSuppressedSdkWarning(args[0])) {
      return;
    }
    return originalWarn(...args);
  };

  try {
    return await operation();
  } finally {
    console.warn = originalWarn;
  }
}

async function resolveConnectedIp(socksPort, moduleLoader = importModuleFromFile, packageRootOverride = null) {
  if (!socksPort) return null;

  let packageRoot = packageRootOverride;
  try {
    if (!packageRoot) {
      packageRoot = getSdkPackageRoot();
    }
  } catch {
    return null;
  }

  const axiosCandidates = [
    path.join(packageRoot, 'node_modules', 'axios', 'index.js'),
    path.join(packageRoot, 'node_modules', 'sentinel-dvpn-sdk', 'node_modules', 'axios', 'index.js'),
  ];
  const socksCandidates = [
    path.join(packageRoot, 'node_modules', 'socks-proxy-agent', 'dist', 'index.js'),
    path.join(packageRoot, 'node_modules', 'sentinel-dvpn-sdk', 'node_modules', 'socks-proxy-agent', 'dist', 'index.js'),
  ];

  const axiosPath = axiosCandidates.find((candidate) => fs.existsSync(candidate));
  const socksPath = socksCandidates.find((candidate) => fs.existsSync(candidate));
  if (!axiosPath || !socksPath) return null;

  try {
    const axiosModule = await moduleLoader(axiosPath);
    const socksModule = await moduleLoader(socksPath);
    const axios = axiosModule.default || axiosModule;
    const SocksProxyAgent = socksModule.SocksProxyAgent || socksModule.default?.SocksProxyAgent;
    if (!axios?.get || !SocksProxyAgent) return null;

    axios.defaults = axios.defaults || {};
    axios.defaults.adapter = 'http';
    axios.defaults.proxy = false;

    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);
    const response = await axios.get(DVPN_IP_CHECK_URL, {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: DVPN_IP_CHECK_TIMEOUT,
      adapter: 'http',
      proxy: false,
    });

    return response?.data?.ip || null;
  } catch {
    return null;
  }
}

function loadMnemonic() {
  const walletPath = getWalletPath();
  if (!fs.existsSync(walletPath)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    log.error('[dVPN] Cannot decrypt wallet: safeStorage unavailable');
    return null;
  }
  try {
    const encrypted = fs.readFileSync(walletPath);
    return safeStorage.decryptString(encrypted);
  } catch (err) {
    log.error('[dVPN] Failed to decrypt wallet:', err);
    return null;
  }
}

function saveMnemonic(mnemonic) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Device encryption not available');
  }
  const encrypted = safeStorage.encryptString(mnemonic);
  fs.writeFileSync(getWalletPath(), encrypted);
}

function persistState() {
  const statePath = getStatePath();
  const state = {
    lastState: currentState,
    lastSessionId: connectResult?.sessionId || null,
    lastSocksPort: connectResult?.socksPort || null,
    walletAddress,
    lastDisconnectReason,
    pendingSessionEnd:
      currentState === STATES.REMOTE_PENDING && connectResult?.sessionId
        ? connectResult.sessionId
        : null,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readPersistedState() {
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  persistState();

  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.DVPN_STATUS_UPDATE, getStatus());
  }
}

function getStatus() {
  return {
    state: currentState,
    walletAddress,
    connected: currentState === STATES.CONNECTED,
    sessionId: connectResult?.sessionId || null,
    protocol: connectResult?.protocol || null,
    nodeAddress: connectResult?.nodeAddress || null,
    country: connectResult?.country || null,
    ip: connectResult?.ip || null,
    socksPort: connectResult?.socksPort || null,
    balance: cachedBalance,
    funded: cachedFunded,
    lastDisconnectReason,
    error: lastError,
  };
}

async function createWallet() {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'Device encryption not available' };
  }

  const sdkModule = await loadSdk();
  const result = await sdkModule.createWallet();

  walletAddress = result.address;
  saveMnemonic(result.mnemonic);
  cachedBalance = null;
  cachedFunded = false;
  lastError = null;

  updateService('dvpn', {
    walletAddress,
    balance: null,
    connected: false,
    funded: false,
  });

  updateState(STATES.WALLET_READY);
  log.info(`[dVPN] Wallet created: ${walletAddress}`);

  return { success: true, address: walletAddress };
}

async function getBalance() {
  const mnemonic = loadMnemonic();
  if (!mnemonic) {
    return { success: false, error: 'No wallet' };
  }

  const sdkModule = await loadSdk();
  const balance = await sdkModule.getBalance(mnemonic);

  cachedBalance = balance.p2p;
  cachedFunded = balance.funded;

  updateService('dvpn', {
    balance: balance.p2p,
    funded: balance.funded,
  });

  return { success: true, p2p: balance.p2p, udvpn: balance.udvpn, funded: balance.funded };
}

async function startDvpn() {
  if (currentState === STATES.CONNECTED || currentState === STATES.CONNECTING) {
    return { success: false, error: 'Already connected or connecting' };
  }

  const mnemonic = loadMnemonic();
  if (!mnemonic) {
    log.error('[dVPN] No wallet mnemonic available');
    return { success: false, error: 'No wallet' };
  }

  const settings = loadSettings();
  log.info(`[dVPN] Starting connection: maxSpend=${settings.dvpnMaxSpendP2P} lowBalanceStop=${settings.dvpnLowBalanceStop} maxDuration=${settings.dvpnMaxDurationMinutes}min`);

  const sdkModule = await loadSdk();

  lastDisconnectReason = null;
  lastError = null;
  updateState(STATES.CONNECTING);

  try {
    const balance = await sdkModule.getBalance(mnemonic);
    const maxSpend = settings.dvpnMaxSpendP2P || 1.0;
    const maxSpendUdVpn = Math.round(maxSpend * 1_000_000);

    cachedBalance = balance.p2p;
    cachedFunded = balance.funded;
    log.info(`[dVPN] Balance: p2p=${balance.p2p} udvpn=${balance.udvpn} funded=${balance.funded}`);

    if (balance.funded === false) {
      updateState(STATES.WALLET_READY, 'Insufficient balance. Fund your wallet.');
      return { success: false, error: 'Insufficient balance. Fund your wallet.' };
    }

    let gigabytes = 1;
    try {
      const costEstimate = await sdkModule.estimateCost({ gigabytes: 1 });
      if (costEstimate?.perGb?.udvpn) {
        const pricePerGbUdVpn = costEstimate.perGb.udvpn;
        const rawGb = maxSpendUdVpn / pricePerGbUdVpn;
        if (rawGb < 1) {
          updateState(STATES.WALLET_READY, 'Budget too small for 1 GB at current node prices.');
          return { success: false, error: 'Budget too small for 1 GB at current node prices.' };
        }
        gigabytes = Math.floor(rawGb);
        log.info(`[dVPN] Cost estimate: pricePerGb=${pricePerGbUdVpn} udvpn, gigabytes=${gigabytes}`);
      }
    } catch {
      log.warn('[dVPN] Cost estimation failed, using default gigabytes: 1');
    }

    const v2rayPath = getV2RayPath();
    log.info(`[dVPN] V2Ray path: ${v2rayPath || 'NOT FOUND'}`);
    if (!v2rayPath) {
      updateState(STATES.ERROR, 'V2Ray binary not found. Reinstall Freedom.');
      return { success: false, error: 'V2Ray binary not found. Reinstall Freedom.' };
    }

    const connectOpts = {
      mnemonic,
      protocol: 'v2ray',
      fullTunnel: false,
      systemProxy: false,
      gigabytes,
      maxAttempts: DVPN_MAX_CONNECT_ATTEMPTS,
      v2rayExePath: v2rayPath,
    };

    log.info(
      `[dVPN] Connecting with opts: protocol=v2ray gb=${gigabytes} attempts=${DVPN_MAX_CONNECT_ATTEMPTS} v2ray=${v2rayPath}`
    );
    const result = await withMutedSdkWarnings(() => sdkModule.connect(connectOpts));
    const resolvedIp = result.ip || await resolveConnectedIp(result.socksPort);
    if (!result.ip && resolvedIp) {
      log.info(`[dVPN] Resolved VPN IP via SOCKS proxy: ${resolvedIp}`);
    }

    connectResult = {
      sessionId: String(result.sessionId),
      protocol: result.protocol,
      nodeAddress: result.nodeAddress,
      country: result.country || null,
      ip: resolvedIp || null,
      socksPort: result.socksPort || null,
    };

    log.info(`[dVPN] SDK connect result: session=${connectResult.sessionId} socks=${connectResult.socksPort} node=${connectResult.nodeAddress}`);

    networkManager.setDvpnProxy('127.0.0.1', connectResult.socksPort);
    await networkManager.rebuild();

    updateService('dvpn', {
      proxy: `127.0.0.1:${connectResult.socksPort}`,
      connected: true,
      sessionId: connectResult.sessionId,
      protocol: connectResult.protocol,
      nodeAddress: connectResult.nodeAddress,
      country: connectResult.country,
      ip: connectResult.ip,
    });
    clearErrorState('dvpn');
    setStatusMessage('dvpn', null);

    updateState(STATES.CONNECTED, null);
    log.info(`[dVPN] Connected: session=${connectResult.sessionId} node=${connectResult.nodeAddress} ip=${connectResult.ip}`);

    startBudgetMonitors(settings);

    return { success: true };
  } catch (err) {
    log.error('[dVPN] Connection failed:', err.message);
    setErrorState('dvpn', err.message);
    updateState(STATES.ERROR, err.message);
    return { success: false, error: err.message };
  }
}

function getV2RayPath() {
  const binary = process.platform === 'win32' ? 'v2ray.exe' : 'v2ray';
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;

  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath, 'dvpn-bin', binary);
    if (fs.existsSync(packagedPath)) return packagedPath;
  }

  const devPaths = [
    path.join(__dirname, '..', '..', 'dvpn-bin', `${platform}-${process.arch}`, binary),
    path.join(__dirname, '..', '..', 'node_modules', 'sentinel-ai-connect', 'node_modules', 'sentinel-dvpn-sdk', 'bin', binary),
    path.join(__dirname, '..', '..', 'node_modules', 'sentinel-dvpn-sdk', 'bin', binary),
  ];

  for (const p of devPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function startBudgetMonitors(settings) {
  stopBudgetMonitors();

  const lowBalanceStop = settings.dvpnLowBalanceStop || 0.5;
  const lowBalanceStopUdVpn = Math.round(lowBalanceStop * 1_000_000);
  const maxDurationMinutes = settings.dvpnMaxDurationMinutes || 120;

  balancePollTimer = setInterval(async () => {
    try {
      const bal = await getBalance();
      if (bal.success && typeof bal.udvpn === 'number' && bal.udvpn < lowBalanceStopUdVpn) {
        log.info(`[dVPN] Balance below ${lowBalanceStop} P2P, auto-disconnecting`);
        lastDisconnectReason = 'low_balance';
        await stopDvpn();
      }
    } catch {
      // poll failure is non-critical
    }
  }, 60000);

  durationTimer = setTimeout(async () => {
    log.info('[dVPN] Max duration reached, auto-disconnecting');
    lastDisconnectReason = 'max_duration';
    await stopDvpn();
  }, maxDurationMinutes * 60 * 1000);
}

function stopBudgetMonitors() {
  if (balancePollTimer) {
    clearInterval(balancePollTimer);
    balancePollTimer = null;
  }
  if (durationTimer) {
    clearTimeout(durationTimer);
    durationTimer = null;
  }
}

async function stopDvpn() {
  if (currentState !== STATES.CONNECTED && currentState !== STATES.CONNECTING) {
    return { success: true };
  }

  log.info(`[dVPN] Disconnecting from state=${currentState}`);
  stopBudgetMonitors();
  updateState(STATES.DISCONNECTING, null);

  let remotePending = false;
  try {
    const sdkModule = await loadSdk();
    await sdkModule.disconnect();
  } catch (err) {
    log.error('[dVPN] Disconnect error:', err.message);
    remotePending = true;
  }

  networkManager.clearDvpnProxy();
  await networkManager.rebuild();

  if (remotePending) {
    lastDisconnectReason = lastDisconnectReason || 'error';
    updateService('dvpn', {
      proxy: null,
      connected: false,
      sessionId: connectResult?.sessionId || null,
      protocol: connectResult?.protocol || null,
      nodeAddress: connectResult?.nodeAddress || null,
      country: connectResult?.country || null,
      ip: connectResult?.ip || null,
      lastDisconnectReason,
    });
    updateState(STATES.REMOTE_PENDING, 'Session end pending. Will retry next launch.');
    return { success: false, error: 'Session end pending. Will retry next launch.' };
  }

  connectResult = null;
  lastDisconnectReason = lastDisconnectReason || 'user';

  updateService('dvpn', {
    proxy: null,
    connected: false,
    sessionId: null,
    protocol: null,
    nodeAddress: null,
    country: null,
    ip: null,
    lastDisconnectReason,
  });

  updateState(STATES.WALLET_READY, null);
  log.info('[dVPN] Disconnected');

  return { success: true };
}

async function initDvpn() {
  log.info('[dVPN] Initializing...');
  if (!walletExists()) {
    log.info('[dVPN] No wallet found, state=OFF');
    cachedBalance = null;
    cachedFunded = false;
    updateState(STATES.OFF, null);
    return;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    setErrorState('dvpn', 'Device encryption not available');
    updateState(STATES.ERROR, 'Device encryption not available');
    return;
  }

  const mnemonic = loadMnemonic();
  if (!mnemonic) {
    setErrorState('dvpn', 'Failed to decrypt wallet');
    updateState(STATES.ERROR, 'Failed to decrypt wallet');
    return;
  }

  try {
    const sdkModule = await loadSdk();
    const { address } = await sdkModule.importWallet(mnemonic);
    walletAddress = address;
    log.info(`[dVPN] Wallet rehydrated: ${walletAddress}`);
  } catch (err) {
    log.error('[dVPN] Wallet rehydration failed:', err.message);
    walletAddress = null;
  }

  const persisted = readPersistedState();
  if (persisted?.pendingSessionEnd || persisted?.lastState === STATES.CONNECTED || persisted?.lastState === STATES.REMOTE_PENDING) {
    log.info(`[dVPN] Previous session may be active (lastState=${persisted.lastState}), attempting cleanup`);
    try {
      const sdkModule = await loadSdk();
      await sdkModule.disconnect();
      log.info('[dVPN] Previous session cleanup succeeded');
    } catch (err) {
      log.warn(`[dVPN] Previous session cleanup failed: ${err.message}`);
    }
  } else {
    log.info(`[dVPN] No previous session to clean up (persisted.lastState=${persisted?.lastState})`);
  }

  if (persisted?.lastDisconnectReason) {
    lastDisconnectReason = persisted.lastDisconnectReason;
    log.info(`[dVPN] Restored lastDisconnectReason: ${lastDisconnectReason}`);
  }

  try {
    await getBalance();
    log.info(`[dVPN] Balance: ${cachedBalance}, funded=${cachedFunded}`);
  } catch (err) {
    log.warn(`[dVPN] Balance check failed during init: ${err.message}`);
  }

  updateService('dvpn', {
    walletAddress,
    connected: false,
    balance: cachedBalance,
    funded: cachedFunded,
    lastDisconnectReason,
  });

  updateState(STATES.WALLET_READY, null);
  log.info(`[dVPN] Initialized: wallet=${walletAddress}`);
}

function registerDvpnIpc() {
  ipcMain.handle(IPC.DVPN_START, async () => {
    const result = await startDvpn();
    return { ...result, status: getStatus() };
  });

  ipcMain.handle(IPC.DVPN_STOP, async () => {
    const result = await stopDvpn();
    return { ...result, status: getStatus() };
  });

  ipcMain.handle(IPC.DVPN_GET_STATUS, () => {
    return getStatus();
  });

  ipcMain.handle(IPC.DVPN_GET_BALANCE, async () => {
    return getBalance();
  });

  ipcMain.handle(IPC.DVPN_CREATE_WALLET, async () => {
    return createWallet();
  });

  ipcMain.handle(IPC.DVPN_GET_WALLET_ADDRESS, () => {
    return { success: true, address: walletAddress };
  });

  ipcMain.handle(IPC.DVPN_GENERATE_QR, async (_event, text, options = {}) => {
    try {
      const dataUrl = await QRCode.toDataURL(text, {
        width: options.width || 192,
        margin: options.margin || 1,
        color: {
          dark: options.dark || '#000000',
          light: options.light || '#ffffff',
        },
      });
      return { success: true, dataUrl };
    } catch (err) {
      log.error('[dVPN] Failed to generate QR code:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerDvpnIpc,
  initDvpn,
  stopDvpn,
  startDvpn,
  getStatus,
  walletExists,
  STATES,
  resolveConnectedIp,
  withMutedSdkWarnings,
  isSuppressedSdkWarning,
};
