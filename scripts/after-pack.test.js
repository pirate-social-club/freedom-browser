const fs = require('fs');
const os = require('os');
const path = require('path');
const afterPack = require('./after-pack').default;

describe('Linux package permissions', () => {
  let root;
  let appOutDir;
  const mode = (file) => fs.statSync(file).mode & 0o7777;
  const file = (name, permissions) => {
    const target = path.join(appOutDir, name);
    fs.writeFileSync(target, 'fixture bytes');
    fs.chmodSync(target, permissions);
    return target;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-pack-permissions-'));
    appOutDir = path.join(root, 'app');
    fs.mkdirSync(appOutDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('removes inherited group/other writes while preserving bytes and executable bits', async () => {
    // Modes observed in the 5c3ff9a2 deb, including its browser executable.
    const executable = file('freedom', 0o777);
    const data = file('resources.pak', 0o666);
    const readOnly = file('notice', 0o444);
    fs.chmodSync(appOutDir, 0o775);
    await afterPack({ appOutDir, electronPlatformName: 'linux' });
    expect(mode(executable)).toBe(0o755);
    expect(mode(data)).toBe(0o644);
    expect(mode(readOnly)).toBe(0o444);
    expect(mode(appOutDir)).toBe(0o755);
    expect(fs.readFileSync(executable, 'utf8')).toBe('fixture bytes');
    expect(fs.readFileSync(data, 'utf8')).toBe('fixture bytes');
  });

  test('does not follow a package symlink into an outside file or directory', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(outside, 'data');
    fs.writeFileSync(target, 'outside bytes');
    fs.chmodSync(target, 0o666);
    fs.symlinkSync(outside, path.join(appOutDir, 'directory-link'));
    fs.symlinkSync(target, path.join(appOutDir, 'file-link'));
    await afterPack({ appOutDir, electronPlatformName: 'linux' });
    expect(mode(target)).toBe(0o666);
    expect(fs.lstatSync(path.join(appOutDir, 'directory-link')).isSymbolicLink()).toBe(true);
  });

  test('does not apply Linux permissions to other targets', async () => {
    const data = file('resources.pak', 0o666);
    await afterPack({ appOutDir, electronPlatformName: 'darwin', packager: { appInfo: {} } });
    expect(mode(data)).toBe(0o666);
  });
});
