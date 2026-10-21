/**
 * The Electron session a main-process network request is made for.
 *
 * WHY THIS EXISTS
 *
 * Name resolution (ENS, its CCIP-Read gateways, the Colibri verifier) and the
 * chain-data RPC reads behind `wallet:chain-request` and `web3:` run in the
 * main process on behalf of one window. Their traffic has to follow that
 * window's session: its proxy policy (the Tor PAC for `.onion`, a dVPN, HNS
 * routing) and, for a private window, its own in-memory partition rather than
 * the default session the window's chrome runs on. Node's `fetch` and ethers'
 * `http.request` follow neither, so a lookup made for a private window behind
 * a proxy went out DIRECT.
 *
 * Threading a session argument through every hop (protocol handler →
 * content-name resolver → ENS resolver → consensus wave → quorum leg → ethers
 * provider → transport) would be the same dozen signature changes
 * `private/private-log-context.js` avoided for log redaction, with the same
 * failure mode: one missed hop is a silent leak. So the entry points that know
 * the session mark the whole async subtree once, beside that marker:
 *   - the dweb protocol handlers, from the session they are registered on
 *     (a private session gets its own registration, see src/main/index.js),
 *   - the ENS and `wallet:chain-request` IPC handlers, from `event.sender`
 *     (`browsingSessionFor`).
 * Every transport underneath asks `requireBrowsingSession()` for the session to
 * dial on.
 *
 * FAILING CLOSED
 *
 * Callers with no browsing context at all (balance refreshes, transaction
 * tracking, Ant's chain bridge, startup probes) get the default session, which
 * is what they dialled through before. A caller that is in a private log
 * context but carries no session is a hop that lost its session somewhere; it
 * gets an error (`SESSION_UNAVAILABLE`), never the default session, because
 * the default session is exactly where a private window's lookups must not go.
 * The same goes for a session whose private window has closed: its
 * retirement (`retireBrowsingSession`, a private-window cleanup hook) stops
 * new work on it and tells the modules holding per-session state to drop it.
 *
 * Per-session state (caches, in-flight dedupe, verifier clients) is keyed by
 * `sessionKey(session)`, an opaque key minted per Session object. It is never
 * derived from a partition string, which a renderer could name.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { BrowserWindow, session } = require('electron');
const log = require('./logger');
const { isPrivateLogContext } = require('./private/private-log-context');
const { getPartitionForWebContents, isPrivateWebContents } = require('./private/private-windows');

const store = new AsyncLocalStorage();
const sessionKeys = new WeakMap();
let nextSessionKey = 1;
const retiredSessions = new WeakSet();
const retirementListeners = new Set();

// The session a window's tabs browse in. A sender that no longer has a window
// (closing mid-lookup), or a private window whose partition is already gone,
// gets none, never the default session.
function hasLiveWindow(sender) {
  try {
    return Boolean(sender && !sender.isDestroyed() && BrowserWindow.fromWebContents(sender));
  } catch {
    return false;
  }
}

function browsingSessionFor(sender) {
  if (!hasLiveWindow(sender)) return null;
  const partition = getPartitionForWebContents(sender);
  if (partition) return session.fromPartition(partition);
  return isPrivateWebContents(sender) ? null : session.defaultSession;
}

// `session.defaultSession` is a getter that throws before the app is ready,
// and Jest's electron mocks often have no `session` at all. Neither is a
// browsing context, so both read as "no session object", which the transports
// treat as the default session they dial on anyway.
function defaultBrowsingSession() {
  try {
    return session?.defaultSession;
  } catch {
    return undefined;
  }
}

function sessionUnavailableError() {
  const err = new Error('Browsing session unavailable');
  err.code = 'SESSION_UNAVAILABLE';
  return err;
}

/**
 * Run `fn` with `targetSession` as the session every network request reached
 * from it (however deep, however async) is made on. Returns whatever `fn`
 * returns, including its promise. A null session clears an outer one rather
 * than inheriting it.
 */
function runWithBrowsingSession(targetSession, fn) {
  return store.run(targetSession || null, fn);
}

/** The session the current async context serves, or null when none was set. */
function currentBrowsingSession() {
  return store.getStore() || null;
}

/**
 * The session to dial on: the current context's, unless its window has
 * closed; for no context at all, the default session, except in a private log
 * context, which throws rather than fall back to it (see FAILING CLOSED).
 */
function requireBrowsingSession() {
  const current = currentBrowsingSession();
  if (current) {
    if (retiredSessions.has(current)) throw sessionUnavailableError();
    return current;
  }
  if (isPrivateLogContext()) throw sessionUnavailableError();
  return defaultBrowsingSession();
}

/**
 * A stable opaque key for `targetSession`: 'default' for the default session
 * (and for no session object at all, see `defaultBrowsingSession`), otherwise
 * one minted the first time the Session object is seen. Keys are never reused.
 */
function sessionKey(targetSession) {
  if (!targetSession || targetSession === defaultBrowsingSession()) return 'default';
  if (typeof targetSession !== 'object') throw new TypeError('sessionKey needs a Session object');
  let key = sessionKeys.get(targetSession);
  if (!key) {
    key = `s${nextSessionKey++}`;
    sessionKeys.set(targetSession, key);
  }
  return key;
}

function isBrowsingSessionRetired(targetSession) {
  return Boolean(targetSession) && typeof targetSession === 'object' && retiredSessions.has(targetSession);
}

/**
 * Mark a private window's session torn down. Electron keeps an in-memory
 * partition's Session object alive after its window closes, and the
 * window's cleanup hooks go on to unregister its routing (HNS, `.onion`), so
 * nothing may keep dialling on it: from here `requireBrowsingSession()`
 * refuses it, and every listener (verifier clients, resolver caches, in-flight
 * bridge fetches) drops what it holds for it. Idempotent; the default session
 * is never retired.
 */
function retireBrowsingSession(targetSession) {
  if (!targetSession || typeof targetSession !== 'object') return;
  if (targetSession === defaultBrowsingSession() || retiredSessions.has(targetSession)) return;
  retiredSessions.add(targetSession);
  for (const listener of [...retirementListeners]) {
    try {
      listener(targetSession);
    } catch (err) {
      log.error('[browsing-transport] session retirement listener failed:', err?.message || err);
    }
  }
}

/** Calls `listener(session)` once per retired session. Returns an unsubscribe. */
function onBrowsingSessionRetired(listener) {
  if (typeof listener !== 'function') return () => {};
  retirementListeners.add(listener);
  return () => retirementListeners.delete(listener);
}

module.exports = {
  browsingSessionFor,
  runWithBrowsingSession,
  currentBrowsingSession,
  requireBrowsingSession,
  sessionKey,
  sessionUnavailableError,
  isBrowsingSessionRetired,
  retireBrowsingSession,
  onBrowsingSessionRetired,
};
