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

  const hasNonEmptyDotLabels = (value = '') => {
    const label = String(value);
    return Boolean(label) && !label.startsWith('.') && !label.endsWith('.') && !label.includes('..');
  };

  const splitSpacesHost = (rawLabel, rawSpace) => {
    const label = normalizeLabel(rawLabel);
    const space = normalizeLabel(rawSpace);
    if (!isHandleLabel(label) || !isSpaceLabel(space) || !hasNonEmptyDotLabels(label)) {
      return null;
    }

    const requestHost = `${label}@${space}`;
    const dotIndex = label.indexOf('.');
    if (dotIndex === -1) {
      return { handle: requestHost, requestHost };
    }

    const subname = label.slice(dotIndex + 1);
    if (!isHandleLabel(subname) || !hasNonEmptyDotLabels(subname)) {
      return null;
    }

    return {
      handle: `${subname}@${space}`,
      requestHost,
    };
  };

  const buildResult = (handle, requestHost, suffix, displayValue) => ({
    handle,
    requestHost,
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

    const split = splitSpacesHost(parsed.username, parsed.hostname);
    if (!split) {
      return null;
    }

    const suffix = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`;
    const displaySuffix = suffix === '/' ? '' : suffix;
    return buildResult(
      split.handle,
      split.requestHost,
      suffix === '/' ? '/' : suffix,
      `${split.requestHost}${displaySuffix}`
    );
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
      return buildResult(handle, handle, suffix, `${handle}${suffix}`);
    }

    const nameMatch = hostPart.match(/^([^@]+)@(.+)$/u);
    if (!nameMatch) {
      return null;
    }

    const split = splitSpacesHost(nameMatch[1], nameMatch[2]);
    if (!split) {
      return null;
    }

    return buildResult(split.handle, split.requestHost, suffix, `${split.requestHost}${suffix}`);
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
