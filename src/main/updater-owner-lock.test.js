const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getUpdaterLockPaths,
  releaseUpdaterOwnerLock,
  tryAcquireUpdaterOwnerLock,
} = require('./updater-owner-lock');

function makeTempProfile(id = 'default') {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-updater-lock-'));
  return {
    id,
    displayName: id === 'default' ? 'Default' : id,
    appRoot,
    userDataDir: path.join(appRoot, id),
  };
}

describe('updater owner lock', () => {
  let tempDirs = [];
  let locks = [];

  afterEach(() => {
    locks.forEach((lock) => releaseUpdaterOwnerLock(lock));
    locks = [];
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];
  });

  function trackProfile(profile) {
    tempDirs.push(profile.appRoot);
    return profile;
  }

  function trackLock(lock) {
    if (lock) locks.push(lock);
    return lock;
  }

  test('allows only one updater owner per app root', () => {
    const profile = trackProfile(makeTempProfile());
    const firstLock = trackLock(tryAcquireUpdaterOwnerLock(profile));
    const paths = getUpdaterLockPaths(profile);

    expect(firstLock).not.toBeNull();
    expect(fs.existsSync(paths.lockDir)).toBe(true);
    expect(tryAcquireUpdaterOwnerLock(profile, { logger: { info: jest.fn() } })).toBeNull();

    releaseUpdaterOwnerLock(firstLock);
    expect(fs.existsSync(paths.lockDir)).toBe(false);

    const secondLock = trackLock(tryAcquireUpdaterOwnerLock(profile));
    expect(secondLock).not.toBeNull();
  });

  test('allows independent app roots to own updater checks separately', () => {
    const firstProfile = trackProfile(makeTempProfile('default'));
    const secondProfile = trackProfile(makeTempProfile('work'));

    const firstLock = trackLock(tryAcquireUpdaterOwnerLock(firstProfile));
    const secondLock = trackLock(tryAcquireUpdaterOwnerLock(secondProfile));

    expect(firstLock.lockDir).not.toBe(secondLock.lockDir);
    expect(fs.existsSync(firstLock.lockDir)).toBe(true);
    expect(fs.existsSync(secondLock.lockDir)).toBe(true);
  });
});
