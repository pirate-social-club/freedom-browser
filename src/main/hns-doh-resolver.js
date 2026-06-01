const crypto = require('crypto');
const net = require('net');

const DNS_TYPE_A = 1;
const DNS_TYPE_CNAME = 5;
const DNS_TYPE_AAAA = 28;
const DNS_CLASS_IN = 1;
const DEFAULT_DOH_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const NEGATIVE_CACHE_TTL_MS = 10 * 1000;
const DEFAULT_HNS_DOH_ENDPOINTS = Object.freeze([
  'https://na.hnsdoh.com/dns-query',
  'https://hnsdoh.com/dns-query',
]);
const NEGATIVE_CACHE_MARKER = 'negative';
const MAX_CNAME_DEPTH = 8;

const cache = new Map();

function normalizeHostname(hostname = '') {
  const normalized = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/g, '');
  if (!normalized) return null;
  if (net.isIP(normalized)) return null;
  const labels = normalized.split('.');
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return null;
  }
  return normalized;
}

function toBase64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodeDnsName(hostname) {
  const labels = hostname.split('.');
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error(`Invalid DNS label in ${hostname}`);
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildDnsQuery(hostname, type = DNS_TYPE_A) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new Error(`Invalid hostname: ${hostname}`);
  }

  const id = crypto.randomInt(0, 0x10000);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);

  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(DNS_CLASS_IN, 2);

  return {
    id,
    message: Buffer.concat([header, encodeDnsName(normalized), question]),
  };
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
      return {
        labels,
        name: labels.join('.'),
        offset: nextOffset,
      };
    }

    if ((length & 0xc0) !== 0) throw new Error('Unsupported DNS label encoding');
    cursor += 1;

    if (length === 0) {
      return {
        labels,
        name: labels.join('.'),
        offset: nextOffset || cursor,
      };
    }

    if (cursor + length > buffer.length) throw new Error('Truncated DNS label');
    labels.push(buffer.toString('ascii', cursor, cursor + length));
    cursor += length;
  }
}

function normalizeRecordName(name = '') {
  return String(name || '').replace(/\.+$/g, '').toLowerCase();
}

function formatIpv6(buffer) {
  const groups = [];
  for (let offset = 0; offset < 16; offset += 2) {
    groups.push(buffer.readUInt16BE(offset).toString(16));
  }
  return groups.join(':');
}

function parseDnsResponse(buffer, expectedId) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 12) throw new Error('DNS response too short');

  const id = buffer.readUInt16BE(0);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error('DNS response id mismatch');
  }

  const flags = buffer.readUInt16BE(2);
  const rcode = flags & 0x000f;
  const qdCount = buffer.readUInt16BE(4);
  const anCount = buffer.readUInt16BE(6);
  let offset = 12;

  for (let index = 0; index < qdCount; index += 1) {
    const questionName = readDnsName(buffer, offset);
    offset = questionName.offset + 4;
    if (offset > buffer.length) throw new Error('Truncated DNS question');
  }

  const answers = [];
  for (let index = 0; index < anCount; index += 1) {
    const rrName = readDnsName(buffer, offset);
    offset = rrName.offset;
    if (offset + 10 > buffer.length) throw new Error('Truncated DNS record');

    const type = buffer.readUInt16BE(offset);
    const klass = buffer.readUInt16BE(offset + 2);
    const ttl = buffer.readUInt32BE(offset + 4);
    const rdLength = buffer.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdLength > buffer.length) throw new Error('Truncated DNS record data');

    const data = buffer.subarray(offset, offset + rdLength);
    offset += rdLength;

    if (klass !== DNS_CLASS_IN) continue;
    if (type === DNS_TYPE_A && rdLength === 4) {
      answers.push({
        address: Array.from(data).join('.'),
        family: 4,
        name: rrName.name,
        ttl,
        type,
      });
    } else if (type === DNS_TYPE_AAAA && rdLength === 16) {
      answers.push({
        address: formatIpv6(data),
        family: 6,
        name: rrName.name,
        ttl,
        type,
      });
    } else if (type === DNS_TYPE_CNAME) {
      answers.push({
        cname: readDnsName(buffer, offset - rdLength).name,
        name: rrName.name,
        ttl,
        type,
      });
    }
  }

  return {
    answers,
    id,
    rcode,
  };
}

function getConfiguredHnsDohEndpoints() {
  const configured = process.env.FREEDOM_HNS_DOH_URLS;
  if (!configured) return DEFAULT_HNS_DOH_ENDPOINTS;
  const endpoints = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return endpoints.length > 0 ? endpoints : DEFAULT_HNS_DOH_ENDPOINTS;
}

async function queryDoh({
  endpoint,
  fetchImpl = fetch,
  hostname,
  timeoutMs = DEFAULT_DOH_TIMEOUT_MS,
  type = DNS_TYPE_A,
}) {
  const { id, message } = buildDnsQuery(hostname, type);
  const url = new URL(endpoint);
  url.searchParams.set('dns', toBase64Url(message));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url.toString(), {
      headers: { accept: 'application/dns-message' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`DoH HTTP ${response.status}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    return parseDnsResponse(body, id);
  } finally {
    clearTimeout(timeout);
  }
}

function cacheResult(cacheKey, value, ttlMs) {
  cache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

function getCachedEntry(cacheKey) {
  const cached = cache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return null;
  }
  return cached;
}

function getQueryTypes(family) {
  if (family === 4 || family === '4') return [DNS_TYPE_A];
  if (family === 6 || family === '6') return [DNS_TYPE_AAAA];
  return [DNS_TYPE_A, DNS_TYPE_AAAA];
}

function collectAddressesFollowingCname(records, wantedName, visited = new Set()) {
  let current = normalizeRecordName(wantedName);
  const cnameChain = [];

  for (let depth = 0; depth < MAX_CNAME_DEPTH; depth += 1) {
    if (visited.has(current)) {
      throw new Error(`CNAME loop while resolving ${wantedName}`);
    }
    visited.add(current);

    const addresses = records
      .filter((record) => record.address && normalizeRecordName(record.name) === current)
      .map((record) => ({
        address: record.address,
        family: record.family,
        name: record.name,
        ttl: record.ttl,
        type: record.type,
      }));
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

async function resolveHnsDohAddresses(hostname, options = {}) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new Error(`Invalid HNS hostname: ${hostname}`);
  }

  const queryTypes = getQueryTypes(options.family);
  const cnameDepth = options.cnameDepth || 0;
  if (cnameDepth > MAX_CNAME_DEPTH) {
    throw new Error(`CNAME chain too deep while resolving ${normalized}`);
  }
  const cacheKey = `${normalized}|${queryTypes.join(',')}`;
  const cached = getCachedEntry(cacheKey);
  if (cached) {
    if (cached.kind === NEGATIVE_CACHE_MARKER) {
      throw new Error(cached.errorMessage || `No HNS DoH records found for ${normalized}`);
    }
    return cached.value;
  }

  const endpoints = options.endpoints || getConfiguredHnsDohEndpoints();
  let lastError = null;
  let sawNxdomain = false;
  let sawNonNxdomainFailure = false;
  const visitedCnames = options.visitedCnames || new Set();

  for (const endpoint of endpoints) {
    try {
      const responses = await Promise.all(queryTypes.map(async (type) => {
        try {
          return await queryDoh({
            endpoint,
            fetchImpl: options.fetchImpl,
            hostname: normalized,
            timeoutMs: options.timeoutMs,
            type,
          });
        } catch (error) {
          return { error };
        }
      }));

      const records = [];
      for (const response of responses) {
        if (response.error) {
          lastError = response.error;
          sawNonNxdomainFailure = true;
          continue;
        }
        if (response.rcode !== 0) {
          lastError = new Error(`DoH DNS rcode ${response.rcode}`);
          if (response.rcode === 3) {
            sawNxdomain = true;
          } else {
            sawNonNxdomainFailure = true;
          }
          continue;
        }
        records.push(...response.answers);
      }

      const resolved = collectAddressesFollowingCname(records, normalized, new Set(visitedCnames));
      if (resolved?.addresses?.length > 0) {
        const result = {
          addresses: resolved.addresses,
          canonicalName: resolved.canonicalName,
          cnameChain: resolved.cnameChain,
          endpoint,
          hostname: normalized,
        };
        cacheResult(cacheKey, result, getResultTtlMs(result));
        return result;
      }

      const cnameRecord = records.find((record) => (
        record.cname && normalizeRecordName(record.name) === normalized
      ));
      const cnameTarget = normalizeHostname(cnameRecord?.cname);
      if (cnameTarget && !visitedCnames.has(cnameTarget)) {
        const nextVisited = new Set(visitedCnames);
        nextVisited.add(normalized);
        const result = await resolveHnsDohAddresses(cnameTarget, {
          ...options,
          cnameDepth: cnameDepth + 1,
          endpoints: [endpoint],
          visitedCnames: nextVisited,
        });
        const wrapped = {
          ...result,
          cnameChain: [
            { from: normalized, to: cnameTarget, ttl: cnameRecord.ttl },
            ...(result.cnameChain || []),
          ],
          endpoint,
          hostname: normalized,
        };
        cacheResult(cacheKey, wrapped, getResultTtlMs(wrapped));
        return wrapped;
      }
    } catch (error) {
      lastError = error;
    }
  }

  const errorMessage = lastError?.message || `No HNS DoH records found for ${normalized}`;
  if (sawNxdomain && !sawNonNxdomainFailure) {
    cache.set(cacheKey, {
      errorMessage,
      expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      kind: NEGATIVE_CACHE_MARKER,
    });
  }
  throw lastError || new Error(errorMessage);
}

function clearHnsDohCache() {
  cache.clear();
}

module.exports = {
  DNS_TYPE_A,
  DNS_TYPE_AAAA,
  buildDnsQuery,
  clearHnsDohCache,
  getConfiguredHnsDohEndpoints,
  parseDnsResponse,
  resolveHnsDohAddresses,
};
