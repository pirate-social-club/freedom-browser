// A session must finish enrollment before its first navigation. Managers share
// this queue so a late proxy application cannot overwrite a newer policy.
function createSessionProxyController(getDefaultSession) {
  const sessions = new Map();
  const appliedPolicies = new WeakMap();
  let pending = Promise.resolve();

  function requireSession(targetSession) {
    for (const method of ['setProxy', 'forceReloadProxyConfig', 'closeAllConnections']) {
      if (typeof targetSession?.[method] !== 'function') {
        throw new TypeError(`Session proxy configuration is unavailable: ${method}`);
      }
    }
  }

  function enqueue(operation) {
    const result = pending.then(operation);
    // Keep a rejected operation visible to its caller while allowing retries.
    pending = result.catch(() => {});
    return result;
  }

  function register(targetSession) {
    requireSession(targetSession);
    if (!sessions.has(targetSession)) {
      appliedPolicies.delete(targetSession);
      sessions.set(targetSession, {});
    }
    return sessions.get(targetSession);
  }

  function isRegistered(targetSession, token) {
    return sessions.has(targetSession) && sessions.get(targetSession) === token;
  }

  function unregister(targetSession, token) {
    if (token === undefined || isRegistered(targetSession, token)) {
      sessions.delete(targetSession);
      appliedPolicies.delete(targetSession);
    }
  }

  async function applyTargets(targets, configuration, policyKey) {
    // Check every capability before changing any session, including on retries.
    for (const targetSession of targets) requireSession(targetSession);
    const results = await Promise.allSettled([...targets].map(async (targetSession) => {
      if (appliedPolicies.get(targetSession) === policyKey) return;
      const registration = sessions.get(targetSession);
      // A failed update may have changed routing before reload/close failed.
      appliedPolicies.delete(targetSession);
      await targetSession.setProxy({ ...configuration });
      await targetSession.forceReloadProxyConfig();
      // Existing sockets may still use the old route after setProxy resolves.
      await targetSession.closeAllConnections();
      if (sessions.get(targetSession) === registration) appliedPolicies.set(targetSession, policyKey);
    }));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), 'Session proxy update failed');
    }
  }

  function apply(configuration, policyKey = JSON.stringify(configuration)) {
    return applyTargets(new Set([getDefaultSession(), ...sessions.keys()]), configuration, policyKey);
  }

  function applyTo(targetSession, configuration, policyKey = JSON.stringify(configuration)) {
    return applyTargets(new Set([targetSession]), configuration, policyKey);
  }

  return { enqueue, register, isRegistered, unregister, apply, applyTo };
}

module.exports = { createSessionProxyController };
