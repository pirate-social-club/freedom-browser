const dgram = require('dgram');
const net = require('net');
const {
  DNS_TYPE_A,
  DNS_TYPE_CNAME,
  DNS_TYPE_NS,
  clearHnsLocalCache,
  queryDns,
  resolveHnsLocalAddresses,
} = require('./hns-local-resolver');

function buildAddressRecord(name, address, ttl = 120) {
  return {
    address,
    family: 4,
    name,
    ttl,
    type: DNS_TYPE_A,
  };
}

function buildDelegation(nsName, address) {
  return {
    additionals: [buildAddressRecord(nsName, address)],
    answers: [],
    authorities: [{
      name: 'pirate',
      ns: nsName,
      ttl: 120,
      type: DNS_TYPE_NS,
    }],
    rcode: 0,
  };
}

function buildEmptyResponse() {
  return {
    additionals: [],
    answers: [],
    authorities: [],
    rcode: 0,
  };
}

function buildWireAddressResponse(query, address = '198.51.100.44') {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);

  const answerHeader = Buffer.alloc(12);
  answerHeader.writeUInt16BE(0xc00c, 0);
  answerHeader.writeUInt16BE(DNS_TYPE_A, 2);
  answerHeader.writeUInt16BE(1, 4);
  answerHeader.writeUInt32BE(120, 6);
  answerHeader.writeUInt16BE(4, 10);

  return Buffer.concat([
    header,
    query.subarray(12),
    answerHeader,
    Buffer.from(address.split('.').map(Number)),
  ]);
}

function buildWireTruncatedResponse(query) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8200, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, query.subarray(12)]);
}

function listenTcp(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function bindUdp(socket, port) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, '127.0.0.1', resolve);
  });
}

describe('hns-local-resolver', () => {
  afterEach(() => {
    clearHnsLocalCache();
    jest.clearAllMocks();
  });

  test('resolves a delegated HNS name through local root glue and authoritative nameserver', async () => {
    const queryDnsMock = jest.fn(async ({ host, hostname, type }) => {
      if (host === '127.0.0.1' && hostname === 'app.pirate') {
        return buildDelegation('ns1.pirate', '198.51.100.9');
      }
      if (host === '198.51.100.9' && hostname === 'app.pirate' && type === DNS_TYPE_A) {
        return {
          ...buildEmptyResponse(),
          answers: [buildAddressRecord('app.pirate', '203.0.113.10')],
        };
      }
      return buildEmptyResponse();
    });

    const result = await resolveHnsLocalAddresses('app.pirate', {
      family: 4,
      queryDns: queryDnsMock,
      rootAddr: '127.0.0.1:5300',
    });

    expect(result).toEqual(expect.objectContaining({
      hostname: 'app.pirate',
      resolver: 'ns1.pirate',
    }));
    expect(result.addresses).toEqual([
      expect.objectContaining({ address: '203.0.113.10', family: 4 }),
    ]);
    expect(queryDnsMock).toHaveBeenCalledWith(expect.objectContaining({
      host: '198.51.100.9',
      hostname: 'app.pirate',
      type: DNS_TYPE_A,
    }));
  });

  test('uses root-known HNS nameserver addresses when delegation omits glue', async () => {
    const queryDnsMock = jest.fn(async ({ host, hostname, type }) => {
      if (host === '127.0.0.1' && hostname === 'trinity.agent') {
        return {
          ...buildEmptyResponse(),
          authorities: [{ name: 'agent', ns: 'ns1.skyinclude', ttl: 120, type: DNS_TYPE_NS }],
        };
      }
      if (host === '127.0.0.1' && hostname === 'ns1.skyinclude' && type === DNS_TYPE_A) {
        return {
          ...buildEmptyResponse(),
          answers: [buildAddressRecord('ns1.skyinclude', '192.0.2.53')],
        };
      }
      if (host === '192.0.2.53' && hostname === 'trinity.agent' && type === DNS_TYPE_A) {
        return {
          ...buildEmptyResponse(),
          answers: [buildAddressRecord('trinity.agent', '139.59.126.11')],
        };
      }
      return buildEmptyResponse();
    });

    const result = await resolveHnsLocalAddresses('trinity.agent', {
      family: 4,
      queryDns: queryDnsMock,
      rootAddr: '127.0.0.1:5300',
    });

    expect(result.addresses).toEqual([
      expect.objectContaining({ address: '139.59.126.11', family: 4 }),
    ]);
    expect(queryDnsMock).toHaveBeenCalledWith(expect.objectContaining({
      host: '127.0.0.1',
      hostname: 'ns1.skyinclude',
      type: DNS_TYPE_A,
    }));
  });

  test('follows CNAME answers before returning addresses', async () => {
    const queryDnsMock = jest.fn(async ({ host, hostname }) => {
      if (host === '127.0.0.1' && hostname === 'alias.pirate') {
        return {
          ...buildEmptyResponse(),
          answers: [
            { cname: 'target.pirate', name: 'alias.pirate', ttl: 30, type: DNS_TYPE_CNAME },
            buildAddressRecord('target.pirate', '203.0.113.22', 30),
          ],
        };
      }
      return buildEmptyResponse();
    });

    const result = await resolveHnsLocalAddresses('alias.pirate', {
      family: 4,
      queryDns: queryDnsMock,
      rootAddr: '127.0.0.1:5300',
    });

    expect(result.canonicalName).toBe('target.pirate');
    expect(result.cnameChain).toEqual([
      { from: 'alias.pirate', to: 'target.pirate', ttl: 30 },
    ]);
    expect(result.addresses).toEqual([
      expect.objectContaining({ address: '203.0.113.22', family: 4 }),
    ]);
  });

  test('caches positive local results by TTL', async () => {
    const queryDnsMock = jest.fn(async ({ host, hostname }) => {
      if (host === '127.0.0.1' && hostname === 'pirate') {
        return {
          ...buildEmptyResponse(),
          answers: [buildAddressRecord('pirate', '173.199.93.117', 30)],
        };
      }
      return buildEmptyResponse();
    });

    await resolveHnsLocalAddresses('pirate', {
      family: 4,
      queryDns: queryDnsMock,
      rootAddr: '127.0.0.1:5300',
    });
    await resolveHnsLocalAddresses('pirate', {
      family: 4,
      queryDns: queryDnsMock,
      rootAddr: '127.0.0.1:5300',
    });

    expect(queryDnsMock).toHaveBeenCalledTimes(1);
  });

  test('retries DNS over TCP when UDP returns a truncated response', async () => {
    const tcpServer = net.createServer((socket) => {
      const chunks = [];
      let totalLength = 0;
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
        const payload = Buffer.concat(chunks, totalLength);
        if (payload.length < 2) return;
        const queryLength = payload.readUInt16BE(0);
        if (payload.length < queryLength + 2) return;
        const response = buildWireAddressResponse(payload.subarray(2, queryLength + 2));
        const length = Buffer.alloc(2);
        length.writeUInt16BE(response.length, 0);
        socket.end(Buffer.concat([length, response]));
      });
    });
    const tcpPort = await listenTcp(tcpServer);

    const udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', (message, rinfo) => {
      udpSocket.send(buildWireTruncatedResponse(message), rinfo.port, rinfo.address);
    });
    await bindUdp(udpSocket, tcpPort);

    try {
      const response = await queryDns({
        host: '127.0.0.1',
        hostname: 'app.pirate',
        port: tcpPort,
        timeoutMs: 500,
        type: DNS_TYPE_A,
      });

      expect(response.answers).toEqual([
        expect.objectContaining({ address: '198.51.100.44', family: 4 }),
      ]);
    } finally {
      udpSocket.close();
      await new Promise((resolve) => tcpServer.close(resolve));
    }
  });
});
