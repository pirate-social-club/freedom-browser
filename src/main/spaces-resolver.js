const net = require('net');
const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const { normalizeSpaceHandle, parseSpacesHandleInput } = require('../shared/spaces-handle');
const {
  buildSpacesProxyUrl,
  rememberSpacesBinding,
  startSpacesProxy,
} = require('./spaces-proxy');

const SPACES_RESOLVER_BASE_URL =
  process.env.SPACES_RESOLVER_BASE_URL?.trim()
  || process.env.SPACES_VERIFIER_BASE_URL?.trim()
  || 'https://verifier.pirate.sc/spaces';
const SPACES_CACHE_TTL_MS = 30 * 1000;
const spaceResultCache = new Map();

let fabricLoader = async () => {
  const { Fabric } = await import('@spacesprotocol/fabric-web');
  const seeds = process.env.SPACES_FABRIC_SEEDS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Fabric(seeds?.length ? { seeds } : {});
};

let fabricClientPromise = null;

function setFabricLoader(loader) {
  fabricLoader = loader;
  fabricClientPromise = null;
}

function resetSpacesResolverForTests() {
  spaceResultCache.clear();
  fabricClientPromise = null;
}

async function getFabric() {
  if (!fabricLoader) {
    return null;
  }
  if (!fabricClientPromise) {
    fabricClientPromise = Promise.resolve()
      .then(() => fabricLoader())
      .catch((error) => {
        log.warn(`[spaces] Fabric client unavailable: ${error.message}`);
        return null;
      });
  }
  return fabricClientPromise;
}

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

function collectAddrValues(records, key) {
  if (!records) return [];

  if (Array.isArray(records)) {
    return records
      .filter((record) => record?.type === 'addr' && record.key === key)
      .flatMap((record) => (Array.isArray(record.value) ? record.value : [record.value]));
  }

  const addrMap = records.addr || {};
  const values = addrMap[key];
  if (!values) return [];
  return Array.isArray(values) ? values : [values];
}

function extractIpv4(zone) {
  if (!zone) return null;
  const json = typeof zone.toJson === 'function' ? zone.toJson() : zone;
  const values = collectAddrValues(json.records, 'ipv4');
  return values.find((value) => net.isIP(String(value)) === 4) || null;
}

async function attachProxyFields(result) {
  if (result?.type !== 'ok' || !result.ipv4) {
    return result;
  }
  rememberSpacesBinding(result.handle, result.ipv4, result.port || 80);
  await startSpacesProxy();
  return {
    ...result,
    proxyUrl: buildSpacesProxyUrl(result.handle, '/'),
  };
}

async function resolveViaFabric(handle) {
  const fabric = await getFabric();
  if (!fabric?.resolve) {
    return null;
  }

  const zone = await fabric.resolve(handle);
  if (!zone) {
    return null;
  }

  const ipv4 = extractIpv4(zone);
  if (!ipv4) {
    return null;
  }

  const resolvedHandle = typeof zone.handle === 'string'
    ? normalizeSpaceHandle(zone.handle)
    : handle;

  return attachProxyFields({
    type: 'ok',
    handle: resolvedHandle,
    canonicalHandle: resolvedHandle,
    ipv4,
    port: 80,
    scheme: 'http',
    source: 'fabric',
    webUrl: null,
    freedomUrl: null,
    selectedUrl: null,
    txid: null,
    n: null,
    scriptPubkey: null,
    rootPubkey: null,
    proofRootHash: null,
    acceptedAnchorHeight: null,
    acceptedAnchorBlockHash: null,
    acceptedAnchorRootHash: null,
    controlClass: null,
    operationClass: null,
    observationProvider: null,
    proofVerified: false,
  });
}

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
    ipv4: null,
    port: 80,
    scheme: 'http',
    proxyUrl: null,
  };
}

async function resolveSpace(handle) {
  const parsed = parseSpacesHandleInput(handle);
  if (!parsed) {
    throw new Error('Spaces handle must be name@space or @space without credentials or dotted space labels');
  }
  const normalizedHandle = parsed.handle;
  const cached = spaceResultCache.get(normalizedHandle);
  if (cached && Date.now() - cached.timestamp < SPACES_CACHE_TTL_MS) {
    return cached.result;
  }

  log.info(`[spaces] Resolving ${normalizedHandle}`);

  try {
    const fabricResult = await resolveViaFabric(normalizedHandle);
    if (fabricResult) {
      spaceResultCache.set(normalizedHandle, { result: fabricResult, timestamp: Date.now() });
      return fabricResult;
    }

    log.info(`[spaces] No Fabric ipv4 for ${normalizedHandle}, trying public resolver`);
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
    log.warn(`[spaces] Resolution failed for ${normalizedHandle}: ${err.message}`, err.cause || '');
    spaceResultCache.set(normalizedHandle, { result, timestamp: Date.now() });
    return result;
  }
}

async function resolveSpacesHandles(handles = []) {
  const unique = [...new Set(handles.map((value) => {
    try {
      return normalizeSpaceHandle(value);
    } catch {
      return null;
    }
  }).filter(Boolean))];

  const results = await Promise.all(unique.map((handle) => resolveSpace(handle)));
  return Object.fromEntries(unique.map((handle, index) => [handle, results[index]]));
}

function registerSpacesIpc() {
  ipcMain.handle(IPC.SPACES_RESOLVE, async (_event, payload = {}) => {
    return resolveSpace(payload.handle);
  });
}

module.exports = {
  extractIpv4,
  normalizeSpaceHandle,
  registerSpacesIpc,
  resetSpacesResolverForTests,
  resolveSpace,
  resolveSpacesHandles,
  setFabricLoader,
};
