const chains = require('./chains.json');
const tokens = require('./tokens.json');

// Shape-of-the-shipped-data tests for chains.json + tokens.json.
//
// The network-registry unit tests mock these files via in-memory fixtures
// (see src/main/networks/network-registry.test.js), so they don't notice
// when a real builtin entry regresses. These tests cover the actual files
// that ship with the app.

describe('chains.json (builtin chains)', () => {
  test.each(['1', '100', '8453'])('chain %s is builtin with the required fields', (cid) => {
    const c = chains[cid];
    expect(c).toBeTruthy();
    expect(c.chainId).toBe(Number(cid));
    expect(c.builtin).toBe(true);
    expect(typeof c.name).toBe('string');
    expect(typeof c.nativeSymbol).toBe('string');
    expect(typeof c.blockExplorer).toBe('string');
    expect(c.verification?.primary).toEqual(expect.any(String));
  });

  test('chainIdHex matches chainId', () => {
    for (const c of Object.values(chains)) {
      if (!c.chainIdHex) continue;
      expect(parseInt(c.chainIdHex, 16)).toBe(c.chainId);
    }
  });
});

describe('tokens.json (builtin tokens)', () => {
  // x402 v1 ships USDC on Base / Ethereum mainnet. These entries are
  // the asset allowlist the payment interstitial will trust; a
  // regression here is a security regression.
  test.each([
    [1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    [8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  ])('USDC on chain %s is builtin with 6 decimals', (chainId, address) => {
    const t = tokens[`${chainId}:${address}`];
    expect(t).toBeTruthy();
    expect(t.symbol).toBe('USDC');
    expect(t.decimals).toBe(6);
    expect(t.chainId).toBe(chainId);
    expect(t.address).toBe(address);
    expect(t.builtin).toBe(true);
  });

  test('Base has a native token entry', () => {
    expect(tokens['8453:native']).toMatchObject({ chainId: 8453, symbol: 'ETH', decimals: 18 });
  });

  // Bridged USDC.e on Gnosis is a separate asset (different symbol +
  // contract from native USDC on Eth/Base). Carried in the allowlist
  // for x402 multi-accept quotes — merchants commonly offer Base USDC
  // + Gnosis USDC.e as alternates.
  test('USDC.e on Gnosis is builtin with 6 decimals', () => {
    const key = '100:0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';
    const t = tokens[key];
    expect(t).toBeTruthy();
    expect(t.symbol).toBe('USDC.e');
    expect(t.decimals).toBe(6);
    expect(t.chainId).toBe(100);
    expect(t.builtin).toBe(true);
  });
});
