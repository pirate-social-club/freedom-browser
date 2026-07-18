const http = require('http');
const log = require('./logger');
const { buildPacHnsRootMap, subscribeHnsHostPolicy } = require('../shared/hns-hosts');
const { subscribeServiceRegistry } = require('./service-registry');
const { isHnsServiceReady } = require('./hns-request-gate');

const BLACKHOLE_PROXY_ADDR = '127.0.0.1:1';

function getProxyAddr(service) {
  if (!isHnsServiceReady(service)) return null;
  try {
    const parsed = new URL(service.api);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) return null;
    return `127.0.0.1:${parsed.port}`;
  } catch {
    return null;
  }
}

function buildHnsPacScript(proxyAddr) {
  if (!/^127\.0\.0\.1:\d+$/.test(proxyAddr || '')) {
    throw new Error('HNS PAC requires a loopback proxy address');
  }
  return `var hnsRoots = ${buildPacHnsRootMap()};

function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (shExpMatch(host, "127.0.0.*") || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
  if (/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(host) || host.indexOf(":") !== -1) {
    return "DIRECT";
  }
  var levels = dnsDomainLevels(host);
  var root = host.substring(host.lastIndexOf(".") + 1);
  if (levels === 0 || hnsRoots[root] === 1) {
    return "PROXY ${proxyAddr}";
  }
  return "DIRECT";
}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function createHnsPacLifecycle({
  targetSession,
  createServer = http.createServer,
  subscribe = subscribeServiceRegistry,
  subscribeHostPolicy = subscribeHnsHostPolicy,
} = {}) {
  if (!targetSession?.setProxy) throw new TypeError('HNS PAC requires an Electron session');

  let server = null;
  let appliedProxyAddr = null;
  let desiredService = null;
  let revision = 0;
  let chain = Promise.resolve();
  let unsubscribe = null;
  let unsubscribeHostPolicy = null;
  let forceRegeneration = false;

  async function clearAppliedProxy() {
    const oldServer = server;
    server = null;
    appliedProxyAddr = null;
    await targetSession.setProxy({ mode: 'direct' });
    await close(oldServer);
  }

  async function reconcile(expectedRevision) {
    const harnessDirect = process.env.FREEDOM_TEST_MODE === '1' && desiredService?.testDirect === true;
    if (harnessDirect) {
      if (server || appliedProxyAddr) await clearAppliedProxy();
      return;
    }
    const proxyAddr = getProxyAddr(desiredService) || BLACKHOLE_PROXY_ADDR;
    if (proxyAddr === appliedProxyAddr && server && !forceRegeneration) return;
    forceRegeneration = false;

    const pac = buildHnsPacScript(proxyAddr);
    const nextServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      response.end(pac);
    });
    const port = await listen(nextServer);
    if (expectedRevision !== revision) {
      await close(nextServer);
      return;
    }

    const previousServer = server;
    server = nextServer;
    appliedProxyAddr = proxyAddr;
    await targetSession.setProxy({ pacScript: `http://127.0.0.1:${port}/proxy.pac` });
    if (expectedRevision !== revision) {
      // Keep the last local PAC active until the queued reconciliation swaps
      // it. Clearing to DIRECT here would create a DNS-disclosure window.
      return;
    }
    await close(previousServer);
    log.info(`[HNS PAC] Routing admitted names through ${proxyAddr}`);
  }

  function schedule(state) {
    desiredService = state?.hns ? { ...state.hns } : null;
    revision += 1;
    const expectedRevision = revision;
    chain = chain
      .then(() => reconcile(expectedRevision))
      .catch((error) => log.error(`[HNS PAC] Reconcile failed: ${error.message}`));
    return chain;
  }

  function start() {
    if (!unsubscribe) unsubscribe = subscribe(schedule);
    if (!unsubscribeHostPolicy) {
      unsubscribeHostPolicy = subscribeHostPolicy(() => {
        forceRegeneration = true;
        return schedule({ hns: desiredService });
      });
    }
    return chain;
  }

  async function stop() {
    revision += 1;
    desiredService = null;
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeHostPolicy?.();
    unsubscribeHostPolicy = null;
    await chain;
    if (server || appliedProxyAddr) await clearAppliedProxy();
  }

  return {
    getAppliedProxyAddr: () => appliedProxyAddr,
    schedule,
    start,
    stop,
  };
}

let appLifecycle = null;

async function startHnsPacLifecycle(targetSession) {
  if (appLifecycle) return appLifecycle;
  appLifecycle = createHnsPacLifecycle({ targetSession });
  await appLifecycle.start();
  return appLifecycle;
}

async function stopHnsPacLifecycle() {
  if (!appLifecycle) return;
  const lifecycle = appLifecycle;
  appLifecycle = null;
  await lifecycle.stop();
}

module.exports = {
  buildHnsPacScript,
  BLACKHOLE_PROXY_ADDR,
  createHnsPacLifecycle,
  getProxyAddr,
  startHnsPacLifecycle,
  stopHnsPacLifecycle,
};
