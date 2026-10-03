/**
 * x402 per-origin payment allowance store.
 *
 * Persists the "allow up to $X for Y seconds" caps the user grants
 * inside the interstitial. Each cap is keyed by `(origin, chainId, asset)`
 * — generic "$10 for example.com" would be too coarse to defend against
 * a compromised site spending the user's holdings across chains.
 *
 *   - grant(origin, chainId, asset, capAmount, windowSeconds)
 *       Create or replace a cap. Resets `spentAmount` to 0 and starts a
 *       fresh window. Lifetime cap is single-window: when `expiresAt`
 *       passes the user is asked again. No rolling renewals — caps
 *       silently extending themselves is a footgun.
 *
 *   - tryConsume(origin, chainId, asset, amount)
 *       Atomic "is this within cap + bump spent" check. Returns `true`
 *       and persists the new spent total if covered, `false` otherwise.
 *       This is the only API the auto-pay path needs.
 *
 *   - revoke(origin, chainId, asset)
 *       Drop a cap. Idempotent.
 *
 * Atomic amounts are strings (BigInt-safe) — USDC's 6 decimals means
 * "$10" is "10000000", well within Number range, but other assets we
 * may support later (high-precision tokens, rebasing supplies) push
 * past Number.MAX_SAFE_INTEGER. Better to bite the bigint bullet now.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeOrigin } = require('../../shared/origin-utils');

const PERMISSIONS_FILE = 'x402-permissions.json';

// In-memory cache; lazy-loaded on first access. Always wins over disk
// (writes go through `save()`).
let cache = null;

function permissionsPath() {
  return path.join(app.getPath('userData'), PERMISSIONS_FILE);
}

// Drop already-expired records on load so the file doesn't accumulate
// dead grants across sessions. Compaction is in-memory only — the
// disk file gets cleaned on the next `save()` (next grant/consume/revoke).
function compactExpired(all) {
  const now = nowSeconds();
  const out = {};
  for (const [origin, byAsset] of Object.entries(all)) {
    const active = {};
    for (const [key, record] of Object.entries(byAsset)) {
      if (record?.expiresAt > now) active[key] = record;
    }
    if (Object.keys(active).length > 0) out[origin] = active;
  }
  return out;
}

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(permissionsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' ? compactExpired(parsed) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[x402:permissions] failed to load:', err.message);
    }
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(permissionsPath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[x402:permissions] failed to save:', err.message);
  }
}

function assetKey(chainId, asset) {
  return `${chainId}:${asset}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create or replace a cap. Starts fresh: spent=0, window from `now`.
 *
 * @param {string} origin - Will be normalised.
 * @param {number} chainId
 * @param {string} asset - ERC-20 address (case-preserving).
 * @param {string} capAmount - Atomic units, as a digit string.
 * @param {number} windowSeconds - How long the cap is valid for.
 * @returns {object} The persisted record.
 */
function grant(origin, chainId, asset, capAmount, windowSeconds) {
  if (typeof capAmount !== 'string' || !/^\d+$/.test(capAmount)) {
    throw new Error('x402-permissions: capAmount must be a digit string');
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('x402-permissions: windowSeconds must be a positive number');
  }

  const all = load();
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    throw new Error(`x402-permissions: origin '${origin}' could not be normalised`);
  }
  const created = nowSeconds();
  const record = {
    capAmount,
    spentAmount: '0',
    createdAt: created,
    expiresAt: created + windowSeconds,
  };

  const byAsset = all[normalized] ?? {};
  byAsset[assetKey(chainId, asset)] = record;
  all[normalized] = byAsset;
  cache = all;
  save();
  return { origin: normalized, chainId, asset, ...record };
}

/**
 * Look up the cap for an origin/asset pair. Returns null if absent or
 * expired (expired entries are treated as if they don't exist; they
 * get cleaned up lazily on next `grant` or `getAll`).
 */
function getPermission(origin, chainId, asset) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  const record = all[normalized]?.[assetKey(chainId, asset)];
  if (!record) return null;
  if (record.expiresAt <= nowSeconds()) return null;
  return { origin: normalized, chainId, asset, ...record };
}

/**
 * Check that `amount` fits inside the remaining cap; if it does,
 * bump `spentAmount` and persist. Returns `true` on success, `false`
 * if no cap, expired cap, or over cap.
 *
 * Strings + BigInt arithmetic so atomic units bigger than 2^53 don't
 * round.
 */
function tryConsume(origin, chainId, asset, amount) {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return false;
  const all = load();
  const normalized = normalizeOrigin(origin);
  const byAsset = all[normalized];
  if (!byAsset) return false;
  const key = assetKey(chainId, asset);
  const record = byAsset[key];
  if (!record) return false;
  if (record.expiresAt <= nowSeconds()) return false;

  const cap = BigInt(record.capAmount);
  const spent = BigInt(record.spentAmount);
  const next = spent + BigInt(amount);
  if (next > cap) return false;

  byAsset[key] = { ...record, spentAmount: next.toString() };
  cache = all;
  save();
  return true;
}

/**
 * Drop a cap. Idempotent.
 */
function revoke(origin, chainId, asset) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  const byAsset = all[normalized];
  if (!byAsset) return;
  delete byAsset[assetKey(chainId, asset)];
  if (Object.keys(byAsset).length === 0) {
    delete all[normalized];
  }
  cache = all;
  save();
}

/**
 * Drop every cap for an origin (all chain/asset combos). Idempotent.
 */
function revokeAllForOrigin(origin) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  if (!all[normalized]) return;
  delete all[normalized];
  cache = all;
  save();
}

/**
 * Patch an existing cap's amount and/or window. Preserves `spentAmount`
 * (a user bumping their cap shouldn't reset what they've already spent)
 * and recomputes `expiresAt` from `createdAt + windowSeconds` when the
 * window changes. Throws if the record doesn't exist — call grant first
 * for new entries.
 *
 * @param {string} origin
 * @param {number} chainId
 * @param {string} asset
 * @param {{ capAmount?: string, windowSeconds?: number }} patch
 * @returns {object} The updated record.
 */
function updatePermission(origin, chainId, asset, patch = {}) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  const byAsset = all[normalized];
  const key = assetKey(chainId, asset);
  const record = byAsset?.[key];
  if (!record) {
    throw new Error('x402-permissions: no permission to update');
  }

  const next = { ...record };
  if (patch.capAmount !== undefined) {
    if (typeof patch.capAmount !== 'string' || !/^\d+$/.test(patch.capAmount)) {
      throw new Error('x402-permissions: capAmount must be a digit string');
    }
    next.capAmount = patch.capAmount;
  }
  if (patch.windowSeconds !== undefined) {
    if (!Number.isFinite(patch.windowSeconds) || patch.windowSeconds <= 0) {
      throw new Error('x402-permissions: windowSeconds must be a positive number');
    }
    next.expiresAt = record.createdAt + patch.windowSeconds;
  }

  byAsset[key] = next;
  cache = all;
  save();
  return { origin: normalized, chainId, asset, ...next };
}

/**
 * Flat list of every active (non-expired) cap. Used by the activity
 * pane in WP6 to render the revoke UI.
 */
function getAllPermissions() {
  const all = load();
  const now = nowSeconds();
  const out = [];
  for (const [origin, byAsset] of Object.entries(all)) {
    for (const [key, record] of Object.entries(byAsset)) {
      if (record.expiresAt <= now) continue;
      const [chainIdStr, asset] = key.split(':');
      out.push({ origin, chainId: Number(chainIdStr), asset, ...record });
    }
  }
  return out;
}

function _resetCache() {
  cache = null;
}

module.exports = {
  grant,
  getPermission,
  tryConsume,
  revoke,
  revokeAllForOrigin,
  updatePermission,
  getAllPermissions,
  _resetCache,
};
