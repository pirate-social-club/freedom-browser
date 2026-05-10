const log = require('./logger');
const { BrowserWindow, app, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
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
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTING: 'disconnecting',
  LOCAL_SERVER_RUNNING: 'local_server_running',
  ERROR: 'error',
};

const DEFAULT_PORT = 4464;
const DEFAULT_BUFFER_STRATEGY = '3';
const DEFAULT_QUALITY = '4';
const LOCAL_SERVER_QUALITY = '8';
const STOP_TIMEOUT_MS = 5000;
const EXEC_TIMEOUT_MS = 10000;
const JACK_WRAPPED_COMMANDS = new Set(['jacktrip', 'jack_lsp', 'jack_connect', 'jack_disconnect', 'jackd']);

let currentState = STATUS.DISCONNECTED;
let lastError = null;
let jacktripProcess = null;
let localServerProcess = null;
let forceKillTimeout = null;
let connection = null;
let audioState = {
  sourceName: null,
  sourceLabel: null,
  defaultInputSource: null,
  defaultInputIsDuetVirtual: false,
  restoreInputSourceHint: null,
  restoreInputSourceLabel: null,
};

function getStatus() {
  return {
    status: currentState,
    error: lastError,
    connection,
    audio: { ...audioState },
    localServerRunning: Boolean(localServerProcess),
  };
}

function broadcastStatus() {
  const status = getStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.JACKTRIP_STATUS_UPDATE, status);
    } catch {
      // Window might be closing.
    }
  }
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  broadcastStatus();
}

function isWindows() {
  return process.platform === 'win32';
}

function candidateBinaryNames(name) {
  if (isWindows() && !name.toLowerCase().endsWith('.exe')) {
    return [`${name}.exe`, name];
  }
  return [name];
}

function findInPath(name) {
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidateBinaryNames(name)) {
      const resolved = path.join(dir, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }
  return null;
}

function resolveJacktripBinary() {
  const explicit = process.env.JACKTRIP_BIN?.trim();
  if (explicit) {
    return explicit;
  }
  return findInPath('jacktrip') || 'jacktrip';
}

function resolveBinary(name) {
  if (name === 'jacktrip') {
    return resolveJacktripBinary();
  }
  return findInPath(name) || name;
}

function binaryExists(name) {
  const resolved = resolveBinary(name);
  return path.isAbsolute(resolved) ? fs.existsSync(resolved) : Boolean(findInPath(name));
}

function envTruthy(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function shouldUsePwJack() {
  return process.platform === 'linux'
    && envTruthy('JACKTRIP_USE_PW_JACK', true)
    && binaryExists('pw-jack');
}

function commandSpec(base) {
  const resolved = resolveBinary(base);
  if (JACK_WRAPPED_COMMANDS.has(base) && shouldUsePwJack()) {
    return {
      command: resolveBinary('pw-jack'),
      argsPrefix: [resolved],
    };
  }
  return {
    command: resolved,
    argsPrefix: [],
  };
}

function execCommand(base, args = [], options = {}) {
  const spec = commandSpec(base);
  return new Promise((resolve, reject) => {
    execFile(
      spec.command,
      [...spec.argsPrefix, ...args],
      {
        timeout: options.timeout ?? EXEC_TIMEOUT_MS,
        env: options.env || process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.trim() || error.message;
          reject(new Error(message));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function spawnCommand(base, args = []) {
  const spec = commandSpec(base);
  return spawn(spec.command, [...spec.argsPrefix, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function checkDeps() {
  const required = ['jacktrip'];
  const jackTools = ['jack_lsp', 'jack_connect', 'jack_disconnect'];
  const optional = process.platform === 'linux' ? ['pw-jack', 'pactl'] : [];
  const missingRequired = required.filter((name) => !binaryExists(name));
  const missingJackTools = jackTools.filter((name) => !binaryExists(name));
  const missingOptional = optional.filter((name) => !binaryExists(name));

  return {
    available: missingRequired.length === 0,
    jackToolsAvailable: missingJackTools.length === 0,
    missing: missingRequired,
    missingJackTools,
    missingOptional,
    jacktripBinary: resolveJacktripBinary(),
    usingPwJack: shouldUsePwJack(),
  };
}

function parsePort(value, fallback = DEFAULT_PORT) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return parsed;
}

function parseServer(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Server is required');
  }
  const server = value.trim();
  if (server.length > 253 || /[\s/\\]/.test(server)) {
    throw new Error('Server must be a hostname or IP address');
  }
  return server;
}

function parseBindPort(peerPort, explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return parsePort(explicit);
  }
  const envValue = process.env.JACKTRIP_BIND_PORT;
  if (envValue) {
    return parsePort(envValue);
  }
  return peerPort === 65535 ? peerPort : peerPort + 1;
}

function getScriptPath(name) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'jacktrip-scripts', name);
  }
  return path.join(__dirname, '..', '..', 'scripts', 'jacktrip', name);
}

function parseKeyValues(raw) {
  const out = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isDuetLikeSourceName(value) {
  const source = String(value || '').trim().toLowerCase();
  return source.includes('jacktrip_duet') || source.endsWith('.monitor');
}

function requiredField(values, key) {
  const value = values[key]?.trim();
  if (!value) {
    throw new Error(`setup script did not return ${key}`);
  }
  return value;
}

function normalizeAudioSetupResult(values) {
  const sourceName = requiredField(values, 'source_name');
  const sourceLabel = values.browser_pick_label || values.source_description || sourceName;
  const defaultSourceAfter = values.default_source_after || values.default_source_before || null;
  const result = {
    backend: values.backend || 'unknown',
    sinkName: requiredField(values, 'sink_name'),
    sinkDescription: values.sink_description || values.sink_name,
    sourceName,
    sourceLabel,
    createdSink: parseBool(values.created_sink),
    movedInputsCount: Number.parseInt(values.moved_inputs_count || '0', 10) || 0,
    setDefaultSourceRequested: parseBool(values.set_default_source_requested),
    setDefaultSource: parseBool(values.set_default_source),
    defaultSourceBefore: values.default_source_before || null,
    defaultSourceAfter,
    defaultSourceIsDuet: parseBool(values.default_source_is_duet)
      || isDuetLikeSourceName(defaultSourceAfter),
    restoreInputSourceHint: values.recommended_restore_source || null,
    restoreInputSourceLabel: values.recommended_restore_label || null,
  };

  audioState = {
    sourceName: result.sourceName,
    sourceLabel: result.sourceLabel,
    defaultInputSource: result.defaultSourceAfter,
    defaultInputIsDuetVirtual: result.defaultSourceIsDuet,
    restoreInputSourceHint: result.restoreInputSourceHint,
    restoreInputSourceLabel: result.restoreInputSourceLabel,
  };
  updateService('jacktrip', {
    mode: MODE.EXTERNAL,
    connected: currentState === STATUS.CONNECTED,
    server: connection?.server || null,
    port: connection?.port || null,
    audioSourceName: audioState.sourceName,
    audioSourceLabel: audioState.sourceLabel,
  });
  broadcastStatus();
  return result;
}

async function listPorts() {
  if (!binaryExists('jack_lsp')) {
    throw new Error('jack_lsp not found in PATH');
  }
  const { stdout } = await execCommand('jack_lsp');
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function connect(options = {}) {
  const deps = checkDeps();
  if (!deps.available) {
    const message = `Missing required tools: ${deps.missing.join(', ')}`;
    updateState(STATUS.ERROR, message);
    setErrorState('jacktrip', message);
    return { ...getStatus(), deps };
  }

  if (jacktripProcess) {
    await disconnect();
  }

  const server = parseServer(options.server);
  const port = parsePort(options.port);
  const bindPort = parseBindPort(port, options.bindPort);
  const bufferStrategy = String(options.bufferStrategy || DEFAULT_BUFFER_STRATEGY);
  const quality = String(options.quality || DEFAULT_QUALITY);
  const args = [
    '-c',
    server,
    '-P',
    String(port),
    '-B',
    String(bindPort),
    '--bufstrategy',
    bufferStrategy,
    '-q',
    quality,
  ];

  updateState(STATUS.CONNECTING);
  setStatusMessage('jacktrip', `Connecting to ${server}:${port}`);
  clearErrorState('jacktrip');

  try {
    const child = spawnCommand('jacktrip', args);
    jacktripProcess = child;
    connection = { server, port, bindPort };

    child.stdout.on('data', (data) => {
      log.info(`[JackTrip stdout]: ${data}`);
    });
    child.stderr.on('data', (data) => {
      log.warn(`[JackTrip stderr]: ${data}`);
    });
    child.on('error', (err) => {
      log.error('[JackTrip] Failed to start:', err);
      jacktripProcess = null;
      connection = null;
      updateState(STATUS.ERROR, err.message);
      setErrorState('jacktrip', `JackTrip failed: ${err.message}`);
    });
    child.on('close', (code) => {
      log.info(`[JackTrip] Process exited with code ${code}`);
      jacktripProcess = null;
      connection = null;
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (currentState === STATUS.DISCONNECTING) {
        updateState(STATUS.DISCONNECTED);
        clearService('jacktrip');
      } else if (code === 0) {
        updateState(STATUS.DISCONNECTED);
        clearService('jacktrip');
      } else {
        const message = `JackTrip exited with code ${code}`;
        updateState(STATUS.ERROR, message);
        setErrorState('jacktrip', message);
      }
    });

    setTimeout(() => {
      if (jacktripProcess === child && currentState === STATUS.CONNECTING) {
        updateState(STATUS.CONNECTED);
        updateService('jacktrip', {
          mode: MODE.EXTERNAL,
          connected: true,
          server,
          port,
          audioSourceName: audioState.sourceName,
          audioSourceLabel: audioState.sourceLabel,
        });
        setStatusMessage('jacktrip', `Connected: ${server}:${port}`);
      }
    }, 250);
  } catch (err) {
    jacktripProcess = null;
    connection = null;
    updateState(STATUS.ERROR, err.message);
    setErrorState('jacktrip', `JackTrip failed: ${err.message}`);
  }

  return getStatus();
}

function stopChild(child, label) {
  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }

    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      resolve();
    };

    child.once('close', finish);
    child.kill('SIGTERM');
    forceKillTimeout = setTimeout(() => {
      try {
        log.warn(`[JackTrip] Force killing ${label}`);
        child.kill('SIGKILL');
      } catch {
        // Process already exited.
      }
      finish();
    }, STOP_TIMEOUT_MS);
  });
}

async function disconnect() {
  updateState(STATUS.DISCONNECTING);
  await stopChild(jacktripProcess, 'client');
  jacktripProcess = null;
  connection = null;
  if (!localServerProcess) {
    updateState(STATUS.DISCONNECTED);
    clearService('jacktrip');
  } else {
    updateState(STATUS.LOCAL_SERVER_RUNNING);
  }
  return getStatus();
}

async function stopJacktrip() {
  await disconnect();
  await stopLocalServer();
}

async function startLocalServer(options = {}) {
  const deps = checkDeps();
  if (!deps.available) {
    const message = `Missing required tools: ${deps.missing.join(', ')}`;
    updateState(STATUS.ERROR, message);
    return { ...getStatus(), deps };
  }
  if (localServerProcess) {
    updateState(STATUS.LOCAL_SERVER_RUNNING);
    return getStatus();
  }

  const port = parsePort(options.port);
  const child = spawnCommand('jacktrip', ['-s', '-P', String(port), '-q', LOCAL_SERVER_QUALITY]);
  localServerProcess = child;
  child.stdout.on('data', (data) => log.info(`[JackTrip server stdout]: ${data}`));
  child.stderr.on('data', (data) => log.warn(`[JackTrip server stderr]: ${data}`));
  child.on('close', (code) => {
    log.info(`[JackTrip] Local server exited with code ${code}`);
    localServerProcess = null;
    if (!jacktripProcess) {
      updateState(STATUS.DISCONNECTED, code !== 0 ? `Local server exited with code ${code}` : null);
      clearService('jacktrip');
    }
  });
  child.on('error', (err) => {
    localServerProcess = null;
    updateState(STATUS.ERROR, err.message);
    setErrorState('jacktrip', `Local JackTrip server failed: ${err.message}`);
  });

  updateState(STATUS.LOCAL_SERVER_RUNNING);
  setStatusMessage('jacktrip', `Local server: 127.0.0.1:${port}`);
  return getStatus();
}

async function stopLocalServer() {
  await stopChild(localServerProcess, 'local server');
  localServerProcess = null;
  if (jacktripProcess) {
    updateState(STATUS.CONNECTED);
  } else {
    updateState(STATUS.DISCONNECTED);
    clearService('jacktrip');
  }
  return getStatus();
}

async function setupAudio(options = {}) {
  if (process.platform !== 'linux') {
    throw new Error('JackTrip audio source setup is Linux-only');
  }
  const scriptPath = getScriptPath('setup-duet-audio-source-linux.sh');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`setup script not found: ${scriptPath}`);
  }

  const env = {
    ...process.env,
    DUET_SET_DEFAULT_SOURCE: options.setDefaultSource ? '1' : '0',
  };
  const { stdout } = await new Promise((resolve, reject) => {
    execFile('bash', [scriptPath], { timeout: EXEC_TIMEOUT_MS, env }, (error, out, stderr) => {
      const values = parseKeyValues(out);
      if (error || values.status !== 'ok') {
        const message = values.error_message || stderr?.trim() || error?.message || 'audio setup failed';
        reject(new Error(message));
        return;
      }
      resolve({ stdout: out });
    });
  });

  return normalizeAudioSetupResult(parseKeyValues(stdout));
}

async function getCurrentDefaultSource() {
  const { stdout } = await execCommand('pactl', ['get-default-source']);
  return stdout.trim() || null;
}

async function listLinuxSources() {
  const { stdout } = await execCommand('pactl', ['list', 'short', 'sources']);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}

async function restoreAudio(options = {}) {
  if (process.platform !== 'linux') {
    throw new Error('JackTrip audio restore is Linux-only');
  }
  const preferredSource = String(options.preferredSource || audioState.restoreInputSourceHint || '').trim();
  const sources = await listLinuxSources();
  const target = preferredSource && !isDuetLikeSourceName(preferredSource)
    ? preferredSource
    : sources.find((source) => !isDuetLikeSourceName(source));

  if (!target) {
    throw new Error('no non-duet input source found to restore');
  }

  const current = await getCurrentDefaultSource();
  if (current !== target) {
    await execCommand('pactl', ['set-default-source', target]);
  }

  audioState = {
    ...audioState,
    defaultInputSource: target,
    defaultInputIsDuetVirtual: false,
    restoreInputSourceHint: target,
  };
  updateService('jacktrip', {
    mode: MODE.EXTERNAL,
    connected: currentState === STATUS.CONNECTED,
    server: connection?.server || null,
    port: connection?.port || null,
    audioSourceName: audioState.sourceName,
    audioSourceLabel: audioState.sourceLabel,
  });
  broadcastStatus();
  return { restoredSource: target, audio: { ...audioState } };
}

function registerJacktripIpc() {
  ipcMain.handle(IPC.JACKTRIP_CONNECT, (_event, options) => connect(options));
  ipcMain.handle(IPC.JACKTRIP_DISCONNECT, () => disconnect());
  ipcMain.handle(IPC.JACKTRIP_GET_STATUS, () => getStatus());
  ipcMain.handle(IPC.JACKTRIP_CHECK_DEPS, () => checkDeps());
  ipcMain.handle(IPC.JACKTRIP_LIST_PORTS, async () => ({ ports: await listPorts() }));
  ipcMain.handle(IPC.JACKTRIP_SETUP_AUDIO, async (_event, options) => setupAudio(options));
  ipcMain.handle(IPC.JACKTRIP_RESTORE_AUDIO, async (_event, options) => restoreAudio(options));
  ipcMain.handle(IPC.JACKTRIP_START_LOCAL_SERVER, (_event, options) => startLocalServer(options));
  ipcMain.handle(IPC.JACKTRIP_STOP_LOCAL_SERVER, () => stopLocalServer());
}

module.exports = {
  STATUS,
  checkDeps,
  connect,
  disconnect,
  getStatus,
  listPorts,
  registerJacktripIpc,
  restoreAudio,
  setupAudio,
  startLocalServer,
  stopJacktrip,
  stopLocalServer,
};
