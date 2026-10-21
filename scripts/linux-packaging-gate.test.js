/**
 * The packaging gate's judgement of what apt, the loader, the probe and docker
 * report. The helpers are tested on output captured from the 2026-10-21 runtime
 * qualification; the docker paths through a Gate whose command runner is
 * replaced by canned results, so each kind of failure is shown to land as a
 * defect or as a harness error, never the other. The real container runs
 * happen in the Linux evaluation deb workflow.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  IMAGES,
  Gate,
  classifyAptUpdate,
  classifyAptInstall,
  refusedDepends,
  scriptFailureLines,
  parsePackages,
  diffPackages,
  parseIdentity,
  identityProblem,
  splitMarkedOutput,
  parseLoaderTrace,
  RUNTIME_START_RE,
  RUNTIME_SYMBOL_RE,
  finish,
} = require('./linux-packaging-gate');

const apt = (status, stdout, stderr = '') => ({ status, stdout, stderr });

// Ubuntu 22.04 refusing the 2f7920f3 deb.
const REFUSAL = [
  'The following packages have unmet dependencies:',
  ' freedom-browser : Depends: libc6 (>= 2.36) but 2.35-0ubuntu3.14 is to be installed',
  '                   Recommends: libappindicator3-1',
  'E: Unable to correct problems, you have held broken packages.',
].join('\n');

const SCRIPT_FAILURE = [
  'Setting up freedom-browser (0.7.15) ...',
  'chmod: cannot access /opt/Freedom/chrome-sandbox: No such file or directory',
  'dpkg: error processing package freedom-browser (--configure):',
  ' installed freedom-browser package post-installation script subprocess returned error exit status 1',
  'Errors were encountered while processing:',
  ' freedom-browser',
  'E: Sub-process /usr/bin/dpkg returned an error code (1)',
].join('\n');

// `LD_TRACE_LOADED_OBJECTS=1 ld.so /opt/Freedom/freedom` on a Depends-only
// install of that deb (abridged), and the IPFS addon's trace on Debian 12.
const FREEDOM_TRACE = [
  '\tlinux-vdso.so.1 (0x00007ac237ce2000)',
  '\tlibffmpeg.so => /opt/Freedom/libffmpeg.so (0x00007ac229d00000)',
  '\tlibgbm.so.1 => not found',
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

  test('the package failing its own maintainer script is a defect, with its dpkg lines', () => {
    expect(classifyAptInstall(apt(100, SCRIPT_FAILURE))).toBe('script-failed');
    expect(scriptFailureLines(SCRIPT_FAILURE)).toEqual([
      'dpkg: error processing package freedom-browser (--configure):',
      'installed freedom-browser package post-installation script subprocess returned error exit status 1',
      'Errors were encountered while processing:',
    ]);
  });

  test('a download that failed is a harness error, not a refusal', () => {
    const fetch =
      "E: Failed to fetch http://deb.debian.org/debian/pool/main/a/alsa-lib/libasound2t64_1.2.14-1_amd64.deb  Temporary failure resolving 'deb.debian.org'\n" +
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

  test('records exactly which packages an install changed', () => {
    const before = parsePackages(
      'base-files\t13.8\tii \nlibudev1\t257.9\tii \ngone\t1\tii \nhalf\t1\trc \n'
    );
    const after = parsePackages(
      'base-files\t13.8\tii \nlibudev1\t257.13\tii \nlibasound2t64\t1.2.14\tii \nfreedom-browser\t0.7.15\tii \n'
    );
    expect(before.has('half')).toBe(false);
    expect(diffPackages(before, after)).toEqual({
      added: ['freedom-browser 0.7.15', 'libasound2t64 1.2.14'],
      upgraded: ['libudev1 257.9 -> 257.13'],
      removed: ['gone 1'],
    });
  });
});

describe('container identity', () => {
  test('reads and strips the identity line', () => {
    const { identity, rest } = parseIdentity('__GATE_ID debian 13 2.41\n{"a":1}\n');
    expect(identity).toEqual({ id: 'debian', versionId: '13', glibc: '2.41' });
    expect(rest).toBe('{"a":1}\n');
    expect(parseIdentity('{}').identity).toBeNull();
  });

  test('a container that is not the expected distribution is named', () => {
    expect(
      identityProblem('debian-13', { id: 'debian', versionId: '13', glibc: '2.41' })
    ).toBeNull();
    expect(identityProblem('debian-12', { id: 'ubuntu', versionId: '22.04', glibc: '2.35' })).toBe(
      'expected debian 12, glibc 2.36, but the container is ubuntu 22.04, glibc 2.35'
    );
    expect(identityProblem('ubuntu-24.04', null)).toBe(
      'the ubuntu:24.04 container did not report its identity'
    );
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

  test('names the exact unresolved sonames', () => {
    const parsed = parseLoaderTrace(FREEDOM_TRACE, [
      'libffmpeg.so',
      'libgbm.so.1',
      'libasound.so.2',
      'libc.so.6',
    ]);
    expect(parsed.parsed).toBe(true);
    expect(parsed.notFound).toEqual(['libasound.so.2', 'libgbm.so.1']);
    expect(parsed.versionErrors).toEqual([]);
  });

  test('a NEEDED entry absent from the trace counts as unresolved', () => {
    expect(parseLoaderTrace(FREEDOM_TRACE, ['libcups.so.2']).notFound).toEqual([
      'libasound.so.2',
      'libcups.so.2',
      'libgbm.so.1',
    ]);
  });

  test('reports version needs the image cannot meet', () => {
    const parsed = parseLoaderTrace(IPFS_TRACE, ['libstdc++.so.6', 'libc.so.6']);
    expect(parsed.notFound).toEqual([]);
    expect(parsed.versionErrors).toHaveLength(2);
    expect(parsed.versionErrors[1]).toMatch(/version `GLIBC_2\.39' not found/);
    expect(parsed.resolved['libstdc++.so.6']).toBe('/lib/x86_64-linux-gnu/libstdc++.so.6');
  });

  test('a missing weak version need is not a defect, as the scanner agrees', () => {
    // A copy of /bin/true patched to need a weak GLIBC_2.99.
    const trace = [
      "./true-weak: /lib/x86_64-linux-gnu/libc.so.6: weak version `GLIBC_2.99' not found (required by ./true-weak)",
      '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)',
    ].join('\n');
    const parsed = parseLoaderTrace(trace, ['libc.so.6']);
    expect(parsed.versionErrors).toEqual([]);
    expect(parsed.weakVersionsNotFound).toHaveLength(1);
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

describe('docker paths', () => {
  const IDS = {
    'ubuntu-24.04': '__GATE_ID ubuntu 24.04 2.39',
    'debian-13': '__GATE_ID debian 13 2.41',
    'debian-12': '__GATE_ID debian 12 2.36',
  };
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-packaging-gate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A Gate whose runner answers from `overrides` (the first whose key occurs
   * in the joined argv), else as a healthy container of `label` would.
   */
  const gateFor = (label, overrides = {}, options = {}) => {
    const calls = [];
    let dpkgQueries = 0;
    const runner = (bin, args) => {
      calls.push([bin, ...args]);
      const joined = args.join(' ');
      const base = { argv: [bin, ...args], status: 0, signal: null, stdout: '', stderr: '' };
      for (const [pattern, result] of Object.entries(overrides)) {
        if (joined.includes(pattern)) return { ...base, timedOut: false, error: null, ...result };
      }
      let stdout = '';
      if (args[0] === 'exec' && args.includes('sh')) stdout = `${IDS[label]}\n`;
      else if (args[0] === 'exec' && args.includes('dpkg-query')) {
        dpkgQueries += 1;
        stdout =
          dpkgQueries === 1
            ? 'base-files\t13\tii \n'
            : 'base-files\t13\tii \nfreedom-browser\t0.7.15\tii \nlibasound2t64\t1.2.14\tii \n';
      } else if (args[0] === 'run' && args.includes('none')) stdout = `${IDS[label]}\n`;
      return { ...base, stdout, timedOut: false, error: null };
    };
    const gate = new Gate(path.join(dir, 'freedom-browser_0.7.15_amd64.deb'), dir, {
      run: runner,
      ...options,
    });
    return { gate, calls };
  };
  const statuses = (section) => section.checks.map((c) => [c.name, c.status]);

  test('installs with Depends only and records what apt added', () => {
    const { gate, calls } = gateFor('debian-13');
    const installed = gate.install('debian-13', false);
    expect(installed.outcome).toBe('installed');
    expect(installed.installed.added).toEqual(['freedom-browser 0.7.15', 'libasound2t64 1.2.14']);
    const aptInstall = calls.find((c) => c.includes('install') && c.includes('apt-get'));
    expect(aptInstall).toContain('--no-install-recommends');
    // Every container this run started is removed.
    expect(calls.filter((c) => c[1] === 'rm')).toHaveLength(1);
  });

  test('a pull failure is a harness error, and the rest of its section does not run', () => {
    const { gate } = gateFor('ubuntu-24.04', {
      'image inspect': { status: 1 },
      'pull ubuntu@': { status: 1, stderr: 'Error response from daemon: manifest unknown' },
    });
    const section = gate.runtimeSection('ubuntu-24.04');
    expect(statuses(section)).toEqual([
      ['apt-install', 'harness-error'],
      ['loader-resolution', 'not-run'],
      ['libstdcxx-versions', 'not-run'],
      ['probe', 'not-run'],
      ['probe-prebuilds-only', 'not-run'],
    ]);
    expect(section.checks[0].harnessErrors[0]).toMatch(
      /^docker pull ubuntu@sha256:[0-9a-f]{64} exited 1: Error response from daemon: manifest unknown$/
    );
    const summary = finish({ sections: [section] }, dir);
    expect(summary.verdict).toBe('harness-error');
    expect(summary.defects).toEqual([]);
  });

  test('an apt network failure is a harness error, not a defect', () => {
    const { gate } = gateFor('debian-13', {
      'apt-get -o Acquire::Retries=3 install': {
        status: 100,
        stderr:
          "E: Failed to fetch http://deb.debian.org/debian/pool/main/m/mesa/libgbm1_25.0.7-2_amd64.deb  Temporary failure resolving 'deb.debian.org'",
      },
    });
    const check = gate.runtimeSection('debian-13').checks[0];
    expect(check.status).toBe('harness-error');
    expect(check.defects).toEqual([]);
    expect(check.harnessErrors[0]).toMatch(
      /^apt-get install failed for a reason other than the package/
    );
  });

  test('a timeout is a harness error', () => {
    const { gate } = gateFor('ubuntu-24.04', {
      'apt-get -o Acquire::Retries=3 update': { timedOut: true },
    });
    const check = gate.runtimeSection('ubuntu-24.04').checks[0];
    expect([check.status, check.harnessErrors]).toEqual([
      'harness-error',
      ['apt-get update timed out'],
    ]);
  });

  test('a spent time budget starts nothing and is a harness error', () => {
    let clock = 0;
    const { gate, calls } = gateFor('debian-12', {}, { now: () => clock, budgetMinutes: 1 });
    clock = 60 * 1000;
    const section = gate.refusalSection('debian-12');
    expect(calls.filter((c) => c[1] !== 'rm' && c[1] !== 'rmi')).toEqual([]);
    expect(section.checks[0].harnessErrors[0]).toBe(
      "docker image inspect not started: the gate's time budget is spent"
    );
  });

  test('a failed maintainer script is a defect, with its output', () => {
    const { gate } = gateFor('debian-13', {
      'apt-get -o Acquire::Retries=3 install': { status: 100, stdout: SCRIPT_FAILURE },
    });
    const section = gate.runtimeSection('debian-13');
    expect(statuses(section)[0]).toEqual(['apt-install', 'fail']);
    expect(section.checks[0].defects[0]).toMatch(
      /^the freedom-browser maintainer script failed: dpkg: error processing package freedom-browser/
    );
    expect(section.checks[0].output).toContain('chmod: cannot access');
    expect(section.checks[1]).toEqual(
      expect.objectContaining({ status: 'not-run', cause: 'apt-install fail' })
    );
  });

  test('the debian:12 refusal passes only on the libc6 floor, and only on debian 12', () => {
    const refusal = {
      status: 100,
      stdout:
        'The following packages have unmet dependencies:\n freedom-browser : Depends: libc6 (>= 2.39) but 2.36-9+deb12u14 is to be installed\nE: Unable to correct problems, you have held broken packages.',
    };
    const right = gateFor('debian-12', { 'apt-get -o Acquire::Retries=3 install': refusal }).gate;
    expect(right.refusalSection('debian-12').checks[0].status).toBe('pass');

    const wrong = gateFor('debian-12', {
      'apt-get -o Acquire::Retries=3 install': refusal,
      'sh -c': { stdout: '__GATE_ID ubuntu 22.04 2.35\n' },
    }).gate;
    const check = wrong.refusalSection('debian-12').checks[0];
    expect(check.status).toBe('harness-error');
    expect(check.harnessErrors[0]).toBe(
      'expected debian 12, glibc 2.36, but the container is ubuntu 22.04, glibc 2.35'
    );

    const accepted = gateFor('debian-12').gate.refusalSection('debian-12').checks[0];
    expect(accepted.defects).toEqual([
      'apt accepted the package on debian:12 (glibc 2.36); it must refuse it, citing libc6 (>= 2.39)',
    ]);
  });

  test('a probe that dies without a summary is a harness error', () => {
    const { gate } = gateFor('ubuntu-24.04', {
      'linux-native-probe.js': {
        status: 1,
        stdout: `${IDS['ubuntu-24.04']}\n`,
        stderr:
          "Error: ENOENT: no such file or directory, open '/gate/linux-native-inventory.json'",
      },
    });
    const check = gate.probe('ubuntu-24.04', 'image', false);
    expect(check.status).toBe('harness-error');
    expect(check.defects).toEqual([]);
    expect(check.harnessErrors[0]).toMatch(/^the probe exited 1 without a summary: Error: ENOENT/);

    const killed = gateFor('ubuntu-24.04', {
      'linux-native-probe.js': {
        status: null,
        signal: 'SIGKILL',
        stdout: `${IDS['ubuntu-24.04']}\n`,
      },
    }).gate.probe('ubuntu-24.04', 'image', true);
    expect([killed.name, killed.status]).toEqual(['probe-prebuilds-only', 'harness-error']);
  });

  test('a runtime the loader cannot start is a defect naming the library or symbol', () => {
    const missing = gateFor('debian-13', {
      'linux-native-probe.js': {
        status: 127,
        stdout: `${IDS['debian-13']}\n`,
        stderr:
          '/opt/Freedom/freedom: error while loading shared libraries: libgbm.so.1: cannot open shared object file: No such file or directory',
      },
    }).gate.probe('debian-13', 'image', false);
    expect([missing.status, missing.defects, missing.harnessErrors]).toEqual([
      'fail',
      [
        'the packaged runtime cannot start: libgbm.so.1 is not resolved (/opt/Freedom/freedom exited 127)',
      ],
      [],
    ]);
    const symbol = gateFor('ubuntu-24.04', {
      'linux-native-probe.js': {
        status: 127,
        stdout: `${IDS['ubuntu-24.04']}\n`,
        stderr:
          '/opt/Freedom/freedom: symbol lookup error: /opt/Freedom/freedom: undefined symbol: snd_device_name_get_hint, version ALSA_0.9',
      },
    }).gate.probe('ubuntu-24.04', 'image', false);
    expect(symbol.defects).toEqual([
      'the packaged runtime cannot start: /opt/Freedom/freedom needs snd_device_name_get_hint (ALSA_0.9), which no loaded library defines',
    ]);
  });

  test('a probe summary keeps its defects and harness errors apart', () => {
    const summary = {
      status: 'harness-error',
      tests: [
        { test: 'usb', status: 'fail', diagnostic: 'usb_bindings.node was not mapped' },
        { test: 'ipfs', status: 'harness-error', diagnostic: 'killed after 90000 ms' },
        { test: 'keccak', status: 'pass' },
      ],
    };
    const { gate } = gateFor('debian-13', {
      'linux-native-probe.js': {
        status: 3,
        stdout: `${IDS['debian-13']}\n${JSON.stringify(summary)}`,
      },
    });
    const check = gate.probe('debian-13', 'image', false);
    expect(check.defects).toEqual(['usb: usb_bindings.node was not mapped']);
    expect(check.harnessErrors).toEqual(['ipfs [harness-error]: killed after 90000 ms']);
    const folded = finish({ sections: [{ name: 'debian-13', checks: [check] }] }, dir);
    expect(folded.defects).toEqual(['debian-13/probe: usb: usb_bindings.node was not mapped']);
    expect(folded.harnessErrors).toEqual([
      'debian-13/probe: ipfs [harness-error]: killed after 90000 ms',
    ]);
    expect(folded.verdict).toBe('harness-error');
  });

  const scanned = (records) => ({
    results: records.map(([file, needed, glibcxx = []]) => ({
      path: `opt/Freedom/${file}`,
      dynamic: true,
      needed,
      glibcxx,
      cxxabi: [],
    })),
  });

  test('one unparseable trace does not hide another file’s defect', () => {
    const { gate } = gateFor('ubuntu-24.04', {
      LD_TRACE_LOADED_OBJECTS: {
        stdout: [
          IDS['ubuntu-24.04'],
          '__GATE_FILE freedom',
          FREEDOM_TRACE,
          '__GATE_EXIT 1',
          '__GATE_FILE libffmpeg.so',
          'Segmentation fault',
          '__GATE_EXIT 139',
        ].join('\n'),
      },
    });
    gate.scanReport = scanned([
      ['freedom', ['libasound.so.2', 'libgbm.so.1', 'libc.so.6']],
      ['libffmpeg.so', ['libc.so.6']],
    ]);
    const check = gate.loaderCheck('ubuntu-24.04', 'image');
    expect(check.defects).toEqual([
      '/opt/Freedom/freedom: libasound.so.2 not found',
      '/opt/Freedom/freedom: libgbm.so.1 not found',
    ]);
    expect(check.harnessErrors).toEqual([
      'unparseable loader output for libffmpeg.so (exit 139): Segmentation fault',
    ]);
    expect(check.notInPackage.length).toBeGreaterThan(0);
  });

  test('the libstdc++ check: a docker failure is a harness error, missing versions a defect', () => {
    const ipfs = 'resources/freedom-ipfs-node/freedom_ipfs_native.node';
    const lib = '/lib/x86_64-linux-gnu/libstdc++.so.6';
    const prepare = (gate) => {
      gate.scanReport = scanned([[ipfs, ['libstdc++.so.6'], ['3.4.29']]]);
      gate.loaderDetails = { [ipfs]: { resolved: { 'libstdc++.so.6': lib } } };
      return gate;
    };
    const failed = prepare(
      gateFor('debian-13', {
        __GATE_LIB: { status: 125, stderr: 'docker: Error response from daemon' },
      }).gate
    ).libstdcxxCheck('debian-13', 'image');
    expect([failed.status, failed.defects]).toEqual(['harness-error', []]);
    expect(failed.harnessErrors[0]).toMatch(/^docker could not run the libstdc\+\+ check/);

    const unreadable = prepare(
      gateFor('debian-13', {
        __GATE_LIB: { stdout: `${IDS['debian-13']}\n__GATE_LIB ${lib}\n__GATE_EXIT 1\n` },
      }).gate
    ).libstdcxxCheck('debian-13', 'image');
    expect([unreadable.status, unreadable.defects]).toEqual(['harness-error', []]);

    const old = prepare(
      gateFor('debian-13', {
        __GATE_LIB: {
          stdout: `${IDS['debian-13']}\n__GATE_LIB ${lib}\nGLIBCXX_3.4.28\nCXXABI_1.3.12\n__GATE_EXIT 0\n`,
        },
      }).gate
    ).libstdcxxCheck('debian-13', 'image');
    expect([old.status, old.defects]).toEqual([
      'fail',
      [`${ipfs}: ${lib} does not define GLIBCXX_3.4.29`],
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
  const check = (name, status, defects = [], harnessErrors = []) => ({
    name,
    status,
    defects,
    harnessErrors,
  });

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
            check('apt-install', 'harness-error', [], ['apt-get update failed']),
            { ...check('probe', 'not-run'), cause: 'apt-install harness-error' }
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

test('every image is pinned by digest and names the distribution it must be', () => {
  for (const image of Object.values(IMAGES)) {
    expect(image.ref).toMatch(/^[a-z]+@sha256:[0-9a-f]{64}$/);
    expect(image.id && image.versionId && image.glibc).toBeTruthy();
  }
});
