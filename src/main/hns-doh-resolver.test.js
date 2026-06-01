const {
  DNS_TYPE_A,
  buildDnsQuery,
  clearHnsDohCache,
  getConfiguredHnsDohEndpoints,
  parseDnsResponse,
  resolveHnsDohAddresses,
} = require('./hns-doh-resolver');

function fromBase64Url(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function buildAddressResponse(query, address = '173.199.93.117') {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);

  const question = query.subarray(12);
  const answerHeader = Buffer.alloc(12);
  answerHeader.writeUInt16BE(0xc00c, 0);
  answerHeader.writeUInt16BE(DNS_TYPE_A, 2);
  answerHeader.writeUInt16BE(1, 4);
  answerHeader.writeUInt32BE(120, 6);
  answerHeader.writeUInt16BE(4, 10);

  return Buffer.concat([
    header,
    question,
    answerHeader,
    Buffer.from(address.split('.').map(Number)),
  ]);
}

function buildRcodeResponse(query, rcode = 3) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);

  return Buffer.concat([
    header,
    query.subarray(12),
  ]);
}

function createDnsMessageResponse(message) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => message.buffer.slice(
      message.byteOffset,
      message.byteOffset + message.byteLength
    ),
  };
}

const originalHnsDohUrls = process.env.FREEDOM_HNS_DOH_URLS;
const DNS_TYPE_CNAME = 5;

function encodeDnsNameForTest(hostname) {
  return Buffer.concat([
    ...hostname.split('.').map((label) => Buffer.concat([
      Buffer.from([Buffer.byteLength(label, 'ascii')]),
      Buffer.from(label, 'ascii'),
    ])),
    Buffer.from([0]),
  ]);
}

function buildCnameAddressResponse(query, address = '203.0.113.22') {
  const targetName = encodeDnsNameForTest('target.pirate');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(2, 6);

  const cnameHeader = Buffer.alloc(12);
  cnameHeader.writeUInt16BE(0xc00c, 0);
  cnameHeader.writeUInt16BE(DNS_TYPE_CNAME, 2);
  cnameHeader.writeUInt16BE(1, 4);
  cnameHeader.writeUInt32BE(30, 6);
  cnameHeader.writeUInt16BE(targetName.length, 10);

  const addressHeader = Buffer.alloc(10);
  addressHeader.writeUInt16BE(DNS_TYPE_A, 0);
  addressHeader.writeUInt16BE(1, 2);
  addressHeader.writeUInt32BE(30, 4);
  addressHeader.writeUInt16BE(4, 8);

  return Buffer.concat([
    header,
    query.subarray(12),
    cnameHeader,
    targetName,
    targetName,
    addressHeader,
    Buffer.from(address.split('.').map(Number)),
  ]);
}

describe('hns-doh-resolver', () => {
  afterEach(() => {
    clearHnsDohCache();
    if (originalHnsDohUrls === undefined) {
      delete process.env.FREEDOM_HNS_DOH_URLS;
    } else {
      process.env.FREEDOM_HNS_DOH_URLS = originalHnsDohUrls;
    }
    jest.clearAllMocks();
  });

  test('parses compressed A answers', () => {
    const query = buildDnsQuery('app.pirate', DNS_TYPE_A);
    const parsed = parseDnsResponse(buildAddressResponse(query.message), query.id);

    expect(parsed.rcode).toBe(0);
    expect(parsed.answers).toEqual([
      expect.objectContaining({
        address: '173.199.93.117',
        family: 4,
        name: 'app.pirate',
        ttl: 120,
      }),
    ]);
  });

  test('resolves A records over DNS wire-format HTTPS', async () => {
    const fetchImpl = jest.fn(async (url, _options) => {
      const query = fromBase64Url(new URL(url).searchParams.get('dns'));
      return createDnsMessageResponse(buildAddressResponse(query, '194.50.5.27'));
    });

    const result = await resolveHnsDohAddresses('hnsdoh', {
      endpoints: ['https://hnsdoh.com/dns-query'],
      fetchImpl,
      family: 4,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/hnsdoh\.com\/dns-query\?dns=/),
      expect.objectContaining({
        headers: { accept: 'application/dns-message' },
      })
    );
    expect(result.addresses).toEqual([
      expect.objectContaining({ address: '194.50.5.27', family: 4 }),
    ]);
  });

  test('follows CNAME answers returned by HNS DoH', async () => {
    const fetchImpl = jest.fn(async (url, _options) => {
      const query = fromBase64Url(new URL(url).searchParams.get('dns'));
      return createDnsMessageResponse(buildCnameAddressResponse(query));
    });

    const result = await resolveHnsDohAddresses('alias.pirate', {
      endpoints: ['https://hnsdoh.com/dns-query'],
      fetchImpl,
      family: 4,
    });

    expect(result.canonicalName).toBe('target.pirate');
    expect(result.cnameChain).toEqual([
      { from: 'alias.pirate', to: 'target.pirate', ttl: 30 },
    ]);
    expect(result.addresses).toEqual([
      expect.objectContaining({ address: '203.0.113.22', family: 4 }),
    ]);
  });

  test('prefers the regional HNS DoH endpoint before the global endpoint', () => {
    delete process.env.FREEDOM_HNS_DOH_URLS;

    expect(getConfiguredHnsDohEndpoints()).toEqual([
      'https://na.hnsdoh.com/dns-query',
      'https://hnsdoh.com/dns-query',
    ]);
  });

  test('caches negative DoH responses briefly', async () => {
    const fetchImpl = jest.fn(async (url, _options) => {
      const query = fromBase64Url(new URL(url).searchParams.get('dns'));
      return createDnsMessageResponse(buildRcodeResponse(query, 3));
    });
    const options = {
      endpoints: ['https://na.hnsdoh.com/dns-query'],
      fetchImpl,
      family: 4,
    };

    await expect(resolveHnsDohAddresses('missing-hns-name', options)).rejects.toThrow('rcode 3');
    await expect(resolveHnsDohAddresses('missing-hns-name', options)).rejects.toThrow('rcode 3');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not cache transient SERVFAIL DoH responses', async () => {
    const fetchImpl = jest.fn(async (url, _options) => {
      const query = fromBase64Url(new URL(url).searchParams.get('dns'));
      return createDnsMessageResponse(buildRcodeResponse(query, 2));
    });
    const options = {
      endpoints: ['https://na.hnsdoh.com/dns-query'],
      fetchImpl,
      family: 4,
    };

    await expect(resolveHnsDohAddresses('temporarily-broken', options)).rejects.toThrow('rcode 2');
    await expect(resolveHnsDohAddresses('temporarily-broken', options)).rejects.toThrow('rcode 2');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
