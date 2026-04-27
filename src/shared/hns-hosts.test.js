const { HNS_PUBLIC_SUFFIXES, isHnsHost } = require('./hns-hosts');

describe('hns-hosts', () => {
  test('exports the default public HNS suffix allowlist', () => {
    expect(HNS_PUBLIC_SUFFIXES).toEqual(['.pirate']);
  });

  test('classifies hostnames consistently for HNS routing', () => {
    expect(isHnsHost('pirate')).toBe(true);
    expect(isHnsHost('app.pirate')).toBe(true);
    expect(isHnsHost('night-signal.clawitzer')).toBe(false);
    expect(isHnsHost('vitalik.eth')).toBe(false);
    expect(isHnsHost('google.com')).toBe(false);
    expect(isHnsHost('127.0.0.1')).toBe(false);
    expect(isHnsHost('localhost')).toBe(false);
  });
});
