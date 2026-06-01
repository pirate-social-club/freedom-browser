const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('./logger');
const { getAllHistory, removeHistoryEntry } = require('./history');
const { isHnsHost } = require('../shared/hns-hosts');

const REQUEST_REPLAY_STATE_PATHS = Object.freeze([
  'Session Storage',
  'Service Worker',
  'Network Persistent State',
]);

function isLoopbackHostname(hostname = '') {
  return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
}

function isUnknownSingleLabelUrl(value = '', isKnownHnsHost = isHnsHost) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname.includes('.') || isLoopbackHostname(hostname)) return false;

    return !isKnownHnsHost(hostname);
  } catch {
    return false;
  }
}

function clearPersistedSessionStorage({
  appImpl = app,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const storageDir = pathImpl.join(appImpl.getPath('userData'), 'Session Storage');

  try {
    if (!fsImpl.existsSync(storageDir)) return false;
    fsImpl.rmSync(storageDir, { recursive: true, force: true });
    log.info('[BrowserState] Cleared persisted Session Storage');
    return true;
  } catch (err) {
    log.warn(`[BrowserState] Failed to clear persisted Session Storage: ${err.message}`);
    return false;
  }
}

function clearPersistedBrowserRequestState({
  appImpl = app,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const userDataDir = appImpl.getPath('userData');
  const cleared = [];

  for (const relativePath of REQUEST_REPLAY_STATE_PATHS) {
    const target = pathImpl.join(userDataDir, relativePath);
    try {
      if (!fsImpl.existsSync(target)) continue;
      fsImpl.rmSync(target, { recursive: true, force: true });
      cleared.push(relativePath);
    } catch (err) {
      log.warn(`[BrowserState] Failed to clear ${relativePath}: ${err.message}`);
    }
  }

  if (cleared.length > 0) {
    log.info(`[BrowserState] Cleared persisted browser request state: ${cleared.join(', ')}`);
  }

  return cleared;
}

function pruneUnknownSingleLabelHistory({
  getAllHistoryImpl = getAllHistory,
  removeHistoryEntryImpl = removeHistoryEntry,
  isKnownHnsHost = isHnsHost,
} = {}) {
  let removed = 0;

  for (const entry of getAllHistoryImpl()) {
    if (!isUnknownSingleLabelUrl(entry?.url, isKnownHnsHost)) continue;
    if (removeHistoryEntryImpl(entry.id)) {
      removed += 1;
    }
  }

  if (removed > 0) {
    log.info(`[BrowserState] Removed ${removed} unknown single-label history entr${removed === 1 ? 'y' : 'ies'}`);
  }

  return removed;
}

module.exports = {
  clearPersistedBrowserRequestState,
  clearPersistedSessionStorage,
  isUnknownSingleLabelUrl,
  pruneUnknownSingleLabelHistory,
};
