const DEFAULT_HNS_PUBLIC_SUFFIXES = Object.freeze(['.pirate']);
const DEFAULT_NAMESPACE_URL = 'https://api.pirate.sc/public-namespaces';

let dynamicHnsPublicSuffixes = [];

function normalizeHnsPublicSuffix(value = '') {
  const normalized = String(value).trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) return null;
  return `.${normalized}`;
}

function getHnsPublicSuffixes() {
  return Object.freeze([...new Set([
    ...DEFAULT_HNS_PUBLIC_SUFFIXES,
    ...dynamicHnsPublicSuffixes,
  ])]);
}

function getHnsPublicRoots() {
  return Object.freeze(getHnsPublicSuffixes().map((suffix) => suffix.slice(1)));
}

function setDynamicHnsPublicSuffixes(values = []) {
  dynamicHnsPublicSuffixes = [...new Set(values.map(normalizeHnsPublicSuffix).filter(Boolean))];
  return getHnsPublicSuffixes();
}

function isValidHostnameLabel(value = '') {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function isLoopbackHostname(hostname = '') {
  return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
}

function isHnsHost(hostname = '') {
  if (typeof hostname !== 'string') return false;
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || isLoopbackHostname(normalized)) return false;
  if (!normalized.includes('.')) return isValidHostnameLabel(normalized);
  if (!normalized.split('.').every(isValidHostnameLabel)) return false;
  return getHnsPublicSuffixes().some((suffix) => normalized.endsWith(suffix));
}

function extractNamespaceSuffixes(payload) {
  if (!Array.isArray(payload?.namespaces)) return [];
  return payload.namespaces
    .map((entry) => entry?.root_label)
    .filter((value) => typeof value === 'string');
}

function buildPacHnsRootMap() {
  const entries = getHnsPublicRoots().map((root) => `${JSON.stringify(root)}:1`);
  return `{${entries.join(',')}}`;
}

async function refreshHnsPublicSuffixes({
  fetchImpl = fetch,
  url = process.env.PIRATE_PUBLIC_NAMESPACES_URL || DEFAULT_NAMESPACE_URL,
  timeoutMs = 3000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`public namespace fetch failed with ${response.status}`);
    return setDynamicHnsPublicSuffixes(extractNamespaceSuffixes(await response.json()));
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_NAMESPACE_URL,
  HNS_PUBLIC_SUFFIXES: DEFAULT_HNS_PUBLIC_SUFFIXES,
  buildPacHnsRootMap,
  extractNamespaceSuffixes,
  getHnsPublicRoots,
  getHnsPublicSuffixes,
  isHnsHost,
  normalizeHnsPublicSuffix,
  refreshHnsPublicSuffixes,
  setDynamicHnsPublicSuffixes,
};
