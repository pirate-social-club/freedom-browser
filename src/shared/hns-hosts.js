(function attachHnsHosts(globalScope) {
  const HNS_PUBLIC_SUFFIXES = Object.freeze(['.pirate']);

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

    return HNS_PUBLIC_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  }

  const api = {
    HNS_PUBLIC_SUFFIXES,
    isHnsHost,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (globalScope) {
    globalScope.FREEDOM_HNS_HOSTS = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : undefined);
