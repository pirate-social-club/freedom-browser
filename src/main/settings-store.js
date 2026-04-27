const log = require('./logger');
const { app, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');

// Apply theme to nativeTheme so webviews get correct prefers-color-scheme
function applyNativeTheme(theme) {
  if (theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else if (theme === 'dark') {
    nativeTheme.themeSource = 'dark';
  } else {
    nativeTheme.themeSource = 'system';
  }
}

const SETTINGS_FILE = 'settings.json';
const DEFAULT_SETTINGS = {
  theme: 'system',
  enableRadicleIntegration: false,
  enableHnsIntegration: true,
  enableIdentityWallet: false,
  startBeeAtLaunch: true,
  startIpfsAtLaunch: true,
  startRadicleAtLaunch: false,
  startHnsAtLaunch: true,
  autoUpdate: true,
  showBookmarkBar: false,
  enableAnyone: false,
  // Legacy compatibility key for pre-toggle Anyone builds.
  showAnyoneControls: false,
  anyoneAutoStart: false,
  showDvpnControls: false,
  dvpnMaxSpendP2P: 1.0,
  dvpnLowBalanceStop: 0.5,
  dvpnMaxDurationMinutes: 120,
  sidebarOpen: false,
  sidebarWidth: 320,
};

let cachedSettings = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function loadSettings() {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      // Migrate legacy Anyone visibility into the real enable flag.
      if (cachedSettings.enableAnyone === undefined) {
        cachedSettings.enableAnyone = cachedSettings.showAnyoneControls === true;
      }
    } else {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
  } catch (err) {
    log.error('Failed to load settings:', err);
    cachedSettings = { ...DEFAULT_SETTINGS };
  }

  // Apply theme to nativeTheme
  applyNativeTheme(cachedSettings.theme);

  return cachedSettings;
}

function saveSettings(newSettings) {
  try {
    const merged = { ...loadSettings(), ...newSettings };
    // Keep the legacy key mirrored so older local state continues to round-trip.
    if (newSettings.enableAnyone !== undefined) {
      merged.showAnyoneControls = newSettings.enableAnyone;
    } else if (newSettings.showAnyoneControls !== undefined) {
      merged.enableAnyone = newSettings.showAnyoneControls;
    }
    const filePath = getSettingsPath();
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
    cachedSettings = merged;

    // Apply theme if it changed
    if (newSettings.theme) {
      applyNativeTheme(newSettings.theme);
    }

    return true;
  } catch (err) {
    log.error('Failed to save settings:', err);
    return false;
  }
}

function registerSettingsIpc() {
  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return loadSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, newSettings) => {
    return saveSettings(newSettings);
  });
}

module.exports = {
  loadSettings,
  saveSettings,
  registerSettingsIpc,
};
