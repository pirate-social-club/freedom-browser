#!/usr/bin/env node

// The Linux packaging gate: a built deb against its dependency contract, on
// the host and in clean, digest-pinned distribution images.
//
// The 2f7920f3 evaluation deb installed with apt on Debian 12, Ubuntu 24.04 and
// Debian 13 and then could not start on any of them, because `freedom` links
// libasound.so.2 and libgbm.so.1 and the deb declared neither; on Debian 12 its
// IPFS and usb addons also needed a newer glibc than the declared floor. This
// installs the package the way apt would and checks what the loader and the
// packaged runtime actually do, in four sections that each run and report on
// their own, whatever an earlier one found:
//
//   scan          the ELF scan of the unpacked deb against the inventory and
//                 the deb's own declared libc6 floor (scripts/linux-native-scan.js);
//   ubuntu-24.04  `apt-get install --no-install-recommends ./deb` on the floor
//                 image, the only step with network access; then, with
//                 --network none and an environment cleared to PATH and HOME:
//                 the distribution loader's resolution of every NEEDED entry of
//                 every supported file (in trace mode, which runs no code from
//                 the file), the GLIBCXX and CXXABI needs against that image's
//                 libstdc++, and the packaged-runtime probe
//                 (scripts/linux-native-probe.js), once plain and once with
//                 PREBUILDS_ONLY=1;
//   debian-13     the same on Debian 13;
//   debian-12     apt must refuse the deb, citing `libc6 (>= <floor>)`.
//
// Recommends are not installed, so a runtime image holds the base image, the
// deb and its declared Depends closure, nothing else: a library the deb fails
// to declare shows up as unresolved instead of arriving through somebody's
// Recommends. The summary lists exactly the packages apt added. Every
// container reports its /etc/os-release ID, VERSION_ID and glibc version, and a
// container that is not the expected distribution is a harness error.
//
// Defects and harness errors are reported separately; blocked checks report
// `not-run` with the cause. The summary is written to
// <out>/summary.json; the exit status is 0 when everything passes, 1 when
// defects and no harness errors were found, and 3 on any harness error. The
// whole run has a time budget (35 minutes by default), and every step's
// timeout is cut to what is left of it, so the summary is written before a CI
// job timeout fires.
//
// Containers use `--rm --init` and a bounded lifetime; owned images are removed.
//
// Usage: node scripts/linux-packaging-gate.js [--budget-minutes 35] <deb> <out-dir>

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scan = require('./linux-native-scan');
const { inspectLinuxPermissions } = require('./linux-package-permissions');

// Pinned by manifest-list digest, as recorded by the 2026-10-21 runtime
// qualification (`docker image inspect --format '{{.RepoDigests}}'`), with the
// identity each container must report.
const IMAGES = {
  'ubuntu-24.04': {
    tag: 'ubuntu:24.04',
    ref: 'ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac',
    id: 'ubuntu',
    versionId: '24.04',
    glibc: '2.39',
  },
  'debian-13': {
    tag: 'debian:13',
    ref: 'debian@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308',
    id: 'debian',
    versionId: '13',
    glibc: '2.41',
  },
  'debian-12': {
    tag: 'debian:12',
    ref: 'debian@sha256:854dd8ab51d62866dbd8f5431d15ce77b12983a2a4a1e1fe43a2395dc7ef9f61',
    id: 'debian',
    versionId: '12',
    glibc: '2.36',
  },
};
const RUNTIME_IMAGES = ['ubuntu-24.04', 'debian-13'];
const REFUSAL_IMAGE = 'debian-12';
const INSTALL_ROOT = 'opt/Freedom';
const CLEAN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const LOADER = '/lib64/ld-linux-x86-64.so.2';
const MINUTE = 60 * 1000;
const BUDGET_MINUTES = 35;
// Per-step ceilings; each is also cut to what is left of the run's budget.
const STEP = {
  inspect: MINUTE,
  pull: 5 * MINUTE,
  start: 2 * MINUTE,
  exec: 2 * MINUTE,
  update: 5 * MINUTE,
  install: 10 * MINUTE,
  commit: 5 * MINUTE,
  offline: 8 * MINUTE,
};
// Below this much budget a step is not started at all.
const MIN_STEP_MS = 5000;

const ID_SCRIPT =
  'if [ -r /etc/os-release ]; then . /etc/os-release; fi; ' +
  'printf "__GATE_ID %s %s %s\\n" "${ID:-unknown}" "${VERSION_ID:-unknown}" ' +
  '"$(getconf GNU_LIBC_VERSION 2>/dev/null | cut -d" " -f2)"';
const PACKAGES_FORMAT = '${Package}\\t${Version}\\t${db:Status-Abbrev}\\n';

const APT_NETWORK_RE =
  /Temporary failure resolving|Could not resolve|Failed to fetch|Unable to fetch some archives|Could not connect to|Connection timed out|Connection failed|Some index files failed to download|Hash Sum mismatch|Network is unreachable/;
const APT_REFUSAL_RE =
  /unmet dependencies|Unable to correct problems|but it is not installable|but [^\n]+ is to be installed/;
// Only freedom-browser's own script, or unpacking its own archive, counts.
// dpkg also prints "error processing package freedom-browser" when a
// dependency's script failed and left it unconfigured ("dependency problems -
// leaving unconfigured"); that is the image's failure, not the package's.
const APT_SCRIPT_RE =
  /dpkg: error processing archive [^\n]*freedom-browser[^\n]*\.deb|freedom-browser package (?:pre|post)-(?:installation|removal) script subprocess returned error/;
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

/** Why an invocation failed as a harness problem, or null when it ran. */
function harnessFailure(result, what) {
  if (result.budgetExhausted) return `${what} not started: the gate's time budget is spent`;
  if (result.timedOut) return `${what} timed out`;
  if (result.error) return `${what} could not run: ${result.error}`;
  return null;
}

/** As harnessFailure, and a non-zero exit is a harness problem too. */
function harnessOrStatus(result, what) {
  return (
    harnessFailure(result, what) ||
    (result.status !== 0 ? `${what} exited ${result.status}: ${tail(result.stderr, 3)}` : null)
  );
}

function tail(text, lines = 12) {
  return String(text).trim().split('\n').slice(-lines).join('\n');
}

/** A check's result, its status derived from what it found. */
function check(name, { defects = [], harnessErrors = [], ...extra } = {}) {
  const status = harnessErrors.length ? 'harness-error' : defects.length ? 'fail' : 'pass';
  return { name, status, defects, harnessErrors, ...extra };
}

function notRun(name, cause) {
  return { name, status: 'not-run', defects: [], harnessErrors: [], cause };
}

/**
 * Take the `__GATE_ID <ID> <VERSION_ID> <glibc>` line off a container's output.
 * @returns {{identity: {id: string, versionId: string, glibc: string} | null, rest: string}}
 */
function parseIdentity(stdout) {
  const lines = String(stdout).split('\n');
  const at = lines.findIndex((line) => line.startsWith('__GATE_ID '));
  if (at < 0) return { identity: null, rest: String(stdout) };
  const [id, versionId, glibc] = lines[at].slice('__GATE_ID '.length).split(' ');
  lines.splice(at, 1);
  return { identity: { id, versionId, glibc: glibc || '' }, rest: lines.join('\n') };
}

/** Why a container is not the image a section expects, or null when it is. */
function identityProblem(label, identity) {
  const want = IMAGES[label];
  if (!identity) return `the ${want.tag} container did not report its identity`;
  const got = `${identity.id} ${identity.versionId}, glibc ${identity.glibc}`;
  if (
    identity.id !== want.id ||
    identity.versionId !== want.versionId ||
    identity.glibc !== want.glibc
  ) {
    return `expected ${want.id} ${want.versionId}, glibc ${want.glibc}, but the container is ${got}`;
  }
  return null;
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
 * satisfy is a refusal; the package's own maintainer script failing is a
 * defect; a download that failed, or any other failure, is the harness's.
 * @returns {'installed' | 'refused' | 'script-failed' | 'harness-error'}
 */
function classifyAptInstall(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) return 'installed';
  if (APT_SCRIPT_RE.test(text)) return 'script-failed';
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

/** The dpkg lines of a failed maintainer script. */
function scriptFailureLines(text) {
  return String(text)
    .split('\n')
    .filter((line) => /dpkg: error|script subprocess returned|Errors were encountered/.test(line))
    .map((line) => line.trim());
}

/** Installed packages from `dpkg-query -W -f '${Package}\t${Version}\t${db:Status-Abbrev}\n'`. */
function parsePackages(text) {
  const packages = new Map();
  for (const line of String(text).split('\n')) {
    const [name, version, status] = line.split('\t');
    if (name && status && status.startsWith('ii')) packages.set(name, version);
  }
  return packages;
}

/** What an install changed: packages added, upgraded and removed. */
function diffPackages(before, after) {
  const added = [];
  const upgraded = [];
  const removed = [];
  for (const [name, version] of after) {
    if (!before.has(name)) added.push(`${name} ${version}`);
    else if (before.get(name) !== version)
      upgraded.push(`${name} ${before.get(name)} -> ${version}`);
  }
  for (const [name, version] of before) if (!after.has(name)) removed.push(`${name} ${version}`);
  return { added: added.sort(), upgraded: upgraded.sort(), removed: removed.sort() };
}

/**
 * Split marked container output (`__GATE_<MARKER> <name>`, its output, then
 * `__GATE_EXIT <status>`) per name.
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
 * unparseable. A missing WEAK version need (`weak version ... not found`) is
 * recorded apart: the loader accepts it, as the scanner does.
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
  const missingVersions = [
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
    versionErrors: missingVersions.filter((line) => !/: weak version `/.test(line)),
    weakVersionsNotFound: missingVersions.filter((line) => /: weak version `/.test(line)),
  };
}

class Gate {
  /**
   * @param {string} deb
   * @param {string} outDir
   * @param {{run?: typeof run, now?: () => number, budgetMinutes?: number}} [options]
   *   `run` and `now` are injected by the tests.
   */
  constructor(deb, outDir, options = {}) {
    this.deb = path.resolve(deb);
    this.outDir = path.resolve(outDir);
    this.logDir = path.join(this.outDir, 'logs');
    this.runner = options.run || run;
    this.now = options.now || Date.now;
    this.deadline = this.now() + (options.budgetMinutes || BUDGET_MINUTES) * MINUTE;
    this.runId = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    this.containers = new Set();
    this.images = new Set();
    this.inventoryPath = path.join(__dirname, 'linux-native-inventory.json');
    this.probePath = path.join(__dirname, 'linux-native-probe.js');
    this.inventory = scan.loadInventory(this.inventoryPath);
    this.scanReport = null;
    this.loaderDetails = {};
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

  /** Run one step within what is left of the budget, and log it when named. */
  exec(logName, bin, args, stepMs) {
    const remaining = this.deadline - this.now();
    const result =
      remaining < MIN_STEP_MS
        ? {
            argv: [bin, ...args],
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: true,
            budgetExhausted: true,
            error: null,
          }
        : this.runner(bin, args, { timeoutMs: Math.min(stepMs, remaining) });
    if (logName) this.log(logName, result);
    return result;
  }

  docker(logName, args, stepMs) {
    return this.exec(logName, 'docker', args, stepMs);
  }

  /** Remove a container whatever the budget says. */
  remove(name) {
    this.runner('docker', ['rm', '-f', '-v', name], { timeoutMs: MINUTE });
    this.containers.delete(name);
  }

  containerName(label, step) {
    const name = `freedom-pkg-gate-${this.runId}-${label}-${step}`;
    this.containers.add(name);
    return name;
  }

  /** Make the pinned base image available; returns a harness diagnostic or null. */
  ensureImage(label) {
    const { ref } = IMAGES[label];
    const present = this.docker(null, ['image', 'inspect', ref], STEP.inspect);
    const broken = harnessFailure(present, 'docker image inspect');
    if (broken) return broken;
    if (present.status === 0) return null;
    const pull = this.docker(`${label}-pull`, ['pull', ref], STEP.pull);
    const failed = harnessOrStatus(pull, `docker pull ${ref}`);
    if (failed) return failed;
    this.images.add(ref);
    return null;
  }

  packages(label, name, step) {
    const result = this.docker(
      `${label}-${step}`,
      ['exec', name, 'dpkg-query', '-W', '-f', PACKAGES_FORMAT],
      STEP.exec
    );
    const broken = harnessOrStatus(result, 'dpkg-query');
    return broken ? { error: broken } : { packages: parsePackages(result.stdout) };
  }

  /**
   * `apt-get install --no-install-recommends ./deb` in a fresh container of the
   * pinned image, the only step with network access. With `commit`, the
   * installed state becomes an image for the offline checks.
   */
  install(label, commit) {
    const pulled = this.ensureImage(label);
    if (pulled) return { outcome: 'harness-error', diagnostic: pulled };
    const name = this.containerName(label, 'install');
    const base = path.basename(this.deb);
    const harness = (diagnostic, extra = {}) => ({
      outcome: 'harness-error',
      diagnostic,
      ...extra,
    });
    try {
      // Bounded, so the container exits even if this process is killed.
      const lifetime = Math.max(60, Math.ceil((this.deadline - this.now()) / 1000));
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
          String(lifetime),
        ],
        STEP.start
      );
      const notStarted = harnessOrStatus(started, 'docker run');
      if (notStarted) return harness(notStarted);
      const id = this.docker(`${label}-identity`, ['exec', name, 'sh', '-c', ID_SCRIPT], STEP.exec);
      const { identity } = parseIdentity(id.stdout);
      const wrongImage =
        harnessOrStatus(id, 'the identity check') || identityProblem(label, identity);
      if (wrongImage) return harness(wrongImage, { identity });
      const before = this.packages(label, name, 'dpkg-before');
      if (before.error) return harness(before.error, { identity });
      const update = this.docker(
        `${label}-apt-update`,
        ['exec', name, 'apt-get', '-o', 'Acquire::Retries=3', 'update'],
        STEP.update
      );
      const updateBroken = harnessFailure(update, 'apt-get update');
      if (updateBroken || classifyAptUpdate(update) !== 'ok') {
        const why =
          updateBroken || `apt-get update failed: ${tail(update.stdout + update.stderr, 4)}`;
        return harness(why, { identity });
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
          '--no-install-recommends',
          `./${base}`,
        ],
        STEP.install
      );
      const installBroken = harnessFailure(install, 'apt-get install');
      if (installBroken) return harness(installBroken, { identity });
      const outcome = classifyAptInstall(install);
      const text = `${install.stdout}\n${install.stderr}`;
      const result = {
        outcome,
        identity,
        refused: outcome === 'refused' ? refusedDepends(text) : [],
        summary: (/^\d+ upgraded, \d+ newly installed.*$/m.exec(install.stdout) || [null])[0],
      };
      if (outcome === 'script-failed') {
        result.scriptFailure = scriptFailureLines(text);
        result.output = tail(text, 40);
      }
      if (outcome === 'harness-error') {
        result.diagnostic = `apt-get install failed for a reason other than the package: ${tail(text, 4)}`;
      }
      if (outcome === 'installed' || outcome === 'script-failed') {
        const after = this.packages(label, name, 'dpkg-after');
        if (after.error) return harness(after.error, result);
        result.installed = diffPackages(before.packages, after.packages);
      }
      if (outcome === 'installed' && commit) {
        const image = `freedom-pkg-gate:${this.runId}-${label}`;
        const committed = this.docker(`${label}-commit`, ['commit', name, image], STEP.commit);
        const failed = harnessOrStatus(committed, 'docker commit');
        if (failed) return { ...result, outcome: 'harness-error', diagnostic: failed };
        this.images.add(image);
        result.image = image;
      }
      return result;
    } finally {
      this.remove(name);
    }
  }

  /**
   * `docker run --rm --init --network none` of the installed image. The
   * container first reports its identity, then runs the command with an
   * environment cleared to PATH, HOME and `envVars`.
   */
  offline(label, step, image, envVars, command, extra = []) {
    const name = this.containerName(label, step);
    try {
      const result = this.docker(
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
          '/bin/sh',
          '-c',
          `${ID_SCRIPT}; exec /usr/bin/env -i PATH=${CLEAN_PATH} HOME=/tmp "$@"`,
          'gate',
          ...envVars,
          ...command,
        ],
        STEP.offline
      );
      const { identity, rest } = parseIdentity(result.stdout);
      return { ...result, stdout: rest, identity };
    } finally {
      this.remove(name);
    }
  }

  /** Why an offline run says nothing about the package, or null when it ran as intended. */
  offlineProblem(label, result, what) {
    return (
      harnessFailure(result, what) ||
      (result.status === 125 || result.status === 126
        ? `docker could not run ${what}: ${tail(result.stderr, 3)}`
        : null) ||
      identityProblem(label, result.identity)
    );
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
    const name = 'loader-resolution';
    if (!this.scanReport) {
      return check(name, {
        harnessErrors: ['the host scan did not run, so the NEEDED lists are unknown'],
      });
    }
    // A file the package lacks is already a scan defect; there is nothing to trace.
    const all = this.checkedFiles();
    const files = all.filter((f) => f.record);
    const dynamic = files.filter((f) => f.record.dynamic);
    const extra = {
      checked: dynamic.length,
      staticNotTraced: files.filter((f) => !f.record.dynamic).map((f) => f.entry.path),
      notInPackage: all.filter((f) => !f.record).map((f) => f.entry.path),
    };
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
    const broken =
      this.offlineProblem(label, result, 'the loader check') ||
      (result.status !== 0 ? `the loader check exited ${result.status}` : null);
    if (broken) return check(name, { harnessErrors: [broken], ...extra });
    const traces = splitMarkedOutput(result.stdout, 'FILE');
    const defects = [];
    const harnessErrors = [];
    const weak = [];
    for (const { entry, record } of dynamic) {
      const trace = traces.get(entry.path);
      if (!trace) {
        harnessErrors.push(`no loader output for ${entry.path}`);
        continue;
      }
      const parsed = parseLoaderTrace(trace.text, record.needed);
      if (!parsed.parsed) {
        harnessErrors.push(
          `unparseable loader output for ${entry.path} (exit ${trace.exit}): ${tail(trace.text, 2)}`
        );
        continue;
      }
      this.loaderDetails[entry.path] = parsed;
      for (const lib of parsed.notFound)
        defects.push(`/${INSTALL_ROOT}/${entry.path}: ${lib} not found`);
      defects.push(...parsed.versionErrors);
      weak.push(...parsed.weakVersionsNotFound);
    }
    return check(name, { defects, harnessErrors, ...extra, weakVersionsNotFound: weak });
  }

  /** GLIBCXX and CXXABI needs against the version definitions of the libstdc++ the loader resolved. */
  libstdcxxCheck(label, image) {
    const name = 'libstdcxx-versions';
    const wanted = this.checkedFiles().filter(
      (f) => f.record && f.record.dynamic && (f.record.glibcxx.length || f.record.cxxabi.length)
    );
    const defects = [];
    const harnessErrors = [];
    const libs = new Map();
    for (const { entry } of wanted) {
      const trace = this.loaderDetails[entry.path];
      const lib = trace && trace.resolved['libstdc++.so.6'];
      if (!trace) harnessErrors.push(`${entry.path}: no loader trace to find its libstdc++.so.6`);
      else if (!lib || lib === 'not found')
        defects.push(`${entry.path}: libstdc++.so.6 is not resolved`);
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
      const broken =
        this.offlineProblem(label, result, 'the libstdc++ check') ||
        (result.status !== 0 ? `the libstdc++ check exited ${result.status}` : null);
      if (broken) {
        return check(name, {
          defects,
          harnessErrors: [...harnessErrors, broken],
          checked: wanted.length,
        });
      }
      provided = new Map(
        [...splitMarkedOutput(result.stdout, 'LIB')].map(([lib, v]) => [
          lib,
          new Set(v.text.split('\n').filter(Boolean)),
        ])
      );
      for (const lib of unique) {
        if (!(provided.get(lib) || new Set()).size) {
          harnessErrors.push(`could not read the version definitions of ${lib}`);
        }
      }
    }
    for (const { entry, record } of wanted) {
      const lib = libs.get(entry.path);
      const have = lib && provided.get(lib);
      if (!have || have.size === 0) continue;
      const needs = [
        ...record.glibcxx.map((v) => `GLIBCXX_${v}`),
        ...record.cxxabi.map((v) => `CXXABI_${v}`),
      ];
      const missing = needs.filter((need) => !have.has(need));
      if (missing.length)
        defects.push(`${entry.path}: ${lib} does not define ${missing.join(', ')}`);
    }
    return check(name, { defects, harnessErrors, checked: wanted.length });
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
    const broken = this.offlineProblem(label, result, 'the probe');
    if (broken) return check(name, { harnessErrors: [broken] });
    let summary = null;
    try {
      summary = JSON.parse(result.stdout);
    } catch {
      // Judged below.
    }
    if (!summary) {
      // Only the dynamic loader naming the cause makes a missing summary the
      // package's fault: the runtime itself could not start.
      const start = RUNTIME_START_RE.exec(result.stderr);
      if (start) {
        return check(name, {
          defects: [
            `the packaged runtime cannot start: ${start[1]} is not resolved (/${INSTALL_ROOT}/freedom exited ${result.status})`,
          ],
        });
      }
      const symbol = RUNTIME_SYMBOL_RE.exec(result.stderr);
      if (symbol) {
        const version = symbol[3] ? ` (${symbol[3]})` : '';
        return check(name, {
          defects: [
            `the packaged runtime cannot start: ${symbol[1]} needs ${symbol[2]}${version}, which no loaded library defines`,
          ],
        });
      }
      const how = result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`;
      return check(name, {
        harnessErrors: [`the probe ${how} without a summary: ${tail(result.stderr, 4)}`],
      });
    }
    const defects = [];
    const harnessErrors = [];
    if (summary.diagnostic) {
      (summary.status === 'fail' ? defects : harnessErrors).push(summary.diagnostic);
    }
    for (const t of summary.tests || []) {
      if (t.status === 'fail') defects.push(`${t.test}: ${t.diagnostic}`);
      else if (t.status !== 'pass') harnessErrors.push(`${t.test} [${t.status}]: ${t.diagnostic}`);
    }
    if (!['pass', 'fail', 'harness-error'].includes(summary.status)) {
      harnessErrors.push(`the probe reported an unknown status ${summary.status}`);
    }
    return check(name, { defects, harnessErrors, probe: summary });
  }

  scanSection() {
    const section = { name: 'scan', title: 'ELF scan of the unpacked deb', checks: [] };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-pkg-gate-'));
    try {
      const extract = this.exec(
        'scan-extract',
        'dpkg-deb',
        ['-R', this.deb, path.join(work, 'pkg')],
        10 * MINUTE
      );
      const broken = harnessOrStatus(extract, 'dpkg-deb -R');
      if (broken) {
        section.checks.push(check('extract', { harnessErrors: [broken] }));
        return section;
      }
      const depends = scan.readControlDepends(path.join(work, 'pkg', 'DEBIAN', 'control'));
      section.checks.push(check('permissions', {
        defects: inspectLinuxPermissions(path.join(work, 'pkg')),
      }));
      this.depends = depends;
      const report = scan.scanPackage({
        root: path.join(work, 'pkg'),
        prefix: INSTALL_ROOT,
        inventory: this.inventory,
        depends,
      });
      this.scanReport = report;
      fs.writeFileSync(path.join(this.outDir, 'scan.json'), `${JSON.stringify(report, null, 1)}\n`);
      const messages = (kinds) =>
        report.failures
          .filter((f) => kinds.includes(f.kind))
          .map((f) => (f.path ? `${f.path}: ${f.message}` : f.message));
      const describe = (e) => `${e.path}: ${e.error}`;
      section.checks.push(
        check('inspection', {
          defects: report.errors.filter((e) => e.kind !== 'tool').map(describe),
          harnessErrors: report.errors.filter((e) => e.kind === 'tool').map(describe),
          elfFiles: report.results.length,
        })
      );
      section.checks.push(
        check('inventory', { defects: messages(['missing', 'extra', 'digest', 'class']) })
      );
      section.checks.push(
        check('interpreter', { defects: messages(['interp']), interpreters: report.interpreters })
      );
      section.checks.push(check('asar-and-symlinks', { defects: messages(['asar', 'symlink']) }));
      section.checks.push(
        check('glibc-floor', {
          defects: messages(['floor']),
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

  installCheck(installed) {
    const extra = {
      summary: installed.summary || null,
      installedPackages: installed.installed || null,
    };
    switch (installed.outcome) {
      case 'installed':
        return check('apt-install', extra);
      case 'refused':
        return check('apt-install', {
          defects: installed.refused.map((d) => `apt refused the package: Depends: ${d}`),
          ...extra,
        });
      case 'script-failed':
        return check('apt-install', {
          defects: [
            `the freedom-browser maintainer script failed: ${installed.scriptFailure.join(' | ')}`,
          ],
          output: installed.output,
          ...extra,
        });
      default:
        return check('apt-install', { harnessErrors: [installed.diagnostic], ...extra });
    }
  }

  runtimeSection(label) {
    const section = {
      name: label,
      title: `install, loader resolution and probes on ${IMAGES[label].tag}`,
      image: IMAGES[label],
      checks: [],
    };
    this.loaderDetails = {};
    const installed = this.install(label, true);
    section.identity = installed.identity || null;
    const installCheck = this.installCheck(installed);
    section.checks.push(installCheck);
    const later = ['loader-resolution', 'libstdcxx-versions', 'probe', 'probe-prebuilds-only'];
    if (installCheck.status !== 'pass') {
      for (const name of later)
        section.checks.push(notRun(name, `apt-install ${installCheck.status}`));
      return section;
    }
    const loader = this.loaderCheck(label, installed.image);
    section.checks.push(loader);
    // The libstdc++ check reads the library each file resolved to from the loader traces.
    section.checks.push(
      Object.keys(this.loaderDetails).length === 0 && loader.status === 'harness-error'
        ? notRun('libstdcxx-versions', 'loader-resolution harness-error')
        : this.libstdcxxCheck(label, installed.image)
    );
    section.checks.push(this.probe(label, installed.image, false));
    section.checks.push(this.probe(label, installed.image, true));
    return section;
  }

  refusalSection(label) {
    const wanted = `libc6 (>= ${this.inventory.glibcFloor})`;
    const section = {
      name: label,
      title: `apt refuses the deb on ${IMAGES[label].tag}`,
      image: IMAGES[label],
      checks: [],
    };
    const installed = this.install(label, false);
    section.identity = installed.identity || null;
    const extra = { installedPackages: installed.installed || null };
    let result;
    if (installed.outcome === 'harness-error') {
      result = { harnessErrors: [installed.diagnostic] };
    } else if (installed.outcome === 'installed' || installed.outcome === 'script-failed') {
      const glibc = installed.identity ? `glibc ${installed.identity.glibc}` : 'glibc unknown';
      result = {
        defects: [
          `apt accepted the package on ${IMAGES[label].tag} (${glibc}); it must refuse it, citing ${wanted}`,
        ],
      };
    } else if (installed.refused.some((d) => d.startsWith(wanted))) {
      result = { refused: installed.refused };
    } else {
      result = {
        defects: [
          `apt refused the package without citing ${wanted}: ${installed.refused.join('; ')}`,
        ],
      };
    }
    section.checks.push(check('apt-refusal', { ...result, ...extra }));
    return section;
  }

  cleanup() {
    for (const name of [...this.containers]) this.remove(name);
    // Committed images first: they were made from the pulled base images.
    for (const image of [...this.images].reverse()) {
      this.runner('docker', ['rmi', image], { timeoutMs: MINUTE });
    }
    this.images.clear();
  }

  run() {
    fs.mkdirSync(this.outDir, { recursive: true });
    const summary = {
      gate: 'linux-packaging-gate',
      startedAt: new Date(this.now()).toISOString(),
      budgetEndsAt: new Date(this.deadline).toISOString(),
      deb: { path: this.deb },
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
        return { name, checks: [check('internal', { harnessErrors: [err.stack || String(err)] })] };
      }
    };
    try {
      summary.sections.push(
        guarded('setup', () => {
          summary.deb.sha256 = crypto
            .createHash('sha256')
            .update(fs.readFileSync(this.deb))
            .digest('hex');
          return { name: 'setup', checks: [check('read-deb')] };
        })
      );
      summary.sections.push(guarded('scan', () => this.scanSection()));
      summary.deb.depends = this.depends || null;
      for (const label of RUNTIME_IMAGES) {
        summary.sections.push(guarded(label, () => this.runtimeSection(label)));
      }
      summary.sections.push(guarded(REFUSAL_IMAGE, () => this.refusalSection(REFUSAL_IMAGE)));
    } finally {
      this.cleanup();
    }
    return finish(summary, this.outDir, this.now);
  }
}

/**
 * Fold the checks into section statuses and the verdict, and write the
 * summary. Defects and harness errors are collected from every check, each
 * into its own list, whatever the check's own status.
 */
function finish(summary, outDir, now = Date.now) {
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
      for (const d of c.defects || []) summary.defects.push(`${section.name}/${c.name}: ${d}`);
      for (const d of c.harnessErrors || []) {
        summary.harnessErrors.push(`${section.name}/${c.name}: ${d}`);
      }
    }
  }
  summary.verdict = summary.harnessErrors.length
    ? 'harness-error'
    : summary.defects.length
      ? 'fail'
      : 'pass';
  summary.finishedAt = new Date(now()).toISOString();
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  return summary;
}

function report(summary) {
  const lines = [];
  for (const section of summary.sections) {
    lines.push(`${section.name}: ${section.status}`);
    for (const c of section.checks) {
      lines.push(`  ${c.name}: ${c.status}${c.cause ? ` (${c.cause})` : ''}`);
      for (const d of c.defects || []) lines.push(`    DEFECT ${d}`);
      for (const d of c.harnessErrors || []) lines.push(`    HARNESS ${d}`);
    }
  }
  lines.push(`verdict: ${summary.verdict}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let budgetMinutes = BUDGET_MINUTES;
  const at = args.indexOf('--budget-minutes');
  if (at >= 0) {
    budgetMinutes = Number(args[at + 1]);
    args.splice(at, 2);
  }
  if (args.length !== 2 || !fs.existsSync(args[0]) || !(budgetMinutes > 0)) {
    console.error(
      'Usage: node scripts/linux-packaging-gate.js [--budget-minutes 35] <freedom-browser.deb> <out-dir>'
    );
    return 3;
  }
  let gate;
  let summary;
  try {
    gate = new Gate(args[0], args[1], { budgetMinutes });
    const stop = () => {
      gate.cleanup();
      process.exit(3);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    summary = gate.run();
  } catch (err) {
    console.error(`the gate could not run: ${err.stack || err}`);
    if (gate) gate.cleanup();
    return 3;
  }
  console.log(report(summary));
  return { pass: 0, fail: 1, 'harness-error': 3 }[summary.verdict];
}

if (require.main === module) process.exitCode = main();

module.exports = {
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
  report,
};
