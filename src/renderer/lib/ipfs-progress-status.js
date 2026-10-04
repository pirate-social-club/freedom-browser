import { clearLoadingStatus, showLoadingStatus } from './link-status.js';

const POLL_INTERVAL_MS = 300;

const PHASE_MESSAGES = {
  queued: 'IPFS: Queued request…',
  started: 'IPFS: Starting request…',
  resolving_name: 'IPFS: Resolving IPNS name…',
  name_resolved: 'IPFS: Resolved name…',
  checking_cache: 'IPFS: Checking local cache…',
  cache_hit: 'IPFS: Loading from local cache…',
  cache_miss: 'IPFS: Looking up content…',
  provider_lookup: 'IPFS: Finding providers…',
  providers_found: 'IPFS: Connecting to providers…',
  provider_diversity_low: 'IPFS: Expanding provider search…',
  dht_fallback_started: 'IPFS: Searching the DHT…',
  fetching_bitswap: 'IPFS: Fetching from peers…',
  fetching_http_provider: 'IPFS: Fetching from verified provider…',
  first_byte: 'IPFS: Receiving content…',
  streaming: 'IPFS: Receiving content…',
  retrying: 'IPFS: Retrying slow provider…',
  completed: 'IPFS: Loaded',
  failed: 'IPFS: Load failed',
};

const PHASE_SCORE = {
  failed: 100,
  retrying: 95,
  fetching_bitswap: 90,
  fetching_http_provider: 88,
  first_byte: 82,
  streaming: 80,
  provider_lookup: 72,
  providers_found: 70,
  provider_diversity_low: 68,
  dht_fallback_started: 66,
  resolving_name: 60,
  checking_cache: 45,
  cache_hit: 42,
  cache_miss: 40,
  started: 20,
  queued: 10,
  completed: 0,
};

const TERMINAL_PHASES = new Set(['completed', 'failed']);
const TERMINAL_STATUSES = new Set(['complete', 'completed', 'done', 'error', 'failed']);

let pollTimer = null;
let pollGeneration = 0;
let pollInFlight = false;

const normalizeToken = (value) =>
  typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_')
    : '';

const candidatePhase = (item) =>
  normalizeToken(item?.phase || item?.current_phase || item?.last_phase || item?.event);

const candidateStatus = (item) => normalizeToken(item?.status || item?.state);

const isActiveCandidate = (item) => {
  const status = candidateStatus(item);
  const phase = candidatePhase(item);
  if (TERMINAL_PHASES.has(phase) || TERMINAL_STATUSES.has(status)) return false;
  return !status || status === 'active' || status === 'started' || status === 'running';
};

const kindScore = (item) => {
  const kind = normalizeToken(item?.kind);
  if (kind === 'gateway_request') return 20;
  if (kind === 'name_resolution') return 16;
  if (kind === 'provider_lookup') return 12;
  if (kind === 'block_fetch') return 6;
  return 0;
};

const elapsedScore = (item) => {
  const elapsed = Number(item?.elapsed_ms || 0);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(10, elapsed / 1000);
};

const candidateScore = (item, index) => {
  const phase = candidatePhase(item);
  return (PHASE_SCORE[phase] || 0) + kindScore(item) + elapsedScore(item) + index / 1000;
};

const collectCandidates = (snapshot) => {
  const active = Array.isArray(snapshot?.active) ? snapshot.active : [];
  if (active.length) return active.filter(isActiveCandidate);

  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  return events.filter(isActiveCandidate).slice(-12);
};

export const deriveIpfsProgressMessage = (progressSnapshot) => {
  let snapshot = progressSnapshot;
  if (typeof progressSnapshot === 'string') {
    if (!progressSnapshot.trim()) return null;
    try {
      snapshot = JSON.parse(progressSnapshot);
    } catch {
      return null;
    }
  }

  const candidates = collectCandidates(snapshot);
  if (!candidates.length) return null;

  const best = candidates.reduce(
    (selected, item, index) => {
      const score = candidateScore(item, index);
      return score > selected.score ? { item, score } : selected;
    },
    { item: null, score: -Infinity }
  ).item;

  const phase = candidatePhase(best);
  if (PHASE_MESSAGES[phase]) return PHASE_MESSAGES[phase];

  const message = typeof best?.message === 'string' ? best.message.trim() : '';
  if (message) return `IPFS: ${message}`;

  return 'IPFS: Loading content…';
};

const pollOnce = async (generation, getStatus) => {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const status = await getStatus();
    if (generation !== pollGeneration) return;
    const message = deriveIpfsProgressMessage(status?.diagnostics?.progress);
    if (message) {
      showLoadingStatus(message);
    } else {
      clearLoadingStatus();
    }
  } catch {
    if (generation === pollGeneration) clearLoadingStatus();
  } finally {
    pollInFlight = false;
  }
};

export const startIpfsProgressStatus = (options = {}) => {
  const getStatus =
    options.getStatus || (() => window.ipfs?.getStatus?.() || Promise.resolve(null));
  stopIpfsProgressStatus({ immediate: true });
  const generation = ++pollGeneration;
  pollOnce(generation, getStatus);
  pollTimer = setInterval(
    () => pollOnce(generation, getStatus),
    options.intervalMs || POLL_INTERVAL_MS
  );
};

export const stopIpfsProgressStatus = (options = {}) => {
  pollGeneration += 1;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  clearLoadingStatus({ immediate: options.immediate === true });
};
