// A session must finish enrollment before its first navigation. Managers share
// this queue so a late proxy application cannot overwrite a newer policy.
function createSessionProxyController(getDefaultSession) {
  const sessions = new Map();
  let pending = Promise.resolve();

  function requireSession(targetSession) {
    if (typeof targetSession?.setProxy !== 'function') {
      throw new TypeError('Session proxy configuration is unavailable');
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
    if (!sessions.has(targetSession)) sessions.set(targetSession, {});
    return sessions.get(targetSession);
  }

  function isRegistered(targetSession, token) {
    return sessions.has(targetSession) && sessions.get(targetSession) === token;
  }

  function unregister(targetSession, token) {
    if (token === undefined || isRegistered(targetSession, token)) sessions.delete(targetSession);
  }

  async function apply(configuration) {
    const defaultSession = getDefaultSession();
    requireSession(defaultSession);
    const targets = new Set([defaultSession, ...sessions.keys()]);
    const results = await Promise.allSettled([...targets].map(async (targetSession) => {
      await targetSession.setProxy({ ...configuration });
      await targetSession.forceReloadProxyConfig?.();
      // Existing sockets may still use the old route after setProxy resolves.
      await targetSession.closeAllConnections?.();
    }));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), 'Session proxy update failed');
    }
  }

  return { enqueue, register, isRegistered, unregister, apply };
}

module.exports = { createSessionProxyController };
