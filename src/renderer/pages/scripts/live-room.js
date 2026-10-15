const api = window.freedomAPI || null;
const requiredApiMethods = [
  'attachLiveRoom',
  'checkJacktripDeps',
  'clearPirateAccessToken',
  'connectJacktrip',
  'disconnectJacktrip',
  'endLiveRoom',
  'getJacktripStatus',
  'getPirateAuthStatus',
  'getPlatform',
  'listJacktripPorts',
  'openInNewTab',
  'onJacktripStatusUpdate',
  'pollPirateDeviceAuth',
  'restoreJacktripAudio',
  'setupJacktripAudio',
  'startJacktripLocalServer',
  'startPirateDeviceAuth',
  'stopJacktripLocalServer',
];
const TOKEN_RENEW_LEAD_MS = 120000;
const TOKEN_RENEW_RETRY_MS = 15000;
const MIN_TOKEN_RENEW_DELAY_MS = 5000;
const params = new URLSearchParams(window.location.search);
const launchWebBase = params.get('webBase') || params.get('web') || '';
const launchSeat = ['host', 'guest'].includes((params.get('seat') || params.get('role') || '').toLowerCase())
  ? (params.get('seat') || params.get('role') || '').toLowerCase()
  : '';
const els = {
  roomId: document.getElementById('room-id'),
  state: document.getElementById('state'),
  form: document.getElementById('connect-form'),
  attachForm: document.getElementById('attach-form'),
  apiBase: document.getElementById('api-base'),
  communityId: document.getElementById('community-id'),
  liveRoomId: document.getElementById('live-room-id'),
  authStatus: document.getElementById('auth-status'),
  deviceCode: document.getElementById('device-code'),
  server: document.getElementById('server'),
  port: document.getElementById('port'),
  bindPort: document.getElementById('bind-port'),
  quality: document.getElementById('quality'),
  bufferStrategy: document.getElementById('buffer-strategy'),
  connection: document.getElementById('connection'),
  audio: document.getElementById('audio'),
  binary: document.getElementById('binary'),
  runtime: document.getElementById('runtime'),
  agora: document.getElementById('agora'),
  ports: document.getElementById('ports'),
  log: document.getElementById('log'),
  connect: document.getElementById('connect'),
  disconnect: document.getElementById('disconnect'),
  startBroadcast: document.getElementById('start-broadcast'),
  stopBroadcast: document.getElementById('stop-broadcast'),
  broadcastStatus: document.getElementById('broadcast-status'),
  broadcastPreview: document.getElementById('broadcast-preview'),
  broadcastPlaceholder: document.getElementById('broadcast-placeholder'),
  diagnostics: document.getElementById('diagnostics'),
  localVideo: document.getElementById('local-video'),
};
let lastStatus = { status: 'DISCONNECTED' };
let hostPlatform = 'unknown';
let busy = false;
let attachPayload = null;
let deviceAuth = null;
let deviceAuthTimer = null;
let agoraClient = null;
let localAudioTrack = null;
let localVideoTrack = null;
let agoraRenewTimer = null;
let broadcastState = 'idle';
const lastDebugMessages = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeAuthStatus(status = {}) {
  return {
    authorized: status.authorized === true,
    hasEnvAccessToken: status.hasEnvAccessToken === true,
    hasStoredAccessToken: status.hasStoredAccessToken === true,
    hasStoredRefreshToken: status.hasStoredRefreshToken === true,
    refreshTokenExpiresAt: status.refreshTokenExpiresAt || null,
    scope: status.scope || null,
    secureStorageAvailable: status.secureStorageAvailable !== false,
  };
}

function summarizeAttachPayload(payload = {}) {
  return {
    agora: payload.agora ? {
      channel: payload.agora.channel || null,
      configured: payload.agora.configured === true,
      hasToken: Boolean(payload.agora.token),
      tokenExpiresAt: payload.agora.token_expires_at || null,
      uid: payload.agora.uid ?? null,
    } : null,
    bridge: payload.bridge ? {
      hasTicket: Boolean(payload.bridge.ticket),
      ticketExpiresAt: payload.bridge.ticket_expires_at || null,
    } : null,
    jacktrip: payload.jacktrip ? {
      configured: payload.jacktrip.configured === true,
      port: payload.jacktrip.port || null,
      required: payload.jacktrip.required === true,
      server: payload.jacktrip.server || null,
    } : null,
    room: payload.room ? {
      accessMode: payload.room.access_mode || null,
      guestUser: payload.room.guest_user || null,
      hostUser: payload.room.host_user || null,
      id: payload.room.id || null,
      jacktripRequired: payload.jacktrip?.required === true,
      status: payload.room.status || null,
    } : null,
    runtime: payload.runtime ? {
      roomRuntimeId: payload.runtime.room_runtime_id || null,
      seat: payload.runtime.seat || null,
      status: payload.runtime.status || null,
    } : null,
  };
}

function summarizeBroadcastControls() {
  return {
    broadcastState,
    busy,
    hasAgoraCredentials: hasAgoraCredentials(),
    jacktripState: lastStatus.status || null,
    jacktripRequired: attachPayload?.jacktrip?.required === true,
    sdkReady: Boolean(window.AgoraRTC),
    seat: getRuntimeSeat(),
    startDisabled: els.startBroadcast.disabled,
    startVisible: els.startBroadcast.style.display !== 'none',
    statusText: els.broadcastStatus.textContent,
    stopDisabled: els.stopBroadcast.disabled,
    stopVisible: els.stopBroadcast.style.display !== 'none',
  };
}

function writeDebugLog(message, detail) {
  let key = message;
  try {
    key += `:${JSON.stringify(redact(detail))}`;
  } catch {
    key += `:${String(detail)}`;
  }
  if (lastDebugMessages.get(message) === key) return;
  lastDebugMessages.set(message, key);
  writeLog(message, detail);
}

function renderAuthStatus(status = {}) {
  const summary = summarizeAuthStatus(status);
  let label = 'Not signed in';
  if (!status.secureStorageAvailable) {
    label = 'Secure token storage is unavailable on this device';
  } else if (status.authorized) {
    label = status.hasStoredRefreshToken
      ? 'Signed in with Pirate device auth'
      : status.hasEnvAccessToken
        ? 'Using development token from environment'
        : 'Stored access token available';
  }
  els.authStatus.textContent = label;
  writeDebugLog('Pirate auth state', { ...summary, label });
}

async function waitForPirateDeviceAuthApproval(auth) {
  const expiresInMs = Math.max(60, Number(auth.expires_in || 600)) * 1000;
  const deadline = Date.now() + expiresInMs;
  let intervalMs = Math.max(1, Number(auth.interval || 5)) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await api.pollPirateDeviceAuth({
      apiBase: els.apiBase.value,
      deviceCode: auth.device_code,
    });
    if (result?.error === 'authorization_pending') {
      intervalMs = Math.max(1, Number(result.interval || auth.interval || 5)) * 1000;
      els.authStatus.textContent = `Waiting for approval · ${auth.user_code}`;
      continue;
    }

    stopDeviceAuthPolling();
    deviceAuth = null;
    els.deviceCode.textContent = '';
    const status = result.auth || await api.getPirateAuthStatus();
    renderAuthStatus(status);
    writeLog('Pirate sign-in complete', result);
    return status;
  }

  throw new Error('Pirate device authorization expired');
}

async function openDeviceAuthorization(auth) {
  const url = auth?.verification_uri_complete || auth?.verification_uri;
  if (!url) return;
  await api.openInNewTab(url);
  writeLog('Pirate sign-in opened in Freedom', { url });
}

async function ensurePirateAuth(status) {
  const currentStatus = status || await api.getPirateAuthStatus();
  renderAuthStatus(currentStatus);
  if (currentStatus.authorized) {
    writeDebugLog('Pirate auth already available', summarizeAuthStatus(currentStatus));
    return currentStatus;
  }

  stopDeviceAuthPolling();
  writeLog('Pirate auth missing; starting device auth', summarizeAuthStatus(currentStatus));
  const auth = await api.startPirateDeviceAuth({ apiBase: els.apiBase.value, openBrowser: false, webBase: launchWebBase });
  deviceAuth = auth;
  els.deviceCode.textContent = `Code ${auth.user_code}`;
  els.authStatus.textContent = 'Approve the device in Pirate web';
  writeLog('Pirate sign-in started', auth);
  await openDeviceAuthorization(auth);
  return await waitForPirateDeviceAuthApproval(auth);
}

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|ticket|authorization|secret/i.test(key)) {
      out[key] = item ? '<redacted>' : item;
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}

function writeLog(message, detail) {
  const time = new Date().toLocaleTimeString();
  const suffix = detail ? `\n${JSON.stringify(redact(detail), null, 2)}` : '';
  els.log.textContent = `[${time}] ${message}${suffix}\n\n${els.log.textContent}`.trim();
  if (/failed|gap|unavailable|missing/i.test(message)) {
    els.diagnostics.open = true;
  }
}

function missingFreedomApiMethods() {
  if (!api) return requiredApiMethods;
  return requiredApiMethods.filter((method) => typeof api[method] !== 'function');
}

function renderBridgeUnavailable(missing) {
  document.querySelectorAll('input, select, button').forEach((el) => {
    el.disabled = true;
  });
  els.state.textContent = 'BRIDGE MISSING';
  els.state.className = 'state-pill disconnected';
  els.authStatus.textContent = 'Freedom live-room bridge unavailable';
  els.runtime.textContent = 'Bridge unavailable';
  els.broadcastStatus.textContent = 'Update or restart Freedom, then open this producer room again.';
  writeLog('Freedom live-room bridge unavailable', {
    missing,
    freedomBrowser: window.freedomBrowser || null,
    hasFreedomAPI: Boolean(window.freedomAPI),
    href: window.location.href,
  });
}

function setBusy(isBusy) {
  busy = isBusy;
  renderStatus(lastStatus);
}

function normalizeState(value) {
  return String(value || 'DISCONNECTED').toLowerCase().replace(/_/g, '-');
}

function renderStatus(status = {}) {
  lastStatus = status;
  const state = status.status || 'DISCONNECTED';
  const stateKey = normalizeState(state);
  const connection = status.connection || status;
  const audio = status.audio || status;
  els.state.textContent = state;
  els.state.className = `state-pill ${stateKey}`;
  els.connection.textContent = connection.server
    ? `${connection.server}:${connection.port || ''}`
    : status.message || 'Idle';
  els.audio.textContent = audio.sourceLabel || audio.sourceName || 'Not configured';

  const isTransition = stateKey === 'connecting' || stateKey === 'disconnecting';
  document.querySelectorAll('input, select, button').forEach((el) => {
    el.disabled = busy;
  });
  els.connect.disabled = busy || isTransition || stateKey === 'connected';
  els.disconnect.disabled = busy || isTransition || stateKey === 'disconnected';
  document.getElementById('setup-audio').disabled = busy || hostPlatform !== 'linux';
  document.getElementById('restore-audio').disabled = busy || hostPlatform !== 'linux';
  renderBroadcastControls();
  writeDebugLog('JackTrip UI state', {
    audio: els.audio.textContent,
    busy,
    connectDisabled: els.connect.disabled,
    connection: els.connection.textContent,
    disconnectDisabled: els.disconnect.disabled,
    state,
  });
}

function connectPayload() {
  const payload = {
    server: els.server.value,
    port: Number(els.port.value),
    quality: els.quality.value,
    bufferStrategy: els.bufferStrategy.value,
  };
  if (els.bindPort.value) {
    payload.bindPort = Number(els.bindPort.value);
  }
  return payload;
}

function attachRequestPayload() {
  const payload = {
    apiBase: els.apiBase.value,
    communityId: els.communityId.value,
    liveRoomId: els.liveRoomId.value,
  };
  if (launchSeat) {
    payload.seat = launchSeat;
  }
  return payload;
}

function applyAttachPayload(payload) {
  attachPayload = payload;
  if (payload?.room?.id) {
    els.roomId.textContent = `Room ${payload.room.id}`;
  }
  if (payload?.runtime) {
    els.runtime.textContent = `${payload.runtime.status || 'attached'} · ${payload.runtime.seat || 'host'}`;
  }
  if (payload?.agora) {
    els.agora.textContent = payload.agora.configured
      ? `${payload.agora.channel} · uid ${payload.agora.uid}`
      : `${payload.agora.channel || 'channel'} · token unavailable`;
  }
  if (payload?.jacktrip) {
    const jacktrip = payload.jacktrip;
    if (jacktrip.server) els.server.value = jacktrip.server;
    if (jacktrip.port) els.port.value = String(jacktrip.port);
    if (jacktrip.bind_port) els.bindPort.value = String(jacktrip.bind_port);
    if (jacktrip.quality) els.quality.value = String(jacktrip.quality);
    if (jacktrip.buffer_strategy) els.bufferStrategy.value = String(jacktrip.buffer_strategy);
  }
  renderBroadcastControls();
  writeDebugLog('Live room attach state', summarizeAttachPayload(payload));
}

function applyEndedRoom(room) {
  if (room?.id) {
    els.roomId.textContent = `Room ${room.id}`;
  }
  els.runtime.textContent = 'ended';
  renderBroadcastStatus('Room ended.', 'idle');
}

function hasAgoraCredentials() {
  const agora = attachPayload?.agora;
  return Boolean(
    agora?.configured
    && agora.app_id
    && agora.channel
    && agora.token
    && agora.uid !== undefined
    && agora.uid !== null
  );
}

function getRuntimeSeat(payload = attachPayload) {
  return payload?.runtime?.seat || launchSeat || '';
}

function isJacktripRequiredRoom(payload = attachPayload) {
  return payload?.jacktrip?.required === true;
}

function isJacktripGuest(payload = attachPayload) {
  return isJacktripRequiredRoom(payload) && getRuntimeSeat(payload) === 'guest';
}

function isJacktripHost(payload = attachPayload) {
  return isJacktripRequiredRoom(payload) && getRuntimeSeat(payload) === 'host';
}

function isJacktripConnected(status = lastStatus) {
  return normalizeState(status?.status) === 'connected';
}

function renderBroadcastStatus(message, nextState = broadcastState) {
  broadcastState = nextState;
  els.broadcastStatus.textContent = message;
  els.broadcastPreview.classList.toggle('live', broadcastState === 'live');
  renderBroadcastControls();
  writeDebugLog('Broadcast UI state', summarizeBroadcastControls());
}

function renderBroadcastControls() {
  const ready = hasAgoraCredentials();
  const sdkReady = Boolean(window.AgoraRTC);
  const active = broadcastState === 'connecting' || broadcastState === 'live';
  const jacktripGuest = isJacktripGuest();
  const jacktripHostWaitingForJackTrip = isJacktripHost() && !isJacktripConnected();
  els.startBroadcast.style.display = jacktripGuest ? 'none' : '';
  els.stopBroadcast.style.display = jacktripGuest ? 'none' : '';
  els.startBroadcast.disabled = busy || active || !ready || !sdkReady || jacktripHostWaitingForJackTrip;
  els.stopBroadcast.disabled = busy || !active || jacktripGuest;
  if (jacktripGuest) {
    els.broadcastStatus.textContent = isJacktripConnected()
      ? 'Connected to JackTrip audio. The host controls the viewer broadcast.'
      : 'Connect JackTrip audio. The host controls the viewer broadcast.';
  } else if (jacktripHostWaitingForJackTrip) {
    els.broadcastStatus.textContent = 'Connect JackTrip audio before broadcasting to viewers.';
  } else if (broadcastState === 'live') {
    els.broadcastStatus.textContent = attachPayload?.agora?.channel
      ? `Broadcasting to ${attachPayload.agora.channel}.`
      : 'Broadcasting.';
  } else if (broadcastState === 'connecting') {
    els.broadcastStatus.textContent = 'Requesting camera and microphone.';
  } else if (!sdkReady) {
    els.broadcastStatus.textContent = 'Agora SDK is still loading.';
  } else if (!ready && broadcastState === 'idle') {
    els.broadcastStatus.textContent = 'Attach a room to enable Agora broadcast.';
  }
  writeDebugLog('Broadcast controls', summarizeBroadcastControls());
}

function clearAgoraRenewTimer() {
  if (agoraRenewTimer) {
    clearTimeout(agoraRenewTimer);
    agoraRenewTimer = null;
  }
}

function scheduleAgoraTokenRenewal() {
  clearAgoraRenewTimer();
  const expiresAt = attachPayload?.agora?.token_expires_at;
  if (!expiresAt || !agoraClient) return;
  const delay = Math.max(
    expiresAt * 1000 - Date.now() - TOKEN_RENEW_LEAD_MS,
    MIN_TOKEN_RENEW_DELAY_MS
  );
  agoraRenewTimer = setTimeout(() => {
    renewAgoraToken().catch((err) => {
      writeLog('Renew Agora token failed', { message: safeErrorMessage(err) });
      agoraRenewTimer = setTimeout(() => {
        scheduleAgoraTokenRenewal();
      }, TOKEN_RENEW_RETRY_MS);
    });
  }, delay);
}

async function renewAgoraToken() {
  if (!agoraClient || !attachPayload?.runtime?.seat) return null;
  const payload = await api.attachLiveRoom({
    ...attachRequestPayload(),
    seat: attachPayload.runtime.seat,
  });
  applyAttachPayload(payload);
  if (payload?.agora?.token) {
    await agoraClient.renewToken(payload.agora.token);
  }
  scheduleAgoraTokenRenewal();
  writeLog('Renewed Agora token', payload);
  return payload;
}

function normalizeAudioDeviceText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function getJacktripAudioSourceHints(status = lastStatus) {
  const audio = status?.audio || {};
  return uniqueStrings([
    audio.sourceName,
    audio.sourceLabel,
    els.audio.textContent,
    'jacktrip',
  ]);
}

function summarizeAudioInputDevice(device) {
  return {
    deviceId: device?.deviceId ? '<available>' : null,
    groupId: device?.groupId ? '<available>' : null,
    kind: device?.kind || null,
    label: device?.label || null,
  };
}

async function listAudioInputsWithLabels() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('Audio device enumeration is unavailable');
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  let audioInputs = devices.filter((device) => device.kind === 'audioinput');
  const hasLabels = audioInputs.some((device) => Boolean(device.label));
  if (!hasLabels && navigator.mediaDevices.getUserMedia) {
    let probeStream = null;
    try {
      probeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      writeLog('Audio device label probe failed', { message: safeErrorMessage(err) });
    } finally {
      probeStream?.getTracks().forEach((track) => track.stop());
    }
    devices = await navigator.mediaDevices.enumerateDevices();
    audioInputs = devices.filter((device) => device.kind === 'audioinput');
  }
  return audioInputs;
}

function scoreJacktripAudioInput(device, hints) {
  const label = normalizeAudioDeviceText(device?.label);
  if (!label) return { score: 0, matchedBy: null };
  let best = { score: 0, matchedBy: null };
  for (const hint of hints) {
    const normalizedHint = normalizeAudioDeviceText(hint);
    if (!normalizedHint) continue;
    if (label === normalizedHint) {
      best = { score: 100, matchedBy: hint };
      break;
    }
    if (label.includes(normalizedHint)) {
      best = best.score >= 80 ? best : { score: 80, matchedBy: hint };
    } else if (normalizedHint.includes(label)) {
      best = best.score >= 70 ? best : { score: 70, matchedBy: hint };
    }
  }
  if (best.score === 0 && label.includes('jacktrip')) {
    best = { score: 50, matchedBy: 'jacktrip' };
  }
  return best;
}

async function resolveJacktripAudioInput() {
  const hints = getJacktripAudioSourceHints();
  const audioInputs = await listAudioInputsWithLabels();
  const ranked = audioInputs
    .map((device) => ({ device, ...scoreJacktripAudioInput(device, hints) }))
    .filter((entry) => entry.score > 0 && entry.device.deviceId)
    .sort((a, b) => b.score - a.score);
  const selected = ranked[0] || null;
  const detail = {
    availableInputs: audioInputs.map(summarizeAudioInputDevice),
    hints,
    selected: selected ? {
      ...summarizeAudioInputDevice(selected.device),
      matchedBy: selected.matchedBy,
      score: selected.score,
    } : null,
  };
  if (!selected) {
    writeLog('JackTrip Agora audio source not found', detail);
    throw new Error('JackTrip audio input was not found in browser devices');
  }
  writeLog('JackTrip Agora audio source selected', detail);
  return selected.device;
}

async function createAgoraAudioTrack() {
  if (!isJacktripHost()) {
    writeLog('Creating Agora audio track from default microphone');
    return await window.AgoraRTC.createMicrophoneAudioTrack();
  }
  const device = await resolveJacktripAudioInput();
  writeLog('Creating Agora audio track from JackTrip input', {
    device: summarizeAudioInputDevice(device),
    musicProfile: 'high_quality_stereo',
  });
  return await window.AgoraRTC.createMicrophoneAudioTrack({
    AEC: false,
    AGC: false,
    ANS: false,
    encoderConfig: 'high_quality_stereo',
    microphoneId: device.deviceId,
  });
}

async function startAgoraBroadcast() {
  if (!hasAgoraCredentials()) {
    throw new Error('Attach the live room before starting broadcast');
  }
  if (!window.AgoraRTC) {
    throw new Error('Agora SDK is not loaded');
  }
  if (isJacktripGuest()) {
    throw new Error('Guests join performance audio over JackTrip. The host broadcasts to viewers.');
  }
  if (isJacktripHost() && !isJacktripConnected()) {
    throw new Error('Connect JackTrip audio before broadcasting to viewers');
  }

  const agora = attachPayload.agora;
  renderBroadcastStatus('Requesting camera and microphone.', 'connecting');
  const client = window.AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
  let audioTrack = null;
  let videoTrack = null;

  try {
    writeLog('Agora producer start requested', {
      channel: agora.channel,
      roomId: attachPayload?.room?.id || els.liveRoomId.value,
      seat: attachPayload?.runtime?.seat || launchSeat || 'host',
      uid: agora.uid,
    });
    client.on('connection-state-change', (currentState, previousState, reason) => {
      writeLog('Agora producer connection state', {
        channel: agora.channel,
        currentState,
        previousState,
        reason: reason || null,
        uid: agora.uid,
      });
    });
    client.on('user-joined', (user) => {
      writeLog('Agora remote user joined producer channel', {
        channel: agora.channel,
        remoteUid: user?.uid ?? null,
      });
    });
    client.on('user-left', (user, reason) => {
      writeLog('Agora remote user left producer channel', {
        channel: agora.channel,
        reason: reason || null,
        remoteUid: user?.uid ?? null,
      });
    });
    client.on('user-published', (user, mediaType) => {
      writeLog('Agora remote user published on producer channel', {
        channel: agora.channel,
        mediaType,
        remoteUid: user?.uid ?? null,
      });
    });
    await client.setClientRole('host');
    writeLog('Agora producer role set', { channel: agora.channel, role: 'host', uid: agora.uid });
    await client.join(agora.app_id, agora.channel, agora.token, agora.uid);
    writeLog('Agora producer joined channel', {
      channel: agora.channel,
      uid: agora.uid,
    });
    [audioTrack, videoTrack] = await Promise.all([
      createAgoraAudioTrack(),
      window.AgoraRTC.createCameraVideoTrack(),
    ]);
    writeLog('Agora local media tracks created', {
      audioTrack: Boolean(audioTrack),
      audioSource: isJacktripHost() ? 'jacktrip' : 'default_microphone',
      channel: agora.channel,
      videoTrack: Boolean(videoTrack),
    });
    await client.publish([audioTrack, videoTrack]);
    writeLog('Agora producer published local tracks', {
      audioTrack: Boolean(audioTrack),
      channel: agora.channel,
      uid: agora.uid,
      videoTrack: Boolean(videoTrack),
    });

    agoraClient = client;
    localAudioTrack = audioTrack;
    localVideoTrack = videoTrack;
    els.localVideo.replaceChildren();
    localVideoTrack.play(els.localVideo);
    renderBroadcastStatus(`Broadcasting to ${agora.channel}.`, 'live');
    scheduleAgoraTokenRenewal();
    return {
      status: 'broadcasting',
      channel: agora.channel,
      uid: agora.uid,
      seat: attachPayload.runtime?.seat || 'host',
    };
  } catch (err) {
    writeLog('Agora producer start failed detail', {
      channel: agora.channel,
      message: safeErrorMessage(err),
      uid: agora.uid,
    });
    audioTrack?.close();
    videoTrack?.close();
    await client.leave().catch(() => undefined);
    renderBroadcastStatus('Broadcast failed.', 'idle');
    throw err;
  }
}

async function stopAgoraBroadcast(options = {}) {
  writeLog('Stop Agora broadcast requested', {
    channel: attachPayload?.agora?.channel || null,
    hasClient: Boolean(agoraClient),
    trackCount: [localAudioTrack, localVideoTrack].filter(Boolean).length,
  });
  clearAgoraRenewTimer();
  const client = agoraClient;
  const tracks = [localAudioTrack, localVideoTrack].filter(Boolean);
  agoraClient = null;
  localAudioTrack = null;
  localVideoTrack = null;
  els.localVideo.replaceChildren();

  if (client) {
    if (tracks.length) {
      await client.unpublish(tracks).catch(() => undefined);
    }
    await client.leave().catch(() => undefined);
  }
  tracks.forEach((track) => {
    track.stop();
    track.close();
  });
  renderBroadcastStatus('Broadcast stopped.', 'idle');
  writeLog('Agora broadcast stopped', {
    channel: attachPayload?.agora?.channel || null,
    quiet: options.quiet === true,
  });
  return options.quiet ? null : { status: 'stopped' };
}

async function connectFromAttach(payload) {
  const jacktrip = payload?.jacktrip;
  writeDebugLog('JackTrip connect decision', {
    jacktrip: summarizeAttachPayload(payload).jacktrip,
    platform: hostPlatform,
    roomId: payload?.room?.id || null,
    seat: payload?.runtime?.seat || null,
  });
  if (!jacktrip?.required) {
    writeLog('JackTrip not required for this room');
    return null;
  }
  if (!jacktrip.configured || !jacktrip.server) {
    throw new Error('Room requires JackTrip but no JackTrip server is configured');
  }
  if (hostPlatform === 'linux' && jacktrip.linux_audio_setup_recommended) {
    const audio = await api.setupJacktripAudio({ setDefaultSource: false });
    writeLog('JackTrip audio source prepared before connect', audio);
  }
  const status = await api.connectJacktrip({
    server: jacktrip.server,
    port: jacktrip.port || 4464,
    bindPort: jacktrip.bind_port || undefined,
    quality: jacktrip.quality || '4',
    bufferStrategy: jacktrip.buffer_strategy || '3',
  });
  if (normalizeState(status?.status) === 'error') {
    throw new Error(status?.error || status?.message || 'Could not connect JackTrip audio');
  }
  return status;
}

async function routeJacktripAudioAfterConnect(payload) {
  if (hostPlatform !== 'linux' || !isJacktripHost(payload)) {
    return null;
  }
  const audio = await api.setupJacktripAudio({ setDefaultSource: false });
  const movedInputsCount = Number(audio?.movedInputsCount || 0);
  writeLog('JackTrip audio routed after connect', {
    audio,
    movedInputsCount,
    roomId: payload?.room?.id || null,
    seat: payload?.runtime?.seat || null,
  });
  if (movedInputsCount === 0) {
    writeLog('JackTrip Pulse routing found no sink inputs; JACK/PipeWire port routing may be required', {
      audio,
      roomId: payload?.room?.id || null,
    });
  }
  const status = await api.getJacktripStatus();
  renderStatus(status);
  return { audio, status };
}

async function waitForJacktripConnected(timeoutMs = 10000) {
  const startedAt = Date.now();
  let status;
  while (Date.now() - startedAt < timeoutMs) {
    status = await api.getJacktripStatus();
    renderStatus(status);
    if (isJacktripConnected(status)) return status;
    const state = normalizeState(status?.status);
    if (state === 'error' || state === 'disconnected') {
      throw new Error(status?.error || status?.message || 'JackTrip audio is not connected');
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for JackTrip audio to connect');
}

async function attachConnectAndBroadcast() {
  writeLog('Auto start attach request', attachRequestPayload());
  const payload = await api.attachLiveRoom(attachRequestPayload());
  applyAttachPayload(payload);
  writeLog('Auto start attach result', summarizeAttachPayload(payload));
  const jacktripRequired = isJacktripRequiredRoom(payload);
  const guest = isJacktripGuest(payload);
  let jacktrip = await connectFromAttach(payload);
  let jacktripRouting = null;
  if (jacktripRequired) {
    jacktrip = await waitForJacktripConnected();
    jacktripRouting = await routeJacktripAudioAfterConnect(payload);
  }
  if (guest) {
    renderBroadcastStatus('Connected to JackTrip audio. The host controls the viewer broadcast.', 'idle');
    writeLog('JackTrip guest connected; host controls Agora broadcast', {
      jacktrip,
      jacktripRouting,
      room: payload?.room?.id || null,
      seat: payload?.runtime?.seat || null,
    });
    return {
      room: payload?.room?.id || null,
      seat: payload?.runtime?.seat || null,
      jacktrip,
      jacktripRouting,
      broadcast: null,
    };
  }
  const broadcast = await startAgoraBroadcast();
  return {
    room: payload?.room?.id || null,
    seat: payload?.runtime?.seat || null,
    jacktrip,
    jacktripRouting,
    broadcast,
  };
}

async function autoStartFromLaunch(initialAuthStatus) {
  await ensurePirateAuth(initialAuthStatus);
  return await attachConnectAndBroadcast();
}

async function run(label, fn) {
  try {
    writeDebugLog(`${label} started`, {
      attach: attachPayload ? summarizeAttachPayload(attachPayload) : null,
      broadcastState,
      busy,
    });
    setBusy(true);
    const result = await fn();
    writeLog(label, result);
    if (result && typeof result === 'object' && result.status) {
      renderStatus(result);
    }
    return result;
  } catch (err) {
    writeLog(`${label} failed`, {
      attach: attachPayload ? summarizeAttachPayload(attachPayload) : null,
      broadcastState,
      message: safeErrorMessage(err),
    });
    return null;
  } finally {
    setBusy(false);
  }
}

function stopDeviceAuthPolling() {
  if (deviceAuthTimer) {
    clearTimeout(deviceAuthTimer);
    deviceAuthTimer = null;
  }
}

async function pollDeviceAuth() {
  if (!deviceAuth?.device_code) return;
  try {
    const result = await api.pollPirateDeviceAuth({
      apiBase: els.apiBase.value,
      deviceCode: deviceAuth.device_code,
    });
    if (result?.error === 'authorization_pending') {
      const intervalMs = Math.max(1, Number(result.interval || deviceAuth.interval || 5)) * 1000;
      els.authStatus.textContent = `Waiting for approval · ${deviceAuth.user_code}`;
      deviceAuthTimer = setTimeout(pollDeviceAuth, intervalMs);
      return;
    }
    stopDeviceAuthPolling();
    deviceAuth = null;
    els.deviceCode.textContent = '';
    renderAuthStatus(result.auth || await api.getPirateAuthStatus());
    writeLog('Pirate sign-in complete', result);
  } catch (err) {
    stopDeviceAuthPolling();
    els.authStatus.textContent = 'Pirate sign-in failed';
    writeLog('Pirate sign-in failed', { message: safeErrorMessage(err) });
  }
}

async function bootstrap() {
  const missing = missingFreedomApiMethods();
  if (missing.length > 0) {
    renderBridgeUnavailable(missing);
    return;
  }

  const roomId = params.get('roomId') || params.get('room');
  const communityId = params.get('communityId') || params.get('community');
  const apiBase = params.get('apiBase') || params.get('api');
  const autoStart = Boolean(roomId && communityId && params.get('auto') !== '0');
  els.roomId.textContent = roomId ? `Room ${roomId}` : 'No room selected';
  if (apiBase) els.apiBase.value = apiBase;
  if (communityId) els.communityId.value = communityId;
  if (roomId) els.liveRoomId.value = roomId;
  writeLog('Live room launch parameters', {
    apiBase: els.apiBase.value,
    autoStart,
    communityId: els.communityId.value,
    roomId: els.liveRoomId.value,
    seat: launchSeat || null,
    webBase: launchWebBase || null,
  });
  els.server.value = params.get('server') || '';
  els.port.value = params.get('port') || '4464';
  els.bindPort.value = params.get('bindPort') || '';

  api.onJacktripStatusUpdate(renderStatus);

  hostPlatform = await api.getPlatform();
  els.runtime.textContent = hostPlatform;

  const deps = await api.checkJacktripDeps();
  els.binary.textContent = deps.jacktripBinary || 'Unknown';
  writeLog(deps.available ? 'JackTrip dependencies ready' : 'JackTrip dependency gap', deps);

  renderStatus(await api.getJacktripStatus());
  renderBroadcastControls();
  const authStatus = await api.getPirateAuthStatus();
  renderAuthStatus(authStatus);

  if (autoStart) {
    setTimeout(() => {
      run('Auto start live room', () => autoStartFromLaunch(authStatus));
    }, 0);
  }
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  run('Connect', () => api.connectJacktrip(connectPayload()));
});
els.attachForm.addEventListener('submit', (event) => {
  event.preventDefault();
  run('Attach room', async () => {
    writeLog('Attach room request', attachRequestPayload());
    const payload = await api.attachLiveRoom(attachRequestPayload());
    applyAttachPayload(payload);
    await connectFromAttach(payload);
    if (isJacktripRequiredRoom(payload)) {
      await waitForJacktripConnected();
      await routeJacktripAudioAfterConnect(payload);
    }
    return payload;
  });
});
document.getElementById('end-room').addEventListener('click', () => {
  run('End room', async () => {
    await stopAgoraBroadcast({ quiet: true });
    const room = await api.endLiveRoom(attachRequestPayload());
    applyEndedRoom(room);
    let jacktrip;
    try {
      jacktrip = await api.disconnectJacktrip();
    } catch (err) {
      jacktrip = { disconnectError: safeErrorMessage(err) };
    }
    return { room, jacktrip };
  });
});
document.getElementById('disconnect').addEventListener('click', () => {
  run('Disconnect', () => api.disconnectJacktrip());
});
document.getElementById('check-deps').addEventListener('click', async () => {
  const deps = await run('Check deps', () => api.checkJacktripDeps());
  if (deps) els.binary.textContent = deps.jacktripBinary || 'Unknown';
});
document.getElementById('setup-audio').addEventListener('click', () => {
  run('Setup audio', () => api.setupJacktripAudio({ setDefaultSource: true }));
});
document.getElementById('restore-audio').addEventListener('click', () => {
  run('Restore audio', () => api.restoreJacktripAudio());
});
document.getElementById('list-ports').addEventListener('click', async () => {
  const ports = await run('List ports', () => api.listJacktripPorts());
  els.ports.replaceChildren();
  if (Array.isArray(ports) && ports.length) {
    ports.forEach((port) => {
      const code = document.createElement('code');
      code.textContent = port;
      els.ports.appendChild(code);
    });
  } else {
    els.ports.textContent = 'No JACK ports found';
  }
});
document.getElementById('start-local').addEventListener('click', () => {
  run('Start local server', () => api.startJacktripLocalServer({ port: Number(els.port.value) }));
});
document.getElementById('stop-local').addEventListener('click', () => {
  run('Stop local server', () => api.stopJacktripLocalServer());
});
els.startBroadcast.addEventListener('click', () => {
  run('Start Agora broadcast', startAgoraBroadcast);
});
els.stopBroadcast.addEventListener('click', () => {
  run('Stop Agora broadcast', stopAgoraBroadcast);
});
document.getElementById('start-device-auth').addEventListener('click', () => {
  run('Start Pirate sign-in', async () => {
    const currentStatus = await api.getPirateAuthStatus();
    renderAuthStatus(currentStatus);
    writeLog('Start Pirate sign-in clicked', summarizeAuthStatus(currentStatus));
    stopDeviceAuthPolling();
    const auth = await api.startPirateDeviceAuth({ apiBase: els.apiBase.value, openBrowser: false, webBase: launchWebBase });
    deviceAuth = auth;
    els.deviceCode.textContent = `Code ${auth.user_code}`;
    els.authStatus.textContent = 'Approve the device in Pirate web';
    await openDeviceAuthorization(auth);
    deviceAuthTimer = setTimeout(pollDeviceAuth, Math.max(1, Number(auth.interval || 5)) * 1000);
    return auth;
  });
});
document.getElementById('clear-token').addEventListener('click', () => {
  run('Forget token', async () => {
    stopDeviceAuthPolling();
    const status = await api.clearPirateAccessToken();
    deviceAuth = null;
    els.deviceCode.textContent = '';
    renderAuthStatus(status);
    return status;
  });
});
window.addEventListener('beforeunload', () => {
  stopAgoraBroadcast({ quiet: true }).catch(() => undefined);
});

bootstrap().catch((err) => {
  writeLog('Live room failed to initialize', { message: safeErrorMessage(err) });
});
