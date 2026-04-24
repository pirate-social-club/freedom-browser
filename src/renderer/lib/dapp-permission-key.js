/**
 * Derive stable wallet permission keys from browser URLs.
 *
 * Gateway-backed dweb pages load from localhost, so raw origin alone would
 * collapse unrelated IPFS/Swarm/Radicle apps into one permission bucket.
 */

export function getPermissionKeyFromUrl(value) {
  if (!value) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  // ENS name without protocol (e.g., 1inch.eth/path)
  if (/^[a-z0-9-]+\.(eth|box)/i.test(trimmed)) {
    return trimmed.split('/')[0].toLowerCase();
  }

  // ens:// protocol -> extract ENS name (e.g., ens://1inch.eth/#/path -> 1inch.eth)
  const ensMatch = trimmed.match(/^ens:\/\/([^/#]+)/i);
  if (ensMatch) {
    return ensMatch[1].toLowerCase();
  }

  // dweb protocols: ipfs://CID/path -> ipfs://CID
  const dwebMatch = trimmed.match(/^(ipfs|bzz|ipns):\/\/([^/]+)/i);
  if (dwebMatch) {
    return `${dwebMatch[1].toLowerCase()}://${dwebMatch[2]}`;
  }

  // rad:// protocol
  const radMatch = trimmed.match(/^rad:\/\/([^/]+)/i);
  if (radMatch) {
    return `rad://${radMatch[1]}`;
  }

  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    const root = parts[1];

    // Local gateway forms.
    if (parts[0] === 'ipfs' && root) {
      return `ipfs://${root}`;
    }
    if (parts[0] === 'ipns' && root) {
      return `ipns://${root}`;
    }
    if (parts[0] === 'bzz' && root) {
      return `bzz://${root}`;
    }
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'repos' && parts[3]) {
      return `rad://${parts[3]}`;
    }

    if (url.origin === 'null') {
      return trimmed;
    }
    return url.origin;
  } catch {
    return trimmed;
  }
}

export function getPermissionContext({ webviewUrl, requestOrigin } = {}) {
  const webviewKey = getPermissionKeyFromUrl(webviewUrl);
  if (webviewKey && webviewKey !== 'about:blank') {
    return {
      permissionKey: webviewKey,
      displayUrl: webviewUrl || webviewKey,
    };
  }

  const originKey = getPermissionKeyFromUrl(requestOrigin);
  return {
    permissionKey: originKey,
    displayUrl: requestOrigin || originKey || '',
  };
}
