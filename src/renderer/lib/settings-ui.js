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
let hnsStartBtn = null;
let hnsStopBtn = null;
let isWindows = false;

let currentThemeMode = 'system';
let currentRadicleIntegrationEnabled = false;
let currentHnsIntegrationEnabled = false;
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

  if (hnsStartBtn && hnsStopBtn) {
    const isRunning = status.status === 'running' || status.status === 'starting';
    hnsStartBtn.disabled = isRunning;
    hnsStopBtn.disabled = !isRunning;
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
  };

  const success = await electronAPI.saveSettings(newSettings);
  if (success) {
    if (wasRadicleIntegrationEnabled && !newSettings.enableRadicleIntegration) {
      window.radicle?.stop?.().catch(() => {});
    }
    if (wasHnsIntegrationEnabled && !newSettings.enableHnsIntegration) {
      window.hns?.stop?.().catch(() => {});
    }
    pushDebug('Settings saved');
    currentThemeMode = newSettings.theme;
    currentRadicleIntegrationEnabled = newSettings.enableRadicleIntegration;
    currentHnsIntegrationEnabled = newSettings.enableHnsIntegration;
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
  hnsStartBtn = document.getElementById('hns-start-btn');
  hnsStopBtn = document.getElementById('hns-stop-btn');

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
  enableIdentityWalletCheckbox?.addEventListener('change', saveSettings);
  autoUpdateCheckbox?.addEventListener('change', saveSettings);

  hnsStartBtn?.addEventListener('click', () => {
    window.hns?.start?.().catch(() => {});
  });

  hnsStopBtn?.addEventListener('click', () => {
    window.hns?.stop?.().catch(() => {});
  });

  if (window.hns?.onStatusUpdate) {
    _hnsStatusUnsubscribe = window.hns.onStatusUpdate(updateHnsStatusDisplay);
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
      if (enableIdentityWalletCheckbox)
        enableIdentityWalletCheckbox.checked = settings.enableIdentityWallet === true;
      if (autoUpdateCheckbox) autoUpdateCheckbox.checked = settings.autoUpdate !== false;
      updateRadicleSettingsVisibility();
      updateHnsSettingsVisibility();
    }

    window.hns?.getStatus?.().then(updateHnsStatusDisplay).catch(() => {});

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
