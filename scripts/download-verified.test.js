const artifacts = require('./binary-artifacts.lock.json');
const { verifyDigest } = require('./download-verified');

describe('binary artifact lock', () => {
  test('contains only HTTPS URLs and correctly sized digests', () => {
    for (const family of [artifacts.bee, artifacts.ipfs]) {
      for (const artifact of Object.values(family.targets)) {
        expect(new URL(artifact.url).protocol).toBe('https:');
        if (artifact.sha256) expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        if (artifact.sha512) expect(artifact.sha512).toMatch(/^[a-f0-9]{128}$/);
      }
    }

    for (const artifact of Object.values(artifacts.radicle.targets)) {
      expect(artifact.mainSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.httpdSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('rejects content that does not match its digest', () => {
    expect(() => verifyDigest(Buffer.from('unexpected'), 'sha256', '0'.repeat(64))).toThrow(
      'sha256 mismatch'
    );
  });
});
