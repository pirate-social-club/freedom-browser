const fs = require('fs');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalFreedomIdentityData = process.env.FREEDOM_IDENTITY_DATA;

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', originalPlatform);
}

function makeProfile(id, userDataDir) {
  return {
    id,
    displayName: id,
    userDataDir,
  };
}

function writeVault(identityDir, label = 'vault-a') {
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(path.join(identityDir, 'identity-vault.json'), JSON.stringify({ label }));
}

function loadQuickUnlock({
  activeProfile,
  userDataDir,
  verifyPasswordImpl = jest.fn().mockResolvedValue(undefined),
} = {}) {
  const profileResolverPath = require.resolve('./profile-resolver');
  const vaultModulePath = require.resolve('./identity/vault');
  const systemPreferences = {
    canPromptTouchID: jest.fn(() => true),
    promptTouchID: jest.fn().mockResolvedValue(undefined),
  };
  const safeStorage = {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((password) => Buffer.from(`encrypted:${password}`)),
    decryptString: jest.fn((buffer) => buffer.toString().replace(/^encrypted:/, '')),
  };

  const { mod } = loadMainModule(require.resolve('./quick-unlock'), {
    userDataDir,
    electronOverrides: {
      systemPreferences,
      safeStorage,
    },
    extraMocks: {
      [profileResolverPath]: () => ({
        getActiveProfile: () => activeProfile,
      }),
      [vaultModulePath]: () => ({
        getVaultPath: (dataDir) => path.join(dataDir, 'identity-vault.json'),
        verifyPassword: verifyPasswordImpl,
      }),
    },
  });

  return {
    mod,
    systemPreferences,
    safeStorage,
    verifyPassword: verifyPasswordImpl,
  };
}

describe('quick-unlock', () => {
  let tempDirs = [];

  beforeEach(() => {
    tempDirs = [];
    setPlatform('darwin');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    if (originalFreedomIdentityData === undefined) {
      delete process.env.FREEDOM_IDENTITY_DATA;
    } else {
      process.env.FREEDOM_IDENTITY_DATA = originalFreedomIdentityData;
    }
  });

  afterEach(() => {
    restorePlatform();
    if (originalFreedomIdentityData === undefined) {
      delete process.env.FREEDOM_IDENTITY_DATA;
    } else {
      process.env.FREEDOM_IDENTITY_DATA = originalFreedomIdentityData;
    }
    for (const dir of tempDirs) {
      removeTempUserDataDir(dir);
    }
    jest.restoreAllMocks();
  });

  function tempUserData() {
    const dir = createTempUserDataDir('quick-unlock-test-');
    tempDirs.push(dir);
    return dir;
  }

  test('stores and unlocks a profile-bound credential', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    const profile = makeProfile('work', userDataDir);
    const { mod, verifyPassword } = loadQuickUnlock({
      activeProfile: profile,
      userDataDir,
    });

    await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });

    const credentialPath = path.join(identityDir, 'quick-unlock.dat');
    const payload = JSON.parse(fs.readFileSync(credentialPath, 'utf-8'));
    expect(payload).toEqual(
      expect.objectContaining({
        version: mod.CREDENTIAL_VERSION,
        profileId: 'work',
        encrypted: Buffer.from('encrypted:password-a').toString('base64'),
      })
    );

    await expect(mod.unlockWithTouchId()).resolves.toEqual({
      success: true,
      password: 'password-a',
    });
    expect(verifyPassword).toHaveBeenCalledWith(identityDir, 'password-a');
  });

  test('hides a bound credential when the active profile does not match', async () => {
    const sharedIdentityDir = tempUserData();
    process.env.FREEDOM_IDENTITY_DATA = sharedIdentityDir;
    writeVault(sharedIdentityDir);

    const profileA = makeProfile('profile-a', tempUserData());
    const first = loadQuickUnlock({
      activeProfile: profileA,
      userDataDir: profileA.userDataDir,
    });
    await first.mod.enableQuickUnlock('password-a');

    const profileB = makeProfile('profile-b', tempUserData());
    const second = loadQuickUnlock({
      activeProfile: profileB,
      userDataDir: profileB.userDataDir,
    });

    expect(second.mod.isQuickUnlockEnabled()).toBe(false);
    await expect(second.mod.unlockWithTouchId()).resolves.toEqual({
      success: false,
      error: 'Quick unlock not enabled',
    });
    expect(second.systemPreferences.promptTouchID).not.toHaveBeenCalled();
  });

  test('migrates a legacy raw credential after a successful unlock', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    fs.writeFileSync(path.join(identityDir, 'quick-unlock.dat'), Buffer.from('encrypted:legacy'));

    const { mod } = loadQuickUnlock({
      activeProfile: makeProfile('default', userDataDir),
      userDataDir,
    });

    await expect(mod.unlockWithTouchId()).resolves.toEqual({
      success: true,
      password: 'legacy',
    });

    const payload = JSON.parse(fs.readFileSync(path.join(identityDir, 'quick-unlock.dat'), 'utf-8'));
    expect(payload.version).toBe(mod.CREDENTIAL_VERSION);
    expect(payload.profileId).toBe('default');
  });

  test('rejects a decrypted credential that does not unlock the current vault', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    fs.writeFileSync(path.join(identityDir, 'quick-unlock.dat'), Buffer.from('encrypted:wrong'));

    const verifyPassword = jest.fn().mockRejectedValue(new Error('Incorrect password'));
    const { mod } = loadQuickUnlock({
      activeProfile: makeProfile('default', userDataDir),
      userDataDir,
      verifyPasswordImpl: verifyPassword,
    });

    await expect(mod.unlockWithTouchId()).resolves.toEqual({
      success: false,
      error: 'Incorrect password',
    });
  });
});
