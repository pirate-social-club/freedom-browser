const { Resolver } = require('dns').promises;
const { DNS_CLASS_HS, DNS_TYPE_TXT, queryDns } = require('./hns-local-resolver');

const DEFAULT_QUERY_TIMEOUT_MS = 3000;

function normalizeSuffixRoot(suffix) {
  const root = String(suffix || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/g, '')
    .replace(/\.+$/g, '');
  return root && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(root) ? root : null;
}

function buildHnsHealthProbeHosts(suffixes = []) {
  const hosts = ['pirate', 'app.pirate'];
  for (const suffix of suffixes) {
    const root = normalizeSuffixRoot(suffix);
    if (root) hosts.push(root);
  }
  return Array.from(new Set(hosts));
}

function withTimeout(promise, timeoutMs, host) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`DNS query timed out for ${host}`);
      error.code = 'ETIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function probeHnsResolver({
  hosts,
  recursiveAddr,
  resolverFactory = () => new Resolver(),
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
}) {
  const resolver = resolverFactory();
  resolver.setServers([recursiveAddr]);
  const results = [];

  for (const host of hosts) {
    const startedAt = Date.now();
    try {
      const addresses = await withTimeout(resolver.resolve4(host), timeoutMs, host);
      results.push({
        addresses,
        durationMs: Date.now() - startedAt,
        host,
        ok: addresses.length > 0,
      });
    } catch (error) {
      results.push({
        code: error?.code || 'DNS_ERROR',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        host,
        ok: false,
      });
    }
  }

  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

function formatHnsHealthSummary(result) {
  return result.results
    .map((entry) => {
      if (entry.ok) {
        return `${entry.host}=${entry.addresses.join('|')}`;
      }
      return `${entry.host}=FAIL(${entry.code})`;
    })
    .join(', ');
}

module.exports = {
  buildHnsHealthProbeHosts,
  formatHnsHealthSummary,
  probeHnsResolver,
};

// Local hnsd metadata is separate from any website's DNS/DANE canary.
async function probeHnsChainState({ rootAddr, query = queryDns }) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(rootAddr || '');
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('HNS metadata requires the local root resolver');
  }
  const params = {
    host: '127.0.0.1', port: Number(match[1]), klass: DNS_CLASS_HS,
    type: DNS_TYPE_TXT, timeoutMs: 1000,
  };
  const [chain, pool] = await Promise.all([
    query({ ...params, hostname: 'chain.hnsd' }),
    query({ ...params, hostname: 'size.pool.hnsd' }),
  ]);
  const text = (response, name) => {
    if (response.rcode !== 0 || response.truncated) throw new Error('HNS metadata unavailable');
    const records = response.answers.filter((record) => (
      record.name.replace(/\.$/, '') === name && record.klass === DNS_CLASS_HS &&
      record.type === DNS_TYPE_TXT && record.text?.length === 1
    ));
    if (records.length !== 1) throw new Error(`Missing HNS metadata: ${name}`);
    return records[0].text[0];
  };
  const synced = text(chain, 'synced.chain.hnsd');
  const heightText = text(chain, 'height.tip.chain.hnsd');
  const progressText = text(chain, 'progress.chain.hnsd');
  const peersText = text(pool, 'size.pool.hnsd');
  const height = Number(heightText);
  const progress = Number(progressText);
  const peers = Number(peersText);
  if (!['true', 'false'].includes(synced) || !/^\d+$/.test(heightText) ||
      !/^\d+$/.test(peersText) || !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(peers) || !/^\d+(?:\.\d+)?$/.test(progressText) ||
      !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('Invalid HNS chain metadata');
  }
  return { synced: synced === 'true', height, progress, peers };
}

module.exports.probeHnsChainState = probeHnsChainState;
