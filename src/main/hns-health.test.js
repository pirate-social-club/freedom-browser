const {
  buildHnsHealthProbeHosts,
  formatHnsHealthSummary,
  probeHnsResolver,
  probeHnsChainState,
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

describe('local HNS chain metadata', () => {
  const answer = (name, text, klass = 4) => ({ name, text: [text], klass, type: 16 });
  const responses = (synced = 'false') => ({
    'chain.hnsd': { rcode: 0, answers: [answer('synced.chain.hnsd', synced), answer('height.tip.chain.hnsd', '136149'), answer('progress.chain.hnsd', '0.4')] },
    'size.pool.hnsd': { rcode: 0, answers: [answer('size.pool.hnsd', '2')] },
  });
  test('reads chain synchronization separately from website health', async () => {
    const query = jest.fn(async ({ hostname }) => responses()[hostname]);
    expect(await probeHnsChainState({ rootAddr: '127.0.0.1:25349', query })).toEqual({ synced: false, height: 136149, progress: 0.4, peers: 2 });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ klass: 4, type: 16, host: '127.0.0.1' }));
  });
  test('rejects external metadata endpoints before sending a query', async () => {
    const query = jest.fn();
    await expect(probeHnsChainState({ rootAddr: '203.0.113.10:5349', query })).rejects.toThrow('local root');
    expect(query).not.toHaveBeenCalled();
  });
  test.each(['yes', '1', '', ' true'])('rejects malformed sync value %p', async (value) => {
    await expect(probeHnsChainState({ rootAddr: '127.0.0.1:25349', query: async ({ hostname }) => responses(value)[hostname] })).rejects.toThrow('Invalid HNS');
  });
  test('rejects ordinary DNS records masquerading as internal metadata', async () => {
    const data = responses(); data['chain.hnsd'].answers[0].klass = 1;
    await expect(probeHnsChainState({ rootAddr: '127.0.0.1:25349', query: async ({ hostname }) => data[hostname] })).rejects.toThrow('Missing HNS');
  });
});
