const http = require('http');
const { expect } = require('@playwright/test');
const { evalInActiveWebview, loadInActiveWebview } = require('./installed-acceptance');

async function readHttpCache(window) {
  return window.evaluate(async () => {
    const guest = document.querySelector('webview:not(.hidden)');
    if (!guest) throw new Error('No active webview for HTTP cache evidence');
    return {
      activeWebContentsId: guest.getWebContentsId(),
      ...(await window.electronAPI.getAcceptanceHttpCacheState()),
    };
  });
}

function activeCache(state) {
  const guest = state.contents.find((wc) => wc.id === state.activeWebContentsId && wc.type === 'webview');
  if (!guest || !state.caches[guest.sessionIndex]) throw new Error('Active webview cache was not measured');
  return state.caches[guest.sessionIndex];
}

function expectEmptyHttpCache(state, url, phase) {
  activeCache(state);
  expect(state.caches.length, 'at least one actual browser session was measured').toBeGreaterThan(0);
  for (const cache of state.caches) {
    expect(cache.sizeBytes, `${url} must be absent from the entire HTTP cache ${phase}: ${JSON.stringify(cache)}`).toBe(0);
  }
}

// After B's control is complete, put a cacheable response into the SAME
// guest session. Its native size must increase, and a cache-only read must
// work with the server closed. Never clear or disable a cache to make B cold.
async function verifyHttpCacheMeasurement(window, coldState) {
  const body = 'Freedom HTTP cache measurement positive control';
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== '/cache-measurement-control') {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/cache-measurement-control`;
  try {
    await loadInActiveWebview(window, url);
    await expect.poll(() => evalInActiveWebview(window, 'document.body.innerText'), { timeout: 30_000 }).toBe(body);
    let state;
    await expect.poll(async () => {
      state = await readHttpCache(window);
      return activeCache(state).sizeBytes;
    }, { message: 'the native measurement detects a real cache entry in the tested session', timeout: 10_000 }).toBeGreaterThan(0);
    expect(state.activeWebContentsId, 'the positive control uses the same webview').toBe(coldState.activeWebContentsId);
    expect(activeCache(state)).toMatchObject({
      persistent: activeCache(coldState).persistent,
      storagePath: activeCache(coldState).storagePath,
    });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const cached = await evalInActiveWebview(window,
      'fetch(location.href, { cache: "only-if-cached", mode: "same-origin" }).then(async response => ' +
      '({ status: response.status, body: await response.text() }))');
    expect(cached).toEqual({ status: 200, body });
    expect(requests, 'the cache-only read did not contact the stopped server').toBe(1);
    return { url, requests, state, cacheOnlyRead: cached, serverClosed: true };
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

module.exports = { readHttpCache, expectEmptyHttpCache, verifyHttpCacheMeasurement };
