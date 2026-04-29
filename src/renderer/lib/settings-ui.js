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
let isWindows = false;

let enableAnyoneCheckbox = null;
let startAnyoneRow = null;
let anyoneAutoStartCheckbox = null;
let currentAnyoneEnabled = false;

let dvpnMaxSpendInput = null;
let dvpnLowBalanceStopInput = null;
let dvpnMaxDurationInput = null;

let currentThemeMode = 'system';
let currentRadicleIntegrationEnabled = false;
let currentHnsIntegrationEnabled = false;

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
  };
  if (dvpnMaxSpendInput) {
    newSettings.dvpnMaxSpendP2P = Math.max(0.1, parseFloat(dvpnMaxSpendInput.value || '50') || 50);
  }
  if (dvpnLowBalanceStopInput) {
    newSettings.dvpnLowBalanceStop = Math.max(0.1, parseFloat(dvpnLowBalanceStopInput.value || '0.5') || 0.5);
  }
  if (dvpnMaxDurationInput) {
    newSettings.dvpnMaxDurationMinutes = Math.max(30, parseInt(dvpnMaxDurationInput.value || '120', 10) || 120);
  }

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

  enableAnyoneCheckbox = document.getElementById('enable-anyone');
  startAnyoneRow = document.getElementById('start-anyone-row');
  anyoneAutoStartCheckbox = document.getElementById('anyone-auto-start');

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
  dvpnMaxSpendInput?.addEventListener('change', saveSettings);
  dvpnLowBalanceStopInput?.addEventListener('change', saveSettings);
  dvpnMaxDurationInput?.addEventListener('change', saveSettings);
  enableIdentityWalletCheckbox?.addEventListener('change', saveSettings);
  autoUpdateCheckbox?.addEventListener('change', saveSettings);

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
      if (dvpnMaxSpendInput)
        dvpnMaxSpendInput.value = String(settings.dvpnMaxSpendP2P ?? 50.0);
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
    }

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
