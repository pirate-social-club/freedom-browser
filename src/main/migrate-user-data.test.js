const fs = require('fs');
const path = require('path');
const {
  createAppMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function loadMigrationModule(userDataDir, options = {}) {
  return loadMainModule(require.resolve('./migrate-user-data'), {
    app: createAppMock({ isPackaged: options.isPackaged ?? true, userDataDir }),
    extraMocks: {
      [require.resolve('./logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  }).mod;
}

function writeBeeData(userDataDir, { withKeystore = true, extras = [] } = {}) {
  const beeData = path.join(userDataDir, 'bee-data');
  fs.mkdirSync(path.join(beeData, 'keys'), { recursive: true });
  if (withKeystore) {
    fs.writeFileSync(path.join(beeData, 'keys', 'swarm.key'), '{"version":3}');
  }
  fs.writeFileSync(path.join(beeData, 'config.yaml'), 'password: bee-era-password\n');
  for (const extra of extras) {
    fs.mkdirSync(path.join(beeData, extra), { recursive: true });
    fs.writeFileSync(path.join(beeData, extra, 'data'), 'x');
  }
  return beeData;
}

describe('migrateBeeDataToAntData (bee → ant upgrade)', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    delete process.env.FREEDOM_ANT_DATA;
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
    delete process.env.FREEDOM_ANT_DATA;
  });

  test('renames bee-data to ant-data when ant-data does not exist', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);

    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(false);
  });

  test('uses the active profile userData directory in dev mode', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    const mod = loadMigrationModule(userDataDir, { isPackaged: false });

    expect(mod.isBeeDataMigrationPending()).toBe(true);
    expect(mod.migrateBeeDataToAntData()).toBe(true);

    expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(false);
  });

  test('drops Bee-only LevelDB state but keeps stamperstore', () => {
    writeBeeData(userDataDir, {
      extras: ['statestore', 'localstore', 'kademlia-metrics', 'stamperstore'],
    });
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);

    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.existsSync(path.join(antData, 'statestore'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'localstore'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'kademlia-metrics'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
  });

  test('merges into existing ant-data and removes antd self-generated identity', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // antd already ran once on the empty dir and self-initialized.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');
    fs.writeFileSync(path.join(antData, 'signing.key'), 'throwaway');
    fs.writeFileSync(path.join(antData, 'config.yaml'), 'password: throwaway-password\n');

    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);

    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    // The injected keystore's password must win over the throwaway config.
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'signing.key'))).toBe(false);
  });

  test('does nothing when bee-data has no injected keystore', () => {
    writeBeeData(userDataDir, { withKeystore: false });
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'ant-data'))).toBe(false);
  });

  test('does nothing when bee-data does not exist', () => {
    const mod = loadMigrationModule(userDataDir);
    expect(mod.migrateBeeDataToAntData()).toBe(false);
  });

  test('never clobbers an already-injected ant-data identity', () => {
    writeBeeData(userDataDir);
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(path.join(antData, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(antData, 'keys', 'swarm.key'), '{"version":3,"already":"injected"}');

    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.readFileSync(path.join(antData, 'keys', 'swarm.key'), 'utf-8')).toContain(
      'already'
    );
    expect(fs.existsSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'))).toBe(true);
  });

  test('is skipped entirely under the FREEDOM_ANT_DATA test override', () => {
    writeBeeData(userDataDir);
    process.env.FREEDOM_ANT_DATA = path.join(userDataDir, 'throwaway');
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(true);
  });

  test('is idempotent: second run is a no-op', () => {
    writeBeeData(userDataDir);
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(mod.migrateBeeDataToAntData()).toBe(false);
  });

  test('a mid-merge failure before the keystore moves is retried cleanly on next launch', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // Force the merge path by pre-creating ant-data.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');

    const mod = loadMigrationModule(userDataDir);

    // Simulate a Windows-EPERM-style failure on the stamperstore move. The
    // keystore moves last, so it must still be in bee-data afterwards and the
    // retry precondition must hold.
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (String(src).includes('stamperstore')) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRename(src, dest);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(false);
    // config.yaml moved before the failure — the retry must tolerate that.
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );

    // Next launch: the lock is gone and the migration completes.
    spy.mockRestore();
    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
  });

  test('a failure removing the stale antd identity keeps the migration retryable', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // antd already self-initialized on the existing ant-data → merge path.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');
    fs.writeFileSync(path.join(antData, 'signing.key'), 'throwaway');

    const mod = loadMigrationModule(userDataDir);

    // Simulate a locked identity.json (Windows EPERM). The stale identity is
    // removed before the keystore moves — the commit point that clears the
    // retry precondition — so the migration must still be pending afterwards.
    // If it weren't, antd would keep the throwaway identity with no retry.
    const realRm = fs.rmSync.bind(fs);
    const spy = jest.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (String(target).endsWith('identity.json')) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRm(target, opts);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(false);
    expect(mod.isBeeDataMigrationPending()).toBe(true);

    // Next launch: the lock is gone and the migration completes.
    spy.mockRestore();
    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'signing.key'))).toBe(false);
    expect(mod.isBeeDataMigrationPending()).toBe(false);
  });

  test('a locked Bee-only directory does not fail the completed migration', () => {
    writeBeeData(userDataDir, { extras: ['statestore', 'stamperstore'] });
    const mod = loadMigrationModule(userDataDir);

    // The Bee-only cleanup runs after the keystore landed; a stray lock on
    // dead LevelDB cache must not report the identity migration as failed.
    const realRm = fs.rmSync.bind(fs);
    const spy = jest.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (String(target).endsWith('statestore')) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return realRm(target, opts);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    spy.mockRestore();

    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(mod.isBeeDataMigrationPending()).toBe(false);
  });

  test('isBeeDataMigrationPending tracks the migration lifecycle', () => {
    const mod = loadMigrationModule(userDataDir);

    // Nothing to migrate yet.
    expect(mod.isBeeDataMigrationPending()).toBe(false);

    // Bee-era keystore present, ant-data empty → pending.
    writeBeeData(userDataDir);
    expect(mod.isBeeDataMigrationPending()).toBe(true);

    // Suppressed under the throwaway-data-dir test override.
    process.env.FREEDOM_ANT_DATA = path.join(userDataDir, 'throwaway');
    expect(mod.isBeeDataMigrationPending()).toBe(false);
    delete process.env.FREEDOM_ANT_DATA;

    // Cleared once the migration completes.
    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(mod.isBeeDataMigrationPending()).toBe(false);
  });

  test('falls back to item-by-item carry when the whole-directory rename fails', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore', 'statestore'] });
    const mod = loadMigrationModule(userDataDir);

    const antData = path.join(userDataDir, 'ant-data');
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      // Fail only the whole-directory rename, not the per-item carries.
      if (String(src).endsWith('bee-data') && String(dest).endsWith('ant-data')) {
        const err = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(src, dest);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    spy.mockRestore();

    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    // Bee-only state is never carried by the item list.
    expect(fs.existsSync(path.join(antData, 'statestore'))).toBe(false);
  });

  test('moves the keystore LAST on the merge path so an interrupt is always retryable', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // Force the merge path: ant-data already exists (antd self-initialized),
    // so the whole-directory fast rename is skipped and items are carried
    // one by one in BEE_CARRY_ITEMS order.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');

    const mod = loadMigrationModule(userDataDir);

    const moveOrder = [];
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (String(src).includes(`${path.sep}bee-data${path.sep}`)) {
        moveOrder.push(path.basename(String(src)));
      }
      return realRename(src, dest);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    spy.mockRestore();

    // keys/ is the commit point that clears isBeeDataMigrationPending(): it
    // MUST move after config.yaml and stamperstore. If a refactor reordered
    // BEE_CARRY_ITEMS so keys moved earlier, an interrupted carry could strand
    // a keystore in ant-data whose password is still in bee-data, with no
    // retry — silently abandoning a funded identity. This locks the ordering.
    expect(moveOrder).toEqual(['config.yaml', 'stamperstore', 'keys']);
    expect(moveOrder[moveOrder.length - 1]).toBe('keys');
  });
});
