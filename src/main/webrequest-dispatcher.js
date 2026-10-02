// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared dispatcher for Electron `session.webRequest` events.
 *
 * Electron allows exactly one listener per `webRequest` event per session;
 * registering a second listener silently replaces the first. As the browser
 * grows new features that need to observe / intercept requests (the bzz /
 * rad request rewriter, x402 payment interception, future devtools, …) we
 * need a single owner per event that fans out to multiple consumers.
 *
 * Semantics per event:
 *
 * - `onBeforeRequest`: handlers run in registration order. The first to
 *   return a result with `cancel` or `redirectURL` wins; subsequent
 *   handlers are skipped. A handler that returns `null` / `undefined` /
 *   `{}` passes the request through.
 *
 * - `onBeforeSendHeaders`: handlers chain — each sees the request headers
 *   as accumulated by previous handlers and may return new
 *   `requestHeaders` (full replacement). A `cancel:true` from any handler
 *   short-circuits to a cancel.
 *
 * - `onHeadersReceived`: same chaining shape as `onBeforeSendHeaders` but
 *   for response headers + status line. A `cancel:true` or `redirectURL`
 *   short-circuits.
 *
 * - `onCompleted` / `onErrorOccurred`: notification-only fan-out. Handlers
 *   run in registration order; return values are ignored (Electron's
 *   listener signature for these events has no callback). Useful for
 *   per-request lifecycle cleanup (e.g. x402's request-context map).
 *
 * Handlers may be async; the dispatcher awaits each before calling the
 * next, preserving the "first match wins" semantics across handler I/O.
 * Filtering is the handler's responsibility — the dispatcher attaches
 * with no URL filter so each handler sees every request.
 *
 * Ordinary handlers that throw are logged and skipped; subsequent handlers still
 * run and the request is not cancelled. A buggy consumer must not be
 * able to break the browser's request chain.
 */

const log = require('./logger');

const EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onHeadersReceived',
  'onCompleted',
  'onErrorOccurred',
];

let sessionBindings = new WeakMap();
let registrationClosed = false;

const handlers = {
  onBeforeRequest: [],
  onBeforeSendHeaders: [],
  onHeadersReceived: [],
  onCompleted: [],
  onErrorOccurred: [],
};

/**
 * Register a handler for a webRequest event.
 *
 * @param {'onBeforeRequest'|'onBeforeSendHeaders'|'onHeadersReceived'|'onCompleted'|'onErrorOccurred'} event
 * @param {string} name - Identifier used for error logging; must be unique
 *   per event so re-registration is loud, not silent.
 * @param {(details: object) => null | undefined | object | Promise<null | undefined | object>} handler
 * @param {{ session?: Electron.Session }} [options] - Optional explicit session scope
 */
function registerWebRequestHandler(event, name, handler, options = {}) {
  if (!Object.hasOwn(handlers, event)) {
    throw new Error(`Unsupported webRequest event: ${event}`);
  }
  if (registrationClosed) {
    throw new Error('Register all webRequest handlers before attaching a session');
  }
  if (typeof handler !== 'function') throw new TypeError('webRequest handler must be a function');
  if (handlers[event].some((entry) => entry.name === name)) {
    throw new Error(`webRequest handler '${name}' already registered for ${event}`);
  }
  handlers[event].push({ name, handler, session: options.session });
}

// The getter is bound to this session at attachment. Consumer errors remain
// independent; policy errors always cancel. Never await a policy decision.
function readRequestPolicy(getRequestPolicy) {
  try {
    const policy = getRequestPolicy();
    if (policy && typeof policy.then === 'function') {
      // An async getter is invalid, including one returning a rejected promise.
      Promise.resolve(policy).catch(() => {});
      return null;
    }
    if (policy?.allowed !== true || !Number.isSafeInteger(policy.generation) || policy.generation < 0) {
      return null;
    }
    return policy.generation;
  } catch {
    return null;
  }
}

function makeRequestPermit(getRequestPolicy) {
  if (!getRequestPolicy) return () => true;
  const generation = readRequestPolicy(getRequestPolicy);
  return () => generation !== null && readRequestPolicy(getRequestPolicy) === generation;
}

function logHandlerFailure(name, event, error) {
  let message = 'unprintable exception';
  try {
    const detail = error?.message;
    message = typeof detail === 'string' ? detail : String(error);
  } catch {
    // Even exception formatting may throw; it cannot interrupt dispatch.
  }
  try {
    log.error(`[dispatcher:${name}] ${event} threw: ${message}`);
  } catch {
    // A failed log transport must not strand Electron's callback.
  }
}

function guardedCallback(callback, permitted, result) {
  callback(permitted() ? result : { cancel: true });
}

function makeOnBeforeRequestListener(eventHandlers, getRequestPolicy) {
  return async (details, callback) => {
    const permitted = makeRequestPermit(getRequestPolicy);
    for (const { name, handler } of eventHandlers) {
      if (!permitted()) { callback({ cancel: true }); return; }
      let result;
      try {
        result = await handler(details);
      } catch (err) {
        logHandlerFailure(name, 'onBeforeRequest', err);
        continue;
      }
      if (result && (result.cancel || result.redirectURL)) {
        guardedCallback(callback, permitted, result);
        return;
      }
    }
    guardedCallback(callback, permitted, {});
  };
}

function makeHeaderChainListener(eventHandlers, eventName, headersKey, getRequestPolicy) {
  return async (details, callback) => {
    const permitted = makeRequestPermit(getRequestPolicy);
    let headers = details[headersKey];
    let statusLine = details.statusLine;
    for (const { name, handler } of eventHandlers) {
      if (!permitted()) { callback({ cancel: true }); return; }
      let result;
      try {
        result = await handler({ ...details, [headersKey]: headers, statusLine });
      } catch (err) {
        logHandlerFailure(name, eventName, err);
        continue;
      }
      if (!result) continue;
      if (result.cancel) {
        callback({ cancel: true });
        return;
      }
      if (result.redirectURL) {
        guardedCallback(callback, permitted, { redirectURL: result.redirectURL });
        return;
      }
      if (result[headersKey]) headers = result[headersKey];
      if (result.statusLine) statusLine = result.statusLine;
    }
    const out = { [headersKey]: headers };
    if (statusLine) out.statusLine = statusLine;
    guardedCallback(callback, permitted, out);
  };
}

// Fan-out factory for notification-only events; see file header for
// semantics. Synchronous on purpose: Electron's listener signature has
// no callback, observers can't observe each other's results, and these
// events fire on every request — awaiting each handler would allocate
// a Promise per handler per request for no observable benefit. Sync
// handlers stay on the synchronous stack; thenables get a fire-and-
// forget `.catch` so async errors still surface.
function makeNotificationListener(eventHandlers, eventName) {
  return (details) => {
    for (const { name, handler } of eventHandlers) {
      try {
        const result = handler(details);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch((err) => logHandlerFailure(name, eventName, err));
        }
      } catch (err) {
        logHandlerFailure(name, eventName, err);
      }
    }
  };
}

/**
 * Attach one Electron listener per registered event to the given session.
 *
 * All consumers must register first. Reattachment with the same options is
 * idempotent; replacement options or a partly failed attachment are refused.
 *
 * `options.exclude` filters registered handlers by name — a predicate
 * `(name) => boolean` returning true drops that handler from this session's
 * chain. Private windows use this to attach the request rewriter without
 * the x402 payment interception (see src/main/index.js).
 *
 * @param {Electron.Session} session
 * @param {{ exclude?: (name: string) => boolean, getRequestPolicy?: () => {allowed: boolean, generation: number} }} [options]
 */
function attachWebRequestDispatcher(session, options = {}) {
  const { exclude, getRequestPolicy } = options;
  if (exclude !== undefined && typeof exclude !== 'function') {
    throw new TypeError('webRequest exclude must be a function');
  }
  if (getRequestPolicy !== undefined && typeof getRequestPolicy !== 'function') {
    throw new TypeError('webRequest request policy must be a function');
  }
  const previous = sessionBindings.get(session);
  if (previous) {
    if (previous.failed || previous.exclude !== exclude || previous.getRequestPolicy !== getRequestPolicy) {
      throw new Error('Session webRequest dispatcher cannot be replaced');
    }
    return;
  }
  const select = (event) => handlers[event].filter((entry) =>
    (entry.session === undefined || entry.session === session) && (!exclude || !exclude(entry.name)));
  const selected = Object.fromEntries(EVENTS.map((event) => [event, select(event)]));
  const required = EVENTS.filter((event) => selected[event].length > 0 ||
    (getRequestPolicy && ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'].includes(event)));
  for (const event of required) {
    if (typeof session?.webRequest?.[event] !== 'function') {
      throw new TypeError(`Session webRequest interception is unavailable: ${event}`);
    }
  }
  registrationClosed = true;
  const binding = { exclude, getRequestPolicy, failed: true };
  sessionBindings.set(session, binding);
  for (const event of required) {
    let listener;
    if (event === 'onBeforeRequest') {
      listener = makeOnBeforeRequestListener(selected[event], getRequestPolicy);
    } else if (event === 'onBeforeSendHeaders' || event === 'onHeadersReceived') {
      const key = event === 'onBeforeSendHeaders' ? 'requestHeaders' : 'responseHeaders';
      listener = makeHeaderChainListener(selected[event], event, key, getRequestPolicy);
    } else {
      listener = makeNotificationListener(selected[event], event);
    }
    session.webRequest[event](listener);
  }
  binding.failed = false;
}

/**
 * Clear all handlers. Test-only — Jest's require-cache singleton would
 * otherwise leak handler state between test suites.
 */
function _resetWebRequestHandlers() {
  sessionBindings = new WeakMap();
  registrationClosed = false;
  for (const event of EVENTS) {
    handlers[event] = [];
  }
}

module.exports = {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
  _resetWebRequestHandlers,
};
