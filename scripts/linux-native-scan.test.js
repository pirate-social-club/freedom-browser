/**
 * The ELF scanner the Linux packaging gate runs over the unpacked deb, and the
 * dependency contract it holds the package to. The parsers are tested on
 * canned readelf output; the scan itself on small trees built per test from a
 * copy of the host's /bin/true, so nothing is compiled. Those tests need
 * readelf and objdump and are skipped only when binutils is missing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  compareVersions,
  parseHeader,
  parseDynamic,
  parseVersionNeeds,
  summarizeVersionNeeds,
  parseObjdumpSymbols,
  parseLibcFloor,
  readControlDepends,
  elfLibc,
  validateInventory,
  loadInventory,
  scanPackage,
  resolveInTree,
} = require('./linux-native-scan');

const SCRIPT = path.join(__dirname, 'linux-native-scan.js');
const INVENTORY = path.join(__dirname, 'linux-native-inventory.json');
const pkg = require('../package.json');

const haveBinutils = ['readelf', 'objdump'].every(
  (tool) => spawnSync(tool, ['--version']).status === 0
);
const TRUE_BIN = ['/bin/true', '/usr/bin/true'].find((file) => fs.existsSync(file));
const describeElf = haveBinutils && TRUE_BIN ? describe : describe.skip;

// `readelf -V -W` of usb_bindings.node from the 2f7920f3 deb, version needs
// section only, with one WEAK need added to libm.
const USB_VERSION_NEEDS = [
  "Version symbols section '.gnu.version' contains 3 entries:",
  '  000:   0 (*local*)       2 (GLIBC_2.38)    3 (GLIBCXX_3.4.22)',
  '',
  "Version needs section '.gnu.version_r' contains 3 entries:",
  ' Addr: 0x0000000000002a10  Offset: 0x00002a10  Link: 6 (.dynstr)',
  '  000000: Version: 1  File: libstdc++.so.6  Cnt: 2',
  '  0x0010:   Name: CXXABI_1.3  Flags: none  Version: 9',
  '  0x0020:   Name: GLIBCXX_3.4.22  Flags: none  Version: 3',
  '  0x0030: Version: 1  File: libm.so.6  Cnt: 1',
  '  0x0040:   Name: GLIBC_2.29  Flags: WEAK  Version: 8',
  '  0x0050: Version: 1  File: libc.so.6  Cnt: 3',
  '  0x0060:   Name: GLIBC_2.38  Flags: none  Version: 2',
  '  0x0070:   Name: GLIBC_2.2.5  Flags: none  Version: 5',
  '  0x0080:   Name: GLIBC_2.9  Flags: none  Version: 6',
].join('\n');

describe('readelf parsing', () => {
  test('orders versions numerically', () => {
    expect(compareVersions('2.9', '2.10')).toBe(-1);
    expect(compareVersions('2.39', '2.39')).toBe(0);
    expect(compareVersions('2.2.5', '2.2')).toBe(1);
  });

  test('reads the version needs section and nothing around it', () => {
    const entries = parseVersionNeeds(USB_VERSION_NEEDS);
    expect(entries).toHaveLength(6);
    expect(entries[2]).toEqual({ file: 'libm.so.6', version: 'GLIBC_2.29', flags: 'WEAK' });
  });

  test('reports the newest GLIBC need, its weakness, and the C++ needs', () => {
    const needs = summarizeVersionNeeds(parseVersionNeeds(USB_VERSION_NEEDS));
    expect(needs.glibcNewest).toBe('2.38');
    expect(needs.glibcNewestNonWeak).toBe('2.38');
    expect(needs.glibc.find((n) => n.version === '2.29')).toEqual({ version: '2.29', weak: true });
    expect(needs.glibcxx).toEqual(['3.4.22']);
    expect(needs.cxxabi).toEqual(['1.3']);
  });

  test('a version is weak only when every entry naming it is weak', () => {
    const needs = summarizeVersionNeeds([
      { version: 'GLIBC_2.39', flags: 'WEAK' },
      { version: 'GLIBC_2.39', flags: 'none' },
      { version: 'GLIBC_2.40', flags: 'WEAK' },
    ]);
    expect(needs.glibc).toEqual([
      { version: '2.39', weak: false },
      { version: '2.40', weak: true },
    ]);
    expect(needs.glibcNewest).toBe('2.40');
    expect(needs.glibcNewestNonWeak).toBe('2.39');
  });

  test('reads the header, dynamic section and undefined versioned symbols', () => {
    expect(
      parseHeader(
        '  Class:                             ELF32\n  Type:                              DYN (Shared object file)\n  Machine:                           Intel 80386'
      )
    ).toEqual({ class: 'ELF32', type: 'DYN', machine: 'Intel 80386' });
    expect(
      parseDynamic(
        ' 0x000000000000000f (RPATH)              Library rpath: [$ORIGIN]\n' +
          ' 0x0000000000000001 (NEEDED)             Shared library: [libasound.so.2]'
      )
    ).toEqual({ needed: ['libasound.so.2'], rpath: ['$ORIGIN'], runpath: [], dynamic: true });
    expect(parseDynamic('\nThere is no dynamic section in this file.\n').dynamic).toBe(false);
    expect(
      parseObjdumpSymbols(
        '0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.38) __isoc23_sscanf\n' +
          '0000000000000000      DF *UND*\t0000000000000000  GLIBC_2.2.5 free',
        'GLIBC_2.38'
      )
    ).toEqual(['__isoc23_sscanf']);
  });

  test('tells the C library apart', () => {
    expect(elfLibc({ needed: ['libc.so.6'], dynamic: true })).toBe('glibc');
    expect(elfLibc({ needed: ['libc.musl-x86_64.so.1'], dynamic: true })).toBe('musl');
    expect(elfLibc({ needed: ['liblog.so', 'libc.so'], dynamic: true })).toBe('bionic');
    expect(elfLibc({ needed: [], dynamic: false })).toBe('static');
  });
});

describe('declared floor', () => {
  test('reads libc6 (>= x.y) from a Depends value', () => {
    expect(parseLibcFloor('libgtk-3-0, libunbound8, libc6 (>= 2.36)')).toBe('2.36');
    expect(parseLibcFloor('libasound2t64 | libasound2 (>= 1.0.17), libc6 (>= 2.39)')).toBe('2.39');
    expect(parseLibcFloor('libgtk-3-0, libc6')).toBeNull();
    expect(parseLibcFloor('')).toBeNull();
  });

  test('reads Depends from a control file, folded lines included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-native-scan-control-'));
    try {
      const control = path.join(dir, 'control');
      fs.writeFileSync(
        control,
        'Package: freedom-browser\nDepends: libgtk-3-0,\n libc6 (>= 2.39)\nRecommends: libappindicator3-1\n'
      );
      expect(readControlDepends(control)).toBe('libgtk-3-0, libc6 (>= 2.39)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the checked-in contract', () => {
  const inventory = loadInventory(INVENTORY);
  const depends = pkg.build.deb.depends;

  test('package.json declares the floor the inventory records', () => {
    expect(parseLibcFloor(depends.join(', '))).toBe(inventory.glibcFloor);
    expect(inventory.glibcFloor).toBe('2.39');
  });

  test('package.json declares the libraries the browser binary links', () => {
    for (const dep of ['libudev1', 'libasound2t64 | libasound2 (>= 1.0.17)', 'libgbm1']) {
      expect(depends).toContain(dep);
    }
    for (const dep of [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'libunbound8',
    ]) {
      expect(depends).toContain(dep);
    }
  });

  test('the inventory lists the 29 ELF files of the Linux x64 deb by class', () => {
    const count = (cls) => inventory.files.filter((entry) => entry.class === cls).length;
    expect(inventory.files).toHaveLength(29);
    expect([count('supported'), count('dormant'), count('foreign')]).toEqual([16, 4, 9]);
    expect(validateInventory(inventory)).toEqual([]);
  });

  test('exactly the pinned downloads carry a digest', () => {
    expect(
      inventory.files
        .filter((entry) => entry.sha256)
        .map((entry) => entry.path)
        .sort()
    ).toEqual(
      [
        'resources/ant-bin/antd',
        'resources/dvpn-bin/v2ray',
        'resources/freedom-ipfs-node/freedom_ipfs_native.node',
        'resources/hns-bin/fingertipd',
        'resources/hns-bin/hnsd',
        'resources/radicle-bin/libradicle.node',
      ].sort()
    );
  });

  test('the committed helpers match their inventory digests', () => {
    const crypto = require('crypto');
    const committed = {
      'resources/hns-bin/hnsd': 'hns-bin/linux-x64/hnsd',
      'resources/hns-bin/fingertipd': 'hns-bin/linux-x64/fingertipd',
      'resources/dvpn-bin/v2ray': 'dvpn-bin/linux-x64/v2ray',
    };
    for (const [entryPath, file] of Object.entries(committed)) {
      const entry = inventory.files.find((e) => e.path === entryPath);
      const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', file)))
        .digest('hex');
      expect(digest).toBe(entry.sha256);
    }
  });

  test('the libradicle digest is the pinned release linux-x64 entry', () => {
    const fixture = fs.readFileSync(path.join(__dirname, 'fetch-radicle-addon.test.js'), 'utf8');
    const line = /'([0-9a-f]{64}) {2}libradicle-linux-x64\.node'/.exec(fixture);
    const entry = inventory.files.find((e) => e.path === 'resources/radicle-bin/libradicle.node');
    expect(line && line[1]).toBe(entry.sha256);
  });

  test('only the usb and keccak glibc prebuilds are held to the floor as dormant', () => {
    expect(
      inventory.files.filter((entry) => entry.selectedWhen).map((entry) => entry.path)
    ).toEqual([
      'resources/app.asar.unpacked/node_modules/keccak/prebuilds/linux-x64/node.napi.glibc.node',
      'resources/app.asar.unpacked/node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node',
    ]);
  });

  test('refuses an inventory entry without its evidence', () => {
    const broken = {
      ...inventory,
      files: [{ path: 'x.node', class: 'dormant', reason: 'r', evidence: { citation: 'c' } }],
    };
    expect(validateInventory(broken)).toEqual([
      'x.node: evidence must state the loader-selection assumption',
    ]);
    expect(
      validateInventory({ ...inventory, files: [{ path: 'a', class: 'odd', reason: 'r' }] })
    ).toContain('a: unknown class odd');
  });
});

describeElf('scanning a tree', () => {
  const hostGlibc = process.report.getReport().header.glibcVersionRuntime;
  const ASSUMES = 'loader variables unset';
  let dir;

  const inventoryWith = (files, glibcFloor = hostGlibc) => ({
    glibcFloor,
    loaderSelection: { assumption: ASSUMES },
    files,
  });
  const supported = (file, extra = {}) => ({
    path: file,
    class: 'supported',
    reason: 'test',
    ...extra,
  });
  const tree = (files) => {
    const root = path.join(dir, 'tree');
    for (const [rel, make] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      make(full);
    }
    return root;
  };
  const copyTrue = (full) => fs.copyFileSync(TRUE_BIN, full);
  const truncated = (bytes) => (full) =>
    fs.writeFileSync(full, fs.readFileSync(TRUE_BIN).subarray(0, bytes));
  const cli = (root, inventory, extra = []) => {
    const inv = path.join(dir, 'inventory.json');
    fs.writeFileSync(inv, JSON.stringify(inventory));
    return spawnSync(process.execPath, [SCRIPT, '--root', root, '--inventory', inv, ...extra], {
      encoding: 'utf8',
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-native-scan-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a clean tree passes and records the ELF facts', () => {
    const root = tree({
      'bin/tool': copyTrue,
      'share/readme.txt': (f) => fs.writeFileSync(f, 'x'),
    });
    const report = scanPackage({ root, inventory: inventoryWith([supported('bin/tool')]) });
    expect(report.errors).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.status).toBe('pass');
    expect(report.results).toHaveLength(1);
    const [record] = report.results;
    expect(record.machine).toBe('Advanced Micro Devices X86-64');
    expect(record.needed).toContain('libc.so.6');
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.glibcNewestNonWeak).toBeTruthy();
    expect(cli(root, inventoryWith([supported('bin/tool')])).status).toBe(0);
  });

  test('an ELF file missing from the inventory fails', () => {
    const root = tree({ 'bin/tool': copyTrue, 'bin/other': copyTrue });
    const report = scanPackage({ root, inventory: inventoryWith([supported('bin/tool')]) });
    expect(report.failures).toEqual([
      { kind: 'extra', path: 'bin/other', message: 'ELF file not in the inventory' },
    ]);
    expect(cli(root, inventoryWith([supported('bin/tool')])).status).toBe(1);
  });

  test('an inventoried file missing from the tree fails', () => {
    const root = tree({ 'bin/tool': copyTrue });
    const report = scanPackage({
      root,
      inventory: inventoryWith([supported('bin/tool'), supported('bin/gone')]),
    });
    expect(report.failures.map((f) => [f.kind, f.path])).toEqual([['missing', 'bin/gone']]);
  });

  test('a pinned digest that differs fails', () => {
    const root = tree({ 'bin/tool': copyTrue });
    const pinned = supported('bin/tool', { sha256: '0'.repeat(64), pin: 'test pin' });
    const report = scanPackage({ root, inventory: inventoryWith([pinned]) });
    expect(report.failures.map((f) => f.kind)).toEqual(['digest']);
    expect(cli(root, inventoryWith([pinned])).status).toBe(1);
  });

  test('a non-weak GLIBC need above the floor fails for supported and PREBUILDS_ONLY files', () => {
    const root = tree({ 'bin/tool': copyTrue, 'lib/prebuild': copyTrue, 'lib/unused': copyTrue });
    const dormant = (file, extra) => ({
      path: file,
      class: 'dormant',
      reason: 'test',
      evidence: { citation: 'test', assumes: ASSUMES },
      ...extra,
    });
    const inventory = inventoryWith(
      [
        supported('bin/tool'),
        dormant('lib/prebuild', { selectedWhen: 'PREBUILDS_ONLY=1' }),
        dormant('lib/unused'),
      ],
      '2.0'
    );
    const report = scanPackage({ root, inventory });
    expect(report.failures.map((f) => [f.kind, f.path])).toEqual([
      ['floor', 'bin/tool'],
      ['floor', 'lib/prebuild'],
    ]);
    expect(report.failures[0].message).toMatch(
      /^needs GLIBC_[\d.]+.*not weak, above the floor 2\.0$/
    );
    const run = cli(root, inventory);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/FAIL \[floor\] bin\/tool: needs GLIBC_/);
  });

  test('the declared floor is checked, and must match the inventory', () => {
    const root = tree({ 'bin/tool': copyTrue });
    const report = scanPackage({
      root,
      inventory: inventoryWith([supported('bin/tool')]),
      depends: 'libgtk-3-0, libc6 (>= 2.0)',
    });
    expect(report.floor).toBe('2.0');
    expect(report.failures.map((f) => [f.kind, f.path])).toEqual([
      ['floor', null],
      ['floor', 'bin/tool'],
    ]);
    expect(report.failures[0].message).toBe(
      `the package declares libc6 (>= 2.0) but the inventory records ${hostGlibc}`
    );
    const undeclared = scanPackage({
      root,
      inventory: inventoryWith([supported('bin/tool')]),
      depends: 'libgtk-3-0',
    });
    expect(undeclared.failures.map((f) => f.message)).toEqual([
      'the package declares no libc6 (>= x.y) floor',
    ]);
    const run = cli(root, inventoryWith([supported('bin/tool')]), ['--depends', 'libc6 (>= 2.0)']);
    expect(run.status).toBe(1);
    expect(cli(root, inventoryWith([supported('bin/tool')]), ['--floor', hostGlibc]).status).toBe(
      0
    );
  });

  test('a file whose ELF target contradicts its class fails', () => {
    const root = tree({ 'bin/tool': copyTrue });
    const foreign = {
      path: 'bin/tool',
      class: 'foreign',
      reason: 'test',
      evidence: { citation: 'test', assumes: ASSUMES },
    };
    const report = scanPackage({ root, inventory: inventoryWith([foreign]) });
    expect(report.failures.map((f) => f.kind)).toEqual(['class']);
  });

  test('a truncated ELF file is an inspection error and exits 2', () => {
    for (const bytes of [4, 64, 4096]) {
      const root = tree({ [`bin/cut-${bytes}`]: truncated(bytes) });
      const report = scanPackage({ root });
      expect(report.results).toEqual([]);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].path).toBe(`bin/cut-${bytes}`);
      expect(report.errors[0].error).toMatch(/readelf/);
      const run = cli(root, inventoryWith([]));
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(new RegExp(`ERROR bin/cut-${bytes}: readelf`));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const describeUnreadable = process.getuid && process.getuid() === 0 ? test.skip : test;
  describeUnreadable('an unreadable file is an inspection error and exits 2', () => {
    const root = tree({ 'bin/locked': copyTrue });
    fs.chmodSync(path.join(root, 'bin/locked'), 0o000);
    const report = scanPackage({ root, inventory: inventoryWith([supported('bin/locked')]) });
    expect(report.errors).toEqual([
      expect.objectContaining({
        path: 'bin/locked',
        error: expect.stringMatching(/^cannot read: /),
      }),
    ]);
    // Already an error, so it is not reported missing too.
    expect(report.failures).toEqual([]);
    expect(cli(root, inventoryWith([supported('bin/locked')])).status).toBe(2);
  });

  test('symlinks resolve inside the tree, never on the host', () => {
    // The host has this file, but the package does not.
    const outside = path.join(dir, 'outside-tool');
    copyTrue(outside);
    const root = tree({
      'bin/tool': copyTrue,
      'bin/host': (full) => fs.symlinkSync(outside, full),
      'bin/libc': (full) => fs.symlinkSync('/lib/x86_64-linux-gnu/libc.so.6', full),
      'bin/rel': (full) => fs.symlinkSync('tool', full),
      'bin/abs': (full) => fs.symlinkSync('/bin/tool', full),
      libdir: (full) => fs.symlinkSync('bin', full),
      'bin/via-dir': (full) => fs.symlinkSync('../libdir/tool', full),
    });
    const report = scanPackage({ root, inventory: inventoryWith([supported('bin/tool')]) });
    expect(report.mount).toBe('/');
    expect(report.failures.map((f) => [f.kind, f.path])).toEqual([
      ['symlink', 'bin/host'],
      ['symlink', 'bin/libc'],
    ]);
    expect(report.failures[1].message).toBe(
      '-> /lib/x86_64-linux-gnu/libc.so.6 dangles: nothing in the package is at /lib/x86_64-linux-gnu/libc.so.6'
    );
  });

  test('a symlink that leaves the install root or loops fails', () => {
    const root = tree({
      'bin/tool': copyTrue,
      'bin/up': (full) => fs.symlinkSync('../../../usr/lib/libasound.so.2', full),
      'bin/sys': (full) => fs.symlinkSync('/usr/lib/libgbm.so.1', full),
      'bin/self': (full) => fs.symlinkSync('/opt/Freedom/bin/tool', full),
      'bin/a': (full) => fs.symlinkSync('b', full),
      'bin/b': (full) => fs.symlinkSync('a', full),
    });
    const inventory = { ...inventoryWith([supported('bin/tool')]), installRoot: '/opt/Freedom' };
    const report = scanPackage({ root, inventory });
    expect(report.mount).toBe('/opt/Freedom');
    expect(report.failures.map((f) => [f.path, f.message])).toEqual([
      ['bin/a', '-> b loops at /opt/Freedom/bin/a'],
      ['bin/b', '-> a loops at /opt/Freedom/bin/b'],
      ['bin/sys', '-> /usr/lib/libgbm.so.1 leaves the package for /usr/lib/libgbm.so.1'],
      [
        'bin/up',
        '-> ../../../usr/lib/libasound.so.2 leaves the package for /usr/lib/libasound.so.2',
      ],
    ]);
  });

  test('a supported file that requests another interpreter fails', () => {
    const relinked = (full) => {
      const bytes = fs.readFileSync(TRUE_BIN);
      const at = bytes.indexOf('/lib64/ld-linux-x86-64.so.2');
      bytes.write('/lib64/ld-linux-x86-64.so.3', at, 'latin1');
      fs.writeFileSync(full, bytes);
    };
    const root = tree({ 'bin/tool': copyTrue, 'bin/nix': relinked });
    const report = scanPackage({
      root,
      inventory: inventoryWith([supported('bin/tool'), supported('bin/nix')]),
    });
    expect(report.interpreters).toEqual({
      'bin/nix': '/lib64/ld-linux-x86-64.so.3',
      'bin/tool': '/lib64/ld-linux-x86-64.so.2',
    });
    expect(report.failures).toEqual([
      {
        kind: 'interp',
        path: 'bin/nix',
        message:
          'requests the interpreter /lib64/ld-linux-x86-64.so.3, not /lib64/ld-linux-x86-64.so.2',
      },
    ]);
  });

  test('scans under a prefix and fails an ELF file outside it', () => {
    const root = tree({ 'opt/Freedom/bin/tool': copyTrue, 'usr/bin/stray': copyTrue });
    const report = scanPackage({
      root,
      prefix: 'opt/Freedom',
      inventory: inventoryWith([supported('bin/tool')]),
    });
    expect(report.failures).toEqual([
      { kind: 'extra', path: 'usr/bin/stray', message: 'ELF file outside opt/Freedom' },
    ]);
  });

  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    asar = null;
  }
  const asarTest = asar ? test : test.skip;

  asarTest('an ELF member packed inside an asar fails; an unpacked one passes', async () => {
    const src = tree({
      'app/index.js': (f) => fs.writeFileSync(f, '1'),
      'app/addon.node': copyTrue,
    });
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await asar.createPackageWithOptions(path.join(src, 'app'), path.join(out, 'packed.asar'), {});
    await asar.createPackageWithOptions(path.join(src, 'app'), path.join(out, 'app.asar'), {
      unpack: '*.node',
    });
    const inventory = inventoryWith([supported('app.asar.unpacked/addon.node')]);
    const report = scanPackage({ root: out, inventory });
    expect(report.asar.map((a) => [a.path, a.files, a.unpacked])).toEqual([
      ['app.asar', 2, 1],
      ['packed.asar', 2, 0],
    ]);
    expect(report.failures).toEqual([
      {
        kind: 'asar',
        path: 'packed.asar:addon.node',
        message: 'ELF member packed inside the archive',
      },
    ]);
  });

  asarTest('an asar entry marked unpacked with no file behind it fails', async () => {
    const src = tree({
      'app/index.js': (f) => fs.writeFileSync(f, '1'),
      'app/addon.node': copyTrue,
    });
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await asar.createPackageWithOptions(path.join(src, 'app'), path.join(out, 'app.asar'), {
      unpack: '*.node',
    });
    fs.rmSync(path.join(out, 'app.asar.unpacked', 'addon.node'));
    const report = scanPackage({ root: out, inventory: inventoryWith([]) });
    expect(report.failures).toEqual([
      {
        kind: 'asar',
        path: 'app.asar:addon.node',
        message: 'header marks it unpacked but no file is behind it',
      },
    ]);
  });
});

describe('resolveInTree', () => {
  test('resolves through directory links and stays within the mount', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-native-scan-links-'));
    try {
      fs.mkdirSync(path.join(root, 'resources/lib'), { recursive: true });
      fs.writeFileSync(path.join(root, 'resources/lib/real.so'), 'x');
      fs.symlinkSync('resources/lib', path.join(root, 'lib'));
      fs.symlinkSync('/opt/Freedom/lib/real.so', path.join(root, 'abs'));
      expect(resolveInTree(root, '/opt/Freedom', 'abs')).toEqual({
        status: 'ok',
        resolved: '/opt/Freedom/resources/lib/real.so',
      });
      fs.symlinkSync('lib/missing.so', path.join(root, 'gone'));
      expect(resolveInTree(root, '/opt/Freedom', 'gone')).toEqual({
        status: 'dangling',
        resolved: '/opt/Freedom/resources/lib/missing.so',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
