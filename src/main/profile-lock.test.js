const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_STALE_MS,
  DEFAULT_UPDATE_MS,
  DEV_STALE_MS,
  DEV_UPDATE_MS,
  acquireProfileLock,
  getProfileLockTiming,
  getProfileLockPaths,
  isProfileLocked,
  isLockUnavailableError,
  releaseProfileLock,
} = require('./profile-lock');

function makeTempProfile(id = 'default') {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-lock-'));
  return {
    id,
    displayName: id === 'default' ? 'Default' : id,
    userDataDir,
  };
}

describe('profile lock', () => {
  let tempDirs = [];
  let locks = [];

  afterEach(() => {
    locks.forEach((lock) => releaseProfileLock(lock));
    locks = [];
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];
  });

  function trackProfile(profile) {
    tempDirs.push(profile.userDataDir);
    return profile;
  }

  function trackLock(lock) {
    locks.push(lock);
    return lock;
  }

  test('prevents two processes from opening the same profile directory', () => {
    const profile = trackProfile(makeTempProfile());
    const firstLock = trackLock(acquireProfileLock(profile));
    const paths = getProfileLockPaths(profile);

    expect(fs.existsSync(paths.lockDir)).toBe(true);
    expect(() => acquireProfileLock(profile)).toThrow(expect.objectContaining({
      code: 'ELOCKED',
    }));

    releaseProfileLock(firstLock);
    expect(fs.existsSync(paths.lockDir)).toBe(false);

    const secondLock = trackLock(acquireProfileLock(profile));
    expect(fs.existsSync(secondLock.lockDir)).toBe(true);
  });

  test('checks whether a profile directory is locked', () => {
    const profile = trackProfile(makeTempProfile());
    expect(isProfileLocked(profile)).toBe(false);

    const lock = trackLock(acquireProfileLock(profile));
    expect(isProfileLocked(profile)).toBe(true);

    releaseProfileLock(lock);
    expect(isProfileLocked(profile)).toBe(false);
  });

  test('allows different profile directories to be open at the same time', () => {
    const defaultProfile = trackProfile(makeTempProfile('default'));
    const workProfile = trackProfile(makeTempProfile('work'));

    const defaultLock = trackLock(acquireProfileLock(defaultProfile));
    const workLock = trackLock(acquireProfileLock(workProfile));

    expect(defaultLock.lockDir).not.toBe(workLock.lockDir);
    expect(fs.existsSync(defaultLock.lockDir)).toBe(true);
    expect(fs.existsSync(workLock.lockDir)).toBe(true);
  });

  test('recovers stale locks left behind by an unclean exit', () => {
    const profile = trackProfile(makeTempProfile());
    const paths = getProfileLockPaths(profile);
    fs.mkdirSync(profile.userDataDir, { recursive: true });
    fs.writeFileSync(paths.targetPath, 'stale target');
    fs.mkdirSync(paths.lockDir);
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(paths.lockDir, oldTime, oldTime);

    const lock = trackLock(acquireProfileLock(profile, {
      staleMs: 2000,
      updateMs: 1000,
    }));

    expect(lock.lockDir).toBe(paths.lockDir);
    expect(fs.existsSync(paths.lockDir)).toBe(true);
  });

  test('uses shorter stale-lock timing for dev profiles', () => {
    expect(getProfileLockTiming({ isDev: true })).toEqual({
      staleMs: DEV_STALE_MS,
      updateMs: DEV_UPDATE_MS,
    });
    expect(getProfileLockTiming({ isDev: false })).toEqual({
      staleMs: DEFAULT_STALE_MS,
      updateMs: DEFAULT_UPDATE_MS,
    });
  });

  test('allows explicit lock timing overrides', () => {
    expect(getProfileLockTiming({ isDev: true }, {
      staleMs: 12000,
      updateMs: 3000,
    })).toEqual({
      staleMs: 12000,
      updateMs: 3000,
    });
  });

  test('identifies lock-unavailable errors', () => {
    expect(isLockUnavailableError({ code: 'ELOCKED' })).toBe(true);
    expect(isLockUnavailableError({ code: 'ENOENT' })).toBe(false);
    expect(isLockUnavailableError(null)).toBe(false);
  });
});
