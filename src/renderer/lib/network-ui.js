// Network popover UI controls for Privacy & Routing services
import { state } from './state.js';
import { pushDebug } from './debug.js';

// --- Anyone ---
let anyoneToggleBtn = null;
let anyoneToggleSwitch = null;
let anyoneInfoPanel = null;
let anyoneMenuStatusValue = null;
let anyoneMenuIpRow = null;
let anyoneMenuIpValue = null;
let anyoneMenuErrorRow = null;
let anyoneMenuErrorValue = null;

// --- Handshake ---
let hnsMenuStatus = null;
let hnsOpenPirateBtn = null;

// --- Sentinel ---
let sentinelMenuStatus = null;
let sentinelFundBtn = null;
let sentinelConnectBtn = null;
let sentinelDisconnectBtn = null;
let sentinelMenuBalanceRow = null;
let sentinelMenuBalance = null;
let sentinelPrerequisites = null;

// --- Sentinel Funding Modal ---
let sentinelFundingModal = null;
let sentinelFundingQr = null;
let sentinelFundingAddress = null;
let sentinelFundingCloseBtn = null;
let sentinelFundingCopyBtn = null;
let sentinelFundingRefreshBtn = null;
let sentinelBackupRevealBtn = null;
let sentinelBackupPanel = null;
let sentinelBackupWords = null;
let sentinelBackupCopyBtn = null;
let latestSentinelMnemonic = '';

// Callbacks
let onOpenPirate = null;
export const setOnOpenPirate = (callback) => {
  onOpenPirate = callback;
};

let latestDvpnStatus = null;

const formatP2PBalance = (balance) => {
  if (!balance) return '0 P2P';
  const value = String(balance);
  return value.includes('P2P') ? value : `${value} P2P`;
};

const renderMnemonicWords = (container, mnemonic) => {
  if (!container) return;
  container.innerHTML = '';
  mnemonic.split(/\s+/).filter(Boolean).forEach((word, index) => {
    const item = document.createElement('div');
    item.className = 'sentinel-backup-word';
    const number = document.createElement('span');
    number.className = 'sentinel-backup-index';
    number.textContent = String(index + 1);
    const text = document.createElement('span');
    text.textContent = word;
    item.appendChild(number);
    item.appendChild(text);
    container.appendChild(item);
  });
};

const copyText = async (text) => {
  if (!text) return;
  try {
    const result = await window.electronAPI?.copyText?.(text);
    if (result?.success) return;
  } catch {
    // Fallback below
  }
  try {
    await globalThis.navigator?.clipboard?.writeText?.(text);
  } catch {
    // Ignore clipboard failures
  }
};

const updateSentinelPrerequisites = (result) => {
  if (!result) return;
  sentinelPrerequisites = result;
  if (latestDvpnStatus) {
    updateSentinelMenuDisplay(latestDvpnStatus);
  }
};

export const updateAnyoneMenuDisplay = (status) => {
  if (!status) return;

  const stateLabel =
    {
      off: 'Off',
      starting: 'Connecting…',
      connected: 'Connected',
      stopping: 'Disconnecting…',
      error: 'Error',
    }[status.state] || status.state || 'Off';

  if (anyoneMenuStatusValue) anyoneMenuStatusValue.textContent = stateLabel;
  if (anyoneMenuIpRow) anyoneMenuIpRow.style.display = status.ip ? '' : 'none';
  if (anyoneMenuIpValue) anyoneMenuIpValue.textContent = status.ip || '—';

  if (anyoneMenuErrorRow) {
    anyoneMenuErrorRow.style.display = status.error ? '' : 'none';
    if (anyoneMenuErrorValue) anyoneMenuErrorValue.textContent = status.error || '';
  }

  if (anyoneToggleSwitch) {
    anyoneToggleSwitch.classList.remove('running', 'starting');
    if (status.state === 'connected' || status.state === 'starting') {
      anyoneToggleSwitch.classList.add(
        status.state === 'starting' ? 'starting' : 'running'
      );
    }
  }

  state.currentAnyoneStatus = status.state || 'off';

  if (anyoneInfoPanel) {
    const show =
      status.state === 'connected' ||
      status.state === 'starting' ||
      status.state === 'error';
    anyoneInfoPanel.classList.toggle('visible', show);
  }
};

export const updateHnsMenuDisplay = (status) => {
  if (!status) return;
  const s = status.status || 'stopped';
  const labels = {
    stopped: 'Disabled',
    starting: 'Starting',
    running: status.synced ? 'Ready' : 'Syncing',
    stopping: 'Stopping',
    error: 'Error',
  };
  if (hnsMenuStatus) hnsMenuStatus.textContent = labels[s] || s;

  if (hnsOpenPirateBtn) {
    const ready = s === 'running' && status.synced;
    hnsOpenPirateBtn.style.display = ready ? '' : 'none';
  }
};

export const updateSentinelMenuDisplay = (status) => {
  if (!status) return;
  latestDvpnStatus = status;
  if (status.prerequisites) {
    sentinelPrerequisites = status.prerequisites;
  }

  const hasWallet = !!status.walletAddress;
  const unavailable = sentinelPrerequisites?.ok === false;
  const isConnected = status.state === 'connected';
  const isConnecting = status.state === 'connecting';
  const isStopping =
    status.state === 'disconnecting' ||
    status.state === 'local_off_remote_pending';

  if (sentinelMenuStatus) {
    if (unavailable) {
      sentinelMenuStatus.textContent = 'Unavailable';
    } else if (status.state === 'error') {
      sentinelMenuStatus.textContent = status.error ? `Error · ${status.error}` : 'Error';
    } else if (!hasWallet) {
      sentinelMenuStatus.textContent = 'Setup required';
    } else if (!status.funded) {
      sentinelMenuStatus.textContent = 'Needs P2P';
    } else {
      const stateLabels = {
        off: 'Ready',
        wallet_ready: status.lastDisconnectReason ? 'Stopped' : 'Ready',
        connecting: 'Connecting…',
        connected: 'Connected',
        disconnecting: 'Disconnecting…',
        local_off_remote_pending: 'Ending session…',
        error: 'Error',
      };
      sentinelMenuStatus.textContent =
        stateLabels[status.state] || status.state || 'Ready';
    }
  }

  if (sentinelMenuBalanceRow) {
    sentinelMenuBalanceRow.style.display = '';
  }
  if (sentinelMenuBalance) {
    sentinelMenuBalance.textContent = hasWallet ? formatP2PBalance(status.balance) : '-';
  }

  if (sentinelFundBtn) {
    sentinelFundBtn.style.display =
      !hasWallet || !status.funded ? 'inline-flex' : 'none';
    sentinelFundBtn.textContent = !hasWallet ? 'Setup Wallet' : 'Add P2P';
    sentinelFundBtn.disabled = unavailable;
  }
  if (sentinelConnectBtn) {
    sentinelConnectBtn.style.display =
      !unavailable && hasWallet && status.funded && !isConnected && !isConnecting && !isStopping
        ? 'inline-flex'
        : 'none';
  }
  if (sentinelDisconnectBtn) {
    sentinelDisconnectBtn.style.display =
      isConnected || isConnecting || isStopping ? 'inline-flex' : 'none';
  }

  state.currentDvpnStatus = status.state || 'off';
};

// Polling: refresh Sentinel balance while menu is open
let sentinelBalanceInterval = null;

export const startNetworkInfoPolling = () => {
  if (sentinelBalanceInterval) clearInterval(sentinelBalanceInterval);
  sentinelBalanceInterval = setInterval(() => {
    window.dvpn
      ?.getBalance?.()
      .then(() => {
        window.dvpn
          ?.getStatus?.()
          .then(updateSentinelMenuDisplay)
          .catch(() => {});
      })
      .catch(() => {});
  }, 5000);
};

export const stopNetworkInfoPolling = () => {
  if (sentinelBalanceInterval) {
    clearInterval(sentinelBalanceInterval);
    sentinelBalanceInterval = null;
  }
};

const updateSentinelFundingModal = (status) => {
  if (!status) return;

  if (sentinelFundingAddress) {
    sentinelFundingAddress.textContent = status.walletAddress || '';
  }

  const fundingBalanceEl = document.getElementById('sentinel-funding-balance');
  if (fundingBalanceEl) {
    fundingBalanceEl.textContent = status.walletAddress
      ? formatP2PBalance(status.balance)
      : '-';
  }

  if (!status.walletAddress) {
    window.dvpn
      ?.createWallet?.()
      .then(() => {
        window.dvpn
          ?.getStatus?.()
          .then((s) => {
            updateSentinelFundingModal(s);
            updateSentinelMenuDisplay(s);
          })
          .catch(() => {});
      })
      .catch(() => {});
    return;
  }

  if (window.dvpn?.generateQR && sentinelFundingQr) {
    window.dvpn
      .generateQR(status.walletAddress, { width: 192, margin: 1 })
      .then((result) => {
        if (result?.success && result.dataUrl) {
          sentinelFundingQr.src = result.dataUrl;
        }
      })
      .catch(() => {});
  }
};

const revealSentinelBackup = async () => {
  if (!sentinelBackupPanel || !sentinelBackupWords) return;
  const result = await window.dvpn?.exportMnemonic?.();
  if (!result?.success || !result.mnemonic) {
    renderMnemonicWords(sentinelBackupWords, result?.error || 'Backup unavailable');
    sentinelBackupPanel.hidden = false;
    return;
  }
  latestSentinelMnemonic = result.mnemonic;
  renderMnemonicWords(sentinelBackupWords, result.mnemonic);
  sentinelBackupPanel.hidden = false;
};

export const initNetworkUi = () => {
  // Anyone DOM
  anyoneToggleBtn = document.getElementById('anyone-toggle-btn');
  anyoneToggleSwitch = document.getElementById('anyone-toggle-switch');
  anyoneInfoPanel = document.getElementById('anyone-info-panel');
  anyoneMenuStatusValue = document.getElementById('anyone-menu-status-value');
  anyoneMenuIpRow = document.getElementById('anyone-menu-ip-row');
  anyoneMenuIpValue = document.getElementById('anyone-menu-ip-value');
  anyoneMenuErrorRow = document.getElementById('anyone-menu-error-row');
  anyoneMenuErrorValue = document.getElementById('anyone-menu-error-value');

  // Handshake DOM
  hnsMenuStatus = document.getElementById('hns-menu-status');
  hnsOpenPirateBtn = document.getElementById('hns-open-pirate-btn');

  // Sentinel DOM
  sentinelMenuStatus = document.getElementById('sentinel-menu-status');
  sentinelFundBtn = document.getElementById('sentinel-fund-btn');
  sentinelConnectBtn = document.getElementById('sentinel-connect-btn');
  sentinelDisconnectBtn = document.getElementById('sentinel-disconnect-btn');
  sentinelMenuBalanceRow = document.getElementById('sentinel-menu-balance-row');
  sentinelMenuBalance = document.getElementById('sentinel-menu-balance');

  // Funding Modal DOM
  sentinelFundingModal = document.getElementById('sentinel-funding-modal');
  sentinelFundingQr = document.getElementById('sentinel-funding-qr');
  sentinelFundingAddress = document.getElementById('sentinel-funding-address');
  sentinelFundingCloseBtn = document.getElementById('close-sentinel-funding');
  sentinelFundingCopyBtn = document.getElementById('sentinel-funding-copy');
  sentinelFundingRefreshBtn = document.getElementById('sentinel-funding-refresh');
  sentinelBackupRevealBtn = document.getElementById('sentinel-backup-reveal');
  sentinelBackupPanel = document.getElementById('sentinel-backup-panel');
  sentinelBackupWords = document.getElementById('sentinel-backup-words');
  sentinelBackupCopyBtn = document.getElementById('sentinel-backup-copy');

  // Anyone toggle
  anyoneToggleBtn?.addEventListener('click', () => {
    const current = state.currentAnyoneStatus || 'off';
    if (current === 'connected' || current === 'starting') {
      pushDebug('User toggled Anyone Off');
      window.anyone
        ?.stop?.()
        .then(({ status }) => updateAnyoneMenuDisplay(status))
        .catch((err) => pushDebug(`Failed to stop Anyone: ${err.message}`));
    } else {
      pushDebug('User toggled Anyone On');
      window.anyone
        ?.start?.()
        .then(({ status }) => updateAnyoneMenuDisplay(status))
        .catch((err) => pushDebug(`Failed to start Anyone: ${err.message}`));
    }
  });

  // Handshake open app.pirate/
  hnsOpenPirateBtn?.addEventListener('click', () => {
    onOpenPirate?.();
  });

  // Sentinel actions
  sentinelFundBtn?.addEventListener('click', () => {
    sentinelFundingModal?.showModal();
    window.dvpn
      ?.getStatus?.()
      .then((status) => updateSentinelFundingModal(status))
      .catch(() => {});
  });

  sentinelConnectBtn?.addEventListener('click', () => {
    window.dvpn?.start?.().catch(() => {});
  });

  sentinelDisconnectBtn?.addEventListener('click', () => {
    window.dvpn?.stop?.().catch(() => {});
  });

  // Funding modal close
  sentinelFundingCloseBtn?.addEventListener('click', () => {
    sentinelFundingModal?.close();
  });

  sentinelFundingModal?.addEventListener('click', (event) => {
    if (event.target === sentinelFundingModal) {
      sentinelFundingModal.close();
    }
  });

  // Funding modal copy address
  sentinelFundingCopyBtn?.addEventListener('click', async () => {
    const address = sentinelFundingAddress?.textContent?.trim();
    await copyText(address);
  });

  sentinelBackupRevealBtn?.addEventListener('click', () => {
    revealSentinelBackup().catch((err) => pushDebug(`Failed to export Sentinel wallet: ${err.message}`));
  });

  sentinelBackupCopyBtn?.addEventListener('click', () => {
    copyText(latestSentinelMnemonic).catch(() => {});
  });

  // Funding modal refresh balance
  sentinelFundingRefreshBtn?.addEventListener('click', () => {
    window.dvpn
      ?.getBalance?.()
      .then(() => {
        window.dvpn
          ?.getStatus?.()
          .then((s) => {
            updateSentinelFundingModal(s);
            updateSentinelMenuDisplay(s);
          })
          .catch(() => {});
      })
      .catch(() => {});
  });

  // Live subscriptions
  if (window.anyone?.onStatusUpdate) {
    window.anyone.onStatusUpdate((data) => updateAnyoneMenuDisplay(data));
    window.anyone
      .getStatus()
      .then((data) => updateAnyoneMenuDisplay(data))
      .catch(() => {});
  }

  if (window.hns?.onStatusUpdate) {
    window.hns.onStatusUpdate((data) => updateHnsMenuDisplay(data));
    window.hns
      .getStatus()
      .then((data) => updateHnsMenuDisplay(data))
      .catch(() => {});
  }

  if (window.dvpn?.onStatusUpdate) {
    window.dvpn.onStatusUpdate((data) => updateSentinelMenuDisplay(data));
    window.dvpn
      .getStatus()
      .then((data) => updateSentinelMenuDisplay(data))
      .catch(() => {});
    window.dvpn
      ?.checkPrerequisites?.()
      .then(updateSentinelPrerequisites)
      .catch(() => {});
  }
};
