// Controlled loopback data for installed acceptance; never an on-chain claim.
const http = require('http');
const { Interface } = require('ethers');

const REVERSE = new Interface([
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)',
]);
const UR = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee';
const RESOLVER = '0x' + '22'.repeat(20);
const CASES = [
  { address: '0x' + '11'.repeat(20), name: 'portal.eth', valid: true },
  { address: '0x' + '33'.repeat(20), name: 'portaI.eth', valid: false },
  { address: '0x' + '44'.repeat(20), name: 'bad\u200b.eth', valid: false },
];

function answerRpc(request, observations) {
  const { id, method, params = [] } = request;
  observations.methods.push(method);
  let result;
  switch (method) {
    case 'eth_chainId': result = '0x1'; break;
    case 'eth_blockNumber': result = '0x100'; break;
    case 'eth_gasPrice': result = '0x3b9aca00'; break;
    case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
    case 'eth_estimateGas': result = '0x5208'; break;
    case 'eth_getTransactionCount': result = '0x0'; break;
    case 'eth_getBalance': result = '0xde0b6b3a7640000'; break;
    case 'eth_getBlockByNumber':
      result = {
        number: params[0] === 'latest' ? '0x100' : params[0],
        hash: '0x' + '55'.repeat(32), parentHash: '0x' + '66'.repeat(32),
        timestamp: '0x12345678', nonce: '0x0000000000000000', difficulty: '0x0',
        gasLimit: '0x1c9c380', gasUsed: '0x0', miner: RESOLVER,
        extraData: '0x', baseFeePerGas: '0x1', transactions: [],
      };
      break;
    case 'eth_call': {
      if (params[0]?.to?.toLowerCase() !== UR) break;
      let decoded;
      try { decoded = REVERSE.parseTransaction({ data: params[0].data }); } catch { break; }
      if (decoded?.name !== 'reverse' || decoded.args[1] !== 60n) break;
      const address = decoded.args[0].toLowerCase();
      const entry = CASES.find((item) => item.address === address);
      if (!entry) break;
      observations.reverse.push(address);
      result = REVERSE.encodeFunctionResult('reverse', [entry.name, RESOLVER, RESOLVER]);
      break;
    }
  }
  // Sending a transaction, an unknown contract, or an unexpected RPC method
  // fails explicitly. No response is forwarded to another endpoint.
  return result === undefined
    ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported acceptance request' } }
    : { jsonrpc: '2.0', id, result };
}

async function startSecurityFixture() {
  const observations = { methods: [], reverse: [], malformed: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Installed wallet fixture</title><p>Controlled local acceptance page</p>');
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = Array.isArray(body)
        ? body.map((item) => answerRpc(item, observations)) : answerRpc(body, observations);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    } catch {
      observations.malformed += 1;
      res.writeHead(400); res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    observations,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

function isolatedNetworkConfig(url, builtinSources) {
  return {
    networks: { 1: { verification: { primary: 'direct', order: ['direct'], preferVerified: false },
      access: { readOrder: ['direct'], broadcastOrder: [] } } },
    removedSources: Object.keys(builtinSources.sources || builtinSources),
    endpointSources: { 'installed-acceptance-rpc': {
      name: 'Controlled local acceptance RPC', role: 'rpc', keyed: false, coverage: { 1: url },
    } },
  };
}

module.exports = { CASES, REVERSE, UR, answerRpc, startSecurityFixture, isolatedNetworkConfig };
