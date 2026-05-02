const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');

const SPACES_RESOLVER_BASE_URL =
  process.env.SPACES_RESOLVER_BASE_URL?.trim()
  || process.env.SPACES_VERIFIER_BASE_URL?.trim()
  || 'https://verifier.pirate.sc/spaces';
const SPACES_CACHE_TTL_MS = 30 * 1000;
const spaceResultCache = new Map();

const normalizeSpaceHandle = (handle) => {
  const trimmed = (handle || '').trim();
  if (!trimmed) {
    throw new Error('Spaces handle is empty');
  }
  const match = trimmed.match(/^@([^\s/?#:@]+)$/u);
  if (!match) {
    throw new Error('Spaces handle must be a root label like @space');
  }

  const normalizedLabel = match[1].normalize('NFKC').toLowerCase();
  return `@${normalizedLabel}`;
};

const parseOutpoint = (value) => {
  if (!value || typeof value !== 'string') {
    return { txid: null, n: null };
  }

  const [txid, n] = value.split(':');
  const parsedN = Number.parseInt(n, 10);
  return {
    txid: txid || null,
    n: Number.isInteger(parsedN) ? parsedN : null,
  };
};

async function resolveViaPublicResolver(handle) {
  if (!SPACES_RESOLVER_BASE_URL) {
    throw new Error('No Spaces resolver base URL configured');
  }

  const normalizedBaseUrl = SPACES_RESOLVER_BASE_URL.endsWith('/')
    ? SPACES_RESOLVER_BASE_URL
    : `${SPACES_RESOLVER_BASE_URL}/`;
  const url = new URL('resolve', normalizedBaseUrl);
  url.searchParams.set('handle', handle);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid spaces resolver response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data?.error || `${response.status} ${response.statusText}`;
    throw new Error(`spaces resolver HTTP ${response.status}: ${message}`);
  }

  if (data.resolved !== true) {
    return {
      type: 'not_found',
      handle,
      reason: typeof data.reason === 'string' ? data.reason : 'SPACE_NOT_FOUND',
      source: 'resolver',
    };
  }

  const outpoint = parseOutpoint(data.outpoint);

  return {
    type: 'ok',
    handle: typeof data.handle === 'string' ? data.handle : handle,
    canonicalHandle:
      typeof data.canonical_handle === 'string' ? data.canonical_handle : handle,
    txid: outpoint.txid,
    n: outpoint.n,
    scriptPubkey: null,
    rootPubkey: typeof data.root_pubkey === 'string' ? data.root_pubkey : null,
    proofRootHash: typeof data.proof_root_hash === 'string' ? data.proof_root_hash : null,
    acceptedAnchorHeight:
      typeof data.accepted_anchor_height === 'number' ? data.accepted_anchor_height : null,
    acceptedAnchorBlockHash:
      typeof data.accepted_anchor_block_hash === 'string' ? data.accepted_anchor_block_hash : null,
    acceptedAnchorRootHash:
      typeof data.accepted_anchor_root_hash === 'string' ? data.accepted_anchor_root_hash : null,
    controlClass: typeof data.control_class === 'string' ? data.control_class : null,
    operationClass: typeof data.operation_class === 'string' ? data.operation_class : null,
    webUrl: typeof data.web_url === 'string' && data.web_url.trim() ? data.web_url.trim() : null,
    freedomUrl:
      typeof data.freedom_url === 'string' && data.freedom_url.trim() ? data.freedom_url.trim() : null,
    selectedUrl:
      (typeof data.freedom_url === 'string' && data.freedom_url.trim() ? data.freedom_url.trim() : null)
      || (typeof data.web_url === 'string' && data.web_url.trim() ? data.web_url.trim() : null),
    source: 'resolver',
    observationProvider:
      typeof data.observation_provider === 'string' ? data.observation_provider : null,
    proofVerified: data.proof_verified === true,
  };
}

async function resolveSpace(handle) {
  const normalizedHandle = normalizeSpaceHandle(handle);
  const cached = spaceResultCache.get(normalizedHandle);
  if (cached && Date.now() - cached.timestamp < SPACES_CACHE_TTL_MS) {
    return cached.result;
  }

  log.info(`[spaces] Resolving ${normalizedHandle} via ${SPACES_RESOLVER_BASE_URL}`);

  try {
    const result = await resolveViaPublicResolver(normalizedHandle);
    spaceResultCache.set(normalizedHandle, { result, timestamp: Date.now() });
    return result;
  } catch (err) {
    const result = {
      type: 'error',
      handle: normalizedHandle,
      reason: 'RESOLVER_UNAVAILABLE',
      message: err.message,
    };
    log.warn(`[spaces] Public resolver failed for ${normalizedHandle}: ${err.message}`);
    spaceResultCache.set(normalizedHandle, { result, timestamp: Date.now() });
    return result;
  }
}

function registerSpacesIpc() {
  ipcMain.handle(IPC.SPACES_RESOLVE, async (_event, payload = {}) => {
    return resolveSpace(payload.handle);
  });
}

module.exports = {
  normalizeSpaceHandle,
  registerSpacesIpc,
  resolveSpace,
};
