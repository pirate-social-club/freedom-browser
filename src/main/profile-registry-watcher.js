const fs = require('fs');
const path = require('path');
const log = require('./logger');

// The profile catalog/registry is shared across processes: each profile runs
// as its own Electron process, but they all read/write one registry file in
// the shared app root. So a rename / create / delete performed in one process
// (which only rebuilds *its own* native menu) must be picked up by every other
// running profile process. This watcher fires whenever the registry changes —
// from this process or any other — so each process can rebuild its native menu
// and refresh its renderers.
//
// We watch the containing directory rather than the file itself: the registry
// is written atomically (temp file + rename), which detaches a file-level
// watch from the live inode. A directory watch survives the replace.

const PROFILE_REGISTRY_FILE = 'profile-registry.json';
const DEBOUNCE_MS = 150;

let watcher = null;
let debounceTimer = null;
let lastRegistryMtimeMs = null;

function readRegistryMtimeMs(appRoot) {
  try {
    return fs.statSync(path.join(appRoot, PROFILE_REGISTRY_FILE)).mtimeMs;
  } catch {
    // Missing/unreadable (e.g. mid atomic-rename): treat as "can't tell".
    return null;
  }
}

function stopWatchingProfileRegistry() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // best-effort
    }
    watcher = null;
  }
}

/**
 * Watch the profile registry for changes and invoke onChange (debounced).
 *
 * @param {string} appRoot  Directory containing profile-registry.json.
 * @param {() => void} onChange
 * @returns {() => void} stop function
 */
function watchProfileRegistry(appRoot, onChange) {
  if (!appRoot || typeof onChange !== 'function') return () => {};
  stopWatchingProfileRegistry();
  lastRegistryMtimeMs = readRegistryMtimeMs(appRoot);

  try {
    watcher = fs.watch(appRoot, (_eventType, filename) => {
      // Some platforms omit the filename; when present, only react to the
      // registry file (its atomic-write temp files have a different name).
      if (filename && filename !== PROFILE_REGISTRY_FILE) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // On platforms that report the filename we've already confirmed it's the
        // registry file. On platforms that omit it, this watched dir is shared
        // with busy siblings (the catalog write-lock, Profiles/…), so confirm
        // the registry file actually changed via mtime before rebuilding the
        // menu + rebroadcasting. When the mtime can't be read we fall open and
        // fire, so a missed stat never suppresses a real change.
        const mtimeMs = readRegistryMtimeMs(appRoot);
        if (filename == null && mtimeMs != null && mtimeMs === lastRegistryMtimeMs) {
          return;
        }
        lastRegistryMtimeMs = mtimeMs;
        try {
          onChange();
        } catch (err) {
          log.error('[profile] registry-change handler failed:', err?.message || err);
        }
      }, DEBOUNCE_MS);
    });
    watcher.on('error', (err) => {
      log.warn('[profile] registry watcher error:', err?.message || err);
    });
  } catch (err) {
    log.warn('[profile] Failed to watch profile registry:', err?.message || err);
  }

  return stopWatchingProfileRegistry;
}

module.exports = { watchProfileRegistry, stopWatchingProfileRegistry };
