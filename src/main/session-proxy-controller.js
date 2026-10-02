const { routingError, runRoutingOperation } = require('./session-routing-operation');

// Window owners await enrollment. The queue covers shared preparation and all
// native changes; getters remain bound to their original Electron Session.
function createSessionProxyController(getDefaultSession, options = {}) {
  const sessions = new Map();
  const records = new WeakMap();
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid session routing deadline');
  let pending = Promise.resolve();
  let terminal = false;
  let onFatal = options.onFatal;

  function requireSession(targetSession) {
    for (const method of ['setProxy', 'forceReloadProxyConfig', 'closeAllConnections']) {
      if (typeof targetSession?.[method] !== 'function') {
        throw routingError(`capability_${method}`);
      }
    }
  }

  function recordFor(targetSession) {
    if (!targetSession || typeof targetSession !== 'object') throw routingError('session_unavailable');
    let record = records.get(targetSession);
    if (!record) {
      record = { state: 'enrolling', generation: 0, key: undefined, poisoned: false };
      record.getPolicy = () => ({
        allowed: !terminal && !record.poisoned && ['initial', 'ready'].includes(record.state),
        generation: record.generation,
        state: record.state,
      });
      records.set(targetSession, record);
    }
    return record;
  }

  function transition(record, state) {
    if (record.generation === Number.MAX_SAFE_INTEGER) {
      record.poisoned = true;
      record.state = 'quarantined';
      terminate('generation_exhausted');
      throw routingError('generation_exhausted');
    }
    record.generation += 1;
    record.state = state;
    if (state !== 'ready') record.key = undefined;
  }

  function assertLive() {
    if (terminal) throw routingError('terminal');
  }

  function setFatalHandler(handler) {
    if (typeof handler !== 'function') throw new TypeError('Session routing termination handler is required');
    if (onFatal && onFatal !== handler) throw routingError('termination_handler_replaced');
    onFatal = handler;
  }

  function activeTargets() {
    return new Set([getDefaultSession(), ...sessions.keys()]);
  }

  function retireAll() {
    if (terminal) return;
    terminal = true;
    const targets = new Set(sessions.keys());
    try { targets.add(getDefaultSession()); } catch { /* Session teardown may already be in progress. */ }
    for (const targetSession of targets) {
      const record = records.get(targetSession);
      if (record) {
        if (record.generation < Number.MAX_SAFE_INTEGER) record.generation += 1;
        record.state = 'retired';
        record.key = undefined;
      }
    }
    sessions.clear();
  }

  function terminate(code) {
    if (terminal) return;
    let retirementError;
    try {
      retireAll();
    } catch (error) {
      terminal = true;
      retirementError = error;
    }
    if (!onFatal) throw routingError('termination_handler_unavailable', retirementError);
    onFatal(code);
  }

  function adoptDefault() {
    assertLive();
    const targetSession = getDefaultSession();
    requireSession(targetSession);
    const record = recordFor(targetSession);
    if (record.state === 'enrolling' && record.generation === 0) {
      // Preserve the native startup state without claiming a proxy receipt.
      record.state = 'initial';
    } else if (record.state !== 'initial') {
      throw routingError('default_already_managed');
    }
    return record.getPolicy;
  }

  function getPolicyGetter(targetSession) {
    return recordFor(targetSession).getPolicy;
  }

  function policyFor(targetSession) {
    return records.get(targetSession)?.getPolicy() || { allowed: false, generation: 0, state: 'unknown' };
  }

  function enqueue(operation) {
    assertLive();
    const result = pending.then(() => { assertLive(); return operation(); });
    pending = result.catch(() => {});
    return result;
  }

  function register(targetSession) {
    assertLive();
    requireSession(targetSession);
    const record = recordFor(targetSession);
    if (record.poisoned || record.state === 'retired') throw routingError('session_retired');
    if (!sessions.has(targetSession)) {
      transition(record, 'enrolling');
      sessions.set(targetSession, {});
    }
    return sessions.get(targetSession);
  }

  function isRegistered(targetSession, token) {
    return !terminal && sessions.has(targetSession) && sessions.get(targetSession) === token;
  }

  function unregister(targetSession, token) {
    if (token !== undefined && !isRegistered(targetSession, token)) return;
    sessions.delete(targetSession);
    const record = records.get(targetSession);
    if (record) transition(record, 'retired');
  }

  function cancelEnrollment(targetSession, token) {
    if (!isRegistered(targetSession, token)) return;
    sessions.delete(targetSession);
    transition(recordFor(targetSession), 'quarantined');
  }

  function withdrawAll() {
    assertLive();
    for (const targetSession of activeTargets()) {
      const record = recordFor(targetSession);
      if (record.state !== 'retired') transition(record, 'updating');
    }
  }

  async function drain(targetSession, record) {
    try {
      if (typeof targetSession.closeAllConnections !== 'function') throw routingError('capability_closeAllConnections');
      await runRoutingOperation(() => targetSession.closeAllConnections(), 'closeAllConnections', timeoutMs);
    } catch (error) {
      record.poisoned = true;
      transition(record, 'quarantined');
      terminate(error.code || 'closeAllConnections_failed');
      throw error;
    }
  }

  async function quarantineAll() {
    withdrawAll();
    const results = await Promise.allSettled([...activeTargets()].map(async (targetSession) => {
      const record = recordFor(targetSession);
      if (record.state !== 'retired') transition(record, 'quarantined');
      await drain(targetSession, record);
    }));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Session quarantine drainage failed');
  }

  async function applyTargets(targets, configuration, policyKey, deferReady = false) {
    assertLive();
    if (typeof onFatal !== 'function') throw routingError('termination_handler_unavailable');
    const needed = [...targets].filter((targetSession) => {
      const record = recordFor(targetSession);
      return record.state !== 'ready' || record.key !== policyKey;
    });
    for (const targetSession of needed) {
      const record = recordFor(targetSession);
      if (!record.poisoned && record.state !== 'retired') transition(record, 'updating');
    }
    const preflight = [];
    for (const targetSession of needed) {
      try { requireSession(targetSession); } catch (error) { preflight.push(error); }
    }
    const results = await Promise.allSettled(needed.map(async (targetSession) => {
      const record = recordFor(targetSession);
      const generation = record.generation;
      const registration = sessions.get(targetSession);
      const errors = [...preflight];
      if (record.poisoned || record.state === 'retired') errors.push(routingError('session_retired'));
      try {
        if (!errors.length) {
          await runRoutingOperation(() => targetSession.setProxy({ ...configuration }), 'setProxy', timeoutMs);
          if (terminal || record.generation !== generation || sessions.get(targetSession) !== registration) {
            throw routingError('session_superseded');
          }
          await runRoutingOperation(() => targetSession.forceReloadProxyConfig(), 'forceReloadProxyConfig', timeoutMs);
        }
      } catch (error) {
        if (error.code?.endsWith('_timeout')) record.poisoned = true;
        errors.push(error);
      }
      // Drain independently even if configuration, reload or preflight failed.
      try { await drain(targetSession, record); } catch (error) { errors.push(error); }
      const timeout = errors.find((error) => error.code?.endsWith('_timeout'));
      if (timeout) terminate(timeout.code);
      if (terminal || record.state === 'retired' || record.generation !== generation || sessions.get(targetSession) !== registration) {
        errors.push(routingError('session_superseded'));
      }
      if (errors.length) {
        if (!terminal && record.state !== 'retired') transition(record, 'quarantined');
        throw new AggregateError(errors, 'Session proxy update failed');
      }
      transition(record, 'configured');
      const ticket = { targetSession, record, generation: record.generation, registration, key: policyKey };
      if (!deferReady) commit([ticket]);
      return ticket;
    }));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Session proxy update failed');
    return results.map((result) => result.value);
  }

  function commit(tickets) {
    assertLive();
    for (const ticket of tickets) {
      const { targetSession, record, generation, registration } = ticket;
      if (records.get(targetSession) !== record || record.poisoned || record.state !== 'configured' ||
          record.generation !== generation || sessions.get(targetSession) !== registration) {
        throw routingError('session_superseded');
      }
    }
    for (const { record, key } of tickets) {
      transition(record, 'ready');
      record.key = key;
    }
  }

  function apply(configuration, policyKey = JSON.stringify(configuration), { deferReady = false } = {}) {
    return applyTargets(activeTargets(), configuration, policyKey, deferReady);
  }

  function applyTo(targetSession, configuration, policyKey = JSON.stringify(configuration)) {
    return applyTargets(new Set([targetSession]), configuration, policyKey);
  }

  return { enqueue, register, isRegistered, unregister, cancelEnrollment, apply, applyTo,
    adoptDefault, getPolicyGetter, policyFor, setFatalHandler, withdrawAll, quarantineAll, retireAll, terminate, commit };
}

module.exports = { createSessionProxyController };
