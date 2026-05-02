(function attachHnsHosts(globalScope) {
  const DEFAULT_HNS_PUBLIC_SUFFIXES = Object.freeze(['.pirate']);
  let dynamicHnsPublicSuffixes = [];

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

  function setDynamicHnsPublicSuffixes(values = []) {
    dynamicHnsPublicSuffixes = Array.from(new Set(
      values
        .map(normalizeHnsPublicSuffix)
        .filter(Boolean),
    ));
    return getHnsPublicSuffixes();
  }

  function isLoopbackHostname(hostname = '') {
    return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
  }

  function isHnsHost(hostname = '') {
    if (!hostname || typeof hostname !== 'string') return false;

    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (isLoopbackHostname(normalized)) return false;

    if (!normalized.includes('.')) {
      return true;
    }

    return getHnsPublicSuffixes().some((suffix) => normalized.endsWith(suffix));
  }

  const api = {
    HNS_PUBLIC_SUFFIXES: DEFAULT_HNS_PUBLIC_SUFFIXES,
    getHnsPublicSuffixes,
    isHnsHost,
    setDynamicHnsPublicSuffixes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (globalScope) {
    globalScope.FREEDOM_HNS_HOSTS = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : undefined);
