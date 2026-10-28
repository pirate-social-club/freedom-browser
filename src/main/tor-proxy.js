/**
 * Tor proxy wiring for Electron sessions.
 *
 * Tor adds an `.onion`-only route to the shared network manager policy.
 * Other destinations keep the current HNS/dVPN policy or connect directly.
 * `.onion` needs no custom scheme — it is an ordinary http(s) host that just
 * needs proxying, and SOCKS5 does remote DNS so the name resolves at Tor.
 */

const log = require('./logger');

const ONION_PROXY_TEST_URL = 'https://freedom-proxy-check.onion/';

async function logOnionProxyResolution(targetSession, socksHostPort) {
  if (!targetSession || typeof targetSession.resolveProxy !== 'function') {
    return;
  }

  try {
    const resolvedProxy = await targetSession.resolveProxy(ONION_PROXY_TEST_URL);
    if (String(resolvedProxy).includes(socksHostPort)) {
      log.info(`[tor-proxy] Chromium resolves .onion via ${resolvedProxy}`);
      return;
    }
    log.warn(
      `[tor-proxy] Chromium did not resolve .onion via SOCKS5 ${socksHostPort}: ${resolvedProxy || '(empty)'}`
    );
  } catch (err) {
    log.warn(`[tor-proxy] failed to verify .onion proxy resolution: ${err?.message || err}`);
  }
}

/**
 * Point a session at the Arti SOCKS proxy for `.onion` traffic only.
 *
 * @param {import('electron').Session} targetSession
 * @param {string} socksHostPort - e.g. '127.0.0.1:9150'
 * @returns {Promise<void>}
 */
async function applyOnionProxy(targetSession, socksHostPort) {
  const networkManager = require('./network-manager');
  await networkManager.setTorProxy(socksHostPort);
  await logOnionProxyResolution(targetSession, socksHostPort);
}

/**
 * Restore direct connections (no proxy) on a session.
 *
 * @param {import('electron').Session} targetSession
 * @returns {Promise<void>}
 */
async function clearOnionProxy() {
  await require('./network-manager').clearTorProxy();
}

// Replay the current shared intent without withdrawing a newer Tor endpoint
// or changing HNS/dVPN routing after a superseded start finishes.
async function reassertOnionProxy() {
  await require('./network-manager').rebuild();
}

module.exports = {
  applyOnionProxy,
  clearOnionProxy,
  reassertOnionProxy,
};
