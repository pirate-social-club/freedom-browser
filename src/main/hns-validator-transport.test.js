const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { validateEncryptedHnsd } = require('./hns-validator-transport');

// Read these tracked bytes without executing the native artifact.
const nativeDir = path.join(__dirname, '..', '..', 'hns-bin', 'linux-x64');
const binary = fs.readFileSync(path.join(nativeDir, 'hnsd'));
const manifest = JSON.parse(fs.readFileSync(path.join(nativeDir, 'encrypted-validator.json'), 'utf8'));
function fixture(metadata = manifest, bytes = binary) {
  return { readFileSync: jest.fn((filename) => filename.endsWith('encrypted-validator.json')
    ? JSON.stringify(metadata) : bytes) };
}

test('accepts only the reviewed native artifact with its exact source and patch binding', () => {
  expect(() => validateEncryptedHnsd('/owned/hnsd', fixture())).not.toThrow();
});

test.each([
  ['schema', 2],
  ['source_commit', 'b'.repeat(40)],
  ['patch_sha256', 'c'.repeat(64)],
  ['sha256', 'd'.repeat(64)],
])('rejects changed %s provenance', (key, value) => {
  expect(() => validateEncryptedHnsd('/owned/hnsd', fixture({ ...manifest, [key]: value }))).toThrow();
});

test('a self-consistent replacement binary and manifest cannot replace the source-pinned digest', () => {
  const replacement = Buffer.from(binary);
  replacement[replacement.length - 1] ^= 1;
  const digest = createHash('sha256').update(replacement).digest('hex');
  expect(() => validateEncryptedHnsd('/owned/hnsd', fixture({ ...manifest, sha256: digest }, replacement))).toThrow();
});

test('refuses a missing or malformed native manifest', () => {
  expect(() => validateEncryptedHnsd('/owned/hnsd', { readFileSync: () => { throw new Error('ENOENT'); } })).toThrow();
  expect(() => validateEncryptedHnsd('/owned/hnsd', { readFileSync: () => 'not JSON' })).toThrow();
});
