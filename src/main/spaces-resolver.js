const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');

const DEFAULT_SPACES_RESOLVER_BASE_URL = 'https://verifier.pirate.sc/spaces';
const SPACES_CACHE_TTL_MS = 30 * 1000;
const SPACES_REQUEST_TIMEOUT_MS = 15 * 1000;
const spaceResultCache = new Map();

const getResolverBaseUrl = () =>
  process.env.SPACES_RESOLVER_BASE_URL?.trim()
  || process.env.SPACES_VERIFIER_BASE_URL?.trim()
  || DEFAULT_SPACES_RESOLVER_BASE_URL;

const normalizeSpaceHandle = (handle) => {
  const trimmed = (handle || '').trim();
  if (!trimmed) throw new Error('Spaces handle is empty');

  const match = trimmed.match(/^@([^\s/?#:@]+)$/u);
  if (!match) throw new Error('Spaces handle must be a root label like @space');

  return `@${match[1].normalize('NFKC').toLowerCase()}`;
};

const parseOutpoint = (value) => {
  if (!value || typeof value !== 'string') return { txid: null, n: null };

  const [txid, n] = value.split(':');
  const parsedN = Number.parseInt(n, 10);
  return {
    txid: txid || null,
    n: Number.isInteger(parsedN) ? parsedN : null,
  };
};

const optionalString = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const safePublishedUrl = (value) => {
  const candidate = optionalString(value);
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    return ['https:', 'http:', 'bzz:', 'ipfs:', 'ipns:'].includes(parsed.protocol)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

async function resolveViaPublicResolver(handle, fetchImpl = fetch) {
  const resolverBaseUrl = getResolverBaseUrl();
  const normalizedBaseUrl = resolverBaseUrl.endsWith('/')
    ? resolverBaseUrl
    : `${resolverBaseUrl}/`;
  const url = new URL('resolve', normalizedBaseUrl);
  url.searchParams.set('handle', handle);

  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(SPACES_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Spaces resolver returned invalid JSON');
  }

  if (!response.ok) {
    const reason = optionalString(data?.error) || `${response.status} ${response.statusText}`;
    throw new Error(`Spaces resolver HTTP ${response.status}: ${reason}`);
  }

  if (data.resolved !== true) {
    return {
      type: 'not_found',
      handle,
      reason: optionalString(data.reason) || 'SPACE_NOT_FOUND',
      source: 'resolver',
    };
  }

  if (data.proof_verified !== true) {
    throw new Error('Spaces resolver did not return a verified proof');
  }

  const outpoint = parseOutpoint(data.outpoint);
  const freedomUrl = safePublishedUrl(data.freedom_url);
  const webUrl = safePublishedUrl(data.web_url);

  return {
    type: 'ok',
    handle: optionalString(data.handle) || handle,
    canonicalHandle: optionalString(data.canonical_handle) || handle,
    txid: outpoint.txid,
    n: outpoint.n,
    rootPubkey: optionalString(data.root_pubkey),
    proofRootHash: optionalString(data.proof_root_hash),
    acceptedAnchorHeight:
      typeof data.accepted_anchor_height === 'number' ? data.accepted_anchor_height : null,
    acceptedAnchorBlockHash: optionalString(data.accepted_anchor_block_hash),
    acceptedAnchorRootHash: optionalString(data.accepted_anchor_root_hash),
    controlClass: optionalString(data.control_class),
    operationClass: optionalString(data.operation_class),
    webUrl,
    freedomUrl,
    selectedUrl: freedomUrl || webUrl,
    source: 'resolver',
    observationProvider: optionalString(data.observation_provider),
    proofVerified: true,
  };
}

async function resolveSpace(handle) {
  const normalizedHandle = normalizeSpaceHandle(handle);
  const cached = spaceResultCache.get(normalizedHandle);
  if (cached && Date.now() - cached.timestamp < SPACES_CACHE_TTL_MS) return cached.result;

  log.info(`[spaces] Resolving ${normalizedHandle}`);
  try {
    const result = await resolveViaPublicResolver(normalizedHandle);
    spaceResultCache.set(normalizedHandle, { result, timestamp: Date.now() });
    return result;
  } catch (error) {
    log.warn(`[spaces] Resolver failed for ${normalizedHandle}: ${error.message}`);
    const result = {
      type: 'error',
      handle: normalizedHandle,
      reason: 'RESOLVER_UNAVAILABLE',
      message: 'The Spaces resolver is unavailable or returned an unverified response.',
    };
    spaceResultCache.set(normalizedHandle, { result, timestamp: Date.now() });
    return result;
  }
}

function registerSpacesIpc() {
  ipcMain.handle(IPC.SPACES_RESOLVE, (_event, payload = {}) => resolveSpace(payload.handle));
}

function resetForTests() {
  spaceResultCache.clear();
}

module.exports = {
  normalizeSpaceHandle,
  registerSpacesIpc,
  resolveSpace,
  resolveViaPublicResolver,
  resetForTests,
};
