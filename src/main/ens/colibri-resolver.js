const { ethers } = require('ethers');
const { ccipReadFetch } = require('./ccip-fetch');
// Colibri itself runs in a per-chain worker thread (#495): proof verification
// is synchronous WASM and must never block Electron's main process. The worker
// owns the package (via colibri-runtime), its disk storage and trap recovery.
const workerHost = require('./colibri-worker-host');
const log = require('../logger');
const registry = require('../networks/network-registry');
const { universalResolverCall, universalResolverReverse, hostOf } = require('../ens-resolver');
const {
  isBrowsingSessionRetired,
  onBrowsingSessionRetired,
  requireBrowsingSession,
  sessionKey,
  sessionUnavailableError,
} = require('../browsing-transport');

// One client per chain AND per browsing session (`${chainId}|${sessionKey}`):
// a client's network traffic is dialled on the session it was built for (see
// colibri-worker-host.js), so a private window never verifies through a
// client built for another window, nor joins another window's build.
const clients = new Map();
const inFlightBuilds = new Map();
const clientReferences = new Map();
const retiredClients = new Set();
const buildGenerations = new Map();

function slotFor(chainId, browsingSession) {
  return `${Number(chainId)}|${sessionKey(browsingSession)}`;
}

function destroyClient(client) {
  if (!client || typeof client.destroy !== 'function') return;
  try {
    client.destroy();
  } catch (err) {
    log.warn(`[ens-colibri] failed to destroy old client: ${err.message}`);
  }
}

function retainClient(client) {
  clientReferences.set(client, (clientReferences.get(client) || 0) + 1);
}

function releaseClient(client) {
  const remaining = (clientReferences.get(client) || 1) - 1;
  if (remaining > 0) {
    clientReferences.set(client, remaining);
    return;
  }
  clientReferences.delete(client);
  if (retiredClients.delete(client)) destroyClient(client);
}

function retireClient(client) {
  if (!client) return;
  if ((clientReferences.get(client) || 0) > 0) {
    retiredClients.add(client);
    return;
  }
  destroyClient(client);
}

// Obtain a live client + its provider with a reference already held, closing
// the use-after-destroy window: retainClient only ran inside the old
// useClient, i.e. after `await getClient` resolved, and in that microtask gap a
// concurrent request's failure path could release the last ref and destroy the
// very client this caller was about to use. Here we retain optimistically and
// then re-validate that the retained client is still the cached one (and not
// retired); if it was swapped/evicted during the gap, release and re-acquire.
// The caller releases in a finally.
async function acquireClient(chainId, browsingSession) {
  const id = Number(chainId);
  const slot = slotFor(id, browsingSession);
  for (;;) {
    const client = await getClient(id, browsingSession);
    retainClient(client);
    const cached = clients.get(slot);
    if (cached?.client === client && !retiredClients.has(client)) {
      return { client, provider: cached.provider };
    }
    // Evicted or rebuilt during the acquire gap — drop our ref and retry.
    releaseClient(client);
  }
}

function colibriRevertData(err) {
  const data = err?.data || err?.info?.error?.data || '';
  return typeof data === 'string' && data.length >= 10 ? data : null;
}

function retryableColibriError(err) {
  if (!err) return false;
  if (err.code === 'CALL_EXCEPTION') return colibriRevertData(err) === null;
  if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT'].includes(err.code)) return true;
  if (err.info?.error?.code === -32603) return true;
  return /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|no response|timeout/i
    .test(err.shortMessage || err.message || '');
}

function sanitizeColibriErrorDetail(value, maxLength = 200) {
  if (value == null || value === '') return '';
  const cleaned = String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/0x[0-9a-fA-F]{66,}/g, (hex) =>
      `${hex.slice(0, 10)}…(${Math.floor((hex.length - 2) / 2)} bytes)`
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 1)}…`;
}

function colibriErrorForLog(err) {
  const nested = err?.info?.error;
  const message = sanitizeColibriErrorDetail(
    err?.shortMessage || err?.reason || err?.message || String(err)
  );
  const fields = [`error=${JSON.stringify(message || 'unknown error')}`];
  if (err?.code != null) fields.push(`code=${sanitizeColibriErrorDetail(err.code, 40)}`);
  if (nested?.code != null) fields.push(`rpcCode=${sanitizeColibriErrorDetail(nested.code, 40)}`);
  if (nested?.message) {
    fields.push(`rpcMessage=${JSON.stringify(sanitizeColibriErrorDetail(nested.message))}`);
  }
  fields.push(`revert=${colibriRevertData(err)?.slice(0, 10) || 'none'}`);
  return fields.join(' ');
}

// Evict only the client that actually failed. If another concurrent request
// or a settings change has already installed a replacement, leave it intact.
function evictFailedClient(slot, failedClient) {
  const cached = clients.get(slot);
  if (cached?.client !== failedClient) return;
  clients.delete(slot);
  retireClient(failedClient);
}

// Retry exactly once after rebuilding the in-memory verifier. This recovers
// from a stale runtime after sleep or a transient prover/network failure while
// preserving fail-closed behavior: proof failures and reverts carrying actual
// EVM revert data are never retried or reclassified.
async function withColibriClientRetry(chainId, browsingSession, operation) {
  const id = Number(chainId);
  const first = await acquireClient(id, browsingSession);
  try {
    return await operation(first);
  } catch (err) {
    if (!retryableColibriError(err)) throw err;
    log.warn(
      `[colibri] chain ${id} request failed; rebuilding client and retrying once ` +
      colibriErrorForLog(err)
    );
    evictFailedClient(slotFor(id, browsingSession), first.client);
    const retry = await acquireClient(id, browsingSession);
    try {
      return await operation(retry);
    } finally {
      releaseClient(retry.client);
    }
  } finally {
    // Always releases first's acquire ref — on success, on a rethrown
    // non-retryable error, and after the retry path above. Dropping the last
    // ref on an evicted/retired client is what finally destroys it.
    releaseClient(first.client);
  }
}

async function buildClient({ chainId, slot, key, proverUrl, zkProof, generation, browsingSession }) {
  // The worker for this chain and session registers the verifier's storage
  // before it reports ready (on disk for the default session, in memory for
  // any other; colibri-worker-host.js, STORAGE); settings-change rebuilds
  // reuse the same worker and storage.
  await workerHost.ensureWorker(chainId, browsingSession);

  const client = workerHost.createClient({ chainId, proverUrl, zkProof, session: browsingSession });

  // A newer build for this slot, or this session's window closed meanwhile
  // (its generations were dropped): this one is obsolete.
  if (generation !== buildGenerations.get(slot)) {
    destroyClient(client);
    return getClient(chainId, browsingSession);
  }

  const previousClient = clients.get(slot)?.client;
  // Co-locate the provider with its client in one entry so acquireClient
  // captures the {client, provider} pair atomically — a separate providers
  // map can return undefined mid-rebuild or a provider from another
  // generation.
  const provider = new ethers.BrowserProvider(client);
  // Colibri pins EVM reads internally, so ethers sees "latest" and follows
  // OffchainLookup automatically. Its inherited gateway fetch has no body
  // cap and a 300s timeout; use the same bounds as Myotis and pinned RPCs,
  // on the session this client was built for.
  provider.ccipReadFetch = (transaction, data, urls) =>
    ccipReadFetch(transaction, data, urls, undefined, { session: browsingSession });
  clients.set(slot, { client, key, provider });
  retireClient(previousClient);
  log.info(`[colibri] chain ${chainId} client ready (prover=${hostOf(proverUrl)}, zk=${zkProof})`);
  return client;
}

// Lazy singleton per (chain, session) slot. Cache key is the tuple of
// settings that materially affect proof state (prover URL + zk_proof flag); a
// runtime change to either tears down the cached instance and rebuilds. WASM
// init is paid on first use, not module load. `inFlightBuild` collapses
// concurrent first-call lookups of one slot onto a single construction. The
// generation counter prevents a slower old-settings build from replacing a
// newer client.
async function getClient(chainId, browsingSession) {
  const id = Number(chainId);
  if (isBrowsingSessionRetired(browsingSession)) throw sessionUnavailableError();
  const slot = slotFor(id, browsingSession);
  const [proverUrl] = registry.getEndpoints(id, 'prover');
  if (!proverUrl) {
    throw new Error(`No Colibri prover configured for chain ${id}`);
  }
  const zkProof = registry.getNetwork(id)?.zkProof !== false;
  const key = `${proverUrl}|${zkProof}`;
  const cached = clients.get(slot);
  const inFlight = inFlightBuilds.get(slot);
  if (cached?.client && cached.key === key) {
    if (inFlight && inFlight.key !== key) {
      buildGenerations.set(slot, (buildGenerations.get(slot) || 0) + 1);
    }
    return cached.client;
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const generation = (buildGenerations.get(slot) || 0) + 1;
  buildGenerations.set(slot, generation);
  const promise = buildClient({
    chainId: id, slot, key, proverUrl, zkProof, generation, browsingSession,
  });
  inFlightBuilds.set(slot, { key, promise, generation });
  try { return await promise; }
  finally {
    if (inFlightBuilds.get(slot)?.promise === promise) inFlightBuilds.delete(slot);
  }
}

// A private window closed: drop its clients (destroyed once no request holds
// them; their network traffic is cut off by the worker host right away) and
// its generations, so a build still in flight for it is discarded.
function forgetColibriSession(retired) {
  const suffix = `|${sessionKey(retired)}`;
  if (suffix === '|default') return;
  for (const [slot, { client }] of [...clients]) {
    if (!slot.endsWith(suffix)) continue;
    clients.delete(slot);
    retireClient(client);
  }
  for (const slot of [...buildGenerations.keys()]) {
    if (slot.endsWith(suffix)) buildGenerations.delete(slot);
  }
}

onBrowsingSessionRetired(forgetColibriSession);

// Drop-in for what a single `consensusResolve` leg does today, but the
// answer is cryptographically verified by Colibri rather than corroborated
// across multiple public RPCs. No blockTag override — Colibri's verifier
// pins to head − 1 by construction (sync committee signatures for block N
// live in block N+1).
// Each entry point takes the session from the request's context
// (browsing-transport.js) before anything is built or dialled: a private
// caller that lost its session fails here.
async function resolveCallViaColibri(name, callData, callResolver = universalResolverCall) {
  const browsingSession = requireBrowsingSession();
  return withColibriClientRetry(1, browsingSession, ({ provider }) =>
    callResolver(provider, name, callData)
  );
}

async function resolveViaColibri(name, callData) {
  return resolveCallViaColibri(name, callData, universalResolverCall);
}

// Reverse counterpart: cryptographically-verified `ur.reverse` for an
// address. Returns { name } on a successful (forward-verified) lookup.
// Throws on revert (UR's ResolverNotFound / ReverseAddressMismatch) or
// network/verification failure — the orchestrator classifies.
async function resolveReverseViaColibri(addressBytes, coinType = 60n) {
  const browsingSession = requireBrowsingSession();
  return withColibriClientRetry(1, browsingSession, ({ provider }) =>
    universalResolverReverse(provider, addressBytes, {}, coinType)
  );
}

// `deadlineMs` is how long the caller will wait: past it, a worker still
// verifying this request is terminated rather than left running.
async function requestViaColibri(chainId, method, params = [], { deadlineMs } = {}) {
  const browsingSession = requireBrowsingSession();
  return withColibriClientRetry(chainId, browsingSession, ({ client }) =>
    client.request({ method, params }, { deadlineMs })
  );
}

function clearColibriClientForTest() {
  for (const { client } of clients.values()) retireClient(client);
  for (const slot of new Set([
    ...clients.keys(),
    ...inFlightBuilds.keys(),
    ...buildGenerations.keys(),
  ])) {
    buildGenerations.set(slot, (buildGenerations.get(slot) || 0) + 1);
  }
  clients.clear();
  inFlightBuilds.clear();
  for (const client of retiredClients) destroyClient(client);
  clientReferences.clear();
  retiredClients.clear();
}

module.exports = {
  resolveCallViaColibri,
  resolveViaColibri,
  resolveReverseViaColibri,
  requestViaColibri,
  clearColibriClientForTest,
};
