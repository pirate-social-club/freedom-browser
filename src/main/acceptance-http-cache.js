// Read-only cache evidence for installed, unstubbed acceptance. Ordinary
// profiles and fixture-harness launches never register this operation.
const { remoteDebuggingPortOpen } = require('./test-mode');

const CHANNEL = 'acceptance:http-cache-state';

function registerAcceptanceHttpCache({ app, ipcMain, webContents, profile, env = process.env }) {
  if (
    profile?.source !== 'test-user-data' ||
    env.FREEDOM_E2E_ACCEPTANCE !== '1' ||
    env.FREEDOM_TEST_MODE === '1' ||
    !remoteDebuggingPortOpen({ app, env })
  ) return false;

  // ipc-sender-policy leaves this channel chrome-only. No URL, file path,
  // session selector, evaluation or cache mutation is accepted from callers.
  ipcMain.handle(CHANNEL, async () => {
    const sessions = [];
    const contents = [];
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      let index = sessions.findIndex((entry) => entry.session === wc.session);
      if (index < 0) {
        index = sessions.length;
        sessions.push({ session: wc.session });
      }
      contents.push({ id: wc.id, type: wc.getType(), sessionIndex: index });
    }
    const caches = [];
    for (const { session } of sessions) {
      // Electron calls ComputeHttpCacheSize over the full time range, which
      // queries the backend's CalculateSizeOfAllEntries (memory or disk).
      const sizeBytes = await session.getCacheSize();
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error('Invalid HTTP cache size');
      }
      caches.push({
        sizeBytes,
        persistent: session.isPersistent(),
        storagePath: session.getStoragePath(),
      });
    }
    return { measuredAt: new Date().toISOString(), contents, caches };
  });
  return true;
}

module.exports = { CHANNEL, registerAcceptanceHttpCache };
