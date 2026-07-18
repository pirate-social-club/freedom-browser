const {
  ACCEPT_CERTIFICATE,
  USE_CHROMIUM_VERIFICATION,
  chainContainsFingerprint,
  clearHnsCertificateVerifier,
  configureHnsCertificateVerifier,
  createCertificateVerifyProc,
  leafMatchesHostAndValidity,
  loadCaFingerprint,
} = require('./hns-cert-verifier');

describe('HNS certificate verifier', () => {
  class ValidLeaf {
    validFrom = '2026-01-01T00:00:00.000Z';
    validTo = '2027-01-01T00:00:00.000Z';
    checkHost(hostname) { return hostname === 'app.pirate'; }
  }
  const leafOptions = {
    Certificate: ValidLeaf,
    now: () => Date.parse('2026-07-18T00:00:00.000Z'),
  };
  test('loads the exact fingerprint from the helper-provided CA file', () => {
    const readFile = jest.fn(() => 'test PEM');
    class Certificate { fingerprint = 'AA:BB:CC'; }
    expect(loadCaFingerprint('/profile/hns-data/ca.pem', { readFile, Certificate }))
      .toBe('AA:BB:CC');
    expect(readFile).toHaveBeenCalledWith('/profile/hns-data/ca.pem', 'utf8');
  });

  test('walks a bounded issuer chain and handles cycles', () => {
    const root = { fingerprint: 'ROOT' };
    const leaf = { fingerprint: 'LEAF', issuerCert: root };
    root.issuerCert = root;
    expect(chainContainsFingerprint(leaf, 'ROOT')).toBe(true);
    expect(chainContainsFingerprint(leaf, 'OTHER')).toBe(false);
  });

  test('accepts a pinned chain only for an admitted HNS hostname', () => {
    const verify = createCertificateVerifyProc('ROOT', leafOptions);
    const certificate = {
      data: 'leaf PEM',
      fingerprint: 'LEAF',
      issuerCert: { fingerprint: 'ROOT' },
    };
    const callback = jest.fn();
    verify({ hostname: 'app.pirate', certificate }, callback);
    expect(callback).toHaveBeenLastCalledWith(ACCEPT_CERTIFICATE);

    verify({ hostname: 'example.com', certificate }, callback);
    expect(callback).toHaveBeenLastCalledWith(USE_CHROMIUM_VERIFICATION);

    verify({ hostname: 'app.pirate', certificate: { fingerprint: 'UNPINNED' } }, callback);
    expect(callback).toHaveBeenLastCalledWith(USE_CHROMIUM_VERIFICATION);
  });

  test('requires hostname match and current validity before overriding Chromium', () => {
    expect(leafMatchesHostAndValidity({
      hostname: 'app.pirate',
      certificate: { data: 'leaf PEM' },
    }, leafOptions)).toBe(true);
    expect(leafMatchesHostAndValidity({
      hostname: 'other.pirate',
      certificate: { data: 'leaf PEM' },
    }, leafOptions)).toBe(false);

    class ExpiredLeaf extends ValidLeaf {
      validTo = '2026-01-02T00:00:00.000Z';
    }
    expect(leafMatchesHostAndValidity({
      hostname: 'app.pirate',
      certificate: { data: 'leaf PEM' },
    }, { ...leafOptions, Certificate: ExpiredLeaf })).toBe(false);
  });

  test('is the sole source owner of Electron certificate verification', () => {
    const path = require('path');
    const sourceFiles = (directory) => require('fs').readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(absolute);
        return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
      });
    const offenders = sourceFiles(__dirname)
      .filter((file) => !file.endsWith('.test.js'))
      .filter((file) => path.basename(file) !== 'hns-cert-verifier.js')
      .filter((file) => /\.setCertificateVerifyProc\s*\(/.test(require('fs').readFileSync(file, 'utf8')))
      .map((file) => path.relative(__dirname, file));
    expect(offenders).toEqual([]);
  });

  test('installs and clears the verifier on the profile session', () => {
    const targetSession = { setCertificateVerifyProc: jest.fn() };
    class Certificate { fingerprint = 'AA:BB'; }
    expect(configureHnsCertificateVerifier(targetSession, '/ca.pem', {
      readFile: () => 'PEM',
      Certificate,
      now: leafOptions.now,
    })).toBe('AA:BB');
    expect(targetSession.setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function));
    clearHnsCertificateVerifier(targetSession);
    expect(targetSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
  });
});
