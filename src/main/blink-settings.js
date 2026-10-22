/**
 * Blink settings every renderer starts with, applied through Chromium's
 * `--blink-settings` switch before the app is ready.
 *
 * DNS prefetching is off. A page's `<link rel="dns-prefetch">` hint, and the
 * same hint sent as an HTTP `Link: <//name>; rel=dns-prefetch` header, make
 * Chromium look the name up at once, and on Electron 44.9.3 that lookup
 * ignores the session's proxy policy. So a page could have any name looked up
 * in ordinary DNS, a `.pirate` name or one under an imported Handshake root
 * included, although the PAC sends those names to the Handshake guard and
 * never resolves them
 * (src/main/__tests__/integration/hns-namespace-discovery.test.js). An
 * `X-DNS-Prefetch-Control: off` header would not help: explicit hints check
 * the frame's DNSPrefetchingEnabled setting itself (Chromium's
 * third_party/blink/renderer/core/loader/preload_helper.cc), and Electron's
 * webPreferences do not expose that setting. The switch reaches every
 * renderer, <webview> guests and private-window partitions included.
 *
 * Chromium keeps one value per switch, so settings already on the launch
 * command line are merged rather than replaced; ours win where they overlap.
 */

const BLINK_SETTINGS_SWITCH = 'blink-settings';
const FORCED_BLINK_SETTINGS = Object.freeze({ dnsPrefetchingEnabled: 'false' });

// `name=value,name=value`, as Blink reads the switch.
function mergeBlinkSettings(existing = '') {
  const settings = new Map();
  for (const entry of String(existing || '').split(',')) {
    const at = entry.indexOf('=');
    const name = (at === -1 ? entry : entry.slice(0, at)).trim();
    if (name) settings.set(name, at === -1 ? null : entry.slice(at + 1).trim());
  }
  for (const [name, value] of Object.entries(FORCED_BLINK_SETTINGS)) settings.set(name, value);
  return [...settings]
    .map(([name, value]) => (value === null ? name : `${name}=${value}`))
    .join(',');
}

function applyBlinkSettings(app) {
  const value = mergeBlinkSettings(app.commandLine.getSwitchValue(BLINK_SETTINGS_SWITCH));
  app.commandLine.appendSwitch(BLINK_SETTINGS_SWITCH, value);
  return value;
}

module.exports = {
  BLINK_SETTINGS_SWITCH,
  FORCED_BLINK_SETTINGS,
  mergeBlinkSettings,
  applyBlinkSettings,
};
