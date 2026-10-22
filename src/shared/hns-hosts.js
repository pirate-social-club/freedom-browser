(function attachHnsHosts(globalScope) {
  const DEFAULT_HNS_PUBLIC_SUFFIXES = Object.freeze(['.pirate']);
  let dynamicHnsPublicSuffixes = [];

  // A listed root sends every name under it to the Handshake resolver instead
  // of ordinary DNS, so no root that ICANN delegates, that another name system
  // Freedom resolves owns, or that local networks use is ever accepted, whatever
  // discovery says. The lists are api-next's
  // (packages/application/src/hns-reserved-roots.ts). Refusing a root only
  // leaves its names on the ordinary path they took before.
  const RESERVED_NON_ICANN_ROOTS = Object.freeze([
    // Suffixes Freedom resolves through another name system (origin-utils.js).
    'eth', 'box', 'wei', 'gwei', 'tez', 'onion',
    // Special-use and non-DNS names, including RFC 9476's `alt`.
    'local', 'localhost', 'test', 'invalid', 'example', 'arpa', 'alt',
    // Private-network names ICANN does not delegate or local networks commonly use.
    'internal', 'corp', 'home', 'mail', 'lan', 'intranet', 'private', 'localdomain',
  ]);
  // The ICANN set comes from the bundled IANA snapshot: required in Node, and
  // loaded by its own <script> ahead of this one in a page. Without it every
  // imported root is refused, so a missing snapshot can never capture a TLD.
  const ianaTldSnapshot = typeof module !== 'undefined' && module.exports
    ? require('./hns-iana-tld-snapshot').IANA_TLD_SNAPSHOT
    : globalScope?.FREEDOM_HNS_IANA_TLD_SNAPSHOT?.IANA_TLD_SNAPSHOT;
  const reservedHnsRoots = new Set([
    ...String(ianaTldSnapshot || '')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.toLowerCase()),
    ...RESERVED_NON_ICANN_ROOTS,
  ]);

  function isReservedHnsRoot(root = '') {
    return typeof ianaTldSnapshot !== 'string' || reservedHnsRoots.has(root);
  }

  function normalizeHnsPublicSuffix(value = '') {
    const normalized = String(value).trim().toLowerCase().replace(/\.+$/g, '');
    if (!normalized) return null;
    const suffix = normalized.startsWith('.') ? normalized : `.${normalized}`;
    return /^\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(suffix) ? suffix : null;
  }

  function getHnsPublicSuffixes() {
    return Object.freeze(Array.from(new Set([
      ...DEFAULT_HNS_PUBLIC_SUFFIXES,
      ...dynamicHnsPublicSuffixes,
    ])));
  }

  function getHnsPublicRoots() {
    return Object.freeze(getHnsPublicSuffixes().map((suffix) => suffix.replace(/^\./, '')));
  }

  // Imported roots: LDH labels only, never a reserved root. `.pirate` stays
  // built in whatever the list holds.
  function setDynamicHnsPublicSuffixes(values = []) {
    dynamicHnsPublicSuffixes = Array.from(new Set(
      values
        .map(normalizeHnsPublicSuffix)
        .filter((suffix) => suffix && !isReservedHnsRoot(suffix.slice(1))),
    ));
    return getHnsPublicSuffixes();
  }

  function isLoopbackHostname(hostname = '') {
    return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
  }

  function isValidHostnameLabel(value = '') {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
  }

  function isHnsPublicRoot(hostname = '') {
    const normalized = String(hostname || '').trim().toLowerCase();
    return isValidHostnameLabel(normalized) && getHnsPublicRoots().includes(normalized);
  }

  function isHnsHost(hostname = '') {
    if (!hostname || typeof hostname !== 'string') return false;

    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (isLoopbackHostname(normalized)) return false;

    if (!normalized.includes('.')) {
      return isValidHostnameLabel(normalized);
    }

    if (!normalized.split('.').every(isValidHostnameLabel)) return false;

    return getHnsPublicSuffixes().some((suffix) => normalized.endsWith(suffix));
  }

  const api = {
    HNS_PUBLIC_SUFFIXES: DEFAULT_HNS_PUBLIC_SUFFIXES,
    getHnsPublicRoots,
    getHnsPublicSuffixes,
    isHnsPublicRoot,
    isHnsHost,
    isReservedHnsRoot,
    isValidHostnameLabel,
    setDynamicHnsPublicSuffixes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (globalScope) {
    globalScope.FREEDOM_HNS_HOSTS = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : undefined);
