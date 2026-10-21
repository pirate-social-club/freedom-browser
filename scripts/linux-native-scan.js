#!/usr/bin/env node

// Check every ELF file in an unpacked Linux package against the checked-in
// inventory (`scripts/linux-native-inventory.json`) and the declared glibc
// floor.
//
// The 2f7920f3 evaluation deb declared `libc6 (>= 2.36)`, but its IPFS addon
// needs GLIBC_2.39 and its source-built usb addon GLIBC_2.38, so on Debian 12
// both failed to load in a package apt had accepted. Nothing in the build
// looked at the link tables, so this reads them for every ELF file in the tree:
//
//   - SHA256, ELF class, machine and interpreter;
//   - NEEDED, RPATH and RUNPATH;
//   - every GLIBC version need and whether it is WEAK (`.gnu.version_r` flags),
//     plus the GLIBCXX and CXXABI needs.
//
// Every readelf and objdump call has its exit status checked, and any
// `Error:` or `Warning:` line on stderr is an inspection error: readelf exits 0
// on a truncated file and reports the damage only on stderr. readelf runs with
// -wN and objdump with -WN, so neither follows a separate-debug link (binutils
// 2.38 otherwise warns about Chromium's split-DWARF libvulkan.so.1 even for
// -h). Inspection errors are reported apart from results, and any one of them
// makes the scan exit 2.
//
// It also checks every `.asar` archive in the tree (no member is an ELF file;
// every entry marked unpacked has a file behind it) and every symlink (none
// points at an ELF file outside the tree). Then it compares the results with
// the inventory and fails (exit 1) when an ELF file is missing or extra, a
// pinned download's digest differs, a file's ELF target contradicts its class,
// or a supported file (or a dormant prebuild that PREBUILDS_ONLY=1 selects)
// has a non-weak GLIBC need above the floor. GLIBCXX and CXXABI needs are only
// recorded here; the packaging gate checks them against the floor image's own
// libstdc++.
//
// The floor is the package's declared `libc6 (>= x.y)`, read from its control
// file (`--control`) or its Depends value (`--depends`), else the inventory's
// `glibcFloor`; `--floor` overrides both. A declared floor that differs from
// the inventory's is itself a failure, because the inventory records the
// contract the package is meant to declare.
//
// Usage:
//   node scripts/linux-native-scan.js --root <dir> [--prefix opt/Freedom]
//     [--inventory scripts/linux-native-inventory.json]
//     [--control <DEBIAN/control> | --depends '<Depends value>'] [--floor 2.39]
//     [--json <report.json>]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const TOOL_TIMEOUT_MS = 120000;
const CLASSES = new Set(['supported', 'foreign', 'dormant']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const X86_64_MACHINE = 'Advanced Micro Devices X86-64';

class InspectionError extends Error {
  /**
   * @param {string} message
   * @param {'file' | 'tool'} kind `tool` when the inspection tool itself could
   *   not run or timed out, `file` when it ran and the file is unreadable or
   *   damaged.
   */
  constructor(message, kind = 'file') {
    super(message);
    this.name = 'InspectionError';
    this.kind = kind;
  }
}

/**
 * Run an inspection tool. A non-zero exit, a timeout, or any Error/Warning
 * line on stderr is an InspectionError.
 * @param {string[]} argv
 * @param {{timeoutMs?: number}} [options]
 * @returns {string} stdout
 */
function runTool(argv, options = {}) {
  const timeout = options.timeoutMs || TOOL_TIMEOUT_MS;
  const proc = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout,
  });
  const command = argv.join(' ');
  if (proc.error) {
    if (proc.error.code === 'ETIMEDOUT') {
      throw new InspectionError(`${command}: timed out after ${timeout} ms`, 'tool');
    }
    throw new InspectionError(`${argv[0]}: could not run: ${proc.error.message}`, 'tool');
  }
  const stderr = proc.stderr || '';
  if (proc.status !== 0) {
    const how = proc.signal ? `was killed by ${proc.signal}` : `exited ${proc.status}`;
    throw new InspectionError(`${command} ${how}: ${stderr.trim().slice(0, 2000)}`);
  }
  const bad = stderr.split('\n').filter((line) => /\b(Error|Warning)\b/.test(line));
  if (bad.length > 0) {
    throw new InspectionError(
      `${command} exited 0 but reported: ${bad.join(' | ').slice(0, 2000)}`
    );
  }
  return proc.stdout;
}

/**
 * Compare dotted version strings numerically ('2.9' < '2.10').
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `readelf -h`: class, machine and type. */
function parseHeader(text) {
  const info = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*(Class|Machine|Type):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Class') info.class = m[2];
    else if (m[1] === 'Machine') info.machine = m[2];
    else info.type = m[2].split(/\s+/)[0];
  }
  return info;
}

/** `readelf -d`: NEEDED, RPATH and RUNPATH, and whether there is a dynamic section. */
function parseDynamic(text) {
  const needed = [];
  const rpath = [];
  const runpath = [];
  for (const line of String(text).split('\n')) {
    const m = /\((NEEDED|RPATH|RUNPATH)\)\s+.*?\[(.*)\]\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'NEEDED') needed.push(m[2]);
    else if (m[1] === 'RPATH') rpath.push(m[2]);
    else runpath.push(m[2]);
  }
  const dynamic = !String(text).includes('There is no dynamic section');
  return { needed, rpath, runpath, dynamic };
}

/** `readelf -l`: the PT_INTERP path, or null. */
function parseInterp(text) {
  const m = /\[Requesting program interpreter: (.*?)\]/.exec(String(text));
  return m ? m[1] : null;
}

/**
 * `readelf -V`: every entry of the version needs section (`.gnu.version_r`),
 * as {file, version, flags}. The version symbols and definitions sections
 * around it are ignored.
 * @param {string} text
 */
function parseVersionNeeds(text) {
  const entries = [];
  let inNeeds = false;
  let file = null;
  for (const line of String(text).split('\n')) {
    if (line.includes('Version needs section')) {
      inNeeds = true;
      file = null;
      continue;
    }
    if (/Version (definition|symbols) section/.test(line)) {
      inNeeds = false;
      continue;
    }
    if (!inNeeds) continue;
    const mf = /File:\s+(\S+)\s+Cnt:/.exec(line);
    if (mf) {
      file = mf[1];
      continue;
    }
    const mn = /Name:\s+(\S+)\s+Flags:\s+(.*?)\s+Version:/.exec(line);
    if (mn) entries.push({ file, version: mn[1], flags: mn[2].trim() });
  }
  return entries;
}

/**
 * Group version needs by family. A version counts as weak only when every
 * entry naming it is WEAK, because glibc's loader rejects any unmet need that
 * is not.
 * @param {{version: string, flags: string}[]} entries
 */
function summarizeVersionNeeds(entries) {
  const byFamily = { GLIBC: new Map(), GLIBCXX: new Map(), CXXABI: new Map() };
  for (const entry of entries) {
    const m = /^(GLIBC|GLIBCXX|CXXABI)_(\d+(?:\.\d+)*)$/.exec(entry.version);
    if (!m) continue;
    const weak = /\bWEAK\b/.test(entry.flags);
    const seen = byFamily[m[1]].get(m[2]);
    byFamily[m[1]].set(m[2], seen === undefined ? weak : seen && weak);
  }
  const list = (map) =>
    [...map.entries()]
      .sort(([a], [b]) => compareVersions(a, b))
      .map(([version, weak]) => ({ version, weak }));
  const glibc = list(byFamily.GLIBC);
  const nonWeak = glibc.filter((need) => !need.weak);
  return {
    glibc,
    glibcNewest: glibc.length ? glibc[glibc.length - 1].version : null,
    glibcNewestNonWeak: nonWeak.length ? nonWeak[nonWeak.length - 1].version : null,
    glibcxx: list(byFamily.GLIBCXX).map((need) => need.version),
    cxxabi: list(byFamily.CXXABI).map((need) => need.version),
  };
}

/** Undefined dynamic symbols bound to one version, from `objdump -T`. */
function parseObjdumpSymbols(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\(?${escaped}\\)?\\s+(\\S+)\\s*$`);
  const symbols = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.includes('*UND*')) continue;
    const m = pattern.exec(line);
    if (m) symbols.add(m[1]);
  }
  return [...symbols].sort();
}

/**
 * The C library a file is built against, from its interpreter and NEEDED
 * list: `glibc`, `musl`, `bionic` (Android), `static`, or `unknown`.
 */
function elfLibc(record) {
  const needed = record.needed || [];
  if (needed.some((lib) => /^libc\.musl-/.test(lib)) || /ld-musl/.test(record.interp || '')) {
    return 'musl';
  }
  if (needed.includes('libc.so.6')) return 'glibc';
  if (needed.includes('libc.so') || /\/system\/bin\/linker/.test(record.interp || '')) {
    return 'bionic';
  }
  if (!record.dynamic) return 'static';
  return 'unknown';
}

/** Whether the Linux x86-64 glibc loader can select this file at all. */
function isX86_64Glibc(record) {
  return (
    record.class === 'ELF64' && record.machine === X86_64_MACHINE && elfLibc(record) === 'glibc'
  );
}

function readMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    return n === 4 ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Inspect one regular file. Returns null when it is not an ELF file.
 * @param {string} file
 * @param {{tool?: (argv: string[]) => string}} [options]
 */
function inspectElf(file, options = {}) {
  const tool = options.tool || runTool;
  let magic;
  try {
    magic = readMagic(file);
  } catch (err) {
    throw new InspectionError(`cannot read: ${err.message}`);
  }
  if (!magic.equals(ELF_MAGIC)) return null;
  let sha256;
  let size;
  try {
    size = fs.statSync(file).size;
    sha256 = sha256File(file);
  } catch (err) {
    throw new InspectionError(`cannot read: ${err.message}`);
  }
  const record = { sha256, size };
  Object.assign(record, parseHeader(tool(['readelf', '-h', '-W', '-wN', file])));
  record.interp = parseInterp(tool(['readelf', '-l', '-W', '-wN', file]));
  Object.assign(record, parseDynamic(tool(['readelf', '-d', '-W', '-wN', file])));
  const needs = parseVersionNeeds(tool(['readelf', '-V', '-W', '-wN', file]));
  Object.assign(record, summarizeVersionNeeds(needs));
  record.glibcNewestSymbols =
    record.dynamic && record.glibcNewest
      ? parseObjdumpSymbols(
          tool(['objdump', '-T', '-w', '-WN', file]),
          `GLIBC_${record.glibcNewest}`
        )
      : [];
  record.libc = elfLibc(record);
  return record;
}

/**
 * Read an asar archive's header: a Pickle holding the header Pickle's size,
 * then the header Pickle, whose payload is one length-prefixed JSON string.
 * File data starts right after it; a file entry's `offset` is relative to
 * that point.
 * @param {string} file
 * @returns {{header: object, dataOffset: number}}
 */
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('truncated size pickle');
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) {
      throw new Error('truncated header pickle');
    }
    const length = headerBuf.readInt32LE(4);
    if (length < 0 || 8 + length > headerSize) throw new Error('header string overruns its pickle');
    return {
      header: JSON.parse(headerBuf.toString('utf8', 8, 8 + length)),
      dataOffset: 8 + headerSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check one asar archive: no packed member is an ELF file, and every entry
 * marked unpacked has a regular file under `<archive>.unpacked/`.
 * @param {string} archive
 */
function checkAsar(archive) {
  const { header, dataOffset } = readAsarHeader(archive);
  const unpackedRoot = `${archive}.unpacked`;
  const elfMembers = [];
  const missingUnpacked = [];
  let files = 0;
  let unpacked = 0;
  const fd = fs.openSync(archive, 'r');
  try {
    const visit = (node, parts) => {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const member = [...parts, name];
        if (entry.files) {
          visit(entry, member);
          continue;
        }
        if (entry.link !== undefined) continue;
        files += 1;
        const rel = member.join('/');
        if (entry.unpacked) {
          unpacked += 1;
          let st = null;
          try {
            st = fs.lstatSync(path.join(unpackedRoot, ...member));
          } catch {
            // Reported below.
          }
          if (!st || !st.isFile()) missingUnpacked.push(rel);
          continue;
        }
        if (Number(entry.size) < 4) continue;
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, dataOffset + Number(entry.offset));
        if (buf.equals(ELF_MAGIC)) elfMembers.push(rel);
      }
    };
    visit(header, []);
  } finally {
    fs.closeSync(fd);
  }
  return { files, unpacked, elfMembers, missingUnpacked };
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Walk a tree without following symlinks. Every regular file is inspected,
 * every `.asar` archive checked, and every symlink resolved.
 * @param {string} root
 * @param {{tool?: (argv: string[]) => string}} [options]
 */
function scanTree(root, options = {}) {
  const rootReal = fs.realpathSync(root);
  const results = [];
  const errors = [];
  const symlinks = [];
  const asar = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({
        path: path.relative(root, dir),
        error: `cannot list: ${err.message}`,
        kind: 'file',
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        symlinks.push(inspectSymlink(full, rel, rootReal));
      } else if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        try {
          const record = inspectElf(full, options);
          if (record) results.push({ path: rel, ...record });
        } catch (err) {
          if (!(err instanceof InspectionError)) throw err;
          errors.push({ path: rel, error: err.message, kind: err.kind });
          continue;
        }
        if (entry.name.endsWith('.asar')) {
          try {
            asar.push({ path: rel, ...checkAsar(full) });
          } catch (err) {
            errors.push({
              path: rel,
              error: `cannot read asar header: ${err.message}`,
              kind: 'file',
            });
          }
        }
      }
    }
  };
  visit(root);
  return { results, errors, symlinks, asar };
}

function inspectSymlink(full, rel, rootReal) {
  const link = { path: rel, target: fs.readlinkSync(full) };
  let resolved;
  try {
    resolved = fs.realpathSync(full);
  } catch {
    return { ...link, resolved: null, dangling: true };
  }
  link.resolved = resolved;
  link.outside = !isInside(rootReal, resolved);
  link.targetIsElf = false;
  try {
    link.targetIsElf = fs.statSync(resolved).isFile() && readMagic(resolved).equals(ELF_MAGIC);
  } catch {
    // An unreadable target is not shown to be an ELF file; it is recorded.
  }
  return link;
}

/**
 * The glibc floor a Depends value declares, from its `libc6 (>= x.y)`
 * relation, or null when it declares none.
 * @param {string} depends
 */
function parseLibcFloor(depends) {
  const floors = [];
  for (const group of String(depends || '').split(',')) {
    for (const alternative of group.split('|')) {
      const m = /^\s*libc6(?::\S+)?\s*\(\s*>=\s*([0-9]+(?:\.[0-9]+)*)[^)]*\)\s*$/.exec(alternative);
      if (m) floors.push(m[1]);
    }
  }
  if (floors.length === 0) return null;
  return floors.sort(compareVersions)[floors.length - 1];
}

/** The Depends value of a Debian control file. */
function readControlDepends(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^Depends:[ \t]*(.*(?:\n[ \t].*)*)/m.exec(text);
  return m ? m[1].replace(/\n[ \t]+/g, ' ').trim() : '';
}

/**
 * Validate the inventory's shape so a malformed entry is refused rather than
 * silently skipped.
 * @param {object} inventory
 */
function validateInventory(inventory) {
  const problems = [];
  if (!inventory || !Array.isArray(inventory.files)) return ['inventory has no files array'];
  if (!/^\d+\.\d+$/.test(String(inventory.glibcFloor || ''))) {
    problems.push('inventory glibcFloor must be a version such as 2.39');
  }
  const assumption = inventory.loaderSelection && inventory.loaderSelection.assumption;
  if (!assumption) problems.push('inventory has no loaderSelection.assumption');
  const seen = new Set();
  for (const entry of inventory.files) {
    const where = entry && entry.path ? entry.path : JSON.stringify(entry);
    if (!entry || typeof entry.path !== 'string' || entry.path.startsWith('/')) {
      problems.push(`${where}: path must be relative to the install root`);
      continue;
    }
    if (seen.has(entry.path)) problems.push(`${where}: listed twice`);
    seen.add(entry.path);
    if (!CLASSES.has(entry.class)) problems.push(`${where}: unknown class ${entry.class}`);
    if (!entry.reason) problems.push(`${where}: no reason`);
    if (entry.class !== 'supported') {
      if (!entry.evidence || !entry.evidence.citation)
        problems.push(`${where}: no evidence citation`);
      if (!entry.evidence || entry.evidence.assumes !== assumption) {
        problems.push(`${where}: evidence must state the loader-selection assumption`);
      }
    }
    if (entry.sha256 !== undefined && !SHA256_RE.test(entry.sha256)) {
      problems.push(`${where}: sha256 is not a lowercase hex digest`);
    }
    if (entry.sha256 !== undefined && !entry.pin) problems.push(`${where}: digest without its pin`);
    if (entry.selectedWhen !== undefined && entry.class !== 'dormant') {
      problems.push(`${where}: only a dormant file has selectedWhen`);
    }
  }
  return problems;
}

function loadInventory(file) {
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateInventory(inventory);
  if (problems.length > 0) {
    throw new Error(`invalid inventory ${file}:\n  ${problems.join('\n  ')}`);
  }
  return inventory;
}

/**
 * Whether the floor applies to an inventory entry: every supported file, and
 * each dormant prebuild that the app would load under PREBUILDS_ONLY=1.
 */
function floorApplies(entry) {
  return entry.class === 'supported' || entry.selectedWhen === 'PREBUILDS_ONLY=1';
}

/**
 * Compare a scan with the inventory.
 * @param {{results: object[], errors: object[], symlinks: object[], asar: object[]}} scan
 * @param {object} inventory
 * @param {{prefix?: string, floor: string, declaredFloor?: string | null}} options
 * @returns {{kind: string, path?: string, message: string}[]}
 */
function compareWithInventory(scan, inventory, options) {
  const prefix = options.prefix ? path.normalize(options.prefix) : '';
  const failures = [];
  const fail = (kind, file, message) => failures.push({ kind, path: file, message });

  if (options.declaredFloor === null) {
    fail('floor', null, 'the package declares no libc6 (>= x.y) floor');
  } else if (options.declaredFloor && options.declaredFloor !== inventory.glibcFloor) {
    fail(
      'floor',
      null,
      `the package declares libc6 (>= ${options.declaredFloor}) but the inventory records ${inventory.glibcFloor}`
    );
  }

  const byPath = new Map();
  for (const record of scan.results) {
    const rel = prefix ? path.relative(prefix, record.path) : record.path;
    if (prefix && (rel.startsWith('..') || path.isAbsolute(rel))) {
      fail('extra', record.path, `ELF file outside ${prefix}`);
      continue;
    }
    byPath.set(rel, record);
  }
  const errored = new Set(
    scan.errors.map((e) => (prefix ? path.relative(prefix, e.path) : e.path))
  );
  const listed = new Map(inventory.files.map((entry) => [entry.path, entry]));

  for (const [rel] of byPath) {
    if (!listed.has(rel)) fail('extra', rel, 'ELF file not in the inventory');
  }
  for (const entry of inventory.files) {
    const record = byPath.get(entry.path);
    if (!record) {
      // An inspection error is already reported; do not report it twice.
      if (!errored.has(entry.path))
        fail('missing', entry.path, 'inventoried ELF file not in the package');
      continue;
    }
    if (entry.sha256 && record.sha256 !== entry.sha256) {
      fail('digest', entry.path, `sha256 ${record.sha256} differs from the pinned ${entry.sha256}`);
    }
    const target = `${record.class} ${record.machine}, ${record.libc}`;
    if (entry.class === 'foreign' && isX86_64Glibc(record)) {
      fail('class', entry.path, `listed as foreign but is ${target}, which the loader can select`);
    }
    if (entry.class === 'dormant' && !isX86_64Glibc(record)) {
      fail('class', entry.path, `listed as dormant but is ${target}; that is foreign`);
    }
    if (
      entry.class === 'supported' &&
      !(
        record.class === 'ELF64' &&
        record.machine === X86_64_MACHINE &&
        ['glibc', 'static'].includes(record.libc)
      )
    ) {
      fail('class', entry.path, `listed as supported but is ${target}`);
    }
    if (
      floorApplies(entry) &&
      record.glibcNewestNonWeak &&
      compareVersions(record.glibcNewestNonWeak, options.floor) > 0
    ) {
      const symbols =
        record.glibcNewestNonWeak === record.glibcNewest && record.glibcNewestSymbols.length
          ? ` (${record.glibcNewestSymbols.join(', ')})`
          : '';
      const above = record.glibc
        .filter((need) => !need.weak && compareVersions(need.version, options.floor) > 0)
        .map((need) => `GLIBC_${need.version}`);
      fail(
        'floor',
        entry.path,
        `needs ${above.join(', ')}${symbols}, not weak, above the floor ${options.floor}`
      );
    }
  }

  for (const archive of scan.asar) {
    for (const member of archive.elfMembers) {
      fail('asar', `${archive.path}:${member}`, 'ELF member packed inside the archive');
    }
    for (const member of archive.missingUnpacked) {
      fail(
        'asar',
        `${archive.path}:${member}`,
        'header marks it unpacked but no file is behind it'
      );
    }
  }
  for (const link of scan.symlinks) {
    if (link.outside && link.targetIsElf) {
      fail('symlink', link.path, `points at the ELF file ${link.resolved}, outside the tree`);
    }
  }
  return failures;
}

/**
 * Scan a tree and, given an inventory, compare it.
 * @param {{root: string, prefix?: string, inventory?: object, depends?: string | null,
 *   floor?: string, tool?: (argv: string[]) => string}} options
 */
function scanPackage(options) {
  const scan = scanTree(options.root, { tool: options.tool });
  const report = {
    root: options.root,
    prefix: options.prefix || '',
    results: scan.results,
    errors: scan.errors,
    symlinks: scan.symlinks,
    asar: scan.asar,
    failures: [],
  };
  if (options.inventory) {
    const declaredFloor =
      options.depends === undefined ? undefined : parseLibcFloor(options.depends);
    const floor =
      options.floor || (declaredFloor ? declaredFloor : null) || options.inventory.glibcFloor;
    report.inventoryFloor = options.inventory.glibcFloor;
    report.declaredFloor = declaredFloor === undefined ? null : declaredFloor;
    report.floor = floor;
    report.failures = compareWithInventory(scan, options.inventory, {
      prefix: options.prefix,
      floor,
      declaredFloor,
    });
  }
  report.status = report.errors.length ? 'error' : report.failures.length ? 'fail' : 'pass';
  return report;
}

function parseArgs(argv) {
  const args = {};
  const flags = ['root', 'prefix', 'inventory', 'control', 'depends', 'floor', 'json'];
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !flags.includes(name) || i + 1 >= argv.length) {
      throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    }
    args[name] = argv[i + 1];
    i += 1;
  }
  if (!args.root) throw new Error('--root is required');
  if (args.control && args.depends !== undefined)
    throw new Error('give --control or --depends, not both');
  if (args.floor && !/^\d+\.\d+$/.test(args.floor)) throw new Error('--floor must look like 2.39');
  return args;
}

function printReport(report) {
  const lines = [`ELF files: ${report.results.length}, inspection errors: ${report.errors.length}`];
  if (report.floor) {
    const declared = report.declaredFloor ? `declared ${report.declaredFloor}, ` : '';
    lines.push(
      `glibc floor checked: ${report.floor} (${declared}inventory ${report.inventoryFloor})`
    );
  }
  for (const e of report.errors) lines.push(`ERROR ${e.path}: ${e.error}`);
  for (const f of report.failures)
    lines.push(`FAIL [${f.kind}] ${f.path ? `${f.path}: ` : ''}${f.message}`);
  lines.push(`result: ${report.status}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  let args;
  let inventory;
  let depends;
  try {
    args = parseArgs(argv);
    inventory = args.inventory ? loadInventory(args.inventory) : undefined;
    if (args.control) depends = readControlDepends(args.control);
    else if (args.depends !== undefined) depends = args.depends;
  } catch (err) {
    console.error(err.message);
    console.error(
      'Usage: node scripts/linux-native-scan.js --root <dir> [--prefix <dir>] [--inventory <json>] ' +
        "[--control <file> | --depends '<value>'] [--floor x.y] [--json <out>]"
    );
    return 2;
  }
  const report = scanPackage({
    root: args.root,
    prefix: args.prefix,
    inventory,
    depends,
    floor: args.floor,
  });
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 1)}\n`);
  const text = printReport(report);
  if (report.status === 'pass') console.log(text);
  else console.error(text);
  return report.errors.length ? 2 : report.failures.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  InspectionError,
  runTool,
  compareVersions,
  parseHeader,
  parseDynamic,
  parseInterp,
  parseVersionNeeds,
  summarizeVersionNeeds,
  parseObjdumpSymbols,
  elfLibc,
  isX86_64Glibc,
  inspectElf,
  readAsarHeader,
  checkAsar,
  scanTree,
  parseLibcFloor,
  readControlDepends,
  validateInventory,
  loadInventory,
  floorApplies,
  compareWithInventory,
  scanPackage,
  printReport,
  main,
};
