const {
  buildPacHnsRootMap,
  getHnsPublicRoots,
  getHnsPublicSuffixes,
  isHnsHost,
  normalizeHnsPublicSuffix,
  refreshHnsPublicSuffixes,
  setDynamicHnsPublicSuffixes,
  subscribeHnsHostPolicy,
} = require('./hns-hosts');

describe('HNS host classification', () => {
  afterEach(() => setDynamicHnsPublicSuffixes([]));

  test('admits valid single-label and configured namespace hosts only', () => {
    expect(isHnsHost('pirate')).toBe(true);
    expect(isHnsHost('app.pirate')).toBe(true);
    expect(isHnsHost('unknown-single-label')).toBe(true);
    expect(isHnsHost('google.com')).toBe(false);
    expect(isHnsHost('localhost')).toBe(false);
    expect(isHnsHost('127.0.0.1')).toBe(false);
    expect(isHnsHost('bad_label')).toBe(false);
    expect(isHnsHost('bad_label.pirate')).toBe(false);
  });

  test('normalizes, validates, and deduplicates imported roots', () => {
    expect(normalizeHnsPublicSuffix('..XN--Pokmon-dva.')).toBe('.xn--pokmon-dva');
    expect(normalizeHnsPublicSuffix('-invalid')).toBeNull();
    expect(setDynamicHnsPublicSuffixes([
      'xn--pokmon-dva',
      '.XN--Pokmon-dva.',
      'bad_label',
    ])).toEqual(['.pirate', '.xn--pokmon-dva']);
    expect(getHnsPublicRoots()).toEqual(['pirate', 'xn--pokmon-dva']);
    expect(isHnsHost('v.xn--pokmon-dva')).toBe(true);
  });

  test('builds a compact PAC root lookup instead of repeated suffix expressions', () => {
    setDynamicHnsPublicSuffixes(['xn--pokmon-dva']);
    expect(buildPacHnsRootMap()).toBe('{"pirate":1,"xn--pokmon-dva":1}');
  });

  test('refreshes imported roots over normal WebPKI with timeout cancellation', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ namespaces: [
        { root_label: 'xn--pokmon-dva' },
        { root_label: 'bad_label' },
      ] }),
    }));

    await expect(refreshHnsPublicSuffixes({ fetchImpl })).resolves.toEqual([
      '.pirate',
      '.xn--pokmon-dva',
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.pirate.sc/public-namespaces',
      expect.objectContaining({
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  test('keeps the prior admission set when refresh fails', async () => {
    setDynamicHnsPublicSuffixes(['existing']);
    await expect(refreshHnsPublicSuffixes({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    })).rejects.toThrow('public namespace fetch failed with 503');
    expect(getHnsPublicSuffixes()).toEqual(['.pirate', '.existing']);
  });

  test('notifies policy subscribers only when the effective imported set changes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeHnsHostPolicy(listener);
    setDynamicHnsPublicSuffixes(['new-root']);
    setDynamicHnsPublicSuffixes(['new-root']);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setDynamicHnsPublicSuffixes(['other-root']);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
