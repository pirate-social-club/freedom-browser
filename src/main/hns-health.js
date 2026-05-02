const { Resolver } = require('dns').promises;

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
