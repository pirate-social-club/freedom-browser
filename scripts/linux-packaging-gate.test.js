/**
 * The packaging gate's classification of what apt, the loader and docker
 * report, on output captured from the 2026-10-21 runtime qualification. The
 * container runs themselves happen in the Linux evaluation deb workflow.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  IMAGES,
  classifyAptUpdate,
  classifyAptInstall,
  refusedDepends,
  splitMarkedOutput,
  parseLoaderTrace,
  RUNTIME_START_RE,
  RUNTIME_SYMBOL_RE,
  finish,
} = require('./linux-packaging-gate');

const apt = (status, stdout, stderr = '') => ({ status, stdout, stderr });

// Ubuntu 22.04 refusing the 2f7920f3 deb.
const REFUSAL = [
  'Some packages could not be installed. This may mean that you have',
  'requested an impossible situation or if you are using the unstable',
  'distribution that some required packages have not yet been created',
  'or been moved out of Incoming.',
  'The following information may help to resolve the situation:',
  '',
  'The following packages have unmet dependencies:',
  ' freedom-browser : Depends: libc6 (>= 2.36) but 2.35-0ubuntu3.14 is to be installed',
  '                   Recommends: libappindicator3-1',
  'E: Unable to correct problems, you have held broken packages.',
].join('\n');

// `LD_TRACE_LOADED_OBJECTS=1 ld.so /opt/Freedom/freedom` on a plain install of
// that deb (abridged), and the IPFS addon's trace on Debian 12.
const FREEDOM_TRACE = [
  '\tlinux-vdso.so.1 (0x00007ac237ce2000)',
  '\tlibffmpeg.so => /opt/Freedom/libffmpeg.so (0x00007ac229d00000)',
  '\tlibgbm.so.1 => /lib/x86_64-linux-gnu/libgbm.so.1 (0x00007ac229100000)',
  '\tlibudev.so.1 => /lib/x86_64-linux-gnu/libudev.so.1 (0x00007ac229000000)',
  '\tlibasound.so.2 => not found',
  '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x000071e95668f000)',
  '\t/lib64/ld-linux-x86-64.so.2 (0x000071e957c74000)',
].join('\n');
const IPFS = '/opt/Freedom/resources/freedom-ipfs-node/freedom_ipfs_native.node';
const IPFS_TRACE = [
  `${IPFS}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.38' not found (required by ${IPFS})`,
  `${IPFS}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.39' not found (required by ${IPFS})`,
  '\tlinux-vdso.so.1 (0x000071badb131000)',
  '\tlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x000071badad48000)',
  '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x000071badab46000)',
].join('\n');

describe('apt outcomes', () => {
  test('an unmet dependency is a refusal and names the relation', () => {
    expect(classifyAptInstall(apt(100, REFUSAL))).toBe('refused');
    expect(refusedDepends(REFUSAL)).toEqual([
      'libc6 (>= 2.36) but 2.35-0ubuntu3.14 is to be installed',
    ]);
  });

  test('a download that failed is a harness error, not a refusal', () => {
    const fetch =
      "E: Failed to fetch http://deb.debian.org/debian/pool/main/a/alsa-lib/libasound2_1.2.8-1_amd64.deb  Temporary failure resolving 'deb.debian.org'\n" +
      'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?';
    expect(classifyAptInstall(apt(100, '', fetch))).toBe('harness-error');
    expect(classifyAptInstall(apt(100, '', 'E: dpkg was interrupted'))).toBe('harness-error');
    expect(classifyAptInstall(apt(0, 'Setting up freedom-browser (0.7.15) ...'))).toBe('installed');
  });

  test('apt-get update that could not reach the archive is a harness error', () => {
    expect(classifyAptUpdate(apt(0, 'Reading package lists...'))).toBe('ok');
    expect(
      classifyAptUpdate(
        apt(
          0,
          '',
          "W: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Temporary failure resolving 'archive.ubuntu.com'"
        )
      )
    ).toBe('harness-error');
    expect(classifyAptUpdate(apt(100, ''))).toBe('harness-error');
  });
});

describe('loader traces', () => {
  test('splits marked output per file', () => {
    const out = `__GATE_FILE freedom\n${FREEDOM_TRACE}\n__GATE_EXIT 0\n__GATE_FILE ${IPFS}\n${IPFS_TRACE}\n__GATE_EXIT 1\n`;
    const files = splitMarkedOutput(out, 'FILE');
    expect([...files.keys()]).toEqual(['freedom', IPFS]);
    expect(files.get('freedom').exit).toBe(0);
    expect(files.get(IPFS).exit).toBe(1);
  });

  test('names the exact unresolved soname', () => {
    const parsed = parseLoaderTrace(FREEDOM_TRACE, [
      'libffmpeg.so',
      'libgbm.so.1',
      'libasound.so.2',
      'libc.so.6',
    ]);
    expect(parsed.parsed).toBe(true);
    expect(parsed.notFound).toEqual(['libasound.so.2']);
    expect(parsed.versionErrors).toEqual([]);
    expect(parsed.resolved['libgbm.so.1']).toBe('/lib/x86_64-linux-gnu/libgbm.so.1');
  });

  test('a NEEDED entry absent from the trace counts as unresolved', () => {
    expect(parseLoaderTrace(FREEDOM_TRACE, ['libcups.so.2']).notFound).toEqual([
      'libasound.so.2',
      'libcups.so.2',
    ]);
  });

  test('reports version needs the image cannot meet', () => {
    const parsed = parseLoaderTrace(IPFS_TRACE, ['libstdc++.so.6', 'libc.so.6']);
    expect(parsed.notFound).toEqual([]);
    expect(parsed.versionErrors).toHaveLength(2);
    expect(parsed.versionErrors[1]).toMatch(/version `GLIBC_2\.39' not found/);
    expect(parsed.resolved['libstdc++.so.6']).toBe('/lib/x86_64-linux-gnu/libstdc++.so.6');
  });

  test('output with no library lines is unparseable', () => {
    expect(
      parseLoaderTrace('bash: /lib64/ld-linux-x86-64.so.2: No such file', ['libc.so.6']).parsed
    ).toBe(false);
  });
});

describe('runtime start failures', () => {
  test('name the unresolved library', () => {
    const m = RUNTIME_START_RE.exec(
      '/opt/Freedom/freedom: error while loading shared libraries: libasound.so.2: cannot open shared object file: No such file or directory'
    );
    expect(m[1]).toBe('libasound.so.2');
  });

  test('name the undefined symbol and its version', () => {
    // Ubuntu 24.04 with liboss4-salsa-asound2 standing in for libasound2.
    const m = RUNTIME_SYMBOL_RE.exec(
      '/opt/Freedom/freedom: symbol lookup error: /opt/Freedom/freedom: undefined symbol: snd_device_name_get_hint, version ALSA_0.9'
    );
    expect([m[1], m[2], m[3]]).toEqual([
      '/opt/Freedom/freedom',
      'snd_device_name_get_hint',
      'ALSA_0.9',
    ]);
  });
});

describe('verdict', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-packaging-gate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const section = (name, ...checks) => ({ name, checks });
  const check = (name, status, diagnostics = []) => ({ name, status, diagnostics });

  test('passes only when every check passes', () => {
    const summary = finish({ sections: [section('scan', check('inventory', 'pass'))] }, dir);
    expect(summary.verdict).toBe('pass');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).verdict).toBe(
      'pass'
    );
  });

  test('a defect fails its section and the gate, and keeps its diagnostic', () => {
    const summary = finish(
      {
        sections: [
          section('scan', check('glibc-floor', 'fail', ['usb_bindings.node: needs GLIBC_2.38'])),
          section('debian-12', check('apt-refusal', 'pass')),
        ],
      },
      dir
    );
    expect(summary.sections.map((s) => s.status)).toEqual(['fail', 'pass']);
    expect(summary.verdict).toBe('fail');
    expect(summary.defects).toEqual(['scan/glibc-floor: usb_bindings.node: needs GLIBC_2.38']);
  });

  test('a harness error is never a pass and never a defect', () => {
    const summary = finish(
      {
        sections: [
          section(
            'ubuntu-24.04',
            check('apt-install', 'harness-error', ['apt-get update failed']),
            check('probe', 'not-run', ['apt-install harness-error'])
          ),
          section('scan', check('glibc-floor', 'fail', ['x'])),
        ],
      },
      dir
    );
    expect(summary.sections[0].status).toBe('harness-error');
    expect(summary.verdict).toBe('harness-error');
    expect(summary.harnessErrors).toEqual(['ubuntu-24.04/apt-install: apt-get update failed']);
    expect(summary.defects).toEqual(['scan/glibc-floor: x']);
  });
});

test('every image is pinned by digest', () => {
  for (const image of Object.values(IMAGES))
    expect(image.ref).toMatch(/^[a-z]+@sha256:[0-9a-f]{64}$/);
});
