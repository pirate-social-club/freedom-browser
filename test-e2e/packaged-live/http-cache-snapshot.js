const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = 0xfcfb6d1ba7725c30n;
const EOF_MAGIC = 0xf4fa6f45970d41d8n;

// Chromium 152 Simple Cache, not a search of payload bytes or hashed names.
// Refuse unknown formats and incomplete entries rather than report a miss.
function readEntryKey(data) {
  if (data.length < 80 || data.readBigUInt64LE(0) !== MAGIC || data.readUInt32LE(8) !== 5) {
    throw new Error('Unsupported or incomplete HTTP cache entry');
  }
  const length = data.readUInt32LE(12);
  if (!length || length > 64 * 1024 || 24 + length > data.length - 56) {
    throw new Error('Invalid HTTP cache key length');
  }
  const footer = data.length - 24;
  if (data.readBigUInt64LE(footer) !== EOF_MAGIC || !(data.readUInt32LE(footer + 8) & 2)) {
    throw new Error('HTTP cache entry lacks its key integrity footer');
  }
  const key = data.subarray(24, 24 + length);
  const digest = crypto.createHash('sha256').update(key).digest();
  if (!digest.equals(data.subarray(footer - 32, footer))) throw new Error('HTTP cache key digest mismatch');
  return new TextDecoder('utf-8', { fatal: true }).decode(key);
}

function snapshotHttpCache(cache, target) {
  if (!cache.persistent || !cache.storagePath) return null;
  const source = path.join(cache.storagePath, 'Cache');
  if (!fs.existsSync(source)) return { exists: false, entries: [], files: [] };
  if (!fs.lstatSync(source).isDirectory()) throw new Error('HTTP cache root is not a directory');
  let bytes = 0;
  const names = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(name);
      else {
        if (!entry.isFile()) throw new Error('Unexpected HTTP cache file type');
        bytes += fs.statSync(name).size;
        if (bytes > 64 * 1024 * 1024 || names.length >= 4096) throw new Error('HTTP cache evidence exceeds its bound');
        names.push(name);
      }
    }
  };
  walk(source);
  fs.mkdirSync(target, { recursive: true });
  const files = names.map((name) => {
    const relative = path.relative(source, name);
    const dest = path.join(target, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(name, dest, fs.constants.COPYFILE_EXCL);
    const data = fs.readFileSync(dest);
    return { path: relative, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  });
  const entries = [];
  for (const file of files) {
    if (!file.path.startsWith('Cache_Data/')) {
      if (!['No_Vary_Search/journal.baj', 'No_Vary_Search/snapshot.baf'].includes(file.path)) {
        throw new Error('Unknown HTTP cache metadata');
      }
      continue;
    }
    const name = path.basename(file.path);
    if (file.path === 'Cache_Data/index') {
      const data = fs.readFileSync(path.join(target, file.path));
      if (data.length !== 24 || data.readBigUInt64LE(0) !== MAGIC || data.readUInt32LE(8) !== 9) {
        throw new Error('Unsupported HTTP cache index');
      }
    } else if (file.path.startsWith('Cache_Data/index-dir/')) {
      if (!['the-real-index', 'temp-index'].includes(name)) throw new Error('Unknown HTTP cache index file');
    } else if (/^[0-9a-f]{16}_0$/.test(name)) {
      entries.push({ file: file.path, key: readEntryKey(fs.readFileSync(path.join(target, file.path))) });
    } else if (/^[0-9a-f]{16}_1$/.test(name)) {
      const primary = file.path.replace(/_1$/, '_0');
      if (!files.some((other) => other.path === primary)) throw new Error('Orphan HTTP cache stream');
      const data = fs.readFileSync(path.join(target, file.path));
      if (data.length < 48 || data.readBigUInt64LE(0) !== MAGIC || data.readUInt32LE(8) !== 5) {
        throw new Error('Unsupported secondary HTTP cache stream');
      }
      const length = data.readUInt32LE(12);
      if (!length || length > 64 * 1024 || 24 + length > data.length - 24 ||
          data.readBigUInt64LE(data.length - 24) !== EOF_MAGIC) {
        throw new Error('Invalid secondary HTTP cache stream');
      }
      const key = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(24, 24 + length));
      if (key !== readEntryKey(fs.readFileSync(path.join(target, primary)))) {
        throw new Error('HTTP cache streams have different keys');
      }
    } else throw new Error('Unsupported HTTP cache file');
  }
  if (!files.some((file) => file.path === 'Cache_Data/index')) throw new Error('HTTP cache backend is not Simple Cache');
  if (cache.sizeBytes > 0 && !entries.length) throw new Error('Native HTTP cache has data without a readable entry');
  return { exists: true, directory: target, entries, files, bytes };
}

module.exports = { readEntryKey, snapshotHttpCache };
