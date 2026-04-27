// Settings modal UI
import { pushDebug } from './debug.js';
import { setMenuOpen } from './menus.js';

const electronAPI = window.electronAPI;

// DOM elements (initialized in initSettings)
let settingsBtn = null;
let settingsModal = null;
let closeSettingsBtn = null;
let themeModeSelect = null;
let startBeeAtLaunchCheckbox = null;
let startIpfsAtLaunchCheckbox = null;
let enableRadicleIntegrationCheckbox = null;
let startRadicleRow = null;
let startRadicleAtLaunchCheckbox = null;
let enableIdentityWalletCheckbox = null;
let autoUpdateCheckbox = null;
let experimentalSection = null;
let enableHnsIntegrationCheckbox = null;
let startHnsRow = null;
let startHnsAtLaunchCheckbox = null;
let hnsStatusValue = null;
let hnsHeightRow = null;
let hnsHeightValue = null;
let hnsProxyRow = null;
let hnsProxyValue = null;
let hnsErrorRow = null;
let hnsErrorValue = null;
let isWindows = false;

let enableAnyoneCheckbox = null;
let startAnyoneRow = null;
let anyoneAutoStartCheckbox = null;
let anyoneStatusRow = null;
let anyoneStatusValue = null;
let anyoneProxyRow = null;
let anyoneProxyValue = null;
let anyoneSocksPortRow = null;
let anyoneSocksPortValue = null;
let anyoneControlPortRow = null;
let anyoneControlPortValue = null;
let anyoneCircuitRow = null;
let anyoneCircuitValue = null;
let anyoneIpRow = null;
let anyoneIpValue = null;
let anyoneErrorRow = null;
let anyoneErrorValue = null;
let _anyoneStatusUnsubscribe = null;

let showDvpnControlsCheckbox = null;
let dvpnContent = null;
let dvpnCreateWalletBtn = null;
let dvpnWalletSetup = null;
let dvpnWalletDisplay = null;
let dvpnWalletAddressEl = null;
let dvpnCopyAddressBtn = null;
let dvpnQrRow = null;
let dvpnQrImage = null;
let dvpnBalanceRow = null;
let dvpnBalanceValue = null;
let dvpnRefreshBalanceBtn = null;
let dvpnStatusRow = null;
let dvpnStatusValue = null;
let dvpnNodeRow = null;
let dvpnNodeValue = null;
let dvpnCountryRow = null;
let dvpnCountryValue = null;
let dvpnIpRow = null;
let dvpnIpValue = null;
let dvpnErrorRow = null;
let dvpnErrorValue = null;
let dvpnConnectBtn = null;
let dvpnDisconnectBtn = null;
let dvpnControls = null;
let dvpnMaxSpendInput = null;
let dvpnLowBalanceStopInput = null;
let dvpnMaxDurationInput = null;
let _dvpnStatusUnsubscribe = null;

let currentThemeMode = 'system';
let currentRadicleIntegrationEnabled = false;
let currentHnsIntegrationEnabled = false;
let currentAnyoneEnabled = false;
let _hnsStatusUnsubscribe = null;

let onSettingsChanged = null;

export const setOnSettingsChanged = (callback) => {
  onSettingsChanged = callback;
};

const systemPrefersDark = () => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const updateRadicleSettingsVisibility = () => {
  const enabled = enableRadicleIntegrationCheckbox?.checked === true;
  startRadicleRow?.classList.toggle('disabled', !enabled);
  if (startRadicleAtLaunchCheckbox) {
    startRadicleAtLaunchCheckbox.disabled = !enabled;
  }
};

const updateHnsSettingsVisibility = () => {
  const enabled = enableHnsIntegrationCheckbox?.checked === true;
  startHnsRow?.classList.toggle('disabled', !enabled);
  if (startHnsAtLaunchCheckbox) {
    startHnsAtLaunchCheckbox.disabled = !enabled;
  }
};

const updateAnyoneSettingsVisibility = () => {
  const enabled = enableAnyoneCheckbox?.checked === true;
  startAnyoneRow?.classList.toggle('disabled', !enabled);
  if (anyoneAutoStartCheckbox) {
    anyoneAutoStartCheckbox.disabled = !enabled;
  }
};

const updateDvpnSettingsVisibility = () => {
  const show = showDvpnControlsCheckbox?.checked === true;
  if (dvpnContent) dvpnContent.style.display = show ? '' : 'none';
  if (!show && window.dvpn) {
    window.dvpn.stop?.().catch(() => {});
  }
};

const updateAnyoneStatusDisplay = (status) => {
  if (!status) return;

  if (anyoneStatusRow) anyoneStatusRow.style.display = '';
  if (anyoneStatusValue) {
    const stateLabels = {
      off: 'Off',
      starting: 'Connecting...',
      connected: 'Connected',
      stopping: 'Disconnecting...',
      error: 'Error',
    };
    anyoneStatusValue.textContent = stateLabels[status.state] || status.state || 'Off';
  }

  if (anyoneProxyRow) anyoneProxyRow.style.display = status.proxy ? '' : 'none';
  if (anyoneProxyValue) anyoneProxyValue.textContent = status.proxy || '';

  if (anyoneSocksPortRow) anyoneSocksPortRow.style.display = status.socksPort ? '' : 'none';
  if (anyoneSocksPortValue) anyoneSocksPortValue.textContent = status.socksPort ? String(status.socksPort) : '';

  if (anyoneControlPortRow) anyoneControlPortRow.style.display = status.controlPort ? '' : 'none';
  if (anyoneControlPortValue) anyoneControlPortValue.textContent = status.controlPort ? String(status.controlPort) : '';

  if (anyoneCircuitRow) anyoneCircuitRow.style.display = status.circuitState ? '' : 'none';
  if (anyoneCircuitValue) anyoneCircuitValue.textContent = status.circuitState || '';

  if (anyoneIpRow) anyoneIpRow.style.display = status.ip ? '' : 'none';
  if (anyoneIpValue) anyoneIpValue.textContent = status.ip || '';

  if (anyoneErrorRow) anyoneErrorRow.style.display = status.error ? '' : 'none';
  if (anyoneErrorValue) anyoneErrorValue.textContent = status.error || '';
};

const copyText = async (text) => {
  if (!text) return false;

  try {
    const result = await electronAPI?.copyText?.(text);
    if (result?.success) {
      return true;
    }
  } catch {
    // Fallback below
  }

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Ignore clipboard fallback failures
  }

  return false;
};

const renderDvpnQr = async (address) => {
  if (!dvpnQrRow || !dvpnQrImage || !window.dvpn?.generateQR) return;
  if (!address) {
    dvpnQrRow.style.display = 'none';
    dvpnQrImage.removeAttribute('src');
    return;
  }

  try {
    const result = await window.dvpn.generateQR(address, { width: 192, margin: 1 });
    if (result?.success && result.dataUrl) {
      dvpnQrImage.src = result.dataUrl;
      dvpnQrRow.style.display = '';
    } else {
      dvpnQrRow.style.display = 'none';
    }
  } catch {
    dvpnQrRow.style.display = 'none';
  }
};

const updateDvpnStatusDisplay = (status) => {
  if (!status) return;

  const hasWallet = !!status.walletAddress;
  const isConnected = status.state === 'connected';
  const isConnecting = status.state === 'connecting';
  const isStopping =
    status.state === 'disconnecting' || status.state === 'local_off_remote_pending';

  if (dvpnWalletSetup) dvpnWalletSetup.style.display = hasWallet ? 'none' : '';
  if (dvpnWalletDisplay) dvpnWalletDisplay.style.display = hasWallet ? '' : 'none';
  if (dvpnWalletAddressEl) dvpnWalletAddressEl.textContent = status.walletAddress || '';
  renderDvpnQr(status.walletAddress || null);

  if (dvpnBalanceRow) dvpnBalanceRow.style.display = hasWallet ? '' : 'none';
  if (dvpnBalanceValue) dvpnBalanceValue.textContent = status.balance || '—';

  if (dvpnStatusRow) dvpnStatusRow.style.display = hasWallet ? '' : 'none';
  if (dvpnStatusValue) {
    const stateLabels = {
      off: 'Off',
      wallet_ready: status.lastDisconnectReason ? `Stopped — ${status.lastDisconnectReason.replace(/_/g, ' ')}` : 'Off',
      connecting: 'Connecting...',
      connected: 'Connected',
      disconnecting: 'Disconnecting...',
      local_off_remote_pending: 'Ending session...',
      error: 'Error',
    };
    dvpnStatusValue.textContent = stateLabels[status.state] || status.state || 'Off';
  }

  if (dvpnControls) dvpnControls.style.display = hasWallet ? '' : 'none';

  if (dvpnNodeRow) dvpnNodeRow.style.display = status.nodeAddress ? '' : 'none';
  if (dvpnNodeValue) dvpnNodeValue.textContent = status.nodeAddress || '';

  if (dvpnCountryRow) dvpnCountryRow.style.display = status.country ? '' : 'none';
  if (dvpnCountryValue) dvpnCountryValue.textContent = status.country || '';

  if (dvpnIpRow) dvpnIpRow.style.display = status.ip ? '' : 'none';
  if (dvpnIpValue) dvpnIpValue.textContent = status.ip || '';

  if (dvpnErrorRow) dvpnErrorRow.style.display = status.error ? '' : 'none';
  if (dvpnErrorValue) dvpnErrorValue.textContent = status.error || '';

  if (dvpnConnectBtn && dvpnDisconnectBtn) {
    dvpnConnectBtn.disabled = isConnected || isConnecting || isStopping || !hasWallet || !status.funded;
    dvpnDisconnectBtn.disabled = !isConnected && !isConnecting && !isStopping;
  }
};

const updateHnsStatusDisplay = (status) => {
  if (!status) return;

  if (hnsStatusValue) {
    const s = status.status || 'stopped';
    const labels = {
      stopped: 'Stopped',
      starting: 'Starting',
      running: status.synced ? 'Ready' : 'Syncing',
      stopping: 'Stopping',
      error: 'Error',
    };
    hnsStatusValue.textContent = labels[s] || s;
  }

  if (hnsHeightRow && hnsHeightValue) {
    const show = status.height > 0;
    hnsHeightRow.style.display = show ? '' : 'none';
    hnsHeightValue.textContent = status.height || '0';
  }

  if (hnsProxyRow && hnsProxyValue) {
    const show = !!status.proxyAddr;
    hnsProxyRow.style.display = show ? '' : 'none';
    hnsProxyValue.textContent = status.proxyAddr || '';
  }

  if (hnsErrorRow && hnsErrorValue) {
    const show = !!status.error;
    hnsErrorRow.style.display = show ? '' : 'none';
    hnsErrorValue.textContent = status.error || '';
  }

};

export const applyTheme = (mode) => {
  let isDark;
  if (mode === 'system') {
    isDark = systemPrefersDark();
  } else {
    isDark = mode === 'dark';
  }

  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
  }
};

export const initTheme = async () => {
  const settings = await electronAPI.getSettings();
  currentThemeMode = settings?.theme || 'system';
  currentRadicleIntegrationEnabled = settings?.enableRadicleIntegration === true;
  currentHnsIntegrationEnabled = settings?.enableHnsIntegration !== false;
  currentAnyoneEnabled = settings?.enableAnyone === true || settings?.showAnyoneControls === true;
  applyTheme(currentThemeMode);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode === 'system') {
      applyTheme('system');
    }
  });
};

const saveSettings = async () => {
  const wasRadicleIntegrationEnabled = currentRadicleIntegrationEnabled;
  const wasHnsIntegrationEnabled = currentHnsIntegrationEnabled;
  const wasAnyoneEnabled = currentAnyoneEnabled;
  const newSettings = {
    theme: themeModeSelect?.value || 'system',
    startBeeAtLaunch: startBeeAtLaunchCheckbox?.checked ?? true,
    startIpfsAtLaunch: startIpfsAtLaunchCheckbox?.checked ?? true,
    enableRadicleIntegration: isWindows ? false : (enableRadicleIntegrationCheckbox?.checked ?? false),
    startRadicleAtLaunch: isWindows ? false : (startRadicleAtLaunchCheckbox?.checked ?? false),
    enableHnsIntegration: enableHnsIntegrationCheckbox?.checked ?? true,
    startHnsAtLaunch: startHnsAtLaunchCheckbox?.checked ?? true,
    enableIdentityWallet: enableIdentityWalletCheckbox?.checked ?? false,
    autoUpdate: autoUpdateCheckbox?.checked ?? true,
    enableAnyone: enableAnyoneCheckbox?.checked ?? false,
    anyoneAutoStart: anyoneAutoStartCheckbox?.checked ?? false,
    showDvpnControls: showDvpnControlsCheckbox?.checked ?? false,
    dvpnMaxSpendP2P: Math.max(0.1, parseFloat(dvpnMaxSpendInput?.value || '1') || 1),
    dvpnLowBalanceStop: Math.max(0.1, parseFloat(dvpnLowBalanceStopInput?.value || '0.5') || 0.5),
    dvpnMaxDurationMinutes: Math.max(30, parseInt(dvpnMaxDurationInput?.value || '120', 10) || 120),
  };

  const success = await electronAPI.saveSettings(newSettings);
  if (success) {
    if (wasRadicleIntegrationEnabled && !newSettings.enableRadicleIntegration) {
      window.radicle?.stop?.().catch(() => {});
    }
    if (wasHnsIntegrationEnabled && !newSettings.enableHnsIntegration) {
      window.hns?.stop?.().catch(() => {});
    }
    if (!wasHnsIntegrationEnabled && newSettings.enableHnsIntegration) {
      window.hns?.start?.().catch(() => {});
    }
    if (wasAnyoneEnabled && !newSettings.enableAnyone) {
      window.anyone?.stop?.().catch(() => {});
    }
    if (!wasAnyoneEnabled && newSettings.enableAnyone) {
      window.anyone?.start?.().catch(() => {});
    }
    pushDebug('Settings saved');
    currentThemeMode = newSettings.theme;
    currentRadicleIntegrationEnabled = newSettings.enableRadicleIntegration;
    currentHnsIntegrationEnabled = newSettings.enableHnsIntegration;
    currentAnyoneEnabled = newSettings.enableAnyone;
    applyTheme(currentThemeMode);
    window.dispatchEvent(
      new CustomEvent('settings:updated', {
        detail: newSettings,
      })
    );
    if (onSettingsChanged) {
      onSettingsChanged();
    }
  } else {
    pushDebug('Failed to save settings');
  }
};

export const initSettings = async () => {
  settingsBtn = document.getElementById('settings-btn');
  settingsModal = document.getElementById('settings-modal');
  closeSettingsBtn = document.getElementById('close-settings');
  themeModeSelect = document.getElementById('theme-mode');
  startBeeAtLaunchCheckbox = document.getElementById('start-bee-at-launch');
  startIpfsAtLaunchCheckbox = document.getElementById('start-ipfs-at-launch');
  enableRadicleIntegrationCheckbox = document.getElementById('enable-radicle-integration');
  startRadicleRow = document.getElementById('start-radicle-row');
  startRadicleAtLaunchCheckbox = document.getElementById('start-radicle-at-launch');
  enableIdentityWalletCheckbox = document.getElementById('enable-identity-wallet');
  autoUpdateCheckbox = document.getElementById('auto-update');
  experimentalSection = document.getElementById('experimental-section');
  enableHnsIntegrationCheckbox = document.getElementById('enable-hns-integration');
  startHnsRow = document.getElementById('start-hns-row');
  startHnsAtLaunchCheckbox = document.getElementById('start-hns-at-launch');
  hnsStatusValue = document.getElementById('hns-status-value');
  hnsHeightRow = document.getElementById('hns-height-row');
  hnsHeightValue = document.getElementById('hns-height-value');
  hnsProxyRow = document.getElementById('hns-proxy-row');
  hnsProxyValue = document.getElementById('hns-proxy-value');
  hnsErrorRow = document.getElementById('hns-error-row');
  hnsErrorValue = document.getElementById('hns-error-value');

  enableAnyoneCheckbox = document.getElementById('enable-anyone');
  startAnyoneRow = document.getElementById('start-anyone-row');
  anyoneAutoStartCheckbox = document.getElementById('anyone-auto-start');
  anyoneStatusRow = document.getElementById('anyone-status-row');
  anyoneStatusValue = document.getElementById('anyone-status-value');
  anyoneProxyRow = document.getElementById('anyone-proxy-row');
  anyoneProxyValue = document.getElementById('anyone-proxy-value');
  anyoneSocksPortRow = document.getElementById('anyone-socks-port-row');
  anyoneSocksPortValue = document.getElementById('anyone-socks-port-value');
  anyoneControlPortRow = document.getElementById('anyone-control-port-row');
  anyoneControlPortValue = document.getElementById('anyone-control-port-value');
  anyoneCircuitRow = document.getElementById('anyone-circuit-row');
  anyoneCircuitValue = document.getElementById('anyone-circuit-value');
  anyoneIpRow = document.getElementById('anyone-ip-row');
  anyoneIpValue = document.getElementById('anyone-ip-value');
  anyoneErrorRow = document.getElementById('anyone-error-row');
  anyoneErrorValue = document.getElementById('anyone-error-value');

  showDvpnControlsCheckbox = document.getElementById('show-dvpn-controls');
  dvpnContent = document.getElementById('dvpn-content');
  dvpnCreateWalletBtn = document.getElementById('dvpn-create-wallet-btn');
  dvpnWalletSetup = document.getElementById('dvpn-wallet-setup');
  dvpnWalletDisplay = document.getElementById('dvpn-wallet-display');
  dvpnWalletAddressEl = document.getElementById('dvpn-wallet-address');
  dvpnCopyAddressBtn = document.getElementById('dvpn-copy-address');
  dvpnQrRow = document.getElementById('dvpn-qr-row');
  dvpnQrImage = document.getElementById('dvpn-qr-image');
  dvpnBalanceRow = document.getElementById('dvpn-balance-row');
  dvpnBalanceValue = document.getElementById('dvpn-balance-value');
  dvpnRefreshBalanceBtn = document.getElementById('dvpn-refresh-balance');
  dvpnStatusRow = document.getElementById('dvpn-status-row');
  dvpnStatusValue = document.getElementById('dvpn-status-value');
  dvpnNodeRow = document.getElementById('dvpn-node-row');
  dvpnNodeValue = document.getElementById('dvpn-node-value');
  dvpnCountryRow = document.getElementById('dvpn-country-row');
  dvpnCountryValue = document.getElementById('dvpn-country-value');
  dvpnIpRow = document.getElementById('dvpn-ip-row');
  dvpnIpValue = document.getElementById('dvpn-ip-value');
  dvpnErrorRow = document.getElementById('dvpn-error-row');
  dvpnErrorValue = document.getElementById('dvpn-error-value');
  dvpnConnectBtn = document.getElementById('dvpn-connect-btn');
  dvpnDisconnectBtn = document.getElementById('dvpn-disconnect-btn');
  dvpnControls = document.getElementById('dvpn-controls');
  dvpnMaxSpendInput = document.getElementById('dvpn-max-spend');
  dvpnLowBalanceStopInput = document.getElementById('dvpn-low-balance-stop');
  dvpnMaxDurationInput = document.getElementById('dvpn-max-duration');

  const platform = await electronAPI.getPlatform();
  isWindows = platform === 'win32';
  if (isWindows && experimentalSection) {
    experimentalSection.style.display = 'none';
  }

  themeModeSelect?.addEventListener('change', saveSettings);
  startBeeAtLaunchCheckbox?.addEventListener('change', saveSettings);
  startIpfsAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableRadicleIntegrationCheckbox?.addEventListener('change', () => {
    updateRadicleSettingsVisibility();
    saveSettings();
  });
  startRadicleAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableHnsIntegrationCheckbox?.addEventListener('change', () => {
    updateHnsSettingsVisibility();
    saveSettings();
  });
  startHnsAtLaunchCheckbox?.addEventListener('change', saveSettings);
  enableAnyoneCheckbox?.addEventListener('change', () => {
    updateAnyoneSettingsVisibility();
    saveSettings();
  });
  anyoneAutoStartCheckbox?.addEventListener('change', saveSettings);
  showDvpnControlsCheckbox?.addEventListener('change', () => {
    updateDvpnSettingsVisibility();
    saveSettings();
  });
  dvpnCreateWalletBtn?.addEventListener('click', async () => {
    if (!window.dvpn) return;
    dvpnCreateWalletBtn.disabled = true;
    const result = await window.dvpn.createWallet();
    if (result.success) {
      window.dvpn.getStatus().then(updateDvpnStatusDisplay).catch(() => {});
    } else {
      dvpnCreateWalletBtn.disabled = false;
    }
  });
  dvpnRefreshBalanceBtn?.addEventListener('click', () => {
    window.dvpn?.getBalance?.().then((result) => {
      if (result?.success && dvpnBalanceValue) {
        dvpnBalanceValue.textContent = result.p2p;
        window.dvpn?.getStatus?.().then(updateDvpnStatusDisplay).catch(() => {});
      }
    }).catch(() => {});
  });
  dvpnCopyAddressBtn?.addEventListener('click', async () => {
    const address = dvpnWalletAddressEl?.textContent?.trim();
    if (!address) return;
    await copyText(address);
  });
  dvpnConnectBtn?.addEventListener('click', () => {
    window.dvpn?.start?.().catch(() => {});
  });
  dvpnDisconnectBtn?.addEventListener('click', () => {
    window.dvpn?.stop?.().catch(() => {});
  });
  dvpnMaxSpendInput?.addEventListener('change', saveSettings);
  dvpnLowBalanceStopInput?.addEventListener('change', saveSettings);
  dvpnMaxDurationInput?.addEventListener('change', saveSettings);
  enableIdentityWalletCheckbox?.addEventListener('change', saveSettings);
  autoUpdateCheckbox?.addEventListener('change', saveSettings);

  if (window.hns?.onStatusUpdate) {
    _hnsStatusUnsubscribe = window.hns.onStatusUpdate(updateHnsStatusDisplay);
  }

  if (window.anyone?.onStatusUpdate) {
    _anyoneStatusUnsubscribe = window.anyone.onStatusUpdate(updateAnyoneStatusDisplay);
  }

  if (window.dvpn?.onStatusUpdate) {
    _dvpnStatusUnsubscribe = window.dvpn.onStatusUpdate(updateDvpnStatusDisplay);
  }

  settingsBtn?.addEventListener('click', async () => {
    setMenuOpen(false);
    const settings = await electronAPI.getSettings();
    if (settings) {
      if (themeModeSelect) themeModeSelect.value = settings.theme || 'system';
      if (startBeeAtLaunchCheckbox)
        startBeeAtLaunchCheckbox.checked = settings.startBeeAtLaunch !== false;
      if (startIpfsAtLaunchCheckbox)
        startIpfsAtLaunchCheckbox.checked = settings.startIpfsAtLaunch !== false;
      if (enableRadicleIntegrationCheckbox)
        enableRadicleIntegrationCheckbox.checked = settings.enableRadicleIntegration === true;
      currentRadicleIntegrationEnabled = settings.enableRadicleIntegration === true;
      if (startRadicleAtLaunchCheckbox)
        startRadicleAtLaunchCheckbox.checked = settings.startRadicleAtLaunch === true;
      if (enableHnsIntegrationCheckbox)
        enableHnsIntegrationCheckbox.checked = settings.enableHnsIntegration !== false;
      currentHnsIntegrationEnabled = settings.enableHnsIntegration !== false;
      if (startHnsAtLaunchCheckbox)
        startHnsAtLaunchCheckbox.checked = settings.startHnsAtLaunch !== false;
      const enableAnyone = settings.enableAnyone === true || settings.showAnyoneControls === true;
      if (enableAnyoneCheckbox)
        enableAnyoneCheckbox.checked = enableAnyone;
      currentAnyoneEnabled = enableAnyone;
      if (anyoneAutoStartCheckbox)
        anyoneAutoStartCheckbox.checked = settings.anyoneAutoStart === true;
      if (showDvpnControlsCheckbox)
        showDvpnControlsCheckbox.checked = settings.showDvpnControls === true;
      if (dvpnMaxSpendInput)
        dvpnMaxSpendInput.value = String(settings.dvpnMaxSpendP2P ?? 1.0);
      if (dvpnLowBalanceStopInput)
        dvpnLowBalanceStopInput.value = String(settings.dvpnLowBalanceStop ?? 0.5);
      if (dvpnMaxDurationInput)
        dvpnMaxDurationInput.value = String(settings.dvpnMaxDurationMinutes ?? 120);
      if (enableIdentityWalletCheckbox)
        enableIdentityWalletCheckbox.checked = settings.enableIdentityWallet === true;
      if (autoUpdateCheckbox) autoUpdateCheckbox.checked = settings.autoUpdate !== false;
      updateRadicleSettingsVisibility();
      updateHnsSettingsVisibility();
      updateAnyoneSettingsVisibility();
      updateDvpnSettingsVisibility();
    }

    window.hns?.getStatus?.().then(updateHnsStatusDisplay).catch(() => {});
    window.anyone?.getStatus?.().then(updateAnyoneStatusDisplay).catch(() => {});

    window.dvpn?.getStatus?.().then(async (status) => {
      updateDvpnStatusDisplay(status);
      if (status?.walletAddress) {
        window.dvpn?.getBalance?.().then(() => window.dvpn?.getStatus?.().then(updateDvpnStatusDisplay)).catch(() => {});
      }
    }).catch(() => {});

    settingsModal?.showModal();
  });

  closeSettingsBtn?.addEventListener('click', () => {
    settingsModal?.close();
  });

  settingsModal?.addEventListener('click', (event) => {
    if (event.target === settingsModal) {
      settingsModal.close();
    }
  });
};
