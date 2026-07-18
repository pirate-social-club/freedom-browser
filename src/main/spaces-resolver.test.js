jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));

const originalFetch = global.fetch;

const mockResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

describe('spaces-resolver', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    delete process.env.SPACES_RESOLVER_BASE_URL;
    delete process.env.SPACES_VERIFIER_BASE_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('resolves and normalizes a proof-verified Space', async () => {
    global.fetch.mockResolvedValue(mockResponse({
      resolved: true,
      handle: '@pirate',
      canonical_handle: '@pirate',
      root_pubkey: 'resolver-pubkey',
      outpoint: 'abc123:1',
      proof_verified: true,
      proof_root_hash: 'proof-root-hash',
      accepted_anchor_height: 123456,
      accepted_anchor_block_hash: 'anchor-block-hash',
      accepted_anchor_root_hash: 'anchor-root-hash',
      control_class: 'single_holder_root',
      operation_class: 'owner_managed_namespace',
      freedom_url: 'https://app.pirate/',
      web_url: 'https://pirate.sc/',
      observation_provider: 'spaced_rpc+veritas_native',
    }));

    const { resolveSpace } = require('./spaces-resolver');
    const result = await resolveSpace('@Pirate');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://verifier.pirate.sc/spaces/resolve?handle=%40pirate',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(result).toEqual(expect.objectContaining({
      type: 'ok',
      handle: '@pirate',
      selectedUrl: 'https://app.pirate/',
      proofVerified: true,
      txid: 'abc123',
      n: 1,
    }));
  });

  test('fails closed when proof verification is absent', async () => {
    global.fetch.mockResolvedValue(mockResponse({
      resolved: true,
      handle: '@pirate',
      freedom_url: 'https://app.pirate/',
    }));

    const { resolveSpace } = require('./spaces-resolver');
    await expect(resolveSpace('@pirate')).resolves.toEqual({
      type: 'error',
      handle: '@pirate',
      reason: 'RESOLVER_UNAVAILABLE',
      message: 'The Spaces resolver is unavailable or returned an unverified response.',
    });
  });

  test('does not select a published active-content URL scheme', async () => {
    global.fetch.mockResolvedValue(mockResponse({
      resolved: true,
      handle: '@pirate',
      proof_verified: true,
      freedom_url: 'javascript:alert(1)',
      web_url: 'data:text/html,unsafe',
    }));

    const { resolveSpace } = require('./spaces-resolver');
    const result = await resolveSpace('@pirate');
    expect(result.selectedUrl).toBeNull();
  });

  test('returns not_found and honors an endpoint override', async () => {
    process.env.SPACES_RESOLVER_BASE_URL = 'https://resolver.example';
    global.fetch.mockResolvedValue(mockResponse({
      resolved: false,
      reason: 'root_not_found',
    }));

    const { resolveSpace } = require('./spaces-resolver');
    await expect(resolveSpace('@missing')).resolves.toEqual({
      type: 'not_found',
      handle: '@missing',
      reason: 'root_not_found',
      source: 'resolver',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://resolver.example/resolve?handle=%40missing',
      expect.any(Object)
    );
  });

  test('returns a generic error and rejects malformed handles', async () => {
    global.fetch.mockRejectedValue(new Error('fetch failed for https://secret.invalid'));
    const { resolveSpace } = require('./spaces-resolver');

    await expect(resolveSpace('@pirate')).resolves.toEqual({
      type: 'error',
      handle: '@pirate',
      reason: 'RESOLVER_UNAVAILABLE',
      message: 'The Spaces resolver is unavailable or returned an unverified response.',
    });
    await expect(resolveSpace('name@space')).rejects.toThrow(
      'Spaces handle must be a root label like @space'
    );
  });
});
