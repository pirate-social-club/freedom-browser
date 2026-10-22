const { createHash } = require('crypto');
const {
  HNS_PUBLIC_SUFFIXES,
  getHnsPublicSuffixes,
  isHnsHost,
  isReservedHnsRoot,
  setDynamicHnsPublicSuffixes,
} = require('./hns-hosts');
const {
  IANA_TLD_SNAPSHOT,
  IANA_TLD_SNAPSHOT_SHA256,
  IANA_TLD_SNAPSHOT_VERSION_LINE,
} = require('./hns-iana-tld-snapshot');

const snapshotLines = IANA_TLD_SNAPSHOT.split('\n');
const snapshotTlds = snapshotLines.slice(1, -1);

// The roots api-next reserves besides the ICANN snapshot
// (packages/application/src/hns-reserved-roots.ts).
const RESERVED_NON_ICANN_ROOTS = [
  'eth',
  'box',
  'wei',
  'gwei',
  'tez',
  'onion',
  'local',
  'localhost',
  'test',
  'invalid',
  'example',
  'arpa',
  'alt',
  'internal',
  'corp',
  'home',
  'mail',
  'lan',
  'intranet',
  'private',
  'localdomain',
];

describe('hns-hosts', () => {
  afterEach(() => {
    setDynamicHnsPublicSuffixes([]);
  });

  test('exports the default public HNS suffix allowlist', () => {
    expect(HNS_PUBLIC_SUFFIXES).toEqual(['.pirate']);
    expect(getHnsPublicSuffixes()).toEqual(['.pirate']);
  });

  test('classifies hostnames consistently for HNS routing', () => {
    expect(isHnsHost('pirate')).toBe(true);
    expect(isHnsHost('app.pirate')).toBe(true);
    expect(isHnsHost('unknown-single-label')).toBe(true);
    expect(isHnsHost('night-signal.clawitzer')).toBe(false);
    expect(isHnsHost('vitalik.eth')).toBe(false);
    expect(isHnsHost('google.com')).toBe(false);
    expect(isHnsHost('127.0.0.1')).toBe(false);
    expect(isHnsHost('localhost')).toBe(false);
  });

  test('extends HNS routing with imported namespace roots', () => {
    expect(setDynamicHnsPublicSuffixes(['xn--pokmon-dva'])).toEqual(['.pirate', '.xn--pokmon-dva']);
    expect(isHnsHost('xn--pokmon-dva')).toBe(true);
    expect(isHnsHost('v.xn--pokmon-dva')).toBe(true);
    expect(isHnsHost('not-imported')).toBe(true);
    expect(isHnsHost('google.com')).toBe(false);
  });

  test('bundles the IANA TLD list api-next bundles, byte for byte, under its pinned version and digest', () => {
    expect(createHash('sha256').update(IANA_TLD_SNAPSHOT, 'ascii').digest('hex')).toBe(
      IANA_TLD_SNAPSHOT_SHA256
    );
    expect(IANA_TLD_SNAPSHOT_SHA256).toBe(
      'ef731da5bd52d570d5fdf7b8737e06ed661ed65fbef60f7ad9f26063a49efb6f'
    );
    expect(snapshotLines[0]).toBe(IANA_TLD_SNAPSHOT_VERSION_LINE);
    expect(IANA_TLD_SNAPSHOT_VERSION_LINE).toBe(
      '# Version 2026102100, Last Updated Wed Oct 21 07:07:01 2026 UTC'
    );
    expect(snapshotLines.at(-1)).toBe('');
    expect(snapshotTlds.length).toBeGreaterThan(1000);
    for (const tld of snapshotTlds) {
      expect(tld).toMatch(/^(?:[A-Z]{2,63}|XN--[A-Z0-9]+(?:-[A-Z0-9]+)*)$/);
    }
    expect([...snapshotTlds].sort()).toEqual(snapshotTlds);
    expect(new Set(snapshotTlds).size).toBe(snapshotTlds.length);
  });

  test('reserves every ICANN TLD, other name systems, special-use and private-network names', () => {
    for (const tld of snapshotTlds) expect(isReservedHnsRoot(tld.toLowerCase())).toBe(true);
    for (const root of RESERVED_NON_ICANN_ROOTS) expect(isReservedHnsRoot(root)).toBe(true);
    for (const root of ['8s28', 'a18n', 'pirate', 'xn--pokmon-dva'])
      expect(isReservedHnsRoot(root)).toBe(false);
  });

  test('imported roots take LDH labels only, never a reserved root, and keep pirate built in', () => {
    const reserved = ['com', 'xn--p1ai', 'zw', ...RESERVED_NON_ICANN_ROOTS];
    expect(
      setDynamicHnsPublicSuffixes([
        '8s28',
        ...reserved,
        'under_score',
        '-lead',
        'trail-',
        'a'.repeat(64),
        'a18n',
        '.8S28',
      ])
    ).toEqual(['.pirate', '.8s28', '.a18n']);
    for (const root of reserved) expect(isHnsHost(`app.${root}`)).toBe(false);
    expect(isHnsHost('app.8s28')).toBe(true);
    expect(setDynamicHnsPublicSuffixes([])).toEqual(['.pirate']);
    expect(isHnsHost('app.pirate')).toBe(true);
  });
});
