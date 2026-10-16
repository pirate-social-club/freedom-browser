const {
  buildHnsHealthProbeHosts,
  formatHnsHealthSummary,
  probeHnsResolver,
  probeHnsValidator,
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
  const TIP_HASH = '0000000000000000a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
  const responses = (synced = 'false', tipHash = TIP_HASH) => ({
    'chain.hnsd': { rcode: 0, answers: [answer('synced.chain.hnsd', synced), answer('height.tip.chain.hnsd', '136149'), answer('progress.chain.hnsd', '0.4'), answer('hash.tip.chain.hnsd', tipHash), answer('time.tip.chain.hnsd', '1760000000')] },
    'size.pool.hnsd': { rcode: 0, answers: [answer('size.pool.hnsd', '2')] },
  });
  test('reads chain synchronization separately from website health', async () => {
    const query = jest.fn(async ({ hostname }) => responses()[hostname]);
    expect(await probeHnsChainState({ rootAddr: '127.0.0.1:25349', query })).toEqual({ synced: false, height: 136149, progress: 0.4, peers: 2, tipHash: TIP_HASH, tipTime: 1760000000 });
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
  test.each(['', 'not-a-hash', `${TIP_HASH}00`])('rejects malformed tip hash %p', async (value) => {
    await expect(probeHnsChainState({ rootAddr: '127.0.0.1:25349', query: async ({ hostname }) => responses('true', value)[hostname] })).rejects.toThrow('Invalid HNS');
  });
  test('rejects ordinary DNS records masquerading as internal metadata', async () => {
    const data = responses(); data['chain.hnsd'].answers[0].klass = 1;
    await expect(probeHnsChainState({ rootAddr: '127.0.0.1:25349', query: async ({ hostname }) => data[hostname] })).rejects.toThrow('Missing HNS');
  });
});

describe('probeHnsValidator refuses anything but complete authenticated answers', () => {
  const good = () => ({
    1: { rcode: 0, authenticated: true, truncated: false, answers: [{ type: 1, address: '81.15.150.167' }] },
    28: { rcode: 0, authenticated: true, truncated: false, answers: [] },
    52: { rcode: 0, authenticated: true, truncated: false, answers: [{ type: 52 }] },
  });
  const probe = (data) => probeHnsValidator({ recursiveAddr: '127.0.0.1:25350', query: async ({ type }) => data[type] });

  test('accepts authenticated A and TLSA answers', async () => {
    await expect(probe(good())).resolves.toEqual({ ok: true });
  });

  test.each([
    ['unauthenticated', (d) => { d[52].authenticated = false; }],
    ['truncated', (d) => { d[1].truncated = true; }],
    ['SERVFAIL', (d) => { d[28].rcode = 2; }],
    ['missing TLSA', (d) => { d[52].answers = []; }],
    ['no address', (d) => { d[1].answers = []; }],
  ])('refuses a %s answer', async (_label, damage) => {
    const data = good();
    damage(data);
    await expect(probe(data)).resolves.toEqual({ ok: false });
  });

  test('a query that does not complete makes the probe throw, distinct from a refused answer', async () => {
    const timeout = Object.assign(new Error('DNS query timed out for app.pirate'), { code: 'ETIMEOUT' });
    await expect(probeHnsValidator({ recursiveAddr: '127.0.0.1:25350', query: async ({ type }) => {
      if (type === 52) throw timeout;
      return good()[type];
    } })).rejects.toBe(timeout);
  });

  test('only an owned loopback validator is probed', async () => {
    await expect(probeHnsValidator({ recursiveAddr: '10.0.0.1:53', query: jest.fn() })).rejects.toThrow('Owned validator required');
  });
});

