jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const { execFileSync } = require('child_process');
const { parseChecksums, validateArchive } = require('./fetch-hns-test-fixture');

describe('HNS regtest fixture trust boundary', () => {
  test('parses a strict basename-only checksum manifest', () => {
    const hash = 'a'.repeat(64);
    expect(parseChecksums(`${hash}  hnsd-regtest\n`).get('hnsd-regtest')).toBe(hash);
    expect(() => parseChecksums(`${hash}  nested/hnsd-regtest\n`)).toThrow(
      'Invalid checksum line',
    );
  });

  test('accepts only the single test binary', () => {
    execFileSync.mockReturnValue('./\n./hnsd-regtest\n');
    expect(() => validateArchive('/fixture.tar.gz')).not.toThrow();

    execFileSync.mockReturnValue('./\n./hnsd-regtest\n./fingertipd\n');
    expect(() => validateArchive('/fixture.tar.gz')).toThrow(
      'Unexpected test archive entry: ./fingertipd',
    );
  });

  test('rejects an archive without hnsd-regtest', () => {
    execFileSync.mockReturnValue('./\n');
    expect(() => validateArchive('/fixture.tar.gz')).toThrow(
      'Test archive is missing ./hnsd-regtest',
    );
  });
});
