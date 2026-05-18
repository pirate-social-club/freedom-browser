const IPC = require('../shared/ipc-channels');
const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE = 'https://api.pirate.sc';
const ALLOWED_API_HOSTS = new Set([
  'api.pirate.sc',
  'api-staging.pirate.sc',
  'localhost',
  '127.0.0.1',
]);
const ALLOWED_WEB_HOSTS = new Set([
  'pirate.sc',
  'www.pirate.sc',
  'staging.pirate.sc',
  'localhost',
  '127.0.0.1',
]);
const MAX_ID_LENGTH = 160;
const TOKEN_FILE = 'api-token.enc';
const DEVICE_CLIENT_ID = 'freedom-desktop';
const DEFAULT_DEVICE_SCOPE = 'live_room:attach live_room:manage song_artifacts:read profile:read';

const tokenCache = {
  accessToken: '',
  accessTokenExpiresAt: 0,
  refreshToken: '',
  refreshTokenExpiresAt: 0,
  scope: '',
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeApiBase(value) {
  const raw = cleanString(value) || process.env.PIRATE_API_BASE_URL || DEFAULT_API_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid Pirate API base URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Pirate API base URL must use http or https');
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Pirate API base URL must use https outside localhost');
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname)) {
    throw new Error('Pirate API base URL host is not allowed');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeWebBase(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid Pirate web base URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Pirate web base URL must use http or https');
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Pirate web base URL must use https outside localhost');
  }
  if (!ALLOWED_WEB_HOSTS.has(url.hostname)) {
    throw new Error('Pirate web base URL host is not allowed');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function withVerificationWebBase(result, webBase) {
  if (!webBase || !result?.user_code) return result;
  const verificationUri = `${webBase}/authorize-device`;
  return {
    ...result,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(result.user_code)}`,
  };
}

function normalizeId(value, field) {
  const id = cleanString(value);
  if (!id || /[\s/?#]/.test(id)) {
    throw new Error(`${field} is required`);
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  return id;
}

function loadElectron() {
  try {
    return require('electron');
  } catch {
    return {};
  }
}

function getAuthDeps(options = {}) {
  const electron = options.electron || loadElectron();
  return {
    app: options.app || electron.app,
    fs: options.fs || fs,
    path: options.path || path,
    safeStorage: options.safeStorage || electron.safeStorage,
    shell: options.shell || electron.shell,
  };
}

function getTokenPath(options = {}) {
  if (options.tokenPath) return options.tokenPath;
  const deps = getAuthDeps(options);
  const userData = options.userDataDir || deps.app?.getPath?.('userData');
  if (!userData) {
    throw new Error('Freedom user data path is unavailable');
  }
  return deps.path.join(userData, 'pirate', TOKEN_FILE);
}

function canUseSecureStorage(options = {}) {
  const { safeStorage } = getAuthDeps(options);
  return Boolean(safeStorage?.isEncryptionAvailable?.());
}

function readStoredAuth(options = {}) {
  const deps = getAuthDeps(options);
  if (!canUseSecureStorage(options)) return {};
  const tokenPath = getTokenPath(options);
  if (!deps.fs.existsSync(tokenPath)) return {};
  try {
    const plaintext = cleanString(deps.safeStorage.decryptString(deps.fs.readFileSync(tokenPath)));
    if (!plaintext) return {};
    if (plaintext.startsWith('{')) {
      const parsed = JSON.parse(plaintext);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    return { accessToken: plaintext, legacyAccessToken: true };
  } catch {
    return {};
  }
}

function getPirateAuthStatus(options = {}) {
  const stored = readStoredAuth(options);
  const hasRefreshToken = Boolean(cleanString(stored.refreshToken));
  const hasStoredAccessToken = Boolean(cleanString(stored.accessToken));
  const hasEnvAccessToken = Boolean(cleanString(process.env.PIRATE_API_ACCESS_TOKEN));
  return {
    secureStorageAvailable: canUseSecureStorage(options),
    hasStoredAccessToken,
    hasStoredRefreshToken: hasRefreshToken,
    hasEnvAccessToken,
    authorized: hasRefreshToken || hasStoredAccessToken || hasEnvAccessToken || Boolean(tokenCache.accessToken),
    accessTokenExpiresAt: tokenCache.accessTokenExpiresAt || Number(stored.accessTokenExpiresAt || 0) || null,
    refreshTokenExpiresAt: Number(stored.refreshTokenExpiresAt || 0) || null,
    scope: cleanString(stored.scope || tokenCache.scope) || null,
  };
}

function writeStoredAuth(value, options = {}) {
  const deps = getAuthDeps(options);
  if (!canUseSecureStorage(options)) {
    throw new Error('Device secure storage is not available');
  }
  const tokenPath = getTokenPath(options);
  deps.fs.mkdirSync(deps.path.dirname(tokenPath), { recursive: true });
  deps.fs.writeFileSync(tokenPath, deps.safeStorage.encryptString(JSON.stringify(value)));
}

function savePirateAccessToken(value, options = {}) {
  const token = cleanString(value).replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new Error('Pirate API access token is required');
  }
  writeStoredAuth({ accessToken: token, savedAt: Date.now() }, options);
  return getPirateAuthStatus(options);
}

function clearPirateAccessToken(options = {}) {
  const deps = getAuthDeps(options);
  const tokenPath = getTokenPath(options);
  if (deps.fs.existsSync(tokenPath)) {
    deps.fs.unlinkSync(tokenPath);
  }
  tokenCache.accessToken = '';
  tokenCache.accessTokenExpiresAt = 0;
  tokenCache.refreshToken = '';
  tokenCache.refreshTokenExpiresAt = 0;
  tokenCache.scope = '';
  return getPirateAuthStatus(options);
}

function saveDeviceTokenPayload(payload, options = {}) {
  const accessToken = cleanString(payload.access_token);
  const refreshToken = cleanString(payload.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error('Pirate device authorization returned an invalid token payload');
  }
  const now = Math.floor(Date.now() / 1000);
  const accessTokenExpiresAt = now + Number(payload.expires_in || 0);
  const refreshTokenExpiresAt = now + Number(payload.refresh_expires_in || 0);
  tokenCache.accessToken = accessToken;
  tokenCache.accessTokenExpiresAt = accessTokenExpiresAt;
  tokenCache.refreshToken = refreshToken;
  tokenCache.refreshTokenExpiresAt = refreshTokenExpiresAt;
  tokenCache.scope = cleanString(payload.scope);
  writeStoredAuth({
    refreshToken,
    refreshTokenExpiresAt,
    scope: tokenCache.scope,
    accessTokenExpiresAt,
    savedAt: Date.now(),
  }, options);
}

async function normalizeAccessToken(value, input = {}, options = {}) {
  const explicit = cleanString(value).replace(/^Bearer\s+/i, '').trim();
  if (explicit) return explicit;

  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.accessToken && tokenCache.accessTokenExpiresAt > now + 30) {
    return tokenCache.accessToken;
  }

  const stored = readStoredAuth(options);
  const legacyAccessToken = cleanString(stored.accessToken).replace(/^Bearer\s+/i, '').trim();
  if (legacyAccessToken) return legacyAccessToken;

  const refreshToken = cleanString(tokenCache.refreshToken || stored.refreshToken);
  if (refreshToken) {
    const refreshed = await refreshPirateDeviceAuth({
      apiBase: input.apiBase,
      refreshToken,
    }, { ...options, fetch: input.fetch });
    return refreshed.access_token;
  }

  const token = cleanString(process.env.PIRATE_API_ACCESS_TOKEN);
  if (!token) {
    throw new Error('Pirate API access token is required');
  }
  return token;
}

async function postJson(url, body, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is not available in this runtime');
  }
  const headers = {
    'content-type': 'application/json',
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    if (options.allowErrorBody && responseBody && typeof responseBody === 'object') {
      return { ...responseBody, status: response.status };
    }
    const apiMessage = responseBody?.message || responseBody?.error || 'Pirate API request failed';
    const message = `${apiMessage} (${response.status} ${url})`;
    const error = new Error(message);
    error.status = response.status;
    error.body = responseBody;
    error.url = url;
    throw error;
  }
  return responseBody;
}

async function requestJson(url, token, fetchImpl = globalThis.fetch) {
  return postJson(url, null, { token, fetch: fetchImpl });
}

async function startPirateDeviceAuth(input = {}, options = {}) {
  const apiBase = normalizeApiBase(input.apiBase);
  const webBase = normalizeWebBase(input.webBase || input.webOrigin || input.webUrl);
  const result = await postJson(`${apiBase}/oauth/device_authorize`, {
    client_id: DEVICE_CLIENT_ID,
    scope: cleanString(input.scope) || DEFAULT_DEVICE_SCOPE,
  }, { fetch: options.fetch });
  const launchResult = withVerificationWebBase(result, webBase);

  if (input.openBrowser !== false) {
    const deps = getAuthDeps(options.authStorage);
    await deps.shell?.openExternal?.(launchResult.verification_uri_complete || launchResult.verification_uri).catch(() => undefined);
  }

  return launchResult;
}

async function pollPirateDeviceAuth(input = {}, options = {}) {
  const apiBase = normalizeApiBase(input.apiBase);
  const deviceCode = normalizeOpaqueDeviceCode(input.deviceCode || input.device_code);
  const result = await postJson(`${apiBase}/oauth/device/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: DEVICE_CLIENT_ID,
    device_code: deviceCode,
  }, { fetch: options.fetch, allowErrorBody: true });

  if (result?.error === 'authorization_pending') {
    return result;
  }

  saveDeviceTokenPayload(result, options.authStorage);
  return {
    ...result,
    access_token: '<stored>',
    refresh_token: '<stored>',
    auth: getPirateAuthStatus(options.authStorage),
  };
}

async function refreshPirateDeviceAuth(input = {}, options = {}) {
  const apiBase = normalizeApiBase(input.apiBase);
  const refreshToken = normalizeOpaqueDeviceCode(input.refreshToken || input.refresh_token);
  const result = await postJson(`${apiBase}/oauth/device/token`, {
    grant_type: 'refresh_token',
    client_id: DEVICE_CLIENT_ID,
    refresh_token: refreshToken,
  }, { fetch: options.fetch });
  saveDeviceTokenPayload(result, options);
  return result;
}

function normalizeOpaqueDeviceCode(value) {
  const token = cleanString(value);
  if (!token || token.length > 256 || /\s/.test(token)) {
    throw new Error('Device authorization token is invalid');
  }
  return token;
}

async function hostAttachLiveRoom(input = {}, options = {}) {
  const url = buildLiveRoomActionUrl(input, 'host_attach');
  const token = await normalizeAccessToken(input.accessToken, { apiBase: input.apiBase, fetch: options.fetch }, options.authStorage);
  return await requestJson(url, token, options.fetch);
}

async function guestAttachLiveRoom(input = {}, options = {}) {
  const url = buildLiveRoomActionUrl(input, 'guest_attach');
  const token = await normalizeAccessToken(input.accessToken, { apiBase: input.apiBase, fetch: options.fetch }, options.authStorage);
  return await requestJson(url, token, options.fetch);
}

async function attachLiveRoom(input = {}, options = {}) {
  const seat = cleanString(input.seat || input.role).toLowerCase();
  if (seat === 'host') return await hostAttachLiveRoom(input, options);
  if (seat === 'guest') return await guestAttachLiveRoom(input, options);

  try {
    return await hostAttachLiveRoom(input, options);
  } catch (err) {
    if (err?.status !== 404) throw err;
    return await guestAttachLiveRoom(input, options);
  }
}

async function endLiveRoom(input = {}, options = {}) {
  const url = buildLiveRoomActionUrl(input, 'end');
  const token = await normalizeAccessToken(input.accessToken, { apiBase: input.apiBase, fetch: options.fetch }, options.authStorage);
  return await requestJson(url, token, options.fetch);
}

function buildLiveRoomActionUrl(input = {}, action) {
  const apiBase = normalizeApiBase(input.apiBase);
  const communityId = normalizeId(input.communityId, 'communityId');
  const liveRoomId = normalizeId(input.liveRoomId || input.roomId, 'liveRoomId');
  return `${apiBase}/communities/${encodeURIComponent(communityId)}/live-rooms/${encodeURIComponent(liveRoomId)}/${action}`;
}

function registerLiveRoomApiIpc(ipcMain, options = {}) {
  ipcMain.handle(IPC.PIRATE_LIVE_ROOM_ATTACH, (_event, input) => attachLiveRoom(input, options));
  ipcMain.handle(IPC.PIRATE_LIVE_ROOM_HOST_ATTACH, (_event, input) => hostAttachLiveRoom(input, options));
  ipcMain.handle(IPC.PIRATE_LIVE_ROOM_GUEST_ATTACH, (_event, input) => guestAttachLiveRoom(input, options));
  ipcMain.handle(IPC.PIRATE_LIVE_ROOM_END, (_event, input) => endLiveRoom(input, options));
  ipcMain.handle(IPC.PIRATE_AUTH_GET_STATUS, () => getPirateAuthStatus(options.authStorage));
  ipcMain.handle(IPC.PIRATE_AUTH_START_DEVICE, (_event, input) => startPirateDeviceAuth(input, options));
  ipcMain.handle(IPC.PIRATE_AUTH_POLL_DEVICE, (_event, input) => pollPirateDeviceAuth(input, options));
  ipcMain.handle(IPC.PIRATE_AUTH_SAVE_ACCESS_TOKEN, (_event, accessToken) =>
    savePirateAccessToken(accessToken, options.authStorage)
  );
  ipcMain.handle(IPC.PIRATE_AUTH_CLEAR_ACCESS_TOKEN, () => clearPirateAccessToken(options.authStorage));
}

module.exports = {
  attachLiveRoom,
  clearPirateAccessToken,
  endLiveRoom,
  getPirateAuthStatus,
  guestAttachLiveRoom,
  hostAttachLiveRoom,
  normalizeApiBase,
  pollPirateDeviceAuth,
  registerLiveRoomApiIpc,
  savePirateAccessToken,
  startPirateDeviceAuth,
};
