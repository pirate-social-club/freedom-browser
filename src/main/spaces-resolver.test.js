const mockRequest = jest.fn();

jest.mock('https', () => ({
  request: mockRequest,
}));

jest.mock('http', () => ({
  request: jest.fn(),
}));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

function setupMockRequest(responseBody, statusCode = 200) {
  const res = {
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : 'Error',
    on: jest.fn((event, handler) => {
      if (event === 'data') {
        handler(JSON.stringify(responseBody));
      } else if (event === 'end') {
        handler();
      }
      return res;
    }),
  };

  const req = {
    on: jest.fn(),
    end: jest.fn(),
  };

  mockRequest.mockImplementation((_options, callback) => {
    callback(res);
    return req;
  });

  return req;
}

describe('spaces-resolver', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRequest.mockReset();
    delete process.env.SPACES_RESOLVER_BASE_URL;
    delete process.env.SPACES_VERIFIER_BASE_URL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

    const { resolveSpace } = require('./spaces-resolver');
    const result = await resolveSpace('@Space');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'verifier.pirate.sc',
        path: '/spaces/resolve?handle=%40space',
        method: 'GET',
        rejectUnauthorized: false,
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      }),
      expect.any(Function)
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

    const { resolveSpace } = require('./spaces-resolver');
    const result = await resolveSpace('@bitcoin');

    expect(result.webUrl).toBe('https://example.com');
  });

  test('returns not_found when the resolver does not find the space', async () => {
    setupMockRequest({
      resolved: false,
      handle: '@missing',
      reason: 'root_not_found',
    });

    const { resolveSpace } = require('./spaces-resolver');
    const result = await resolveSpace('@missing');

    expect(result).toEqual({
      type: 'not_found',
      handle: '@missing',
      reason: 'root_not_found',
      source: 'resolver',
    });
  });

  test('returns resolver error details when the public endpoint fails', async () => {
    const req = {
      on: jest.fn((event, handler) => {
        if (event === 'error') {
          handler(new Error('fetch failed'));
        }
        return req;
      }),
      end: jest.fn(),
    };

    mockRequest.mockReturnValue(req);

    const { resolveSpace } = require('./spaces-resolver');
    const result = await resolveSpace('@pirate');

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

    const { resolveSpace } = require('./spaces-resolver');
    await resolveSpace('@pirate');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'resolver.example',
      }),
      expect.any(Function)
    );
  });

  test('rejects invalid handles before calling resolver', async () => {
    const { resolveSpace } = require('./spaces-resolver');

    await expect(resolveSpace('name@space')).rejects.toThrow(
      'Spaces handle must be a root label like @space'
    );
    expect(mockRequest).not.toHaveBeenCalled();
  });
});