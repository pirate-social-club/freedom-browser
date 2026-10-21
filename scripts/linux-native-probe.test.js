/**
 * The packaged-runtime probe's judgement, off the packaged runtime: which
 * mapped `.node` files pass for each test and mode, the loader-selection
 * assumptions, and the parsers. The probe itself runs in the floor images
 * through scripts/linux-packaging-gate.js.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const {
  EXPECTED,
  LOADER_FAILURE_RE,
  mappedNodeFiles,
  goBuildInfo,
  loaderSelectionViolations,
  mappingProblems,
} = require('./linux-native-probe');

const inventory = require('./linux-native-inventory.json');

const TREE = '/opt/Freedom';
const MODULES = `${TREE}/resources/app.asar.unpacked/node_modules`;
const context = (prebuildsOnly) => ({ tree: TREE, inventory, prebuildsOnly });

describe('mapped addon judgement', () => {
  test('every expected file is listed in the inventory with the class its mode needs', () => {
    for (const name of Object.keys(EXPECTED)) {
      for (const [mode, prebuildsOnly] of [
        ['default', false],
        ['prebuildsOnly', true],
      ]) {
        const mapped = EXPECTED[name][mode].map((file) => `${TREE}/${file}`);
        expect([name, mode, mappingProblems(name, mapped, context(prebuildsOnly))]).toEqual([
          name,
          mode,
          [],
        ]);
      }
    }
  });

  test('the source-built usb addon passes by default and fails under PREBUILDS_ONLY', () => {
    const build = [`${MODULES}/usb/build/Release/usb_bindings.node`];
    expect(mappingProblems('usb', build, context(false))).toEqual([]);
    expect(mappingProblems('usb', build, context(true))).toEqual([
      'resources/app.asar.unpacked/node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node was not mapped',
      'supported file mapped: resources/app.asar.unpacked/node_modules/usb/build/Release/usb_bindings.node',
    ]);
  });

  test('a dormant or foreign variant fails, and so does any Colibri addon', () => {
    expect(
      mappingProblems(
        'nodehid',
        [
          `${MODULES}/node-hid/build/Release/HID_hidraw.node`,
          `${MODULES}/node-hid/build/Release/HID.node`,
        ],
        context(false)
      )
    ).toEqual([
      'dormant file mapped: resources/app.asar.unpacked/node_modules/node-hid/build/Release/HID.node',
    ]);
    expect(
      mappingProblems(
        'keccak',
        [`${MODULES}/keccak/prebuilds/linux-x64/node.napi.musl.node`],
        context(false)
      )
    ).toEqual([
      'resources/app.asar.unpacked/node_modules/keccak/build/Release/addon.node was not mapped',
      'foreign file mapped: resources/app.asar.unpacked/node_modules/keccak/prebuilds/linux-x64/node.napi.musl.node',
    ]);
    expect(
      mappingProblems(
        'colibri',
        [`${MODULES}/@corpus-core/colibri-stateless/prebuilds/linux-x64/colibri_native.node`],
        context(false)
      )
    ).toEqual([
      'Colibri native addon mapped: resources/app.asar.unpacked/node_modules/@corpus-core/colibri-stateless/prebuilds/linux-x64/colibri_native.node',
    ]);
  });

  test('a keccak that fell back to JavaScript maps nothing and fails', () => {
    expect(mappingProblems('keccak', [], context(false))).toEqual([
      'resources/app.asar.unpacked/node_modules/keccak/build/Release/addon.node was not mapped',
    ]);
  });

  test('a .node file from outside the package fails', () => {
    expect(mappingProblems('colibri', ['/tmp/elsewhere/addon.node'], context(false))).toEqual([
      'unexpected file mapped: /tmp/elsewhere/addon.node',
    ]);
  });
});

describe('loader-selection assumptions', () => {
  const none = () => false;

  test('a clean environment violates nothing', () => {
    expect(loaderSelectionViolations({ PATH: '/usr/bin', HOME: '/tmp' }, false, none)).toEqual([]);
    expect(loaderSelectionViolations({ PREBUILDS_ONLY: '1' }, true, none)).toEqual([]);
  });

  test('names every variable that changes node-gyp-build selection', () => {
    expect(
      loaderSelectionViolations(
        { LIBC: 'musl', npm_config_arch: 'arm64', USB_PREBUILD: '/x', PREBUILDS_ONLY: '' },
        false,
        none
      )
    ).toEqual(['LIBC', 'npm_config_arch', 'USB_PREBUILD', 'PREBUILDS_ONLY']);
    expect(loaderSelectionViolations({}, false, (file) => file === '/etc/alpine-release')).toEqual([
      '/etc/alpine-release',
    ]);
  });
});

describe('parsers', () => {
  test('lists the mapped .node files, deleted ones included', () => {
    const maps = [
      '7f0000000000-7f0000001000 r--p 00000000 00:2a 123 /opt/Freedom/resources/radicle-bin/libradicle.node',
      '7f0000001000-7f0000002000 r-xp 00001000 00:2a 123 /opt/Freedom/resources/radicle-bin/libradicle.node',
      '7f0000003000-7f0000004000 r--p 00000000 00:2a 124 /usr/lib/x86_64-linux-gnu/libudev.so.1.7.8',
      '7f0000005000-7f0000006000 r--p 00000000 00:2a 125 /tmp/x y/addon.node (deleted)',
      '7ffd00000000-7ffd00021000 rw-p 00000000 00:00 0 [stack]',
    ].join('\n');
    expect(mappedNodeFiles(maps)).toEqual([
      '/opt/Freedom/resources/radicle-bin/libradicle.node',
      '/tmp/x y/addon.node',
    ]);
  });

  test('reads the Go version and main module of a Go executable', () => {
    const varint = (n) => Buffer.from([n]);
    const sentinel = Buffer.alloc(16, 0x30);
    const modinfo = Buffer.concat([
      sentinel,
      Buffer.from('path\tgithub.com/example/tool\nmod\tgithub.com/example/tool\t(devel)\t\n'),
      sentinel,
    ]);
    const header = Buffer.alloc(32);
    Buffer.from('\xff Go buildinf:', 'latin1').copy(header);
    header[14] = 8;
    header[15] = 2;
    const binary = Buffer.concat([
      Buffer.alloc(100),
      header,
      varint(8),
      Buffer.from('go1.26.2'),
      varint(modinfo.length),
      modinfo,
    ]);
    expect(goBuildInfo(binary)).toEqual({ goVersion: 'go1.26.2', path: 'github.com/example/tool' });
    expect(goBuildInfo(Buffer.from('not a go binary'))).toBeNull();
  });
});

describe('coverage of the inventory', () => {
  const nodeFiles = (pred) =>
    inventory.files.filter((e) => e.path.endsWith('.node') && pred(e)).map((e) => e.path);
  const expected = (mode) => new Set(Object.values(EXPECTED).flatMap((byMode) => byMode[mode]));

  test('every supported .node file is driven by some test', () => {
    const covered = expected('default');
    expect(nodeFiles((e) => e.class === 'supported').filter((f) => !covered.has(f))).toEqual([]);
  });

  test('every prebuild PREBUILDS_ONLY selects is driven in that mode', () => {
    const covered = expected('prebuildsOnly');
    expect(nodeFiles((e) => e.selectedWhen).filter((f) => !covered.has(f))).toEqual([]);
  });
});

describe('the probe cannot run', () => {
  const probe = (args) =>
    spawnSync(process.execPath, [path.join(__dirname, 'linux-native-probe.js'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });

  test('a missing inventory is a harness error with a summary', () => {
    const run = probe(['--inventory', '/nonexistent/inventory.json']);
    expect(run.status).toBe(3);
    const summary = JSON.parse(run.stdout);
    expect(summary.status).toBe('harness-error');
    expect(summary.diagnostic).toMatch(/^the probe could not run: ENOENT/);
  });

  test('an unknown --only name is refused', () => {
    const run = probe(['--only', 'usbb,keccak']);
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout).diagnostic).toBe(
      'the probe could not run: --only names no known test: usbb'
    );
    expect(probe(['--only', '']).status).toBe(3);
  });

  test('loader failures are told apart from other deaths', () => {
    expect(
      LOADER_FAILURE_RE.test(
        'node: error while loading shared libraries: libudev.so.1: cannot open shared object file: No such file or directory'
      )
    ).toBe(true);
    expect(LOADER_FAILURE_RE.test('Error: ENOENT: no such file or directory')).toBe(false);
  });
});
