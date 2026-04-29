const anyoneStatusEl = document.getElementById('anyone-status');
const anyoneToggleBtn = document.getElementById('anyone-toggle');
const sentinelStatusEl = document.getElementById('sentinel-status');
const sentinelFundBtn = document.getElementById('sentinel-fund');
const sentinelConnectBtn = document.getElementById('sentinel-connect');
const sentinelDisconnectBtn = document.getElementById('sentinel-disconnect');
const sentinelFundingEl = document.getElementById('sentinel-funding');
const sentinelAddressEl = document.getElementById('sentinel-address');
const sentinelQrEl = document.getElementById('sentinel-qr');
const sentinelCopyBtn = document.getElementById('sentinel-copy');
const sentinelBalanceEl = document.getElementById('sentinel-balance');
const sentinelRefreshBtn = document.getElementById('sentinel-refresh');
const sentinelBackupRevealBtn = document.getElementById('sentinel-backup-reveal');
const sentinelBackupPanel = document.getElementById('sentinel-backup-panel');
const sentinelBackupWords = document.getElementById('sentinel-backup-words');
const sentinelBackupCopyBtn = document.getElementById('sentinel-backup-copy');
const handshakeStatusEl = document.getElementById('handshake-status');

let activeSettings = { enableHnsIntegration: true };
let latestAnyoneStatus = { state: 'off' };
let latestDvpnPrerequisites = null;
let latestSentinelMnemonic = '';

function formatP2PBalance(balance) {
  if (!balance) return '0 P2P';
  const value = String(balance);
  return value.includes('P2P') ? value : `${value} P2P`;
}

function formatAnyoneStatus(status = {}) {
  const labels = {
    off: 'Off',
    starting: 'Connecting...',
    connected: status.ip ? `On · exit ${status.ip}` : 'On',
    stopping: 'Disconnecting...',
    error: status.error ? `Error · ${status.error}` : 'Error',
  };
  return labels[status.state] || status.state || 'Off';
}

function updateAnyone(status = {}) {
  latestAnyoneStatus = status;
  anyoneStatusEl.textContent = formatAnyoneStatus(status);
  const isOn = status.state === 'connected' || status.state === 'starting';
  anyoneToggleBtn.textContent = isOn ? 'Turn off' : 'Turn on';
  anyoneToggleBtn.disabled = status.state === 'starting' || status.state === 'stopping';
}

function formatDvpnStatus(status = {}) {
  const hasWallet = !!status.walletAddress;
  if (latestDvpnPrerequisites?.ok === false) return 'Unavailable';
  if (status.state === 'error') return status.error ? `Error · ${status.error}` : 'Error';
  if (!hasWallet) return 'Setup required';
  if (status.state === 'connected') {
    return status.ip ? `Connected · ${status.ip}` : 'Connected';
  }
  if (status.state === 'connecting') return 'Connecting...';
  if (status.state === 'disconnecting') return 'Disconnecting...';
  if (status.state === 'local_off_remote_pending') return 'Ending session...';
  if (!status.funded) return 'Needs P2P';
  return status.balance ? `Ready · ${formatP2PBalance(status.balance)}` : 'Ready';
}

function updateSentinel(status = {}) {
  if (status.prerequisites) {
    latestDvpnPrerequisites = status.prerequisites;
  }
  const hasWallet = !!status.walletAddress;
  const unavailable = latestDvpnPrerequisites?.ok === false;
  const connected = status.state === 'connected';
  const busy =
    status.state === 'connecting' ||
    status.state === 'disconnecting' ||
    status.state === 'local_off_remote_pending';

  sentinelStatusEl.textContent = formatDvpnStatus(status);
  sentinelFundBtn.style.display = !hasWallet || !status.funded ? '' : 'none';
  sentinelFundBtn.textContent = !hasWallet ? 'Setup Wallet' : 'Add P2P';
  sentinelFundBtn.disabled = unavailable;
  sentinelConnectBtn.style.display = !unavailable && hasWallet && status.funded && !connected && !busy ? '' : 'none';
  sentinelDisconnectBtn.style.display = connected || busy ? '' : 'none';
  sentinelConnectBtn.disabled = busy;
  sentinelDisconnectBtn.disabled = busy && status.state !== 'connecting';
  if (sentinelBalanceEl) {
    sentinelBalanceEl.textContent = hasWallet ? formatP2PBalance(status.balance) : '-';
  }
}

function renderMnemonicWords(container, mnemonic) {
  if (!container) return;
  container.innerHTML = '';
  mnemonic.split(/\s+/).filter(Boolean).forEach((word, index) => {
    const item = document.createElement('div');
    item.className = 'backup-word';
    const number = document.createElement('span');
    number.className = 'backup-index';
    number.textContent = String(index + 1);
    const text = document.createElement('span');
    text.textContent = word;
    item.appendChild(number);
    item.appendChild(text);
    container.appendChild(item);
  });
}

async function revealBackup() {
  const result = await window.freedomAPI.exportDvpnMnemonic();
  if (!result?.success || !result.mnemonic) {
    renderMnemonicWords(sentinelBackupWords, result?.error || 'Backup unavailable');
    sentinelBackupPanel.hidden = false;
    return;
  }
  latestSentinelMnemonic = result.mnemonic;
  renderMnemonicWords(sentinelBackupWords, result.mnemonic);
  sentinelBackupPanel.hidden = false;
}

function updateHandshake(registry = {}) {
  const hns = registry.hns || {};
  if (activeSettings.enableHnsIntegration !== true) {
    handshakeStatusEl.textContent = 'Off';
    return;
  }
  if (hns.mode === 'bundled' && hns.canaryReady === true) {
    handshakeStatusEl.textContent = hns.height > 0 ? `Ready · block ${hns.height}` : 'Ready';
    return;
  }
  if (hns.mode === 'bundled') {
    handshakeStatusEl.textContent = hns.statusMessage || 'Syncing';
    return;
  }
  handshakeStatusEl.textContent = 'Starting';
}

async function refreshDvpnStatus({ refreshBalance = false } = {}) {
  if (refreshBalance) {
    await window.freedomAPI.getDvpnBalance().catch(() => null);
  }
  const status = await window.freedomAPI.getDvpnStatus();
  updateSentinel(status);
  return status;
}

async function showFunding() {
  sentinelFundBtn.disabled = true;
  sentinelStatusEl.textContent = 'Preparing wallet...';

  let status = await window.freedomAPI.getDvpnStatus();
  if (!status.walletAddress) {
    const result = await window.freedomAPI.createDvpnWallet();
    if (!result?.success) {
      sentinelStatusEl.textContent = result?.error || 'Wallet creation failed';
      sentinelFundBtn.disabled = false;
      return;
    }
    status = await window.freedomAPI.getDvpnStatus();
  }

  sentinelAddressEl.textContent = status.walletAddress || '';
  if (sentinelBalanceEl) {
    sentinelBalanceEl.textContent = formatP2PBalance(status.balance);
  }
  const qr = await window.freedomAPI.generateDvpnQR(status.walletAddress, {
    width: 168,
    margin: 1,
  });
  if (qr?.success && qr.dataUrl) {
    sentinelQrEl.src = qr.dataUrl;
  }

  sentinelFundingEl.classList.add('visible');
  sentinelFundBtn.disabled = false;
  updateSentinel(status);
}

async function bootstrap() {
  try {
    activeSettings = await window.freedomAPI.getSettings();
  } catch {
    activeSettings = { enableHnsIntegration: true };
  }

  const [registry, anyoneStatus, dvpnStatus, dvpnPrerequisites] = await Promise.all([
    window.freedomAPI.getServiceRegistry().catch(() => ({})),
    window.freedomAPI.getAnyoneStatus().catch(() => ({ state: 'off' })),
    window.freedomAPI.getDvpnStatus().catch(() => ({ state: 'off' })),
    window.freedomAPI.checkDvpnPrerequisites?.().catch(() => null),
  ]);

  latestDvpnPrerequisites = dvpnPrerequisites;
  updateHandshake(registry);
  updateAnyone(anyoneStatus);
  updateSentinel(dvpnStatus);

  window.freedomAPI.onServiceRegistryUpdate(updateHandshake);
  window.freedomAPI.onAnyoneStatusUpdate(updateAnyone);
  window.freedomAPI.onDvpnStatusUpdate(updateSentinel);

  anyoneToggleBtn.addEventListener('click', async () => {
    const isOn = latestAnyoneStatus.state === 'connected' || latestAnyoneStatus.state === 'starting';
    anyoneToggleBtn.disabled = true;
    const result = isOn
      ? await window.freedomAPI.stopAnyone()
      : await window.freedomAPI.startAnyone();
    updateAnyone(result?.status || (await window.freedomAPI.getAnyoneStatus()));
  });

  sentinelFundBtn.addEventListener('click', () => {
    showFunding().catch((err) => {
      sentinelStatusEl.textContent = err?.message || 'Funding setup failed';
      sentinelFundBtn.disabled = false;
    });
  });

  sentinelCopyBtn?.addEventListener('click', async () => {
    const address = sentinelAddressEl.textContent.trim();
    if (!address) return;
    if (window.freedomAPI.copyText) {
      await window.freedomAPI.copyText(address).catch(() => null);
      return;
    }
    await globalThis.navigator?.clipboard?.writeText?.(address)?.catch(() => null);
  });

  sentinelRefreshBtn?.addEventListener('click', async () => {
    sentinelRefreshBtn.disabled = true;
    await refreshDvpnStatus({ refreshBalance: true }).catch(() => null);
    sentinelRefreshBtn.disabled = false;
  });

  sentinelBackupRevealBtn?.addEventListener('click', () => {
    revealBackup().catch((err) => {
      sentinelStatusEl.textContent = err?.message || 'Backup unavailable';
    });
  });

  sentinelBackupCopyBtn?.addEventListener('click', async () => {
    if (!latestSentinelMnemonic) return;
    await window.freedomAPI.copyText(latestSentinelMnemonic).catch(() => null);
  });

  sentinelConnectBtn.addEventListener('click', async () => {
    sentinelConnectBtn.disabled = true;
    await window.freedomAPI.startDvpn().catch(() => null);
    await refreshDvpnStatus({ refreshBalance: true }).catch(() => null);
  });

  sentinelDisconnectBtn.addEventListener('click', async () => {
    sentinelDisconnectBtn.disabled = true;
    await window.freedomAPI.stopDvpn().catch(() => null);
    await refreshDvpnStatus().catch(() => null);
  });
}

document.addEventListener('DOMContentLoaded', bootstrap);
