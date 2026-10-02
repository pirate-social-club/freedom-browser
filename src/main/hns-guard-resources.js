// Records actual close events, rather than treating destroy() as completion.
function createHnsGuardResources() {
  const resources = new Set();
  const waiters = new Set();
  let admitted = false;
  let pendingDrain;

  function track(resource) {
    if (resources.has(resource)) return resource;
    if (typeof resource?.on !== 'function' || typeof resource.destroy !== 'function') {
      throw new TypeError('HNS guard resource cannot be drained');
    }
    resources.add(resource);
    resource.on('close', () => {
      resources.delete(resource);
      if (!resources.size) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    });
    if (!admitted) resource.destroy();
    return resource;
  }

  function withdraw() { admitted = false; }
  function publish() { admitted = true; }

  function drain() {
    withdraw();
    if (pendingDrain) return pendingDrain;
    pendingDrain = Promise.resolve().then(async () => {
      const errors = [];
      for (const resource of resources) {
        try { resource.destroy(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'HNS guard resource destruction failed');
      if (resources.size) await new Promise((resolve) => waiters.add(resolve));
    }).finally(() => { pendingDrain = null; });
    return pendingDrain;
  }

  return { track, drain, withdraw, publish };
}

module.exports = { createHnsGuardResources };
