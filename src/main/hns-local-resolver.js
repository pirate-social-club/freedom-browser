const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');

const DNS_TYPE_A = 1;
const DNS_TYPE_NS = 2;
const DNS_TYPE_CNAME = 5;
const DNS_TYPE_AAAA = 28;
const DNS_CLASS_IN = 1;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const MAX_CNAME_DEPTH = 8;

const cache = new Map();

function normalizeHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.+$/g, '');
  if (!normalized || net.isIP(normalized)) return null;
  if (!normalized.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return null;
  }
  return normalized;
}

function parseAddr(addr = '') {
  const [host, portValue] = String(addr || '').split(':');
  const port = Number(portValue);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

function encodeDnsName(hostname) {
  const parts = [];
  for (const label of hostname.split('.')) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error(`Invalid DNS label in ${hostname}`);
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildDnsQuery(hostname, type = DNS_TYPE_A, recursive = false) {
  const id = crypto.randomInt(0, 0x10000);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(recursive ? 0x0100 : 0, 2);
  header.writeUInt16BE(1, 4);

  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(DNS_CLASS_IN, 2);

  return {
    id,
    message: Buffer.concat([header, encodeDnsName(hostname), question]),
  };
}

function normalizeRecordName(name = '') {
  return String(name || '').replace(/\.+$/g, '').toLowerCase();
}

function readDnsName(buffer, offset, depth = 0) {
  if (depth > 20) throw new Error('DNS name compression pointer loop');
  const labels = [];
  let cursor = offset;
  let nextOffset = null;

  while (true) {
    if (cursor >= buffer.length) throw new Error('DNS name exceeds packet length');
    const length = buffer[cursor];

    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new Error('Truncated DNS compression pointer');
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (nextOffset === null) nextOffset = cursor + 2;
      const pointed = readDnsName(buffer, pointer, depth + 1);
      labels.push(...pointed.labels);
      return { labels, name: labels.join('.'), offset: nextOffset };
    }

    if ((length & 0xc0) !== 0) throw new Error('Unsupported DNS label encoding');
    cursor += 1;

    if (length === 0) {
      return { labels, name: labels.join('.'), offset: nextOffset || cursor };
    }

    if (cursor + length > buffer.length) throw new Error('Truncated DNS label');
    labels.push(buffer.toString('ascii', cursor, cursor + length));
    cursor += length;
  }
}

function formatIpv6(buffer) {
  const groups = [];
  for (let offset = 0; offset < 16; offset += 2) {
    groups.push(buffer.readUInt16BE(offset).toString(16));
  }
  return groups.join(':');
}

function parseRecord(buffer, offset) {
  const rrName = readDnsName(buffer, offset);
  offset = rrName.offset;
  if (offset + 10 > buffer.length) throw new Error('Truncated DNS record');

  const type = buffer.readUInt16BE(offset);
  const klass = buffer.readUInt16BE(offset + 2);
  const ttl = buffer.readUInt32BE(offset + 4);
  const rdLength = buffer.readUInt16BE(offset + 8);
  offset += 10;
  if (offset + rdLength > buffer.length) throw new Error('Truncated DNS record data');

  const dataOffset = offset;
  const data = buffer.subarray(offset, offset + rdLength);
  offset += rdLength;

  const record = {
    name: rrName.name,
    ttl,
    type,
  };

  if (klass === DNS_CLASS_IN && type === DNS_TYPE_A && rdLength === 4) {
    record.address = Array.from(data).join('.');
    record.family = 4;
  } else if (klass === DNS_CLASS_IN && type === DNS_TYPE_AAAA && rdLength === 16) {
    record.address = formatIpv6(data);
    record.family = 6;
  } else if (klass === DNS_CLASS_IN && type === DNS_TYPE_NS) {
    record.ns = readDnsName(buffer, dataOffset).name;
  } else if (klass === DNS_CLASS_IN && type === DNS_TYPE_CNAME) {
    record.cname = readDnsName(buffer, dataOffset).name;
  }

  return { offset, record };
}

function parseDnsMessage(buffer, expectedId) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 12) throw new Error('DNS response too short');

  const id = buffer.readUInt16BE(0);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error('DNS response id mismatch');
  }

  const flags = buffer.readUInt16BE(2);
  const counts = {
    questions: buffer.readUInt16BE(4),
    answers: buffer.readUInt16BE(6),
    authorities: buffer.readUInt16BE(8),
    additionals: buffer.readUInt16BE(10),
  };
  let offset = 12;

  for (let index = 0; index < counts.questions; index += 1) {
    const questionName = readDnsName(buffer, offset);
    offset = questionName.offset + 4;
    if (offset > buffer.length) throw new Error('Truncated DNS question');
  }

  const readSection = (count) => {
    const records = [];
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRecord(buffer, offset);
      offset = parsed.offset;
      records.push(parsed.record);
    }
    return records;
  };

  const answers = readSection(counts.answers);
  const authorities = readSection(counts.authorities);
  const additionals = readSection(counts.additionals);

  return {
    additionals,
    answers,
    authorities,
    truncated: Boolean(flags & 0x0200),
    rcode: flags & 0x000f,
  };
}

function queryDnsUdp({ host, hostname, port = 53, recursive = false, timeoutMs = DEFAULT_TIMEOUT_MS, type }) {
  return new Promise((resolve, reject) => {
    const query = buildDnsQuery(hostname, type, recursive);
    const socket = dgram.createSocket(net.isIP(host) === 6 ? 'udp6' : 'udp4');
    socket.unref?.();
    const timeout = setTimeout(() => {
      socket.close();
      const error = new Error(`DNS query timed out for ${hostname}`);
      error.code = 'ETIMEOUT';
      reject(error);
    }, timeoutMs);
    timeout.unref?.();

    socket.once('error', (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
    socket.once('message', (message) => {
      clearTimeout(timeout);
      socket.close();
      try {
        resolve(parseDnsMessage(message, query.id));
      } catch (error) {
        reject(error);
      }
    });
    socket.send(query.message, port, host);
  });
}

function queryDnsTcp({ host, hostname, port = 53, recursive = false, timeoutMs = DEFAULT_TIMEOUT_MS, type }) {
  return new Promise((resolve, reject) => {
    const query = buildDnsQuery(hostname, type, recursive);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(query.message.length, 0);
    const framedQuery = Buffer.concat([length, query.message]);
    const chunks = [];
    let totalLength = 0;
    let expectedLength = null;
    let settled = false;

    const socket = net.connect({ host, port }, () => {
      socket.write(framedQuery);
    });
    socket.unref?.();

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`DNS TCP query timed out for ${hostname}`);
      error.code = 'ETIMEOUT';
      finish(error);
    });

    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;
      const payload = Buffer.concat(chunks, totalLength);

      if (expectedLength === null && payload.length >= 2) {
        expectedLength = payload.readUInt16BE(0);
      }
      if (expectedLength === null || payload.length < expectedLength + 2) return;

      try {
        finish(null, parseDnsMessage(payload.subarray(2, expectedLength + 2), query.id));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function queryDns(params) {
  let udpError;
  try {
    const response = await queryDnsUdp(params);
    if (!response.truncated) return response;
    udpError = new Error(`DNS UDP response truncated for ${params.hostname}`);
    udpError.code = 'ETRUNCATED';
  } catch (error) {
    udpError = error;
  }

  if (params.tcpFallback === false) {
    throw udpError;
  }

  try {
    return await queryDnsTcp(params);
  } catch (tcpError) {
    if (udpError && !tcpError.cause) {
      tcpError.cause = udpError;
    }
    throw tcpError;
  }
}

function collectAddressRecords(records, wantedName = null) {
  const normalizedWanted = wantedName ? normalizeRecordName(wantedName) : null;
  return records
    .filter((record) => record.address)
    .filter((record) => {
      if (!normalizedWanted) return true;
      return normalizeRecordName(record.name) === normalizedWanted;
    })
    .map((record) => ({ address: record.address, family: record.family, ttl: record.ttl }));
}

function collectAddressesFollowingCname(records, wantedName, visited = new Set()) {
  let current = normalizeRecordName(wantedName);
  const cnameChain = [];

  for (let depth = 0; depth < MAX_CNAME_DEPTH; depth += 1) {
    if (visited.has(current)) {
      throw new Error(`CNAME loop while resolving ${wantedName}`);
    }
    visited.add(current);

    const addresses = collectAddressRecords(records, current);
    if (addresses.length > 0) {
      return {
        addresses,
        canonicalName: current,
        cnameChain,
      };
    }

    const cnameRecord = records.find((record) => (
      record.cname && normalizeRecordName(record.name) === current
    ));
    if (!cnameRecord) return null;

    const target = normalizeHostname(cnameRecord.cname);
    if (!target) return null;
    cnameChain.push({ from: current, to: target, ttl: cnameRecord.ttl });
    current = target;
  }

  throw new Error(`CNAME chain too deep while resolving ${wantedName}`);
}

function getQueryTypes(family) {
  if (family === 6 || family === '6') return [DNS_TYPE_AAAA];
  if (family === 4 || family === '4') return [DNS_TYPE_A];
  return [DNS_TYPE_A, DNS_TYPE_AAAA];
}

function getCacheKey({ hostname, queryTypes, rootAddr }) {
  return `${rootAddr.host}:${rootAddr.port}|${hostname}|${queryTypes.join(',')}`;
}

function getCachedResult(cacheKey) {
  const cached = cache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function getResultTtlMs(result) {
  const ttlValues = [
    ...(result.addresses || []).map((entry) => entry.ttl),
    ...(result.cnameChain || []).map((entry) => entry.ttl),
  ].filter((ttl) => Number.isFinite(ttl) && ttl > 0);
  const ttlSeconds = ttlValues.length > 0
    ? Math.min(...ttlValues)
    : DEFAULT_CACHE_TTL_SECONDS;
  return Math.max(1, ttlSeconds) * 1000;
}

function cacheResult(cacheKey, result) {
  cache.set(cacheKey, {
    expiresAt: Date.now() + getResultTtlMs(result),
    value: result,
  });
}

function clearHnsLocalCache() {
  cache.clear();
}

async function resolveOsAddresses(hostname, queryTypes) {
  const addresses = [];
  if (queryTypes.includes(DNS_TYPE_A)) {
    try {
      const results = await dns.resolve4(hostname, { ttl: true });
      addresses.push(...results.map((entry) => (
        typeof entry === 'string'
          ? { address: entry, family: 4 }
          : { address: entry.address, family: 4, ttl: entry.ttl }
      )));
    } catch {
      // Try AAAA below.
    }
  }
  if (queryTypes.includes(DNS_TYPE_AAAA)) {
    try {
      const results = await dns.resolve6(hostname, { ttl: true });
      addresses.push(...results.map((entry) => (
        typeof entry === 'string'
          ? { address: entry, family: 6 }
          : { address: entry.address, family: 6, ttl: entry.ttl }
      )));
    } catch {
      // The OS resolver may not know this CNAME target.
    }
  }
  return addresses.filter((entry) => entry.address);
}

async function resolveNameserverAddresses(nsName, glueByName, rootAddr, options = {}) {
  const normalized = normalizeRecordName(nsName);
  const glued = glueByName.get(normalized) || [];
  if (glued.length > 0) return glued;

  const addresses = [];
  const queryDnsImpl = options.queryDns || queryDns;
  if (rootAddr) {
    const rootResponses = await Promise.all([DNS_TYPE_A, DNS_TYPE_AAAA].map((type) => (
      queryDnsImpl({
        host: rootAddr.host,
        hostname: normalized,
        port: rootAddr.port,
        recursive: false,
        timeoutMs: options.timeoutMs,
        type,
      }).catch(() => null)
    )));
    for (const response of rootResponses.filter(Boolean)) {
      addresses.push(...collectAddressRecords(response.answers, normalized));
      addresses.push(...collectAddressRecords(response.additionals, normalized));
    }
    if (addresses.length > 0) return addresses;
  }

  try {
    addresses.push(...(await dns.resolve4(normalized)).map((address) => ({ address, family: 4 })));
  } catch {
    // Try AAAA below.
  }
  try {
    addresses.push(...(await dns.resolve6(normalized)).map((address) => ({ address, family: 6 })));
  } catch {
    // Ignore nameservers that the OS resolver cannot resolve.
  }
  return addresses;
}

async function resolveHnsLocalAddresses(hostname, options = {}) {
  const normalized = normalizeHostname(hostname);
  const rootAddr = parseAddr(options.rootAddr);
  if (!normalized || !rootAddr) {
    throw new Error(`Invalid local HNS lookup target: ${hostname}`);
  }

  const queryTypes = getQueryTypes(options.family);
  const cnameDepth = options.cnameDepth || 0;
  if (cnameDepth > MAX_CNAME_DEPTH) {
    throw new Error(`CNAME chain too deep while resolving ${normalized}`);
  }
  const cacheKey = getCacheKey({ hostname: normalized, queryTypes, rootAddr });
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;
  const queryDnsImpl = options.queryDns || queryDns;
  const visitedCnames = options.visitedCnames || new Set();

  const buildResult = (records, resolver) => {
    const resolved = collectAddressesFollowingCname(records, normalized, new Set(visitedCnames));
    if (!resolved?.addresses?.length) return null;
    return {
      addresses: resolved.addresses,
      canonicalName: resolved.canonicalName,
      cnameChain: resolved.cnameChain,
      hostname: normalized,
      resolver,
    };
  };

  const resolveCnameTarget = async (records, resolver) => {
    const cnameRecord = records.find((record) => (
      record.cname && normalizeRecordName(record.name) === normalized
    ));
    if (!cnameRecord) return null;

    const target = normalizeHostname(cnameRecord.cname);
    if (!target) return null;
    if (visitedCnames.has(target)) {
      throw new Error(`CNAME loop while resolving ${normalized}`);
    }

    const nextVisited = new Set(visitedCnames);
    nextVisited.add(normalized);
    try {
      const result = await resolveHnsLocalAddresses(target, {
        ...options,
        cnameDepth: cnameDepth + 1,
        rootAddr: `${rootAddr.host}:${rootAddr.port}`,
        visitedCnames: nextVisited,
      });
      return {
        ...result,
        canonicalName: result.canonicalName || target,
        cnameChain: [
          { from: normalized, to: target, ttl: cnameRecord.ttl },
          ...(result.cnameChain || []),
        ],
        hostname: normalized,
        resolver,
      };
    } catch (localError) {
      const addresses = await resolveOsAddresses(target, queryTypes);
      if (addresses.length > 0) {
        return {
          addresses,
          canonicalName: target,
          cnameChain: [{ from: normalized, to: target, ttl: cnameRecord.ttl }],
          hostname: normalized,
          resolver,
        };
      }
      throw localError;
    }
  };

  const rootResponses = await Promise.all(queryTypes.map((type) => (
    queryDnsImpl({
      host: rootAddr.host,
      hostname: normalized,
      port: rootAddr.port,
      recursive: false,
      timeoutMs: options.timeoutMs,
      type,
    }).catch((error) => ({ error }))
  )));

  const rootRecords = rootResponses
    .filter((response) => !response.error && response.rcode === 0)
    .flatMap((response) => response.answers);
  let rootResult = buildResult(rootRecords, 'hns-root');
  if (!rootResult) {
    rootResult = await resolveCnameTarget(rootRecords, 'hns-root');
  }
  if (rootResult) {
    cacheResult(cacheKey, rootResult);
    return rootResult;
  }

  const nsNames = Array.from(new Set(rootResponses
    .filter((response) => !response.error)
    .flatMap((response) => response.authorities.map((record) => record.ns).filter(Boolean))
    .map((name) => name.replace(/\.+$/g, '').toLowerCase())));

  const glueByName = new Map();
  for (const response of rootResponses.filter((entry) => !entry.error)) {
    for (const record of response.additionals) {
      if (!record.address) continue;
      const name = normalizeRecordName(record.name);
      if (!glueByName.has(name)) glueByName.set(name, []);
      glueByName.get(name).push({ address: record.address, family: record.family, ttl: record.ttl });
    }
  }

  const nsTargets = [];
  for (const nsName of nsNames) {
    const addresses = await resolveNameserverAddresses(nsName, glueByName, rootAddr, options);
    for (const address of addresses) {
      nsTargets.push({ ...address, nsName });
    }
  }

  const attempts = [];
  for (const nsTarget of nsTargets) {
    for (const type of queryTypes) {
      attempts.push((async () => {
        const response = await queryDnsImpl({
          host: nsTarget.address,
          hostname: normalized,
          recursive: false,
          timeoutMs: options.timeoutMs,
          type,
        });
        if (response.rcode === 0) {
          let result = buildResult(response.answers, nsTarget.nsName);
          if (!result) {
            result = await resolveCnameTarget(response.answers, nsTarget.nsName);
          }
          if (result) return result;
        }
        throw new Error(`rcode ${response.rcode} from ${nsTarget.nsName}`);
      })());
    }
  }

  if (attempts.length === 0) {
    throw new Error(`No local HNS nameservers found for ${normalized}`);
  }

  try {
    const result = await Promise.any(attempts);
    cacheResult(cacheKey, result);
    return result;
  } catch (error) {
    const firstError = error.errors?.[0]?.message || error.message;
    throw new Error(firstError || `No local HNS records found for ${normalized}`, { cause: error });
  }
}

module.exports = {
  DNS_TYPE_A,
  DNS_TYPE_AAAA,
  DNS_TYPE_CNAME,
  DNS_TYPE_NS,
  buildDnsQuery,
  clearHnsLocalCache,
  parseDnsMessage,
  queryDns,
  resolveHnsLocalAddresses,
};
