// Drive every supported native addon of an installed Linux package through
// the path the app loads it by, and check which `.node` file was mapped.
//
// Run inside the packaged runtime, in Electron's Node mode:
//
//   ELECTRON_RUN_AS_NODE=1 /opt/Freedom/freedom scripts/linux-native-probe.js \
//     [--inventory scripts/linux-native-inventory.json] [--only usb,keccak]
//
// Each test runs in its own child process of the same runtime, so
// /proc/self/maps shows only what that one test loaded. Modules are required
// through a require() created at a real module path inside `app.asar` (the
// Ledger transport, the history store, the IPFS and Radicle wrappers), so
// resolution is the app's own and Electron redirects the native files to
// `app.asar.unpacked`. Each test calls a named function before it reads the
// maps: a load alone does not show an addon works, and keccak in particular
// falls back to JavaScript silently when its addon fails, so the maps check is
// what shows the native file is in use.
//
// The mapped `.node` files must be exactly the inventory's supported files for
// that loading path, with no foreign or dormant variant and no Colibri addon.
// With PREBUILDS_ONLY=1 in the environment, node-gyp-build skips build/Release
// and the dormant usb and keccak glibc prebuilds must be mapped and work
// instead. In the default mode it also runs antd, hnsd, fingertipd and v2ray
// and records the version each reports. fingertipd has no version flag, so it
// is run with -h and its version is the Go build information embedded in it.
//
// It prints one JSON summary on stdout and exits 0 when every test passes, 1
// when any test fails, and 3 on a harness error: a test timed out or could not
// be run, the environment breaks the inventory's loader-selection assumptions,
// or the probe itself could not run (a missing inventory, a bad argument),
// none of which says anything about the package. A test child that dies
// without a result counts against the package only when the loader names the
// cause on stderr or the child crashed on a fault signal.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const TREE = path.dirname(process.execPath);
const RES = path.join(TREE, 'resources');
const ASAR = path.join(RES, 'app.asar');
const CHILD_TIMEOUT_MS = 90000;
const KECCAK256_EMPTY = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

const MODULES = 'resources/app.asar.unpacked/node_modules';
const USB_BUILD = `${MODULES}/usb/build/Release/usb_bindings.node`;
const USB_PREBUILD = `${MODULES}/usb/prebuilds/linux-x64/node.napi.glibc.node`;
const KECCAK_BUILD = `${MODULES}/keccak/build/Release/addon.node`;
const KECCAK_PREBUILD = `${MODULES}/keccak/prebuilds/linux-x64/node.napi.glibc.node`;
const HIDRAW = `${MODULES}/node-hid/build/Release/HID_hidraw.node`;
const SQLITE = `${MODULES}/better-sqlite3/prebuilds/linux-x64.node`;
const IPFS = 'resources/freedom-ipfs-node/freedom_ipfs_native.node';
const RADICLE = 'resources/radicle-bin/libradicle.node';

// The `.node` files each addon test must map, in each mode, relative to the
// install root. Under PREBUILDS_ONLY=1 the expected files must be listed as
// dormant with `selectedWhen: PREBUILDS_ONLY=1`; otherwise as supported.
const EXPECTED = {
  usb: { default: [USB_BUILD], prebuildsOnly: [USB_PREBUILD] },
  ledger: { default: [HIDRAW, USB_BUILD], prebuildsOnly: [HIDRAW, USB_PREBUILD] },
  nodehid: { default: [HIDRAW], prebuildsOnly: [HIDRAW] },
  keccak: { default: [KECCAK_BUILD], prebuildsOnly: [KECCAK_PREBUILD] },
  sqlite: { default: [SQLITE], prebuildsOnly: [SQLITE] },
  ipfs: { default: [IPFS], prebuildsOnly: [IPFS] },
  radicle: { default: [RADICLE], prebuildsOnly: [RADICLE] },
  colibri: { default: [], prebuildsOnly: [] },
};
const EXECUTABLES = ['antd', 'hnsd', 'fingertipd', 'v2ray'];
const LOADER_FAILURE_RE =
  /error while loading shared libraries: \S+: cannot open shared object file|symbol lookup error: \S+: undefined symbol: \S+/;
// SIGTRAP is how Chromium's CHECK and IMMEDIATE_CRASH end a process.
const FAULT_SIGNALS = ['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT', 'SIGTRAP'];

class ProbeTimeout extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeout(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errInfo(err) {
  return { message: String((err && err.message) || err), code: (err && err.code) || null };
}

/** Every `.node` file mapped into this process, as absolute paths. */
function mappedNodeFiles(maps = fs.readFileSync('/proc/self/maps', 'utf8')) {
  const out = new Set();
  for (const line of maps.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const file = fields
      .slice(5)
      .join(' ')
      .replace(/ \(deleted\)$/, '');
    if (file.endsWith('.node')) out.add(file);
  }
  return [...out].sort();
}

function appRequire(modulePath) {
  return Module.createRequire(path.join(ASAR, modulePath));
}

/** A require() at the resolved entry of `name`, as seen from `req`. */
function requireFrom(req, name) {
  return Module.createRequire(req.resolve(name));
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ensureResourcesPath(result) {
  if (!process.resourcesPath) {
    process.resourcesPath = RES;
    result.notes.push('process.resourcesPath was unset; set to <tree>/resources as the app has it');
  }
}

/**
 * The Go version and main module embedded in a Go executable (the inline
 * buildinfo format of Go 1.18 and later).
 * @param {Buffer} data
 */
function goBuildInfo(data) {
  const at = data.indexOf(Buffer.from('\xff Go buildinf:', 'latin1'));
  if (at < 0 || !(data[at + 15] & 2)) return null;
  let off = at + 32;
  const readBytes = () => {
    let length = 0;
    let shift = 0;
    let byte;
    do {
      byte = data[off];
      off += 1;
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    const bytes = data.subarray(off, off + length);
    off += length;
    return bytes;
  };
  const goVersion = readBytes().toString('utf8');
  let modinfo = readBytes();
  // The module information is wrapped in two 16-byte sentinels.
  if (modinfo.length >= 32) modinfo = modinfo.subarray(16, modinfo.length - 16);
  const text = modinfo.toString('utf8');
  const main = /^path\t(\S+)/m.exec(text);
  return { goVersion, path: main ? main[1] : null };
}

function runVersion(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000 });
  if (r.error && r.error.code === 'ETIMEDOUT')
    throw new ProbeTimeout(`${bin} ${args.join(' ')} timed out`);
  if (r.error) throw r.error;
  return {
    argv: [bin, ...args],
    status: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

// Each test fills `result` and sets `result.ok`. The maps are read after it.
const tests = {
  async usb(result) {
    const hidReq = requireFrom(
      appRequire('src/main/wallet/ledger/transport.js'),
      '@ledgerhq/hw-transport-node-hid'
    );
    const usb = hidReq('usb');
    const list = usb.getDeviceList();
    result.call = 'usb.getDeviceList()';
    result.value = { devices: list.length };
    result.ok = Array.isArray(list);
  },

  async ledger(result) {
    const Transport = appRequire('src/main/wallet/ledger/transport.js')(
      '@ledgerhq/hw-transport-node-hid'
    ).default;
    const list = await withTimeout(Transport.list(), 15000, 'TransportNodeHid.list()');
    result.call = 'TransportNodeHid.list()';
    result.value = { devices: list.length };
    result.ok = Array.isArray(list);
  },

  async nodehid(result) {
    const hidReq = requireFrom(
      appRequire('src/main/wallet/ledger/transport.js'),
      '@ledgerhq/hw-transport-node-hid'
    );
    const devices = hidReq('node-hid').devices();
    result.call = 'HID.devices()';
    result.value = { devices: devices.length };
    result.ok = Array.isArray(devices);
  },

  async keccak(result) {
    // The app reaches keccak through @ledgerhq/hw-app-eth's domain service
    // and its eip55 checksum.
    const transport = appRequire('src/main/wallet/ledger/transport.js');
    const eip55 = requireFrom(
      requireFrom(requireFrom(transport, '@ledgerhq/hw-app-eth'), '@ledgerhq/domain-service'),
      'eip55'
    );
    // keccak/index.js swallows a failed native load; require the native entry
    // first so the reason is recorded if there is one.
    try {
      eip55('keccak/bindings');
    } catch (err) {
      result.nativeLoadError = errInfo(err);
    }
    const hex = eip55('keccak')('keccak256').update('').digest('hex');
    result.call = "keccak('keccak256').update('').digest('hex')";
    result.value = { hex, matchesKnownVector: hex === KECCAK256_EMPTY };
    result.ok = hex === KECCAK256_EMPTY && !result.nativeLoadError;
  },

  async sqlite(result) {
    const Database = appRequire('src/main/history.js')('better-sqlite3');
    const dir = tmpdir('freedom-probe-sqlite-');
    try {
      const db = new Database(path.join(dir, 'probe.db'));
      db.exec('create table t (k integer primary key, v text)');
      db.prepare('insert into t (v) values (?)').run('freedom-probe');
      const back = db.prepare('select v from t where k = 1').get().v;
      const version = db.prepare('select sqlite_version() as v').get().v;
      db.close();
      result.call = 'new Database(), one insert, one select';
      result.value = { readBack: back, sqliteVersion: version };
      result.ok = back === 'freedom-probe';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  // As ipfs-manager.js starts the bundled node: the wrapper's availability
  // check, then FreedomIpfsNativeNode on a data directory, start, then stop.
  // The container has no network, so the node runs offline.
  async ipfs(result) {
    ensureResourcesPath(result);
    const { FreedomIpfsNativeNode } = require(
      path.join(ASAR, 'src/main/ipfs/freedom-ipfs-native-node.js')
    );
    result.available = FreedomIpfsNativeNode.isAvailable();
    const root = tmpdir('freedom-probe-ipfs-');
    const dataDir = path.join(root, 'freedom-ipfs');
    fs.mkdirSync(dataDir, { recursive: true });
    const failures = [];
    const node = new FreedomIpfsNativeNode({
      dataDir,
      onFailure: (reason) => failures.push(String(reason)),
    });
    try {
      result.version = node.version;
      const started = await withTimeout(node.start(), 60000, 'FreedomIpfsNativeNode.start()');
      const healthy = node.isHealthy();
      // stop() resolves once the gateway is stopped and the handle freed, and
      // rejects (caught below as the test's error) if either step fails.
      const stopped = await withTimeout(node.stop(), 30000, 'FreedomIpfsNativeNode.stop()');
      result.call = 'FreedomIpfsNativeNode start(), isHealthy(), stop()';
      result.value = {
        started,
        healthy,
        stopResult: stopped === undefined ? 'resolved' : stopped,
        healthyAfterStop: node.isHealthy(),
        handleAfterStop: node.nodeHandle,
        cacheCreated: fs.existsSync(path.join(dataDir, 'freedom-ipfs.sqlite3')),
        failures,
      };
      result.ok =
        result.available &&
        started === true &&
        healthy &&
        result.value.healthyAfterStop === false &&
        result.value.handleAfterStop === '0' &&
        failures.length === 0 &&
        result.value.cacheCreated;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },

  async radicle(result) {
    ensureResourcesPath(result);
    const embedded = require(path.join(ASAR, 'src/main/radicle-embedded.js'));
    result.addonPath = embedded.getAddonPath();
    const home = tmpdir('freedom-probe-radicle-');
    try {
      const started = await withTimeout(
        embedded.start(home, 'FreedomBrowser'),
        60000,
        'radicle start()'
      );
      const identity = await withTimeout(embedded.identity(), 20000, 'radicle identity()');
      const shutdown = await withTimeout(embedded.shutdown(), 30000, 'radicle shutdown()');
      result.call = 'radicle-embedded start(), identity(), shutdown()';
      result.value = { did: identity && identity.did, shutdown };
      result.ok =
        result.addonPath === path.join(RES, 'radicle-bin', 'libradicle.node') &&
        Boolean(started && started.did) &&
        Boolean(identity && identity.did === started.did) &&
        Boolean(shutdown && shutdown.ok);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },

  // The fork's single Colibri entry point sets C4_DISABLE_NATIVE=1 and installs
  // a WASM runtime provider; getRuntime() must then build the WASM runtime
  // without opening the native prebuild.
  async colibri(result) {
    require(path.join(ASAR, 'src/main/ens/colibri-runtime.js'));
    const pkg = path.dirname(
      appRequire('src/main/ens/colibri-runtime.js').resolve('@corpus-core/colibri-stateless')
    );
    const runtime = await withTimeout(
      require(path.join(pkg, 'runtime.js')).getRuntime(),
      30000,
      'getRuntime()'
    );
    result.call = 'colibri runtime.js getRuntime()';
    result.value = { runtime: Boolean(runtime), C4_DISABLE_NATIVE: process.env.C4_DISABLE_NATIVE };
    result.ok = Boolean(runtime) && process.env.C4_DISABLE_NATIVE === '1';
  },

  async antd(result) {
    const run = runVersion(path.join(RES, 'ant-bin', 'antd'), ['--version']);
    const m = /^antd (\d+\.\d+\.\d+)/m.exec(run.stdout);
    result.call = 'antd --version';
    result.value = {
      status: run.status,
      version: m ? m[1] : null,
      stdout: run.stdout.slice(0, 200),
    };
    result.ok = run.status === 0 && Boolean(m);
  },

  async hnsd(result) {
    const run = runVersion(path.join(RES, 'hns-bin', 'hnsd'), ['-v']);
    const m = /^(\d+\.\d+\.\d+)/m.exec(run.stdout);
    result.call = 'hnsd -v';
    result.value = {
      status: run.status,
      version: m ? m[1] : null,
      stdout: run.stdout.slice(0, 200),
    };
    result.ok = run.status === 0 && Boolean(m);
  },

  async fingertipd(result) {
    const bin = path.join(RES, 'hns-bin', 'fingertipd');
    const run = runVersion(bin, ['-h']);
    const usage = /Usage of fingertipd/.test(run.stderr);
    const info = goBuildInfo(fs.readFileSync(bin));
    result.call = 'fingertipd -h, and its embedded Go build information';
    result.value = { status: run.status, usage, version: info };
    result.ok =
      usage && [0, 2].includes(run.status) && Boolean(info && /^go\d/.test(info.goVersion));
  },

  async v2ray(result) {
    const run = runVersion(path.join(RES, 'dvpn-bin', 'v2ray'), ['version']);
    const m = /^V2Ray (\d+\.\d+\.\d+)/m.exec(run.stdout);
    result.call = 'v2ray version';
    result.value = { status: run.status, version: m ? m[1] : null };
    result.ok = run.status === 0 && Boolean(m);
  },
};

async function runChild(name) {
  const result = { test: name, ok: false, notes: [] };
  const emit = () => {
    try {
      result.mapped = mappedNodeFiles();
    } catch (err) {
      result.mapsError = errInfo(err);
    }
    process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  };
  setTimeout(() => {
    result.ok = false;
    result.timedOut = true;
    result.error = { message: `test did not finish within ${CHILD_TIMEOUT_MS - 5000} ms` };
    emit();
  }, CHILD_TIMEOUT_MS - 5000).unref();
  try {
    if (!tests[name]) throw new Error(`unknown test ${name}`);
    await tests[name](result);
  } catch (err) {
    result.ok = false;
    result.error = errInfo(err);
    if (err instanceof ProbeTimeout) result.timedOut = true;
  }
  emit();
}

/**
 * The loader-selection variables the inventory's foreign and dormant classes
 * assume unset, that are set here (PREBUILDS_ONLY excepted in its own mode).
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} prebuildsOnly
 * @param {(file: string) => boolean} [exists]
 */
function loaderSelectionViolations(env, prebuildsOnly, exists = fs.existsSync) {
  const violations = [];
  for (const name of ['LIBC', 'npm_config_arch', 'npm_config_platform']) {
    if (env[name] !== undefined) violations.push(name);
  }
  for (const name of Object.keys(env)) if (/_PREBUILD$/.test(name)) violations.push(name);
  if (!prebuildsOnly && env.PREBUILDS_ONLY !== undefined) violations.push('PREBUILDS_ONLY');
  if (exists('/etc/alpine-release')) violations.push('/etc/alpine-release');
  return violations;
}

/**
 * Judge one addon test's mapped files against its expected set and the
 * inventory. Returns the problems found, empty when it passes.
 * @param {string} name
 * @param {string[]} mapped absolute paths
 * @param {{tree: string, inventory: object, prebuildsOnly: boolean}} context
 */
function mappingProblems(name, mapped, context) {
  const expected = EXPECTED[name][context.prebuildsOnly ? 'prebuildsOnly' : 'default'];
  const listed = new Map(context.inventory.files.map((entry) => [entry.path, entry]));
  const problems = [];
  for (const file of expected) {
    const entry = listed.get(file);
    const wanted = context.prebuildsOnly && entry && entry.selectedWhen ? 'dormant' : 'supported';
    if (!entry || entry.class !== wanted) {
      problems.push(`${file} is not listed in the inventory as ${wanted}`);
    }
  }
  const rel = mapped.map((file) =>
    file.startsWith(`${context.tree}/`) ? file.slice(context.tree.length + 1) : file
  );
  for (const file of expected) {
    if (!rel.includes(file)) problems.push(`${file} was not mapped`);
  }
  for (const file of rel) {
    if (expected.includes(file)) continue;
    const entry = listed.get(file);
    if (/colibri/.test(file)) problems.push(`Colibri native addon mapped: ${file}`);
    else if (entry) problems.push(`${entry.class} file mapped: ${file}`);
    else problems.push(`unexpected file mapped: ${file}`);
  }
  return problems;
}

/** Run one test in a fresh child of this runtime and judge the outcome. */
function runTest(name, context) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, [__filename, '--child', name], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  const outcome = { test: name, seconds: Math.round((Date.now() - started) / 100) / 10 };
  const stderrTail = String(proc.stderr || '')
    .trim()
    .split('\n')
    .slice(-5)
    .join('\n');
  if (proc.error && proc.error.code === 'ETIMEDOUT') {
    return {
      ...outcome,
      status: 'harness-error',
      diagnostic: `killed after ${CHILD_TIMEOUT_MS} ms`,
    };
  }
  if (proc.error) {
    return {
      ...outcome,
      status: 'harness-error',
      diagnostic: `could not start: ${proc.error.message}`,
    };
  }
  const line = String(proc.stdout || '')
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('PROBE_RESULT '));
  if (!line) {
    const how = proc.signal ? `killed by ${proc.signal}` : `exited ${proc.status}`;
    const packageFault =
      LOADER_FAILURE_RE.test(proc.stderr || '') || FAULT_SIGNALS.includes(proc.signal);
    return {
      ...outcome,
      status: packageFault ? 'fail' : 'harness-error',
      diagnostic: `${how} without a result: ${stderrTail}`,
    };
  }
  let result;
  try {
    result = JSON.parse(line.slice('PROBE_RESULT '.length));
  } catch (err) {
    return { ...outcome, status: 'harness-error', diagnostic: `unreadable result: ${err.message}` };
  }
  Object.assign(outcome, { call: result.call, value: result.value, notes: result.notes });
  if (result.timedOut) {
    return { ...outcome, status: 'harness-error', diagnostic: result.error.message };
  }
  const problems = [];
  if (!result.ok) {
    problems.push(result.error ? result.error.message : `${result.call || name} did not succeed`);
  }
  if (result.nativeLoadError)
    problems.push(`native load failed: ${result.nativeLoadError.message}`);
  if (EXPECTED[name]) {
    if (result.mapsError)
      problems.push(`could not read /proc/self/maps: ${result.mapsError.message}`);
    else {
      outcome.mapped = result.mapped;
      problems.push(...mappingProblems(name, result.mapped, context));
    }
  }
  if (problems.length > 0) return { ...outcome, status: 'fail', diagnostic: problems.join('; ') };
  return { ...outcome, status: 'pass' };
}

function parseArgs(argv) {
  const args = { inventory: path.join(__dirname, 'linux-native-inventory.json'), only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--child') args.child = argv[++i];
    else if (argv[i] === '--inventory') args.inventory = argv[++i];
    else if (argv[i] === '--only') args.only = String(argv[++i] || '').split(',');
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (args.only) {
    const unknown = args.only.filter((name) => !tests[name]);
    if (unknown.length > 0 || args.only.length === 0) {
      throw new Error(`--only names no known test: ${unknown.join(', ') || '(empty)'}`);
    }
  }
  return args;
}

function main() {
  const prebuildsOnly = Boolean(process.env.PREBUILDS_ONLY);
  let args;
  let inventory;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.child) return runChild(args.child);
    inventory = JSON.parse(fs.readFileSync(args.inventory, 'utf8'));
  } catch (err) {
    // The probe could not run at all: say so as a harness error, never as
    // silence the gate would have to interpret.
    const summary = {
      probe: 'linux-native-probe',
      tree: TREE,
      mode: prebuildsOnly ? 'PREBUILDS_ONLY=1' : 'default',
      status: 'harness-error',
      diagnostic: `the probe could not run: ${err.message}`,
      tests: [],
    };
    process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
    process.exitCode = 3;
    return undefined;
  }
  const names = args.only || [...Object.keys(EXPECTED), ...(prebuildsOnly ? [] : EXECUTABLES)];
  const summary = {
    probe: 'linux-native-probe',
    tree: TREE,
    mode: prebuildsOnly ? 'PREBUILDS_ONLY=1' : 'default',
    versions: { electron: process.versions.electron, node: process.versions.node },
    inventorySha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(args.inventory))
      .digest('hex'),
    loaderSelectionViolations: loaderSelectionViolations(process.env, prebuildsOnly),
    tests: [],
  };
  if (summary.loaderSelectionViolations.length > 0) {
    // The environment, not the package, breaks the inventory's assumptions.
    summary.status = 'harness-error';
    summary.diagnostic = `loader-selection assumptions violated: ${summary.loaderSelectionViolations.join(', ')}`;
  } else {
    for (const name of names)
      summary.tests.push(runTest(name, { tree: TREE, inventory, prebuildsOnly }));
    const statuses = summary.tests.map((t) => t.status);
    summary.status = statuses.includes('harness-error')
      ? 'harness-error'
      : statuses.includes('fail')
        ? 'fail'
        : 'pass';
  }
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  process.exitCode = { pass: 0, fail: 1, 'harness-error': 3 }[summary.status];
  return undefined;
}

if (require.main === module) main();

module.exports = {
  EXPECTED,
  EXECUTABLES,
  LOADER_FAILURE_RE,
  mappedNodeFiles,
  goBuildInfo,
  loaderSelectionViolations,
  mappingProblems,
};
