// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
  _resetWebRequestHandlers,
} = require('./webrequest-dispatcher');

const makeSessionMock = () => ({
  webRequest: {
    onBeforeRequest: jest.fn(),
    onBeforeSendHeaders: jest.fn(),
    onHeadersReceived: jest.fn(),
    onCompleted: jest.fn(),
    onErrorOccurred: jest.fn(),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetWebRequestHandlers();
});

describe('attachWebRequestDispatcher', () => {
  test('does not attach a listener for an event with no handlers', () => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    expect(session.webRequest.onBeforeRequest).not.toHaveBeenCalled();
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
    expect(session.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    expect(session.webRequest.onCompleted).not.toHaveBeenCalled();
    expect(session.webRequest.onErrorOccurred).not.toHaveBeenCalled();
  });

  test('attaches exactly one listener per event that has handlers', () => {
    registerWebRequestHandler('onBeforeRequest', 'a', () => null);
    registerWebRequestHandler('onBeforeRequest', 'b', () => null);
    registerWebRequestHandler('onHeadersReceived', 'c', () => null);
    registerWebRequestHandler('onCompleted', 'd', () => null);
    registerWebRequestHandler('onErrorOccurred', 'e', () => null);

    const session = makeSessionMock();
    attachWebRequestDispatcher(session);

    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onCompleted).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onErrorOccurred).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
  });
});

describe('registerWebRequestHandler', () => {
  test('rejects unknown events', () => {
    expect(() => registerWebRequestHandler('onWhatever', 'a', () => null))
      .toThrow(/Unsupported webRequest event/);
  });

  test('rejects duplicate registration under the same name + event', () => {
    registerWebRequestHandler('onBeforeRequest', 'rewriter', () => null);
    expect(() => registerWebRequestHandler('onBeforeRequest', 'rewriter', () => null))
      .toThrow(/already registered/);
  });

  test('allows the same name on different events (different dispatch chains)', () => {
    registerWebRequestHandler('onBeforeRequest', 'x402', () => null);
    expect(() => registerWebRequestHandler('onHeadersReceived', 'x402', () => null))
      .not.toThrow();
  });
});

// === onBeforeRequest dispatch ============================================

describe('onBeforeRequest dispatch', () => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest.onBeforeRequest.mock.calls[0][0];
    const callback = jest.fn();
    await listener(details, callback);
    return callback.mock.calls[0][0];
  };

  test('passes through when no handler returns an action', async () => {
    registerWebRequestHandler('onBeforeRequest', 'a', () => null);
    registerWebRequestHandler('onBeforeRequest', 'b', () => ({}));
    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({});
  });

  test('first non-empty action wins; later handlers are skipped', async () => {
    const second = jest.fn(() => ({ redirectURL: 'https://second.example/' }));
    registerWebRequestHandler('onBeforeRequest', 'first', () => ({ redirectURL: 'https://first.example/' }));
    registerWebRequestHandler('onBeforeRequest', 'second', second);

    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({ redirectURL: 'https://first.example/' });
    expect(second).not.toHaveBeenCalled();
  });

  test('cancel takes effect like redirect', async () => {
    registerWebRequestHandler('onBeforeRequest', 'block', () => ({ cancel: true }));
    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({ cancel: true });
  });

  test('a throwing handler is logged and skipped — subsequent handlers run', async () => {
    registerWebRequestHandler('onBeforeRequest', 'broken', () => {
      throw new Error('boom');
    });
    registerWebRequestHandler('onBeforeRequest', 'recovery', () => ({ redirectURL: 'https://ok.example/' }));

    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({ redirectURL: 'https://ok.example/' });
  });

  test('awaits async handlers in registration order', async () => {
    const order = [];
    registerWebRequestHandler('onBeforeRequest', 'a', async () => {
      await Promise.resolve();
      order.push('a');
      return null;
    });
    registerWebRequestHandler('onBeforeRequest', 'b', async () => {
      order.push('b');
      return { redirectURL: 'https://b.example/' };
    });
    const result = await drive({ url: 'https://example.com/' });
    expect(order).toEqual(['a', 'b']);
    expect(result).toEqual({ redirectURL: 'https://b.example/' });
  });
});

// === onBeforeSendHeaders dispatch ========================================

describe('onBeforeSendHeaders dispatch', () => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    const callback = jest.fn();
    await listener(details, callback);
    return callback.mock.calls[0][0];
  };

  test('chains headers across handlers — each sees prior modifications', async () => {
    registerWebRequestHandler('onBeforeSendHeaders', 'first', (details) => ({
      requestHeaders: { ...details.requestHeaders, 'X-First': '1' },
    }));
    registerWebRequestHandler('onBeforeSendHeaders', 'second', (details) => {
      // Must see the X-First header the previous handler added.
      expect(details.requestHeaders['X-First']).toBe('1');
      return { requestHeaders: { ...details.requestHeaders, 'X-Second': '2' } };
    });

    const result = await drive({
      url: 'https://example.com/',
      requestHeaders: { Accept: '*/*' },
    });
    expect(result.requestHeaders).toMatchObject({
      Accept: '*/*',
      'X-First': '1',
      'X-Second': '2',
    });
  });

  test('returns base headers when no handler modifies them', async () => {
    registerWebRequestHandler('onBeforeSendHeaders', 'noop', () => null);
    const result = await drive({
      url: 'https://example.com/',
      requestHeaders: { Accept: 'text/html' },
    });
    expect(result.requestHeaders).toEqual({ Accept: 'text/html' });
  });

  test('cancel from any handler short-circuits the chain', async () => {
    const after = jest.fn();
    registerWebRequestHandler('onBeforeSendHeaders', 'block', () => ({ cancel: true }));
    registerWebRequestHandler('onBeforeSendHeaders', 'after', after);

    const result = await drive({ url: 'https://example.com/', requestHeaders: {} });
    expect(result).toEqual({ cancel: true });
    expect(after).not.toHaveBeenCalled();
  });
});

// === onHeadersReceived dispatch ==========================================

describe('onHeadersReceived dispatch', () => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest.onHeadersReceived.mock.calls[0][0];
    const callback = jest.fn();
    await listener(details, callback);
    return callback.mock.calls[0][0];
  };

  test('chains response headers and forwards statusLine', async () => {
    registerWebRequestHandler('onHeadersReceived', 'tag', (details) => ({
      responseHeaders: { ...details.responseHeaders, 'X-Tagged': ['yes'] },
    }));
    const result = await drive({
      url: 'https://example.com/',
      responseHeaders: { 'Content-Type': ['text/html'] },
      statusLine: 'HTTP/1.1 200 OK',
    });
    expect(result.responseHeaders).toMatchObject({ 'X-Tagged': ['yes'] });
    expect(result.statusLine).toBe('HTTP/1.1 200 OK');
  });

  test('redirectURL short-circuits — useful for x402 navigation interstitial', async () => {
    const after = jest.fn();
    registerWebRequestHandler('onHeadersReceived', 'x402', () => ({
      redirectURL: 'freedom://x402-pay',
    }));
    registerWebRequestHandler('onHeadersReceived', 'after', after);

    const result = await drive({
      url: 'https://api.example/article',
      responseHeaders: { 'PAYMENT-REQUIRED': ['eyJzY2hlbWUi...'] },
      statusLine: 'HTTP/1.1 402 Payment Required',
    });
    expect(result).toEqual({ redirectURL: 'freedom://x402-pay' });
    expect(after).not.toHaveBeenCalled();
  });
});

// === Notification-only dispatch (onCompleted, onErrorOccurred) ===========

describe.each([
  ['onCompleted', 'onCompleted'],
  ['onErrorOccurred', 'onErrorOccurred'],
])('%s dispatch', (event, sessionMethod) => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest[sessionMethod].mock.calls[0][0];
    await listener(details);
  };

  test('invokes every registered handler in registration order (sync)', async () => {
    const order = [];
    registerWebRequestHandler(event, 'first', (details) => {
      order.push(['first', details.id]);
    });
    registerWebRequestHandler(event, 'second', (details) => {
      order.push(['second', details.id]);
    });

    await drive({ id: 42, url: 'https://example.com/' });
    expect(order).toEqual([['first', 42], ['second', 42]]);
  });

  test('async handler does not gate the next handler (no await)', async () => {
    // Notification-only: ordering between independent observers is
    // meaningless. The second handler must run synchronously after
    // the first, even if the first is async.
    let secondRan = false;
    registerWebRequestHandler(event, 'slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    registerWebRequestHandler(event, 'fast', () => {
      secondRan = true;
    });

    await drive({ id: 1, url: 'https://example.com/' });
    expect(secondRan).toBe(true);
  });

  test('ignores handler return values (no callback to chain into)', async () => {
    registerWebRequestHandler(event, 'rogue', () => ({ cancel: true }));
    const after = jest.fn();
    registerWebRequestHandler(event, 'after', after);
    await drive({ id: 1, url: 'https://example.com/' });
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('a throwing handler is logged; subsequent handlers still run', async () => {
    registerWebRequestHandler(event, 'broken', () => {
      throw new Error('boom');
    });
    const after = jest.fn();
    registerWebRequestHandler(event, 'after', after);

    await drive({ id: 1, url: 'https://example.com/' });
    expect(after).toHaveBeenCalledTimes(1);
  });
});

// Private windows attach the dispatcher with an exclude predicate so the
// x402 payment-interception handlers never observe private traffic (see
// src/main/index.js — PRIVATE MODE GUARD (x402)).
describe('attachWebRequestDispatcher exclude option', () => {
  test('excluded handlers are not attached for this session', async () => {
    const seen = [];
    registerWebRequestHandler('onBeforeSendHeaders', 'x402-capture', (details) => {
      seen.push(['x402-capture', details.id]);
      return null;
    });
    registerWebRequestHandler('onBeforeSendHeaders', 'rewriter', (details) => {
      seen.push(['rewriter', details.id]);
      return null;
    });
    registerWebRequestHandler('onHeadersReceived', 'x402-detect', (details) => {
      seen.push(['x402-detect', details.id]);
      return null;
    });

    const session = makeSessionMock();
    attachWebRequestDispatcher(session, {
      exclude: (name) => name.startsWith('x402-'),
    });

    // onHeadersReceived only had x402 handlers — nothing left to attach.
    expect(session.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    expect(session.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);

    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    const callback = jest.fn();
    await listener({ id: 7, requestHeaders: {} }, callback);

    expect(seen).toEqual([['rewriter', 7]]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('a session attached without exclude still runs every handler', async () => {
    const seen = [];
    registerWebRequestHandler('onBeforeSendHeaders', 'x402-capture', (details) => {
      seen.push(['x402-capture', details.id]);
      return null;
    });
    registerWebRequestHandler('onBeforeSendHeaders', 'rewriter', (details) => {
      seen.push(['rewriter', details.id]);
      return null;
    });

    const session = makeSessionMock();
    attachWebRequestDispatcher(session);

    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    await listener({ id: 3, requestHeaders: {} }, jest.fn());

    expect(seen).toEqual([
      ['x402-capture', 3],
      ['rewriter', 3],
    ]);
  });
});

const CANCELLABLE_EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'];
const requestDetails = {
  url: 'wss://example.com/socket',
  resourceType: 'webSocket',
  requestHeaders: { Accept: '*/*' },
  responseHeaders: { 'Content-Type': ['text/plain'] },
};

function driveGuarded(session, event, details = requestDetails) {
  const callback = jest.fn();
  const listener = session.webRequest[event].mock.calls[0][0];
  return Promise.resolve(listener(details, callback)).then(() => {
    expect(callback).toHaveBeenCalledTimes(1);
    return callback.mock.calls[0][0];
  });
}

describe('session request policy', () => {
  test.each(CANCELLABLE_EVENTS)('blocks %s even without consumers or a webContentsId', async (event) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, { getRequestPolicy: () => ({ allowed: false, generation: 0 }) });
    expect(await driveGuarded(session, event)).toEqual({ cancel: true });
  });

  test.each(CANCELLABLE_EVENTS)('allows %s only under an unchanged ready policy', async (event) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, { getRequestPolicy: () => ({ allowed: true, generation: 0 }) });
    expect(await driveGuarded(session, event)).not.toHaveProperty('cancel');
  });

  test.each([
    null, undefined, true, {}, { allowed: 'true', generation: 0 },
    { allowed: true, generation: -1 }, { allowed: true, generation: NaN },
    { allowed: true, generation: 0.5 }, { allowed: true, generation: Number.MAX_SAFE_INTEGER + 1 },
  ])('refuses malformed policy %p before a consumer runs', async (policy) => {
    const session = makeSessionMock();
    const consumer = jest.fn(() => ({ redirectURL: 'https://other.example/' }));
    registerWebRequestHandler('onBeforeRequest', 'consumer', consumer);
    attachWebRequestDispatcher(session, { getRequestPolicy: () => policy });
    expect(await driveGuarded(session, 'onBeforeRequest')).toEqual({ cancel: true });
    expect(consumer).not.toHaveBeenCalled();
  });

  test.each(['throw', 'resolve', 'reject'])('refuses a %s policy getter', async (behavior) => {
    const session = makeSessionMock();
    const getRequestPolicy = () => {
      if (behavior === 'throw') throw new Error('unavailable');
      return behavior === 'resolve' ? Promise.resolve({ allowed: true, generation: 0 }) : Promise.reject(new Error('unavailable'));
    };
    attachWebRequestDispatcher(session, { getRequestPolicy });
    expect(await driveGuarded(session, 'onBeforeRequest')).toEqual({ cancel: true });
  });

  test.each(CANCELLABLE_EVENTS)('%s cannot approve after an asynchronous policy withdrawal', async (event) => {
    let policy = { allowed: true, generation: 4 };
    let complete;
    registerWebRequestHandler(event, 'slow', () => new Promise((resolve) => { complete = resolve; }));
    const later = jest.fn(() => null);
    registerWebRequestHandler(event, 'later', later);
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, { getRequestPolicy: () => policy });
    const result = driveGuarded(session, event);
    policy = { allowed: false, generation: 5 };
    complete({ redirectURL: 'https://other.example/' });
    expect(await result).toEqual({ cancel: true });
    expect(later).not.toHaveBeenCalled();
  });

  test.each(CANCELLABLE_EVENTS)('%s rejects an old callback after recovery to a new generation', async (event) => {
    let policy = { allowed: true, generation: 4 };
    let complete;
    registerWebRequestHandler(event, 'slow', () => new Promise((resolve) => { complete = resolve; }));
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, { getRequestPolicy: () => policy });
    const result = driveGuarded(session, event);
    policy = { allowed: false, generation: 5 };
    policy = { allowed: true, generation: 6 };
    complete({ requestHeaders: {}, responseHeaders: {} });
    expect(await result).toEqual({ cancel: true });
  });

  test('does not pass consumer failure through a withdrawn guard', async () => {
    let allowed = true;
    const later = jest.fn();
    registerWebRequestHandler('onBeforeRequest', 'broken', () => {
      allowed = false;
      throw new Error('consumer failure');
    });
    registerWebRequestHandler('onBeforeRequest', 'later', later);
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, { getRequestPolicy: () => ({ allowed, generation: 0 }) });
    expect(await driveGuarded(session, 'onBeforeRequest')).toEqual({ cancel: true });
    expect(later).not.toHaveBeenCalled();
  });

  test.each(CANCELLABLE_EVENTS)('%s cancels if the policy getter fails before the callback', async (event) => {
    let failed = false;
    registerWebRequestHandler(event, 'withdraw', () => {
      failed = true;
      return { redirectURL: 'https://other.example/' };
    });
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, { getRequestPolicy: () => {
      if (failed) throw new Error('policy unavailable');
      return { allowed: true, generation: 0 };
    } });
    expect(await driveGuarded(session, event)).toEqual({ cancel: true });
  });

  test('excluding all consumers does not remove a session guard', async () => {
    const consumer = jest.fn();
    registerWebRequestHandler('onBeforeRequest', 'x402-request', consumer);
    const session = makeSessionMock();
    attachWebRequestDispatcher(session, {
      exclude: () => true,
      getRequestPolicy: () => ({ allowed: false, generation: 0 }),
    });
    expect(await driveGuarded(session, 'onBeforeRequest')).toEqual({ cancel: true });
    expect(consumer).not.toHaveBeenCalled();
  });

  test('binds policy to the session rather than optional request metadata', async () => {
    const blocked = makeSessionMock();
    const ready = makeSessionMock();
    attachWebRequestDispatcher(blocked, { getRequestPolicy: () => ({ allowed: false, generation: 1 }) });
    attachWebRequestDispatcher(ready, { getRequestPolicy: () => ({ allowed: true, generation: 1 }) });
    expect(await driveGuarded(blocked, 'onBeforeRequest')).toEqual({ cancel: true });
    expect(await driveGuarded(ready, 'onBeforeRequest')).toEqual({});
  });
});

describe('dispatcher ownership', () => {
  test('only scoped consumers observe their session', () => {
    const first = makeSessionMock();
    const second = makeSessionMock();
    const scoped = jest.fn();
    const common = jest.fn();
    registerWebRequestHandler('onCompleted', 'scoped', scoped, { session: first });
    registerWebRequestHandler('onCompleted', 'common', common);
    attachWebRequestDispatcher(first);
    attachWebRequestDispatcher(second);
    first.webRequest.onCompleted.mock.calls[0][0]({ id: 1 });
    second.webRequest.onCompleted.mock.calls[0][0]({ id: 2 });
    expect(scoped).toHaveBeenCalledTimes(1);
    expect(scoped).toHaveBeenCalledWith({ id: 1 });
    expect(common).toHaveBeenCalledTimes(2);
  });

  test('same options attach once and cannot remove a guard', () => {
    const session = makeSessionMock();
    const getRequestPolicy = () => ({ allowed: false, generation: 0 });
    attachWebRequestDispatcher(session, { getRequestPolicy });
    attachWebRequestDispatcher(session, { getRequestPolicy });
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(() => attachWebRequestDispatcher(session)).toThrow(/cannot be replaced/);
    expect(() => attachWebRequestDispatcher(session, { getRequestPolicy: () => ({ allowed: true, generation: 0 }) }))
      .toThrow(/cannot be replaced/);
  });

  test('cannot change consumer exclusions after attachment', () => {
    const session = makeSessionMock();
    const exclude = () => true;
    attachWebRequestDispatcher(session, { exclude });
    expect(() => attachWebRequestDispatcher(session)).toThrow(/cannot be replaced/);
  });

  test('requires all native cancellation methods before attaching any listener', () => {
    const session = makeSessionMock();
    delete session.webRequest.onHeadersReceived;
    expect(() => attachWebRequestDispatcher(session, { getRequestPolicy: () => ({ allowed: true, generation: 0 }) }))
      .toThrow(/onHeadersReceived/);
    expect(session.webRequest.onBeforeRequest).not.toHaveBeenCalled();
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
  });

  test('refuses reuse after a native listener attachment fails halfway', () => {
    const session = makeSessionMock();
    session.webRequest.onBeforeSendHeaders.mockImplementation(() => { throw new Error('native failure'); });
    const options = { getRequestPolicy: () => ({ allowed: false, generation: 0 }) };
    expect(() => attachWebRequestDispatcher(session, options)).toThrow('native failure');
    expect(() => attachWebRequestDispatcher(session, options)).toThrow(/cannot be replaced/);
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
  });

  test('rejects consumers registered after attachment', () => {
    attachWebRequestDispatcher(makeSessionMock());
    expect(() => registerWebRequestHandler('onBeforeRequest', 'late', () => null)).toThrow(/before attaching/);
  });

  test('rejects inherited event names and invalid callbacks', () => {
    expect(() => registerWebRequestHandler('__proto__', 'bad', () => null)).toThrow(/Unsupported/);
    expect(() => registerWebRequestHandler('onBeforeRequest', 'bad', null)).toThrow(/must be a function/);
  });

  test.each([{ getRequestPolicy: null }, { exclude: true }])('rejects invalid attachment option %p', (options) => {
    expect(() => attachWebRequestDispatcher(makeSessionMock(), options)).toThrow(TypeError);
  });
});


describe.each([...CANCELLABLE_EVENTS, 'onCompleted', 'onErrorOccurred'])('%s exception boundaries', (event) => {
  const failures = [['null', () => null], ['undefined', () => undefined], ['string', () => 'failed'],
    ['unprintable', () => ({ toString() { throw null; } })], ['message getter', () => ({ get message() { throw null; } })]];
  async function verify() {
    const later = jest.fn(() => ({ cancel: true }));
    registerWebRequestHandler(event, 'later', later);
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const callback = jest.fn();
    await session.webRequest[event].mock.calls[0][0](requestDetails, callback);
    expect(later).toHaveBeenCalledTimes(1);
    if (CANCELLABLE_EVENTS.includes(event)) {
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
  }
  test.each(failures)('a non-Error throw %s does not interrupt dispatch', async (_label, makeFailure) => {
    registerWebRequestHandler(event, 'broken', () => { throw makeFailure(); });
    await verify();
  });
  test.each(failures)('a non-Error rejection %s does not interrupt dispatch', async (_label, makeFailure) => {
    registerWebRequestHandler(event, 'broken', () => Promise.reject(makeFailure()));
    await verify();
  });
  test('a failed logger does not interrupt dispatch', async () => {
    const logger = require('./logger');
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => { throw new Error('transport unavailable'); });
    try {
      registerWebRequestHandler(event, 'broken', () => Promise.reject(null));
      await verify();
    } finally { spy.mockRestore(); }
  });
});
