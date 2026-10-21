// Unit coverage for the pure parts of installed-acceptance.js: the readers the
// installed retrieval specs judge evidence with. The specs themselves need the
// installed browser and the network; this pins the parsing and the decisions,
// so a regression shows up in the fast unit suite.
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  processTable,
  parseProcNetTcp,
  digestMap,
  nativeDigestSource,
  expectedNativeDigests,
  gateLiveSpec,
  DIGESTS_VAR,
  CALIBRATION_VAR,
  ACCEPTANCE_VAR,
  cidV1Bytes,
  pinnedReferences,
  errorPageParams,
  isClearedState,
  progressPhase,
  progressItemsFor,
  phaseOrderEvidence,
  classifyRequestUrls,
} = require('./installed-acceptance');

// Runs `fn` with exactly these mode variables set (undefined unsets one), and
// restores the environment afterwards.
const MODE_VARS = ['FREEDOM_EXPECTED_NATIVE_DIGESTS', 'FREEDOM_E2E_CALIBRATION', 'FREEDOM_E2E_ACCEPTANCE', 'FREEDOM_E2E_EXECUTABLE', 'FREEDOM_E2E_DEMO_LIVE'];
function withEnv(values, fn) {
  const saved = Object.fromEntries(MODE_VARS.map((name) => [name, process.env[name]]));
  try {
    for (const name of MODE_VARS) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

(process.platform === 'linux' ? describe : describe.skip)('processTable', () => {
  it('sees this test process and its executable', () => {
    const self = processTable().get(process.pid);
    expect(self.exe).toBe(fs.realpathSync(process.execPath));
  });
});

describe('parseProcNetTcp', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:0661 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:0661 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0000000000000000 20 4 30 10 -1',
    '',
  ].join('\n');

  it('reads the local port, state and inode of each socket', () => {
    expect(parseProcNetTcp(table, 4)).toEqual([
      { family: 4, address: '0100007F', port: 1633, state: '0A', inode: 4242 },
      { family: 4, address: '0100007F', port: 1633, state: '01', inode: 4343 },
    ]);
  });
});

describe('expected native digests', () => {
  const ant = 'a'.repeat(64);
  const ipfs = 'b'.repeat(64);

  it('reads an inventory and a flat map alike, ignoring non-digests', () => {
    const inventory = {
      files: [
        { path: 'resources/ant-bin/antd', sha256: ant },
        { path: 'freedom' },
        { path: 'resources/freedom-ipfs-node/freedom_ipfs_native.node', sha256: ipfs },
      ],
    };
    expect([...digestMap(inventory)]).toEqual([
      ['resources/ant-bin/antd', ant],
      ['resources/freedom-ipfs-node/freedom_ipfs_native.node', ipfs],
    ]);
    expect([...digestMap({ description: 'baseline', 'resources/ant-bin/antd': ant })]).toEqual([
      ['resources/ant-bin/antd', ant],
    ]);
  });

  it('takes the named inspection input only in a calibration run, and fails when a digest is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-acceptance-'));
    const file = path.join(dir, 'digests.json');
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          'resources/ant-bin/antd': ant,
          'resources/freedom-ipfs-node/freedom_ipfs_native.node': ipfs,
        })
      );
      withEnv({ [DIGESTS_VAR]: file, [CALIBRATION_VAR]: '1' }, () => {
        expect(expectedNativeDigests()).toEqual({
          source: file,
          kind: 'calibration-override',
          calibration: true,
          acceptance: false,
          antd: ant,
          ipfsAddon: ipfs,
        });
        fs.writeFileSync(file, JSON.stringify({ 'resources/ant-bin/antd': ant }));
        expect(() => expectedNativeDigests()).toThrow(/freedom_ipfs_native\.node/);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails at once when the override is set without the calibration flag', () => {
    withEnv({ [DIGESTS_VAR]: '/nonexistent/digests.json' }, () => {
      expect(() => nativeDigestSource()).toThrow(/FREEDOM_EXPECTED_NATIVE_DIGESTS is set without FREEDOM_E2E_CALIBRATION=1/);
      expect(() => expectedNativeDigests()).toThrow(/without FREEDOM_E2E_CALIBRATION=1/);
    });
    withEnv({ [DIGESTS_VAR]: '/nonexistent/digests.json', [CALIBRATION_VAR]: '0' }, () => {
      expect(() => nativeDigestSource()).toThrow(/without FREEDOM_E2E_CALIBRATION=1/);
    });
  });

  it('refuses the override, and the calibration flag, in acceptance mode', () => {
    withEnv({ [DIGESTS_VAR]: '/nonexistent/digests.json', [ACCEPTANCE_VAR]: '1' }, () => {
      expect(() => nativeDigestSource()).toThrow(/acceptance mode \(FREEDOM_E2E_ACCEPTANCE=1\) refuses it/);
    });
    withEnv({ [CALIBRATION_VAR]: '1', [ACCEPTANCE_VAR]: '1' }, () => {
      expect(() => nativeDigestSource()).toThrow(/cannot be a calibration run/);
    });
    withEnv({ [ACCEPTANCE_VAR]: '1' }, () => {
      expect(nativeDigestSource()).toMatchObject({ kind: 'inventory', acceptance: true, calibration: false });
    });
  });

  it('defaults to the inventory, which pins both files', () => {
    withEnv({}, () => {
      const digests = expectedNativeDigests();
      expect(digests.kind).toBe('inventory');
      expect(digests.source).toMatch(/scripts[\\/]linux-native-inventory\.json$/);
      expect(digests.antd).toMatch(/^[0-9a-f]{64}$/);
      expect(digests.ipfsAddon).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

describe('gateLiveSpec', () => {
  // A stand-in for Playwright's `test` that records what the gate registers.
  const fakeTest = () => {
    const calls = { skips: [], hooks: [] };
    return {
      calls,
      skip: (condition, reason) => calls.skips.push({ condition, reason }),
      beforeEach: (fn) => calls.hooks.push(fn),
    };
  };
  const gate = { flag: 'FREEDOM_E2E_DEMO_LIVE', purpose: 'to run the demo' };

  it('skips, as before, outside acceptance mode', () => {
    withEnv({}, () => {
      const test = fakeTest();
      gateLiveSpec(test, gate);
      expect(test.calls.skips).toEqual([
        { condition: true, reason: 'set FREEDOM_E2E_DEMO_LIVE=1 to run the demo' },
        { condition: false, reason: 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary' },
      ]);
      expect(test.calls.hooks).toEqual([]);
    });
    withEnv({ FREEDOM_E2E_DEMO_LIVE: '1' }, () => {
      const test = fakeTest();
      gateLiveSpec(test, gate);
      expect(test.calls.skips.map((skip) => skip.condition)).toEqual([false, true]);
    });
  });

  it('fails instead of skipping in acceptance mode', () => {
    withEnv({ [ACCEPTANCE_VAR]: '1' }, () => {
      const test = fakeTest();
      gateLiveSpec(test, gate);
      expect(test.calls.skips).toEqual([]);
      expect(test.calls.hooks).toHaveLength(1);
      expect(() => test.calls.hooks[0]()).toThrow(/FREEDOM_E2E_DEMO_LIVE=1 is not set; FREEDOM_E2E_EXECUTABLE is not set/);
    });
    withEnv({ [ACCEPTANCE_VAR]: '1', FREEDOM_E2E_DEMO_LIVE: '1', FREEDOM_E2E_EXECUTABLE: '/opt/Freedom/freedom', [DIGESTS_VAR]: '/x.json' }, () => {
      const test = fakeTest();
      gateLiveSpec(test, gate);
      expect(() => test.calls.hooks[0]()).toThrow(/FREEDOM_EXPECTED_NATIVE_DIGESTS is set/);
    });
    withEnv({ [ACCEPTANCE_VAR]: '1', FREEDOM_E2E_DEMO_LIVE: '1', FREEDOM_E2E_EXECUTABLE: '/opt/Freedom/freedom' }, () => {
      const test = fakeTest();
      gateLiveSpec(test, gate);
      expect(() => test.calls.hooks[0]()).not.toThrow();
    });
  });
});

describe('cidV1Bytes', () => {
  it('decodes a base32 CIDv1 to the binary form freedom-ipfs keys blocks by', () => {
    expect(cidV1Bytes('bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m').toString('hex')).toBe(
      '01701220b7fe081ef41160a57b591356186076e5eec77402385325bc1a0816b5bb764adb'
    );
  });

  it('refuses a CIDv0 rather than guessing', () => {
    expect(() => cidV1Bytes('QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o')).toThrow(/CIDv1/);
  });
});

describe('pinned references', () => {
  const refs = pinnedReferences();

  it('pins two Swarm references and two IPFS CIDs, each with bytes from two or more sources', () => {
    for (const entry of [refs.swarm.A, refs.swarm.B, refs.ipfs.A, refs.ipfs.B]) {
      expect(entry.expected.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(entry.expected.length)).toBe(true);
      const agreeing = entry.sources.filter(
        (source) => source.sha256 === entry.expected.sha256 && source.length === entry.expected.length
      );
      expect(new Set(agreeing.map((source) => new URL(source.url).hostname)).size).toBeGreaterThanOrEqual(2);
    }
    expect(refs.swarm.A.reference).toMatch(/^[0-9a-f]{64}$/);
    expect(refs.swarm.B.reference).toMatch(/^[0-9a-f]{64}$/);
    expect(refs.swarm.A.reference).not.toBe(refs.swarm.B.reference);
    expect(refs.ipfs.A.cid).not.toBe(refs.ipfs.B.cid);
    expect(refs.swarm.A.expected.path).toMatch(/^\//);
  });

  it('records the postage batch lifetime as not established rather than inventing one', () => {
    expect(refs.swarm.postageBatches.status).toBe('not established');
    expect(refs.swarm.postageBatches.tried.length).toBeGreaterThan(0);
  });
});

describe('errorPageParams', () => {
  it("reads Freedom's error page and nothing else", () => {
    const href =
      'file:///opt/Freedom/resources/app.asar/src/renderer/pages/error.html?error=ERR_CONNECTION_REFUSED&url=bzz%3A%2F%2Fab&protocol=swarm&retry=bzz%3A%2F%2Fab';
    expect(errorPageParams(href)).toEqual({ error: 'ERR_CONNECTION_REFUSED', url: 'bzz://ab', protocol: 'swarm', retry: 'bzz://ab' });
    expect(errorPageParams('bzz://ab/')).toBeNull();
    expect(errorPageParams(null)).toBeNull();
  });
});

describe('isClearedState', () => {
  it('accepts only what clearService leaves', () => {
    expect(isClearedState({ mode: 'none', api: null, gateway: null })).toBe(true);
    expect(isClearedState({ mode: 'reused', api: 'http://127.0.0.1:1633', gateway: 'http://127.0.0.1:1633' })).toBe(false);
    expect(isClearedState({ mode: 'none', api: 'http://127.0.0.1:1633', gateway: null })).toBe(false);
    expect(isClearedState({ mode: 'bundled', api: null, gateway: null })).toBe(false);
  });
});

describe('IPFS progress evidence', () => {
  const cid = 'bafyexample';
  const event = (id, phase, extra = {}) => ({
    list: 'events',
    item: { event_id: id, request_id: 1, path: `/ipfs/${cid}/`, phase, ...extra },
  });

  it('normalizes phase names the way the renderer does', () => {
    expect(progressPhase({ phase: 'Fetching-HTTP provider' })).toBe('fetching_http_provider');
    expect(progressPhase({ event: 'cache_hit' })).toBe('cache_hit');
    expect(progressPhase({})).toBe('');
  });

  it("keeps only the events of the CID's requests, in the node's order", () => {
    const collected = [
      event(3, 'fetching_bitswap'),
      { list: 'active', item: { request_id: 1, path: `/ipfs/${cid}/`, phase: 'provider_lookup' } },
      event(1, 'cache_miss'),
      { list: 'events', item: { event_id: 2, request_id: 9, path: '/ipfs/other/', phase: 'cache_hit' } },
    ];
    expect(progressItemsFor(collected, cid).map(({ item }) => item.event_id)).toEqual([1, 3]);
  });

  it('requires a cache miss, then a fetch, with no cache hit before the fetch', () => {
    const cold = phaseOrderEvidence([event(1, 'checking_cache'), event(2, 'cache_miss'), event(3, 'fetching_http_provider')]);
    expect(cold).toMatchObject({ cacheMissAt: 1, fetchAt: 2, fetchPhase: 'fetching_http_provider', cacheHitBeforeFetch: false });

    const warm = phaseOrderEvidence([event(1, 'cache_hit'), event(2, 'cache_miss'), event(3, 'fetching_bitswap')]);
    expect(warm.cacheHitBeforeFetch).toBe(true);

    const noMiss = phaseOrderEvidence([event(1, 'checking_cache'), event(2, 'fetching_http_provider', { raw_phase: 'http_provider_race' })]);
    expect(noMiss).toMatchObject({ cacheMissAt: null, fetchAt: null, firstFetchAt: 1, firstFetchPhase: 'fetching_http_provider' });
    expect(noMiss.rawPhases).toEqual([null, 'http_provider_race']);
  });

  it("records the addon's real cold sequence: checking_cache, a fetch, then block_store_put", () => {
    const cold = phaseOrderEvidence([
      event(1, 'checking_cache'),
      event(2, 'provider_lookup'),
      event(3, 'fetching_http_provider'),
      event(4, 'block_store_put'),
    ]);
    expect(cold).toMatchObject({ checkingCacheAt: 0, firstFetchAt: 2, blockStorePutAt: 3, cacheHits: 0 });

    const storedBeforeFetch = phaseOrderEvidence([event(1, 'block_store_put'), event(2, 'fetching_bitswap')]);
    expect(storedBeforeFetch.blockStorePutAt).toBeNull();

    const warm = phaseOrderEvidence([event(1, 'checking_cache'), event(2, 'cache_hit')]);
    expect(warm).toMatchObject({ firstFetchAt: null, blockStorePutAt: null, cacheHits: 1 });
  });
});

describe('classifyRequestUrls', () => {
  it('flags public gateway hosts, gateway paths, subdomain gateways and pinned references, never loopback', () => {
    const ref = 'c9890fb248c99015bb05b728d14a268d66b784f73d2e4fb28ac6c45696dcbeac';
    const result = classifyRequestUrls(
      [
        'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
        'https://bzz.link/bzz/dbec11c4/video.mp4',
        'https://example.org/ipfs/bafy/',
        'https://bafy.ipfs.example.net/',
        `https://example.com/?q=${ref}`,
        `http://127.0.0.1:1633/bzz/${ref}/`,
        'file:///opt/Freedom/resources/app.asar/src/renderer/pages/home.html',
      ],
      [ref]
    );
    expect(result.requests).toBe(7);
    expect(result.schemes).toEqual({ 'https:': 5, 'http:': 1, 'file:': 1 });
    expect(result.gatewayRequests).toEqual([
      { url: 'https://bzz.link/bzz/dbec11c4/video.mp4', reasons: ['public gateway host', 'gateway path'] },
      { url: 'https://example.org/ipfs/bafy/', reasons: ['gateway path'] },
      { url: 'https://bafy.ipfs.example.net/', reasons: ['subdomain gateway'] },
      { url: `https://example.com/?q=${ref}`, reasons: ['names a pinned reference'] },
    ]);
    expect(result.hosts).not.toContain('127.0.0.1');
  });
});
