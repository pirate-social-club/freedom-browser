/**
 * Ledger IPC handlers.
 *
 * Device discovery for the "Connect hardware wallet" flow. Adding the
 * chosen account to the wallet list goes through identity-manager's
 * `wallet:add-ledger-wallet` handler, next to the other wallet-list
 * mutations.
 */

const { ipcMain } = require('electron');
const { listAccounts } = require('./transport');

function registerLedgerIpc() {
  // Requires an attached, unlocked device with the Ethereum app open;
  // errors carry a stable LEDGER_* code the renderer turns into
  // instructions ("plug it in", "open the app", …). The connect screen
  // polls this while waiting for the user to get the device ready.
  ipcMain.handle('ledger:get-accounts', async (_event, options = {}) => {
    try {
      const accounts = await listAccounts(options);
      return { success: true, accounts };
    } catch (err) {
      console.error('[LedgerIPC] Account discovery failed:', err.message);
      return { success: false, error: err.message, code: err.code };
    }
  });
}

module.exports = { registerLedgerIpc };
