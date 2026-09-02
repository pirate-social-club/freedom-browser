(function attachSpacesHandle(globalScope) {
  const normalizeLabel = (value = '') => String(value).normalize('NFKC').toLowerCase();

  const isSpaceLabel = (value = '') => {
    const label = String(value);
    return label.length > 0 && !/[\s/?#:@.]/u.test(label);
  };

  const isHandleLabel = (value = '') => {
    const label = String(value);
    return label.length > 0 && !/[\s/?#:@]/u.test(label);
  };

  const buildResult = (handle, suffix, displayValue) => ({
    handle,
    suffix: suffix || '',
    displayValue,
  });

  const parseHttpSpacesUrl = (value) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.password) {
      return null;
    }
    if (!parsed.username || parsed.username.includes(':')) {
      return null;
    }
    if (!isSpaceLabel(parsed.hostname) || parsed.hostname.includes('.')) {
      return null;
    }
    if (!isHandleLabel(parsed.username)) {
      return null;
    }

    const handle = `${normalizeLabel(parsed.username)}@${normalizeLabel(parsed.hostname)}`;
    const suffix = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`;
    const displaySuffix = suffix === '/' ? '' : suffix;
    return buildResult(handle, suffix === '/' ? '/' : suffix, `${handle}${displaySuffix}`);
  };

  const parseBareSpacesInput = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || /\s/.test(trimmed.split(/[/?#]/)[0])) {
      return null;
    }

    const hostPart = trimmed.split(/[/?#]/)[0];
    if (hostPart.includes(':')) {
      return null;
    }

    const suffix = trimmed.slice(hostPart.length);

    const rootMatch = hostPart.match(/^@(.+)$/u);
    if (rootMatch) {
      const space = rootMatch[1];
      if (!isSpaceLabel(space)) {
        return null;
      }
      const handle = `@${normalizeLabel(space)}`;
      return buildResult(handle, suffix, `${handle}${suffix}`);
    }

    const nameMatch = hostPart.match(/^([^@]+)@(.+)$/u);
    if (!nameMatch) {
      return null;
    }

    const [, label, space] = nameMatch;
    if (!isHandleLabel(label) || !isSpaceLabel(space)) {
      return null;
    }

    const handle = `${normalizeLabel(label)}@${normalizeLabel(space)}`;
    return buildResult(handle, suffix, `${handle}${suffix}`);
  };

  function parseSpacesHandleInput(raw) {
    if (!raw || typeof raw !== 'string') {
      return null;
    }

    let value = raw.trim();
    if (!value) {
      return null;
    }

    if (/^spaces:\/\//i.test(value)) {
      value = value.slice('spaces://'.length);
      return parseBareSpacesInput(value);
    }

    if (/^https?:\/\//i.test(value)) {
      return parseHttpSpacesUrl(value);
    }

    return parseBareSpacesInput(value);
  }

  function normalizeSpaceHandle(handle) {
    const parsed = parseSpacesHandleInput(handle);
    if (!parsed) {
      throw new Error('Spaces handle must be name@space or @space without credentials or dotted space labels');
    }
    return parsed.handle;
  }

  function applySpacesSuffix(baseUrl, suffix = '') {
    if (!baseUrl) {
      return null;
    }
    if (!suffix || suffix === '/') {
      return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    }
    if (suffix.startsWith('?') || suffix.startsWith('#')) {
      return `${String(baseUrl).replace(/\/$/, '')}${suffix}`;
    }
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return `${base}${suffix.replace(/^\//, '')}`;
  }

  function encodeSpacesHandlePath(handle) {
    return encodeURIComponent(handle);
  }

  const api = {
    parseSpacesHandleInput,
    normalizeSpaceHandle,
    applySpacesSuffix,
    encodeSpacesHandlePath,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (globalScope) {
    globalScope.FREEDOM_SPACES_HANDLE = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : undefined);
