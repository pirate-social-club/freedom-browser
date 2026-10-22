const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readEntryKey, snapshotHttpCache } = require('./http-cache-snapshot');

function entry(key) {
  const bytes = Buffer.from(key);
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n);
  header.writeUInt32LE(5, 8);
  header.writeUInt32LE(bytes.length, 12);
  const eof = Buffer.alloc(24);
  eof.writeBigUInt64LE(0xf4fa6f45970d41d8n);
  eof.writeUInt32LE(3, 8);
  return Buffer.concat([header, bytes, eof, crypto.createHash('sha256').update(bytes).digest(), eof]);
}

test('reads the actual key, including isolation prefixes and an HTTP gateway URL', () => {
  const key = '1/0/_dk_https://top.test https://site.test https://gateway.test/ipfs/control-B';
  expect(readEntryKey(entry(key))).toBe(key);
});

test.each([
  (b) => b.subarray(0, 30),
  (b) => { b.writeUInt32LE(99, 8); return b; },
  (b) => { b.writeUInt32LE(999999, 12); return b; },
  (b) => { b[24] ^= 1; return b; },
  (b) => { b[b.length - 24] ^= 1; return b; },
])('refuses corrupt or unsupported cache entries', (damage) => {
  expect(() => readEntryKey(damage(entry('1/0/ipfs://control-B/')))).toThrow();
});

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-http-cache-parser-'));
  try {
    const source = path.join(root, 'profile');
    const data = path.join(source, 'Cache', 'Cache_Data');
    fs.mkdirSync(data, { recursive: true });
    const index = Buffer.alloc(24);
    index.writeBigUInt64LE(0xfcfb6d1ba7725c30n);
    index.writeUInt32LE(9, 8);
    fs.writeFileSync(path.join(data, 'index'), index);
    const name = '0123456789abcdef_0';
    fs.writeFileSync(path.join(data, name), entry('1/0/ipfs://control-B/'));
    run({ source, data, name, target: path.join(root, 'copy'), cache: { persistent: true, storagePath: source, sizeBytes: 100 } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('preserves the full cache and a digest for each file before parsing B', () => fixture(({ cache, target, name }) => {
  const copy = snapshotHttpCache(cache, target);
  expect(copy.entries).toEqual([{ file: `Cache_Data/${name}`, key: '1/0/ipfs://control-B/' }]);
  expect(copy.files).toHaveLength(2);
  expect(copy.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  expect(fs.existsSync(path.join(target, 'Cache_Data', name))).toBe(true);
}));

test('does not follow a symlink or silently skip another backend format', () => fixture(({ data, cache, target }) => {
  fs.symlinkSync('/dev/null', path.join(data, 'untrusted'));
  expect(() => snapshotHttpCache(cache, target)).toThrow('file type');
}));

test('refuses an unrecognised cache file', () => fixture(({ data, cache, target }) => {
  fs.writeFileSync(path.join(data, 'new-backend-format'), 'unknown');
  expect(() => snapshotHttpCache(cache, target)).toThrow('Unsupported HTTP cache file');
}));

test('does not treat a missing readable entry as a native cache miss', () => fixture(({ data, name, cache, target }) => {
  fs.unlinkSync(path.join(data, name));
  expect(() => snapshotHttpCache(cache, target)).toThrow('without a readable entry');
}));

test('does not silently skip a mismatching key in a secondary stream', () => fixture(({ data, name, cache, target }) => {
  fs.writeFileSync(path.join(data, name.replace(/_0$/, '_1')), entry('1/0/ipfs://different-control/'));
  expect(() => snapshotHttpCache(cache, target)).toThrow('different keys');
}));
