const {
  ACCEPT_CERTIFICATE,
  USE_CHROMIUM_VERIFICATION,
  chainContainsFingerprint,
  clearHnsCertificateVerifier,
  configureHnsCertificateVerifier,
  createCertificateVerifyProc,
  loadCaFingerprint,
} = require('./hns-cert-verifier');

describe('HNS certificate verifier', () => {
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
    const verify = createCertificateVerifyProc('ROOT');
    const certificate = { fingerprint: 'LEAF', issuerCert: { fingerprint: 'ROOT' } };
    const callback = jest.fn();
    verify({ hostname: 'app.pirate', certificate }, callback);
    expect(callback).toHaveBeenLastCalledWith(ACCEPT_CERTIFICATE);

    verify({ hostname: 'example.com', certificate }, callback);
    expect(callback).toHaveBeenLastCalledWith(USE_CHROMIUM_VERIFICATION);

    verify({ hostname: 'app.pirate', certificate: { fingerprint: 'UNPINNED' } }, callback);
    expect(callback).toHaveBeenLastCalledWith(USE_CHROMIUM_VERIFICATION);
  });

  test('installs and clears the verifier on the profile session', () => {
    const targetSession = { setCertificateVerifyProc: jest.fn() };
    class Certificate { fingerprint = 'AA:BB'; }
    expect(configureHnsCertificateVerifier(targetSession, '/ca.pem', {
      readFile: () => 'PEM',
      Certificate,
    })).toBe('AA:BB');
    expect(targetSession.setCertificateVerifyProc).toHaveBeenCalledWith(expect.any(Function));
    clearHnsCertificateVerifier(targetSession);
    expect(targetSession.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
  });
});
