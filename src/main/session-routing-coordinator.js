const { routingError, runRoutingOperation } = require('./session-routing-operation');

function terminalFailure(error, seen = new Set()) {
  if (!error || seen.has(error)) return null;
  seen.add(error);
  let code;
  let nestedErrors = [];
  let cause;
  try {
    code = error.code;
    nestedErrors = Array.isArray(error.errors) ? error.errors : [];
    cause = error.cause;
  } catch { /* Unknown exception objects cannot interrupt quarantine. */ }
  if (typeof code === 'string' && (code.endsWith('_timeout') || code === 'guard_drain_failed')) return code;
  for (const nested of [...nestedErrors, cause]) {
    const code = terminalFailure(nested, seen);
    if (code) return code;
  }
  return null;
}

// Owns the prepared policy. Session enrollment must not mutate shared listeners
// while other sessions remain allowed to use an older policy.
function createSessionRoutingCoordinator(controller, hooks, { timeoutMs = 30000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid shared routing deadline');
  let policy = null;
  let attempted = false;
  let intentEpoch = 0;
  let observedIntent = JSON.stringify(hooks.getIntent());

  function intentChanged() {
    const next = JSON.stringify(hooks.getIntent());
    if (next !== observedIntent) {
      if (intentEpoch === Number.MAX_SAFE_INTEGER) {
        controller.terminate('intent_generation_exhausted');
        throw routingError('intent_generation_exhausted');
      }
      intentEpoch += 1;
      observedIntent = next;
      policy = null;
      hooks.withdraw?.();
      controller.withdrawAll();
      return true;
    }
    return false;
  }

  async function recover() {
    const intent = hooks.getIntent();
    const intentKey = JSON.stringify(intent);
    const epoch = intentEpoch;
    const isCurrent = () => intentEpoch === epoch && JSON.stringify(hooks.getIntent()) === intentKey;
    const prepared = policy && policy.intentKey === intentKey && hooks.isValid(policy);
    let candidate = policy;
    attempted = true;
    try {
      if (!prepared) {
        // Withdraw before either a shared PAC body or guard resource changes.
        hooks.withdraw?.();
        controller.withdrawAll();
        policy = null;
        candidate = await runRoutingOperation(() => hooks.prepare(intent), 'prepare', timeoutMs);
        if (!isCurrent()) throw routingError('intent_superseded');
        candidate = { ...candidate, intentKey };
      }
      const tickets = await controller.apply(candidate.configuration, candidate.key, { deferReady: true });
      if (!prepared) await runRoutingOperation(() => hooks.retire(candidate), 'retire_resources', timeoutMs);
      if (!isCurrent()) throw routingError('intent_superseded');
      if (!hooks.isValid(candidate)) throw routingError('resources_unavailable');
      controller.commit(tickets);
      hooks.publish?.(candidate);
      policy = candidate;
      return policy;
    } catch (error) {
      policy = null;
      hooks.withdraw?.();
      let drainageError;
      try { await controller.quarantineAll(); } catch (cause) { drainageError = cause; }
      // Late shared resource mutation is not cancellable. Never recover it in
      // this process, even when closing existing connections succeeds.
      const fatalCode = terminalFailure(error);
      if (fatalCode) controller.terminate(fatalCode);
      if (drainageError) throw new AggregateError([error, drainageError], 'Shared routing recovery failed', { cause: error });
      throw error;
    }
  }

  function rebuild() {
    return controller.enqueue(recover);
  }

  async function enroll(targetSession) {
    const token = controller.register(targetSession);
    try {
      hooks.attach(targetSession, controller.getPolicyGetter(targetSession));
      await controller.enqueue(async () => {
        if (!controller.isRegistered(targetSession, token)) throw routingError('enrollment_cancelled');
        const intent = hooks.getIntent();
        const intentKey = JSON.stringify(intent);
        // Initial DIRECT enrollment needs no shared server preparation and
        // preserves the default session's native startup state.
        if (!policy && !attempted && hooks.isInitialDirect(intent)) {
          policy = { configuration: { mode: 'direct' }, key: 'direct', intentKey };
        }
        if (!policy || policy.intentKey !== intentKey || !hooks.isValid(policy)) throw routingError('policy_unprepared');
        await controller.applyTo(targetSession, policy.configuration, policy.key);
        if (!controller.isRegistered(targetSession, token)) throw routingError('enrollment_cancelled');
      });
    } catch (error) {
      controller.cancelEnrollment(targetSession, token);
      throw error;
    }
  }

  return { rebuild, enroll, intentChanged };
}

module.exports = { createSessionRoutingCoordinator };
