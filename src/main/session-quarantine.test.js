const { createSessionProxyController } = require('./session-proxy-controller');
const { createSessionRoutingCoordinator } = require('./session-routing-coordinator');
const { createSessionRoutingTermination } = require('./session-routing-termination');
const { routingError } = require('./session-routing-operation');

function session() {
  return { setProxy: jest.fn(async () => {}), forceReloadProxyConfig: jest.fn(async () => {}),
    closeAllConnections: jest.fn(async () => {}) };
}

function fixture() {
  const main = session();
  const fatal = jest.fn();
  const controller = createSessionProxyController(() => main, { onFatal: fatal, timeoutMs: 20 });
  const getter = controller.adoptDefault();
  let intent = 'direct';
  const hooks = {
    getIntent: () => intent,
    prepare: jest.fn(async (value) => ({ configuration: { mode: value }, key: value })),
    isValid: jest.fn(() => true),
    isInitialDirect: (value) => value === 'direct',
    retire: jest.fn(async () => {}),
    withdraw: jest.fn(), publish: jest.fn(), attach: jest.fn(),
  };
  const routing = createSessionRoutingCoordinator(controller, hooks, { timeoutMs: 30 });
  return { main, fatal, controller, getter, hooks, routing,
    change(value) { intent = value; routing.intentChanged(); } };
}

function codes(error) {
  return error.errors ? error.errors.flatMap(codes) : [error.code];
}

describe('session quarantine', () => {
  afterEach(() => jest.useRealTimers());

  test('withdraws synchronously and holds readiness through shared resource retirement', async () => {
    const f = fixture();
    expect(f.getter()).toMatchObject({ allowed: true, state: 'initial', generation: 0 });
    f.change('changed');
    expect(f.getter().allowed).toBe(false);
    let finish;
    let entered;
    const retiring = new Promise((resolve) => { entered = resolve; });
    f.hooks.retire.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; entered(); }));
    const update = f.routing.rebuild();
    await retiring;
    expect(f.getter()).toMatchObject({ allowed: false, state: 'configured' });
    expect(f.main.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(f.hooks.publish).not.toHaveBeenCalled();
    finish();
    await update;
    expect(f.getter()).toMatchObject({ allowed: true, state: 'ready' });
  });

  test('unchanged prepared policy and new-only enrollment leave other sessions and resources alone', async () => {
    const f = fixture();
    await f.routing.rebuild();
    const generation = f.getter().generation;
    const added = session();
    await f.routing.enroll(added);
    await f.routing.rebuild();
    expect(f.hooks.prepare).toHaveBeenCalledTimes(1);
    expect(f.hooks.retire).toHaveBeenCalledTimes(1);
    expect(f.main.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(f.getter().generation).toBe(generation);
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(f.hooks.attach.mock.calls[0][1]()).toMatchObject({ allowed: true });
  });

  test.each(['setProxy', 'forceReloadProxyConfig'])('settled %s failure still drains and needs a complete recovery', async (method) => {
    const f = fixture();
    await f.routing.rebuild();
    f.main[method].mockRejectedValueOnce(new Error('native failure'));
    f.change('changed');
    const error = await f.routing.rebuild().catch((cause) => cause);
    expect(codes(error)).toContain(`${method}_failed`);
    expect(f.getter()).toMatchObject({ allowed: false, state: 'quarantined' });
    // Independent drainage happens despite the earlier error, then global
    // recovery failure confirms all targets remain drained and denied.
    expect(f.main.closeAllConnections).toHaveBeenCalledTimes(3);
    expect(f.fatal).not.toHaveBeenCalled();
    await f.routing.rebuild();
    expect(f.getter().allowed).toBe(true);
    expect(f.main[method]).toHaveBeenCalledTimes(3);
  });

  test('partial global failure quarantines even sessions whose native configuration succeeded', async () => {
    const f = fixture();
    const other = session();
    await f.routing.enroll(other);
    other.setProxy.mockRejectedValueOnce(new Error('native failure'));
    f.change('changed');
    await expect(f.routing.rebuild()).rejects.toThrow('Session proxy update failed');
    expect(f.getter().allowed).toBe(false);
    expect(f.controller.policyFor(other).allowed).toBe(false);
    await f.routing.rebuild();
    expect(f.getter().allowed).toBe(true);
    expect(f.controller.policyFor(other).allowed).toBe(true);
  });

  test.each(['prepare', 'retire'])('settled %s failure clears cached authorization and refuses enrollment until global recovery', async (hook) => {
    const f = fixture();
    await f.routing.rebuild();
    f.change('changed');
    f.hooks[hook].mockRejectedValueOnce(new Error('shared failure'));
    await expect(f.routing.rebuild()).rejects.toThrow(hook === 'prepare' ? 'prepare_failed' : 'retire_resources_failed');
    const added = session();
    await expect(f.routing.enroll(added)).rejects.toThrow('policy_unprepared');
    expect(added.setProxy).not.toHaveBeenCalled();
    expect(f.getter().allowed).toBe(false);
    await f.routing.rebuild();
    await f.routing.enroll(added);
    expect(f.controller.policyFor(added).allowed).toBe(true);
  });

  test.each(['setProxy', 'forceReloadProxyConfig', 'closeAllConnections'])('%s timeout terminates once and late completion never reopens the session', async (method) => {
    jest.useFakeTimers();
    const f = fixture();
    let finish;
    f.main[method].mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const update = f.routing.rebuild().catch((error) => error);
    await jest.advanceTimersByTimeAsync(21);
    const error = await update;
    expect(codes(error)).toContain(`${method}_timeout`);
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.fatal).toHaveBeenCalledWith(`${method}_timeout`);
    expect(f.getter()).toMatchObject({ allowed: false, state: 'retired' });
    finish();
    await jest.advanceTimersByTimeAsync(100);
    expect(f.getter().allowed).toBe(false);
    expect(() => f.routing.rebuild()).toThrow('terminal');
    expect(f.main.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test.each(['prepare', 'retire'])('shared %s timeout terminates after drainage and refuses late shared mutation', async (hook) => {
    jest.useFakeTimers();
    const f = fixture();
    let finish;
    f.hooks[hook].mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const update = f.routing.rebuild().catch((error) => error);
    await jest.advanceTimersByTimeAsync(31);
    const error = await update;
    expect(error.code).toBe(hook === 'prepare' ? 'prepare_timeout' : 'retire_resources_timeout');
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.main.closeAllConnections).toHaveBeenCalled();
    finish({ configuration: { mode: 'direct' }, key: 'direct' });
    await jest.advanceTimersByTimeAsync(100);
    expect(f.getter().allowed).toBe(false);
    expect(f.hooks.publish).not.toHaveBeenCalled();
  });

  test('close rejection terminates even when default-session teardown also throws', async () => {
    const main = session();
    const fatal = jest.fn();
    let unavailable = false;
    const c = createSessionProxyController(() => { if (unavailable) throw new Error('teardown'); return main; }, { onFatal: fatal });
    const getter = c.adoptDefault();
    main.closeAllConnections.mockImplementationOnce(async () => { unavailable = true; throw new Error('drainage'); });
    await expect(c.applyTo(main, { mode: 'direct' })).rejects.toThrow('Session proxy update failed');
    expect(fatal).toHaveBeenCalledWith('closeAllConnections_failed');
    expect(getter().allowed).toBe(false);
  });

  test('unconfirmed Node guard destruction remains terminal after independent Electron drainage', async () => {
    const f = fixture();
    f.hooks.prepare.mockRejectedValueOnce(routingError('guard_drain_failed', new Error('destroy')));
    await expect(f.routing.rebuild()).rejects.toThrow('prepare_failed');
    expect(f.main.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(f.fatal).toHaveBeenCalledWith('guard_drain_failed');
    expect(f.getter().allowed).toBe(false);
  });

  test('an unexpected exception object cannot bypass quarantine diagnostics', async () => {
    const f = fixture();
    const unusual = Object.defineProperty({}, 'errors', { get() { throw new Error('getter'); } });
    f.hooks.prepare.mockRejectedValueOnce(unusual);
    await expect(f.routing.rebuild()).rejects.toThrow('prepare_failed');
    expect(f.main.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(f.getter().allowed).toBe(false);
  });

  test.each(['setProxy', 'forceReloadProxyConfig', 'closeAllConnections'])('changing intent during %s prevents ticket publication and old-generation readiness', async (method) => {
    const f = fixture();
    let finish;
    let entered;
    const setting = new Promise((resolve) => { entered = resolve; });
    f.main[method].mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; entered(); }));
    const update = f.routing.rebuild();
    const refused = expect(update).rejects.toThrow('Session proxy update failed');
    await setting;
    f.change('newer');
    finish();
    await refused;
    if (method === 'setProxy') expect(f.main.forceReloadProxyConfig).not.toHaveBeenCalled();
    expect(f.getter().allowed).toBe(false);
    await f.routing.rebuild();
    expect(f.main.setProxy).toHaveBeenLastCalledWith({ mode: 'newer' });
    expect(f.getter().allowed).toBe(true);
  });

  test.each(['prepare', 'retire'])('changing intent during %s refuses publication and requires fresh recovery', async (hook) => {
    const f = fixture();
    let finish;
    let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    f.hooks[hook].mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; entered(); }));
    const update = f.routing.rebuild();
    const refused = expect(update).rejects.toThrow('intent_superseded');
    await waiting;
    f.change('newer');
    finish({ configuration: { mode: 'direct' }, key: 'direct' });
    await refused;
    expect(f.hooks.publish).not.toHaveBeenCalled();
    expect(f.getter().allowed).toBe(false);
    await f.routing.rebuild();
    expect(f.getter().allowed).toBe(true);
  });

  test('exact A to B to A changes cannot reuse a pre-withdrawal policy', async () => {
    const f = fixture();
    await f.routing.rebuild();
    f.change('other'); f.change('direct');
    await f.routing.rebuild();
    expect(f.hooks.prepare).toHaveBeenCalledTimes(2);
    expect(f.hooks.retire).toHaveBeenCalledTimes(2);
    expect(f.getter().allowed).toBe(true);
  });

  test('exact intent reversion during an empty unchanged apply cannot publish the old guard', async () => {
    const f = fixture();
    await f.routing.rebuild();
    const apply = f.controller.apply;
    jest.spyOn(f.controller, 'apply').mockImplementationOnce((...args) => {
      const result = apply(...args);
      f.change('other'); f.change('direct');
      return result;
    });
    await expect(f.routing.rebuild()).rejects.toThrow('intent_superseded');
    expect(f.hooks.publish).toHaveBeenCalledTimes(1);
    expect(f.getter().allowed).toBe(false);
    await f.routing.rebuild();
    expect(f.hooks.prepare).toHaveBeenCalledTimes(2);
  });

  test('no ticket commits if one registration was retired', async () => {
    const f = fixture();
    const added = session();
    f.controller.register(added);
    const tickets = await f.controller.apply({ mode: 'direct' }, 'direct', { deferReady: true });
    f.controller.unregister(added);
    expect(() => f.controller.commit(tickets)).toThrow('session_superseded');
    expect(f.getter().allowed).toBe(false);
  });

  test('generation exhaustion refuses further work without wrapping or resetting a guard', async () => {
    const f = fixture();
    const [ticket] = await f.controller.apply({ mode: 'direct' }, 'direct', { deferReady: true });
    ticket.record.generation = Number.MAX_SAFE_INTEGER;
    expect(() => f.controller.withdrawAll()).toThrow('generation_exhausted');
    expect(f.getter()).toMatchObject({ allowed: false, generation: Number.MAX_SAFE_INTEGER });
    expect(f.fatal).toHaveBeenCalledWith('generation_exhausted');
  });

  test('native configuration cannot begin without a termination boundary', async () => {
    const main = session();
    const c = createSessionProxyController(() => main);
    await expect(c.apply({ mode: 'direct' })).rejects.toThrow('termination_handler_unavailable');
    expect(main.setProxy).not.toHaveBeenCalled();
  });

  test.each(['marker', 'logger', 'neither'])('termination reaches app.exit despite %s failure and is idempotent', (failure) => {
    const app = { exit: jest.fn() };
    const markQuitting = jest.fn(() => { if (failure === 'marker') throw new Error('marker'); });
    const log = { error: jest.fn(() => { if (failure === 'logger') throw new Error('logger'); }) };
    const terminate = createSessionRoutingTermination({ app, log, markQuitting });
    terminate('closeAllConnections_failed');
    terminate('second');
    expect(app.exit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(70);
    expect(markQuitting).toHaveBeenCalledTimes(1);
  });
});
