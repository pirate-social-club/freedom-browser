const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectLinuxPermissions } = require('./linux-package-permissions');
const { Gate } = require('./linux-packaging-gate');
const scan = require('./linux-native-scan');

describe('finished Linux package permission gate', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-permission-gate-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects writable payload directories and data, but accepts normal modes and symlinks', () => {
    const directory = path.join(root, 'resources');
    fs.mkdirSync(directory);
    const data = path.join(directory, 'app.asar');
    fs.writeFileSync(data, 'data');
    fs.chmodSync(directory, 0o775);
    fs.chmodSync(data, 0o666);
    fs.symlinkSync('resources', path.join(root, 'link'));
    expect(inspectLinuxPermissions(root)).toEqual([
      'resources: group/other writable (0775)',
      'resources/app.asar: group/other writable (0666)',
    ]);
    fs.chmodSync(directory, 0o755);
    fs.chmodSync(data, 0o644);
    expect(inspectLinuxPermissions(root)).toEqual([]);
  });

  test('the real packaging scan reports an unsafe browser executable as a package defect', () => {
    // Replace only extraction/ELF inspection; permission judgement reads the
    // actual filesystem, including modes preserved by the package extractor.
    jest.spyOn(scan, 'scanPackage').mockReturnValue({
      failures: [], errors: [], results: [], interpreters: {},
    });
    const gate = new Gate(path.join(root, 'candidate.deb'), path.join(root, 'out'), {
      run: (bin, args) => {
        expect([bin, args[0]]).toEqual(['dpkg-deb', '-R']);
        const unpacked = args[2];
        fs.mkdirSync(path.join(unpacked, 'DEBIAN'), { recursive: true });
        fs.writeFileSync(path.join(unpacked, 'DEBIAN/control'), 'Depends: libc6 (>= 2.39)\n');
        fs.mkdirSync(path.join(unpacked, 'opt/Freedom'), { recursive: true });
        const executable = path.join(unpacked, 'opt/Freedom/freedom');
        fs.writeFileSync(executable, 'not executed');
        for (const directory of ['', 'DEBIAN', 'opt', 'opt/Freedom']) {
          fs.chmodSync(path.join(unpacked, directory), 0o755);
        }
        fs.chmodSync(path.join(unpacked, 'DEBIAN/control'), 0o644);
        fs.chmodSync(executable, 0o777);
        return { argv: [bin, ...args], status: 0, stdout: '', stderr: '' };
      },
    });
    const section = gate.scanSection();
    expect(section.checks.find((check) => check.name === 'permissions')).toEqual({
      name: 'permissions', status: 'fail', harnessErrors: [],
      defects: ['opt/Freedom/freedom: group/other writable (0777)'],
    });
  });
});
