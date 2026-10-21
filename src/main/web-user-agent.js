/**
 * The User-Agent web content sees: plain Chrome, not Freedom (issue #471).
 *
 * Electron's default User-Agent carries two extra product tokens,
 * `<AppName>/<version>` and `Electron/<version>`, and the full Chromium build
 * number. Few people run Freedom, so those tokens alone made every user close
 * to uniquely identifiable (EFF Cover Your Tracks: 18.44 bits from the UA).
 *
 * Stock Chrome sends the "reduced" UA: the real platform token, then
 * `Chrome/<major>.0.0.0` with the minor/build/patch frozen at zero. We rebuild
 * exactly that shape from Electron's default and assign it to
 * `app.userAgentFallback` before any session or webContents exists. Probed
 * against Electron 44.7.0 (2026-10-12): the fallback then reaches the default
 * session, `persist:` and in-memory (private-window) partitions, <webview>
 * guests, dedicated workers, `navigator.userAgent` and the `User-Agent`
 * request header alike.
 *
 * Client hints need nothing from us, as of the same probe: Electron's
 * `navigator.userAgentData` brand list is `Not?A_Brand` + `Chromium` (no
 * Electron or Freedom brand; `getHighEntropyValues().fullVersionList` the
 * same, with the real Chromium version Chrome reports there too), and it
 * sends no `Sec-CH-UA*` request headers even after an `Accept-CH` opt-in.
 *
 * Requests that identify Freedom on purpose set their own header and are not
 * affected: the updater (`updater.js`, `autoUpdater.requestHeaders`) and the
 * GitHub bridge's API calls (`github-bridge.js`).
 */

// Electron's default: `Mozilla/5.0 (<platform>) AppleWebKit/537.36 (KHTML,
// like Gecko) <App>/<v> Chrome/<full> Electron/<v> Safari/537.36`.
const CHROME_PREFIX = /^Mozilla\/5\.0 \(([^()]+)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) /;

// Product tokens stock Chrome's UA is made of; anything else is Electron's or ours.
const CHROME_TOKENS = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari', 'Mobile']);

function chromeUserAgent(electronUserAgent, chromeVersion) {
  const ua = String(electronUserAgent || '');
  const major = String(chromeVersion || '').split('.')[0];
  const prefix = ua.match(CHROME_PREFIX);
  if (prefix && /^\d+$/.test(major)) {
    return `Mozilla/5.0 (${prefix[1]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  // A shape we don't recognise (a future Electron changing its template):
  // still drop every product token Chrome doesn't send, rather than ship it.
  return ua
    .replace(/\s+([^\s()/]+)\/[^\s()]+/g, (token, name) => (CHROME_TOKENS.has(name) ? token : ''))
    .trim();
}

// Must run before the first session/webContents is created: a session reads
// the fallback when it is made.
function applyWebUserAgent(app, chromeVersion = process.versions.chrome) {
  app.userAgentFallback = chromeUserAgent(app.userAgentFallback, chromeVersion);
  return app.userAgentFallback;
}

module.exports = { applyWebUserAgent, chromeUserAgent };
