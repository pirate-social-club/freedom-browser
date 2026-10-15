const { dialog, ipcMain } = require('electron');
const log = require('./logger');

// Evaluation packages must only be replaced by a reviewed Freedom package.
// Keep the existing callers, but never construct an updater or load its feed.
let mainWindow = null;

function initUpdater(window) {
  mainWindow = window;
  log.info('[updater] Updates are disabled for this evaluation build');
}

async function checkForUpdates() {
  const options = {
    type: 'info',
    title: 'Updates Disabled',
    message: 'Updates are disabled for this evaluation build.',
    detail: 'Install a reviewed Freedom package manually to update this browser.',
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
  } catch {
    log.warn('[updater] Could not display the disabled-update notice');
  }
}

function isUpdateReady() {
  return false;
}

function installUpdate() {
  log.info('[updater] Update installation is disabled for this evaluation build');
}

ipcMain.on('update:check', checkForUpdates);
ipcMain.on('update:restart-and-install', installUpdate);

// Retain the menu's profile-era API without allowing installation or relaunch.
function getInstallRelaunchMode() {
  return {
    autoRunAfterInstall: false,
    actionLabel: 'Updates disabled',
    menuLabel: 'Updates disabled',
    readyMessage: null,
  };
}

module.exports = { initUpdater, checkForUpdates, isUpdateReady, installUpdate, getInstallRelaunchMode };
