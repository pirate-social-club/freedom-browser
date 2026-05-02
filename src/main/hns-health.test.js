const {
  buildHnsHealthProbeHosts,
  formatHnsHealthSummary,
  probeHnsResolver,
} = require('./hns-health');

describe('hns-health', () => {
  test('builds compact probe host list from default and imported suffixes', () => {
    expect(buildHnsHealthProbeHosts(['.pirate', '.xn--pokmon-dva', 'xn--pokmon-dva'])).toEqual([
      'pirate',
      'app.pirate',
      'xn--pokmon-dva',
    ]);
  });

  test('probes configured recursive resolver for every host', async () => {
    const resolve4 = jest.fn(async (host) => {
      if (host === 'app.pirate') return ['173.199.93.117'];
      const error = new Error('query failed');
      error.code = 'SERVFAIL';
      throw error;
    });
    const setServers = jest.fn();

    const result = await probeHnsResolver({
      hosts: ['app.pirate', 'xn--pokmon-dva'],
      recursiveAddr: '127.0.0.1:39755',
      resolverFactory: () => ({ resolve4, setServers }),
      timeoutMs: 50,
    });

    expect(setServers).toHaveBeenCalledWith(['127.0.0.1:39755']);
    expect(resolve4).toHaveBeenCalledWith('app.pirate');
    expect(resolve4).toHaveBeenCalledWith('xn--pokmon-dva');
    expect(result.ok).toBe(false);
    expect(formatHnsHealthSummary(result)).toContain('app.pirate=173.199.93.117');
    expect(formatHnsHealthSummary(result)).toContain('xn--pokmon-dva=FAIL(SERVFAIL)');
  });
});
