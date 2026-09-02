jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

const originalFetch = global.fetch;

const mockResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

function setupMockRequest(responseBody, statusCode = 200) {
  global.fetch.mockResolvedValue(mockResponse(responseBody, statusCode));
}

function loadResolver() {
  const proxy = require('./spaces-proxy');
  const resolver = require('./spaces-resolver');
  resolver.setFabricLoader(async () => null);
  resolver.resetSpacesResolverForTests();
  return { resolver, proxy };
}

describe('spaces-resolver', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    delete process.env.SPACES_RESOLVER_BASE_URL;
    delete process.env.SPACES_VERIFIER_BASE_URL;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    try {
      const { resetSpacesProxyForTests } = require('./spaces-proxy');
      await resetSpacesProxyForTests();
    } catch {
      // proxy module may not be loaded
    }
  });

  test('resolves an existing space root through the public resolver', async () => {
    setupMockRequest({
      resolved: true,
      handle: '@space',
      canonical_handle: '@space',
      root_pubkey: 'resolver-pubkey',
      outpoint: 'abc123:1',
      proof_verified: true,
      proof_root_hash: 'proof-root-hash',
      accepted_anchor_height: 123456,
      accepted_anchor_block_hash: 'anchor-block-hash',
      accepted_anchor_root_hash: 'anchor-root-hash',
      control_class: 'single_holder_root',
      operation_class: 'owner_managed_namespace',
      web_url: null,
      observation_provider: 'spaced_rpc+veritas_native',
    });

    const { resolver } = loadResolver();
    const result = await resolver.resolveSpace('@Space');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://verifier.pirate.sc/spaces/resolve?handle=%40space',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      })
    );
    expect(result).toEqual({
      type: 'ok',
      handle: '@space',
      canonicalHandle: '@space',
      txid: 'abc123',
      n: 1,
      scriptPubkey: null,
      rootPubkey: 'resolver-pubkey',
      proofRootHash: 'proof-root-hash',
      acceptedAnchorHeight: 123456,
      acceptedAnchorBlockHash: 'anchor-block-hash',
      acceptedAnchorRootHash: 'anchor-root-hash',
      controlClass: 'single_holder_root',
      operationClass: 'owner_managed_namespace',
      freedomUrl: null,
      selectedUrl: null,
      webUrl: null,
      source: 'resolver',
      observationProvider: 'spaced_rpc+veritas_native',
      proofVerified: true,
      ipv4: null,
      port: 80,
      scheme: 'http',
      proxyUrl: null,
    });
  });

  test('returns a web target when resolver provides one', async () => {
    setupMockRequest({
      resolved: true,
      handle: '@bitcoin',
      canonical_handle: '@bitcoin',
      root_pubkey: 'resolver-pubkey',
      outpoint: 'deadbeef:2',
      proof_verified: true,
      web_url: 'https://example.com',
      observation_provider: 'spaced_rpc+veritas_native',
    });

    const { resolver } = loadResolver();
    const result = await resolver.resolveSpace('@bitcoin');

    expect(result.webUrl).toBe('https://example.com');
  });

  test('returns not_found when the resolver does not find the space', async () => {
    setupMockRequest({
      resolved: false,
      handle: '@missing',
      reason: 'root_not_found',
    });

    const { resolver } = loadResolver();
    const result = await resolver.resolveSpace('@missing');

    expect(result).toEqual({
      type: 'not_found',
      handle: '@missing',
      reason: 'root_not_found',
      source: 'resolver',
    });
  });

  test('returns resolver error details when the public endpoint fails', async () => {
    global.fetch.mockRejectedValue(new Error('fetch failed'));

    const { resolver } = loadResolver();
    const result = await resolver.resolveSpace('@pirate');

    expect(result).toEqual({
      type: 'error',
      handle: '@pirate',
      reason: 'RESOLVER_UNAVAILABLE',
      message: 'fetch failed',
    });
  });

  test('honors SPACES_RESOLVER_BASE_URL override', async () => {
    process.env.SPACES_RESOLVER_BASE_URL = 'https://resolver.example';
    setupMockRequest({
      resolved: false,
      handle: '@pirate',
      reason: 'root_not_found',
    });

    const { resolver } = loadResolver();
    await resolver.resolveSpace('@pirate');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://resolver.example/resolve?handle=%40pirate',
      expect.any(Object)
    );
  });

  test('rejects invalid handles before calling resolver', async () => {
    const { resolver } = loadResolver();

    await expect(resolver.resolveSpace('user@example.com')).rejects.toThrow(
      /dotted space/
    );
    await expect(resolver.resolveSpace('alice:secret@space')).rejects.toThrow(
      /credentials or dotted space/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('selects addr ipv4 records from Fabric and binds a proxy URL', async () => {
    const { resolver, proxy } = loadResolver();
    await proxy.startSpacesProxy();
    resolver.setFabricLoader(async () => ({
      resolve: async () => ({
        handle: 'void@space',
        toJson: () => ({
          records: [
            { type: 'txt', key: 'website', value: ['https://example.com'] },
            { type: 'addr', key: 'ipv4', value: ['203.0.113.10'] },
          ],
        }),
      }),
    }));

    const result = await resolver.resolveSpace('void@space');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      type: 'ok',
      handle: 'void@space',
      ipv4: '203.0.113.10',
      port: 80,
      scheme: 'http',
      source: 'fabric',
    }));
    expect(result.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/void%40space\/$/);
    expect(proxy.getSpacesBinding('void@space')).toEqual({
      handle: 'void@space',
      ipv4: '203.0.113.10',
      port: 80,
    });
  });

  test('falls back to the public resolver when Fabric has no ipv4 record', async () => {
    setupMockRequest({
      resolved: true,
      handle: '@space',
      canonical_handle: '@space',
      web_url: 'https://example.com',
    });
    const { resolver } = loadResolver();
    resolver.setFabricLoader(async () => ({
      resolve: async () => ({
        handle: '@space',
        toJson: () => ({
          records: [{ type: 'addr', key: 'btc', value: ['bc1qexample'] }],
        }),
      }),
    }));

    const result = await resolver.resolveSpace('@space');
    expect(result.webUrl).toBe('https://example.com');
    expect(result.source).toBe('resolver');
    expect(result.ipv4).toBeNull();
  });
});
