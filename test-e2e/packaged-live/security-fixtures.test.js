const { Contract, JsonRpcProvider } = require('ethers');
const { CASES, REVERSE, UR, answerRpc, startSecurityFixture, isolatedNetworkConfig } = require('./security-fixtures');

test('controlled RPC responses decode through the real ethers transport and contract ABI', async () => {
  const fixture = await startSecurityFixture();
  const provider = new JsonRpcProvider(fixture.origin, 1, { staticNetwork: true });
  try {
    expect(await provider.getBlockNumber()).toBe(256);
    const block = await provider.getBlock(248);
    expect(block.number).toBe(248);
    expect(block.hash).toBe('0x' + '55'.repeat(32));
    const resolver = new Contract(UR, REVERSE, provider);
    for (const entry of CASES) {
      const [name] = await resolver.reverse(entry.address, 60);
      expect(name).toBe(entry.name);
    }
    expect(fixture.observations.reverse).toEqual(CASES.map((entry) => entry.address));
    expect(fixture.observations.malformed).toBe(0);
  } finally {
    provider.destroy();
    await fixture.close();
  }
});

test('the fixture refuses broadcasts, unknown contracts and wrong reverse coin types', () => {
  const seen = { methods: [], reverse: [] };
  for (const request of [
    { id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] },
    { id: 2, method: 'eth_call', params: [{ to: CASES[0].address, data: '0x' }] },
    { id: 3, method: 'eth_call', params: [{ to: UR,
      data: REVERSE.encodeFunctionData('reverse', [CASES[0].address, 61]) }] },
  ]) {
    expect(answerRpc(request, seen)).toMatchObject({ id: request.id, error: { code: -32601 } });
  }
  expect(seen.reverse).toEqual([]);
});

test('isolated configuration removes every builtin endpoint and selects only the local RPC', () => {
  const config = isolatedNetworkConfig('http://127.0.0.1:12345', { one: {}, two: {} });
  expect(config.removedSources).toEqual(['one', 'two']);
  expect(config.networks[1].verification.order).toEqual(['direct']);
  expect(config.networks[1].access.broadcastOrder).toEqual([]);
  expect(Object.values(config.endpointSources).map((source) => source.coverage[1]))
    .toEqual(['http://127.0.0.1:12345']);
});
