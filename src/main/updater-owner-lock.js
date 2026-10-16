const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const UPDATER_LOCK_TARGET = 'updater-owner';
const UPDATER_LOCK_DIR = 'updater-owner.lock';
const DEFAULT_STALE_MS = 30000;
const DEFAULT_UPDATE_MS = 10000;

let activeLock = null;

function getUpdaterLockPaths(profile) {
  const appRoot = profile?.appRoot || profile?.userDataDir;
  if (!appRoot) {
    throw new Error('Profile appRoot is required for updater ownership');
  }

  return {
    appRoot,
    targetPath: path.join(appRoot, UPDATER_LOCK_TARGET),
    lockDir: path.join(appRoot, UPDATER_LOCK_DIR),
  };
}

function ensureLockTarget(profile) {
  const paths = getUpdaterLockPaths(profile);
  fs.mkdirSync(paths.appRoot, { recursive: true });
  if (!fs.existsSync(paths.targetPath)) {
    fs.writeFileSync(
      paths.targetPath,
      [
        'Freedom updater owner lock target',
        `createdAt=${new Date().toISOString()}`,
      ].join('\n')
    );
  }
  return paths;
}

function tryAcquireUpdaterOwnerLock(profile, options = {}) {
  const logger = options.logger || console;
  const paths = ensureLockTarget(profile);

  try {
    const release = lockfile.lockSync(paths.targetPath, {
      lockfilePath: paths.lockDir,
      realpath: false,
      retries: options.retries ?? 0,
      stale: options.staleMs ?? DEFAULT_STALE_MS,
      update: options.updateMs ?? DEFAULT_UPDATE_MS,
      onCompromised: options.onCompromised || ((error) => {
        logger.error('[updater-lock] Updater owner lock compromised:', error);
        activeLock = null;
      }),
    });

    activeLock = {
      profileId: profile?.id,
      displayName: profile?.displayName,
      targetPath: paths.targetPath,
      lockDir: paths.lockDir,
      release,
      released: false,
    };
    return activeLock;
  } catch (error) {
    if (error?.code === 'ELOCKED') {
      logger.info('[updater-lock] Another profile owns update checks');
      return null;
    }
    throw error;
  }
}

function releaseUpdaterOwnerLock(lockState = activeLock, options = {}) {
  if (!lockState || lockState.released) {
    return false;
  }

  try {
    lockState.release();
    lockState.released = true;
    if (activeLock === lockState) {
      activeLock = null;
    }
    return true;
  } catch (error) {
    if (error.code === 'ERELEASED' || error.code === 'ENOTACQUIRED') {
      lockState.released = true;
      if (activeLock === lockState) {
        activeLock = null;
      }
      return false;
    }

    const logger = options.logger || console;
    logger.error('[updater-lock] Failed to release updater owner lock:', error);
    throw error;
  }
}

function getActiveUpdaterOwnerLock() {
  return activeLock;
}

module.exports = {
  DEFAULT_STALE_MS,
  DEFAULT_UPDATE_MS,
  UPDATER_LOCK_DIR,
  UPDATER_LOCK_TARGET,
  getActiveUpdaterOwnerLock,
  getUpdaterLockPaths,
  releaseUpdaterOwnerLock,
  tryAcquireUpdaterOwnerLock,
};
