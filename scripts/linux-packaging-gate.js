#!/usr/bin/env node

// The Linux packaging gate: a built deb against its dependency contract, on
// the host and in clean, digest-pinned distribution images.
//
// The 2f7920f3 evaluation deb installed with apt on Debian 12, Ubuntu 24.04 and
// Debian 13 and then could not start on any of them, because `freedom` links
// libasound.so.2 and the deb did not declare it; on Debian 12 its IPFS and usb
// addons also needed a newer glibc than the declared floor. This runs the
// package the way a user's apt would and checks what the loader and the
// packaged runtime actually do, in four sections that each run and report on
// their own, whatever an earlier one found:
//
//   scan          the ELF scan of the unpacked deb against the inventory and
//                 the deb's own declared libc6 floor (scripts/linux-native-scan.js);
//   ubuntu-24.04  `apt-get install ./deb` on the floor image, the only step with
//                 network access; then, with --network none and an environment
//                 cleared to PATH and HOME: the distribution loader's resolution
//                 of every NEEDED entry of every supported file (in trace mode,
//                 which runs no code from the file), the GLIBCXX and CXXABI needs
//                 against that image's libstdc++, and the packaged-runtime probe
//                 (scripts/linux-native-probe.js), once plain and once with
//                 PREBUILDS_ONLY=1;
//   debian-13     the same on Debian 13;
//   debian-12     apt must refuse the deb, citing `libc6 (>= <floor>)`.
//
// The runtime images get the deb and what apt installs for its declared
// dependencies, nothing else, so a library the deb fails to declare shows up as
// unresolved instead of being quietly supplied. Every check reports `pass`,
// `fail` (a defect in the package) or `harness-error` (a pull, an apt
// download, docker or a timeout failed, which says nothing about the package);
// a check that cannot run because an earlier one in its section failed reports
// `not-run` with the cause. The summary is written to <out>/summary.json and
// the exit status is 0 when everything passes, 1 when only defects were found,
// and 3 on any harness error.
//
// Every container is `docker run --rm --init`, named freedom-pkg-gate-*; the
// committed images, and any base image this run pulled, are removed at the end.
//
// Usage: node scripts/linux-packaging-gate.js <freedom-browser.deb> <out-dir>

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scan = require('./linux-native-scan');

// Pinned by manifest-list digest, as recorded by the 2026-10-21 runtime
// qualification (`docker image inspect --format '{{.RepoDigests}}'`).
const IMAGES = {
  'ubuntu-24.04': {
    tag: 'ubuntu:24.04',
    ref: 'ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac',
  },
  'debian-13': {
    tag: 'debian:13',
    ref: 'debian@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308',
  },
  'debian-12': {
    tag: 'debian:12',
    ref: 'debian@sha256:854dd8ab51d62866dbd8f5431d15ce77b12983a2a4a1e1fe43a2395dc7ef9f61',
  },
};
const RUNTIME_IMAGES = ['ubuntu-24.04', 'debian-13'];
const REFUSAL_IMAGE = 'debian-12';
const INSTALL_ROOT = 'opt/Freedom';
const CLEAN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const LOADER = '/lib64/ld-linux-x86-64.so.2';
const MINUTE = 60 * 1000;

const APT_NETWORK_RE =
  /Temporary failure resolving|Could not resolve|Failed to fetch|Unable to fetch some archives|Could not connect to|Connection timed out|Connection failed|Some index files failed to download|Hash Sum mismatch|Network is unreachable/;
const APT_REFUSAL_RE =
  /unmet dependencies|Unable to correct problems|but it is not installable|but [^\n]+ is to be installed/;
const RUNTIME_START_RE =
  /error while loading shared libraries: (\S+): cannot open shared object file/;
const RUNTIME_SYMBOL_RE =
  /symbol lookup error: (\S+): undefined symbol: ([^,\s]+)(?:, version (\S+))?/;

/**
 * Run a command; a spawn failure or a timeout is reported, never thrown.
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs: number}} options
 */
function run(bin, args, options) {
  const proc = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    argv: [bin, ...args],
    status: proc.status,
    signal: proc.signal,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    timedOut: Boolean(proc.error && proc.error.code === 'ETIMEDOUT'),
    error: proc.error && proc.error.code !== 'ETIMEDOUT' ? proc.error.message : null,
  };
}

/** Why a docker or tool invocation failed as a harness problem, or null when it ran. */
function harnessFailure(result, what) {
  if (result.timedOut) return `${what} timed out`;
  if (result.error) return `${what} could not run: ${result.error}`;
  return null;
}

function tail(text, lines = 12) {
  return String(text).trim().split('\n').slice(-lines).join('\n');
}

/**
 * Classify `apt-get update` output.
 * @returns {'ok' | 'harness-error'}
 */
function classifyAptUpdate(result) {
  if (result.status !== 0 || APT_NETWORK_RE.test(`${result.stdout}\n${result.stderr}`)) {
    return 'harness-error';
  }
  return 'ok';
}

/**
 * Classify `apt-get install ./deb` output. A dependency the archive cannot
 * satisfy is a refusal; a download that failed is the harness's problem.
 * @returns {'installed' | 'refused' | 'harness-error'}
 */
function classifyAptInstall(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) return 'installed';
  if (APT_NETWORK_RE.test(text)) return 'harness-error';
  if (APT_REFUSAL_RE.test(text)) return 'refused';
  return 'harness-error';
}

/** The `Depends:` relations apt cites as unmet in a refusal. */
function refusedDepends(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:\S+\s+:\s+)?(?:Pre)?Depends:\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Split the loader-check output (`__GATE_FILE <path>`, the trace, then
 * `__GATE_EXIT <status>`) per file.
 * @returns {Map<string, {exit: number | null, text: string}>}
 */
function splitMarkedOutput(text, marker) {
  const files = new Map();
  let current = null;
  for (const line of String(text).split('\n')) {
    const start = new RegExp(`^__GATE_${marker} (.+)$`).exec(line);
    if (start) {
      current = { exit: null, lines: [] };
      files.set(start[1], current);
      continue;
    }
    const exit = /^__GATE_EXIT (\d+)$/.exec(line);
    if (exit && current) {
      current.exit = Number(exit[1]);
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return new Map([...files].map(([file, v]) => [file, { exit: v.exit, text: v.lines.join('\n') }]));
}

/**
 * Parse one `LD_TRACE_LOADED_OBJECTS=1 ld.so <file>` trace. A missing library
 * or version is a result, not an error; output with no library lines at all is
 * unparseable.
 * @param {string} text
 * @param {string[]} needed the file's NEEDED entries, from the host scan
 */
function parseLoaderTrace(text, needed) {
  const mapping = {};
  for (const line of String(text).split('\n')) {
    let m = /^\s*(\S+)\s+=>\s+(not found|\S+)/.exec(line);
    if (m) {
      mapping[m[1]] = m[2];
      continue;
    }
    m = /^\s*(\/\S+)\s+\(0x/.exec(line);
    if (m && !(path.basename(m[1]) in mapping)) mapping[path.basename(m[1])] = m[1];
  }
  const versionErrors = [
    ...new Set(
      String(text)
        .split('\n')
        .filter((line) => line.includes('version `') && line.includes('not found'))
        .map((line) => line.trim())
    ),
  ];
  const notFound = Object.keys(mapping).filter((lib) => mapping[lib] === 'not found');
  for (const lib of needed) {
    if (!(lib in mapping) && !notFound.includes(lib)) notFound.push(lib);
  }
  return {
    parsed: Object.keys(mapping).length > 0 || needed.length === 0,
    resolved: mapping,
    notFound: notFound.sort(),
    versionErrors,
  };
}

class Gate {
  constructor(deb, outDir) {
    this.deb = path.resolve(deb);
    this.outDir = path.resolve(outDir);
    this.logDir = path.join(this.outDir, 'logs');
    this.runId = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    this.containers = new Set();
    this.images = new Set();
    this.inventoryPath = path.join(__dirname, 'linux-native-inventory.json');
    this.probePath = path.join(__dirname, 'linux-native-probe.js');
    this.inventory = scan.loadInventory(this.inventoryPath);
    this.scanReport = null;
  }

  log(name, result) {
    fs.mkdirSync(this.logDir, { recursive: true });
    const body = [
      `$ ${result.argv.join(' ')}`,
      `status=${result.status} signal=${result.signal} timedOut=${result.timedOut} error=${result.error}`,
      '--- stdout',
      result.stdout,
      '--- stderr',
      result.stderr,
    ].join('\n');
    fs.writeFileSync(path.join(this.logDir, `${name}.log`), `${body}\n`);
  }

  docker(name, args, timeoutMs) {
    const result = run('docker', args, { timeoutMs });
    this.log(name, result);
    return result;
  }

  containerName(label, step) {
    const name = `freedom-pkg-gate-${this.runId}-${label}-${step}`;
    this.containers.add(name);
    return name;
  }

  /** Make the pinned base image available; returns a harness diagnostic or null. */
  ensureImage(label) {
    const { ref } = IMAGES[label];
    const present = run('docker', ['image', 'inspect', ref], { timeoutMs: MINUTE });
    const broken = harnessFailure(present, 'docker image inspect');
    if (broken) return broken;
    if (present.status === 0) return null;
    const pull = this.docker(`${label}-pull`, ['pull', ref], 10 * MINUTE);
    const failed = harnessFailure(pull, `docker pull ${ref}`);
    if (failed) return failed;
    if (pull.status !== 0) return `docker pull ${ref} failed: ${tail(pull.stderr, 3)}`;
    this.images.add(ref);
    return null;
  }

  /**
   * `apt-get install ./deb` in a fresh container of the pinned image, the only
   * step with network access. With `commit`, the installed state becomes an
   * image for the offline checks.
   */
  install(label, commit) {
    const pulled = this.ensureImage(label);
    if (pulled) return { outcome: 'harness-error', diagnostic: pulled };
    const name = this.containerName(label, 'install');
    const base = path.basename(this.deb);
    try {
      const started = this.docker(
        `${label}-container`,
        [
          'run',
          '-d',
          '--rm',
          '--init',
          '--name',
          name,
          '-e',
          'DEBIAN_FRONTEND=noninteractive',
          '-v',
          `${this.deb}:/in/${base}:ro`,
          IMAGES[label].ref,
          'sleep',
          'infinity',
        ],
        5 * MINUTE
      );
      const broken =
        harnessFailure(started, 'docker run') ||
        (started.status !== 0 ? `docker run failed: ${tail(started.stderr, 3)}` : null);
      if (broken) return { outcome: 'harness-error', diagnostic: broken };
      const update = this.docker(
        `${label}-apt-update`,
        ['exec', name, 'apt-get', '-o', 'Acquire::Retries=3', 'update'],
        10 * MINUTE
      );
      const updateBroken = harnessFailure(update, 'apt-get update');
      if (updateBroken || classifyAptUpdate(update) !== 'ok') {
        return {
          outcome: 'harness-error',
          diagnostic:
            updateBroken || `apt-get update failed: ${tail(update.stdout + update.stderr, 4)}`,
        };
      }
      const install = this.docker(
        `${label}-apt-install`,
        [
          'exec',
          '-w',
          '/in',
          name,
          'apt-get',
          '-o',
          'Acquire::Retries=3',
          'install',
          '-y',
          `./${base}`,
        ],
        15 * MINUTE
      );
      const installBroken = harnessFailure(install, 'apt-get install');
      if (installBroken) return { outcome: 'harness-error', diagnostic: installBroken };
      const outcome = classifyAptInstall(install);
      const text = `${install.stdout}\n${install.stderr}`;
      const facts = this.docker(
        `${label}-facts`,
        [
          'exec',
          name,
          'sh',
          '-c',
          '. /etc/os-release; echo "os=$PRETTY_NAME"; echo "glibc=$(getconf GNU_LIBC_VERSION)"; ' +
            "dpkg-query -W -f='pkg=${Package} ${Version} ${db:Status-Abbrev}\\n' " +
            'freedom-browser libc6 libstdc++6 libasound2 libasound2t64 libgbm1 libudev1 2>/dev/null; true',
        ],
        MINUTE
      );
      const result = {
        outcome,
        facts: facts.stdout.trim().split('\n').filter(Boolean),
        refused: outcome === 'refused' ? refusedDepends(text) : [],
        summary: (/^\d+ upgraded, \d+ newly installed.*$/m.exec(install.stdout) || [null])[0],
      };
      if (outcome === 'harness-error') {
        result.diagnostic = `apt-get install failed for a reason other than dependencies: ${tail(text, 4)}`;
      }
      if (outcome === 'installed' && commit) {
        const image = `freedom-pkg-gate:${this.runId}-${label}`;
        const committed = this.docker(`${label}-commit`, ['commit', name, image], 10 * MINUTE);
        const failed =
          harnessFailure(committed, 'docker commit') ||
          (committed.status !== 0 ? `docker commit failed: ${tail(committed.stderr, 3)}` : null);
        if (failed) return { ...result, outcome: 'harness-error', diagnostic: failed };
        this.images.add(image);
        result.image = image;
      }
      return result;
    } finally {
      run('docker', ['rm', '-f', '-v', name], { timeoutMs: 2 * MINUTE });
      this.containers.delete(name);
    }
  }

  /** `docker run --rm --init --network none` of the installed image, with a cleared environment. */
  offline(label, step, image, envVars, command, extra = []) {
    const name = this.containerName(label, step);
    try {
      return this.docker(
        `${label}-${step}`,
        [
          'run',
          '--rm',
          '--init',
          '--network',
          'none',
          '--name',
          name,
          ...extra,
          image,
          '/usr/bin/env',
          '-i',
          `PATH=${CLEAN_PATH}`,
          'HOME=/tmp',
          ...envVars,
          ...command,
        ],
        15 * MINUTE
      );
    } finally {
      run('docker', ['rm', '-f', '-v', name], { timeoutMs: 2 * MINUTE });
      this.containers.delete(name);
    }
  }

  /** The inventory entries the loader and libstdc++ checks cover, with their host-scan records. */
  checkedFiles() {
    const records = new Map(
      ((this.scanReport && this.scanReport.results) || []).map((r) => [
        path.relative(INSTALL_ROOT, r.path),
        r,
      ])
    );
    return this.inventory.files
      .filter(scan.floorApplies)
      .map((entry) => ({ entry, record: records.get(entry.path) || null }));
  }

  loaderCheck(label, image) {
    if (!this.scanReport) {
      return {
        name: 'loader-resolution',
        status: 'harness-error',
        diagnostics: ['the host scan did not run, so the NEEDED lists are unknown'],
      };
    }
    // A file the package lacks is already a scan defect; there is nothing to trace.
    const all = this.checkedFiles();
    const absent = all.filter((f) => !f.record).map((f) => f.entry.path);
    const files = all.filter((f) => f.record);
    const dynamic = files.filter((f) => f.record.dynamic);
    const script =
      'for f in "$@"; do printf "__GATE_FILE %s\\n" "$f"; ' +
      `LD_TRACE_LOADED_OBJECTS=1 ${LOADER} "/${INSTALL_ROOT}/$f" 2>&1; printf "__GATE_EXIT %s\\n" "$?"; done`;
    const result = this.offline(
      label,
      'loader',
      image,
      [],
      ['/bin/bash', '-c', script, 'gate', ...dynamic.map((f) => f.entry.path)]
    );
    const broken = harnessFailure(result, 'loader check');
    if (broken)
      return { name: 'loader-resolution', status: 'harness-error', diagnostics: [broken] };
    const traces = splitMarkedOutput(result.stdout, 'FILE');
    const diagnostics = [];
    const harness = [];
    const details = {};
    for (const { entry, record } of dynamic) {
      const trace = traces.get(entry.path);
      if (!trace) {
        harness.push(`no loader output for ${entry.path}`);
        continue;
      }
      const parsed = parseLoaderTrace(trace.text, record.needed);
      details[entry.path] = parsed;
      if (!parsed.parsed) {
        harness.push(
          `unparseable loader output for ${entry.path} (exit ${trace.exit}): ${tail(trace.text, 2)}`
        );
        continue;
      }
      for (const lib of parsed.notFound)
        diagnostics.push(`/${INSTALL_ROOT}/${entry.path}: ${lib} not found`);
      for (const err of parsed.versionErrors) diagnostics.push(err);
    }
    this.loaderDetails = details;
    const statics = files.filter((f) => !f.record.dynamic).map((f) => f.entry.path);
    return {
      name: 'loader-resolution',
      status: harness.length ? 'harness-error' : diagnostics.length ? 'fail' : 'pass',
      diagnostics: [...harness, ...diagnostics],
      checked: dynamic.length,
      staticNotTraced: statics,
      notInPackage: absent,
    };
  }

  /** GLIBCXX and CXXABI needs against the version definitions of the libstdc++ the loader resolved. */
  libstdcxxCheck(label, image) {
    const wanted = this.checkedFiles().filter(
      (f) => f.record && f.record.dynamic && (f.record.glibcxx.length || f.record.cxxabi.length)
    );
    const diagnostics = [];
    const libs = new Map();
    for (const { entry } of wanted) {
      const trace = this.loaderDetails && this.loaderDetails[entry.path];
      const lib = trace && trace.resolved['libstdc++.so.6'];
      if (!lib || lib === 'not found')
        diagnostics.push(`${entry.path}: libstdc++.so.6 is not resolved`);
      else libs.set(entry.path, lib);
    }
    const unique = [...new Set(libs.values())];
    let provided = new Map();
    if (unique.length > 0) {
      const script =
        'for lib in "$@"; do printf "__GATE_LIB %s\\n" "$lib"; ' +
        `tr '\\000' '\\n' < "$lib" | grep -E '^(GLIBCXX|CXXABI)_[0-9.]+$' | sort -u; printf "__GATE_EXIT %s\\n" "$?"; done`;
      const result = this.offline(
        label,
        'libstdcxx',
        image,
        [],
        ['/bin/bash', '-c', script, 'gate', ...unique]
      );
      const broken = harnessFailure(result, 'libstdc++ check');
      if (broken)
        return { name: 'libstdcxx-versions', status: 'harness-error', diagnostics: [broken] };
      provided = new Map(
        [...splitMarkedOutput(result.stdout, 'LIB')].map(([lib, v]) => [
          lib,
          new Set(v.text.split('\n').filter(Boolean)),
        ])
      );
    }
    for (const { entry, record } of wanted) {
      const lib = libs.get(entry.path);
      if (!lib) continue;
      const have = provided.get(lib) || new Set();
      const needs = [
        ...record.glibcxx.map((v) => `GLIBCXX_${v}`),
        ...record.cxxabi.map((v) => `CXXABI_${v}`),
      ];
      const missing = needs.filter((need) => !have.has(need));
      if (missing.length)
        diagnostics.push(`${entry.path}: ${lib} does not define ${missing.join(', ')}`);
    }
    return {
      name: 'libstdcxx-versions',
      status: diagnostics.length ? 'fail' : 'pass',
      diagnostics,
      checked: wanted.length,
    };
  }

  probe(label, image, prebuildsOnly) {
    const name = prebuildsOnly ? 'probe-prebuilds-only' : 'probe';
    const result = this.offline(
      label,
      name,
      image,
      ['ELECTRON_RUN_AS_NODE=1', ...(prebuildsOnly ? ['PREBUILDS_ONLY=1'] : [])],
      [
        `/${INSTALL_ROOT}/freedom`,
        '/gate/linux-native-probe.js',
        '--inventory',
        '/gate/linux-native-inventory.json',
      ],
      [
        '--user',
        '1000:1000',
        '-v',
        `${this.probePath}:/gate/linux-native-probe.js:ro`,
        '-v',
        `${this.inventoryPath}:/gate/linux-native-inventory.json:ro`,
      ]
    );
    const broken = harnessFailure(result, 'probe');
    if (broken) return { name, status: 'harness-error', diagnostics: [broken] };
    if (result.status === 125 || result.status === 126) {
      return {
        name,
        status: 'harness-error',
        diagnostics: [`docker could not run the probe: ${tail(result.stderr, 3)}`],
      };
    }
    const cannotStart = RUNTIME_START_RE.exec(result.stderr);
    if (cannotStart) {
      return {
        name,
        status: 'fail',
        diagnostics: [
          `the packaged runtime cannot start: ${cannotStart[1]} is not resolved (/${INSTALL_ROOT}/freedom exited ${result.status})`,
        ],
      };
    }
    // The trace above resolves sonames and version needs only; a library that
    // carries the soname but lacks a symbol is caught here, at startup.
    const missingSymbol = RUNTIME_SYMBOL_RE.exec(result.stderr);
    if (missingSymbol) {
      const version = missingSymbol[3] ? ` (${missingSymbol[3]})` : '';
      return {
        name,
        status: 'fail',
        diagnostics: [
          `the packaged runtime cannot start: ${missingSymbol[1]} needs ${missingSymbol[2]}${version}, which no loaded library defines`,
        ],
      };
    }
    let summary;
    try {
      summary = JSON.parse(result.stdout);
    } catch {
      return {
        name,
        status: 'fail',
        diagnostics: [
          `the probe exited ${result.status} without a summary: ${tail(result.stderr, 4)}`,
        ],
      };
    }
    const diagnostics = summary.diagnostic ? [summary.diagnostic] : [];
    for (const t of summary.tests) {
      if (t.status !== 'pass') diagnostics.push(`${t.test} [${t.status}]: ${t.diagnostic}`);
    }
    return { name, status: summary.status, diagnostics, probe: summary };
  }

  scanSection() {
    const section = { name: 'scan', title: 'ELF scan of the unpacked deb', checks: [] };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-pkg-gate-'));
    try {
      const extract = run('dpkg-deb', ['-R', this.deb, path.join(work, 'pkg')], {
        timeoutMs: 10 * MINUTE,
      });
      this.log('scan-extract', extract);
      const broken =
        harnessFailure(extract, 'dpkg-deb -R') ||
        (extract.status !== 0 ? `dpkg-deb -R failed: ${tail(extract.stderr, 3)}` : null);
      if (broken) {
        section.checks.push({ name: 'extract', status: 'harness-error', diagnostics: [broken] });
        return section;
      }
      const depends = scan.readControlDepends(path.join(work, 'pkg', 'DEBIAN', 'control'));
      this.depends = depends;
      const report = scan.scanPackage({
        root: path.join(work, 'pkg'),
        prefix: INSTALL_ROOT,
        inventory: this.inventory,
        depends,
      });
      this.scanReport = report;
      fs.writeFileSync(path.join(this.outDir, 'scan.json'), `${JSON.stringify(report, null, 1)}\n`);
      const toolErrors = report.errors.filter((e) => e.kind === 'tool');
      const fileErrors = report.errors.filter((e) => e.kind !== 'tool');
      const of = (kinds) => report.failures.filter((f) => kinds.includes(f.kind));
      const check = (name, failures, extra = {}) => ({
        name,
        status: failures.length ? 'fail' : 'pass',
        diagnostics: failures.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)),
        ...extra,
      });
      section.checks.push({
        name: 'inspection',
        status: toolErrors.length ? 'harness-error' : fileErrors.length ? 'fail' : 'pass',
        diagnostics: report.errors.map((e) => `${e.path}: ${e.error}`),
        elfFiles: report.results.length,
      });
      section.checks.push(check('inventory', of(['missing', 'extra', 'digest', 'class'])));
      section.checks.push(check('asar-and-symlinks', of(['asar', 'symlink'])));
      section.checks.push(
        check('glibc-floor', of(['floor']), {
          declaredFloor: report.declaredFloor,
          inventoryFloor: report.inventoryFloor,
          checkedAgainst: report.floor,
        })
      );
      return section;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  runtimeSection(label) {
    const section = {
      name: label,
      title: `install, loader resolution and probes on ${IMAGES[label].tag}`,
      image: IMAGES[label],
      checks: [],
    };
    const installed = this.install(label, true);
    section.facts = installed.facts;
    const installCheck = {
      name: 'apt-install',
      status:
        installed.outcome === 'installed' && installed.image
          ? 'pass'
          : installed.outcome === 'refused'
            ? 'fail'
            : 'harness-error',
      diagnostics:
        installed.outcome === 'refused'
          ? installed.refused.map((d) => `apt refused the package: Depends: ${d}`)
          : installed.diagnostic
            ? [installed.diagnostic]
            : [],
      summary: installed.summary,
    };
    section.checks.push(installCheck);
    const later = ['loader-resolution', 'libstdcxx-versions', 'probe', 'probe-prebuilds-only'];
    if (installCheck.status !== 'pass') {
      for (const name of later) {
        section.checks.push({
          name,
          status: 'not-run',
          diagnostics: [`apt-install ${installCheck.status}`],
        });
      }
      return section;
    }
    const loader = this.loaderCheck(label, installed.image);
    section.checks.push(loader);
    // The libstdc++ check reads the library each file resolved to from the loader traces.
    section.checks.push(
      loader.status === 'harness-error'
        ? {
            name: 'libstdcxx-versions',
            status: 'not-run',
            diagnostics: ['loader-resolution harness-error'],
          }
        : this.libstdcxxCheck(label, installed.image)
    );
    section.checks.push(this.probe(label, installed.image, false));
    section.checks.push(this.probe(label, installed.image, true));
    return section;
  }

  refusalSection(label) {
    const floor = this.inventory.glibcFloor;
    const section = {
      name: label,
      title: `apt refuses the deb on ${IMAGES[label].tag}`,
      image: IMAGES[label],
      checks: [],
    };
    const installed = this.install(label, false);
    section.facts = installed.facts;
    const wanted = `libc6 (>= ${floor})`;
    let check;
    if (installed.outcome === 'harness-error') {
      check = { status: 'harness-error', diagnostics: [installed.diagnostic] };
    } else if (installed.outcome === 'installed') {
      const fact = (installed.facts || []).find((f) => f.startsWith('glibc='));
      const glibc = fact ? fact.slice('glibc='.length) : 'glibc unknown';
      check = {
        status: 'fail',
        diagnostics: [
          `apt accepted the package on ${IMAGES[label].tag} (${glibc}); it must refuse it, citing ${wanted}`,
        ],
      };
    } else if (installed.refused.some((d) => d.startsWith(wanted))) {
      check = {
        status: 'pass',
        diagnostics: installed.refused.map((d) => `apt refused: Depends: ${d}`),
      };
    } else {
      check = {
        status: 'fail',
        diagnostics: [
          `apt refused the package without citing ${wanted}: ${installed.refused.join('; ')}`,
        ],
      };
    }
    section.checks.push({ name: 'apt-refusal', ...check });
    return section;
  }

  cleanup() {
    for (const name of this.containers)
      run('docker', ['rm', '-f', '-v', name], { timeoutMs: 2 * MINUTE });
    // Committed images first: they were made from the pulled base images.
    for (const image of [...this.images].reverse()) {
      run('docker', ['rmi', image], { timeoutMs: 2 * MINUTE });
    }
  }

  run() {
    fs.mkdirSync(this.outDir, { recursive: true });
    const summary = {
      gate: 'linux-packaging-gate',
      startedAt: new Date().toISOString(),
      deb: {
        path: this.deb,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(this.deb)).digest('hex'),
      },
      inventorySha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(this.inventoryPath))
        .digest('hex'),
      glibcFloor: this.inventory.glibcFloor,
      images: IMAGES,
      sections: [],
    };
    const guarded = (name, fn) => {
      try {
        return fn();
      } catch (err) {
        return {
          name,
          checks: [
            { name: 'internal', status: 'harness-error', diagnostics: [err.stack || String(err)] },
          ],
        };
      }
    };
    try {
      summary.sections.push(guarded('scan', () => this.scanSection()));
      summary.deb.depends = this.depends || null;
      for (const label of RUNTIME_IMAGES)
        summary.sections.push(guarded(label, () => this.runtimeSection(label)));
      summary.sections.push(guarded(REFUSAL_IMAGE, () => this.refusalSection(REFUSAL_IMAGE)));
    } finally {
      this.cleanup();
    }
    return finish(summary, this.outDir);
  }
}

/** Fold check statuses into section statuses and the verdict, and write the summary. */
function finish(summary, outDir) {
  summary.defects = [];
  summary.harnessErrors = [];
  for (const section of summary.sections) {
    const statuses = section.checks.map((c) => c.status);
    section.status = statuses.includes('harness-error')
      ? 'harness-error'
      : statuses.some((s) => s === 'fail' || s === 'not-run')
        ? 'fail'
        : 'pass';
    for (const c of section.checks) {
      const into =
        c.status === 'harness-error'
          ? summary.harnessErrors
          : c.status === 'fail'
            ? summary.defects
            : null;
      if (into) for (const d of c.diagnostics) into.push(`${section.name}/${c.name}: ${d}`);
    }
  }
  summary.verdict = summary.harnessErrors.length
    ? 'harness-error'
    : summary.defects.length
      ? 'fail'
      : 'pass';
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  return summary;
}

function report(summary) {
  const lines = [];
  for (const section of summary.sections) {
    lines.push(`${section.name}: ${section.status}`);
    for (const c of section.checks) {
      lines.push(`  ${c.name}: ${c.status}`);
      for (const d of c.diagnostics || []) lines.push(`    ${d}`);
    }
  }
  lines.push(`verdict: ${summary.verdict}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || !fs.existsSync(argv[0])) {
    console.error('Usage: node scripts/linux-packaging-gate.js <freedom-browser.deb> <out-dir>');
    return 3;
  }
  let gate;
  try {
    gate = new Gate(argv[0], argv[1]);
  } catch (err) {
    console.error(err.message);
    return 3;
  }
  const stop = () => {
    gate.cleanup();
    process.exit(3);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const summary = gate.run();
  console.log(report(summary));
  return { pass: 0, fail: 1, 'harness-error': 3 }[summary.verdict];
}

if (require.main === module) process.exitCode = main();

module.exports = {
  IMAGES,
  classifyAptUpdate,
  classifyAptInstall,
  refusedDepends,
  splitMarkedOutput,
  parseLoaderTrace,
  RUNTIME_START_RE,
  RUNTIME_SYMBOL_RE,
  finish,
  report,
};
