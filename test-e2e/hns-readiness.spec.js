const { test, expect } = require('./fixtures');

const activeWebviewUrl = (window) => window.evaluate(() => {
  const webview = document.querySelector('webview.active, webview:not(.hidden)');
  return webview?.getURL?.() || webview?.getAttribute?.('src') || '';
});

const activeWebviewEval = (window, expression) => window.evaluate(async (script) => {
  const webview = document.querySelector('webview.active, webview:not(.hidden)');
  if (!webview?.executeJavaScript) return null;
  try { return await webview.executeJavaScript(script); }
  catch { return null; }
}, expression);

const setHnsState = (electronApp, state) => electronApp.evaluate((_electron, value) => {
  globalThis.__FREEDOM_TEST_HARNESS__.setHnsState(value);
}, state);

test('cold HNS navigation renders locally and resumes only after registry readiness', async ({
  electronApp,
  window,
}) => {
  const target = 'https://app.pirate/private?token=interstitial-secret';
  const input = window.locator('[data-test="address-input"]');
  await input.fill(target);
  await input.press('Enter');

  await expect.poll(() => activeWebviewUrl(window)).toMatch(/\/pages\/hns-syncing\.html$/);
  const interstitialUrl = await activeWebviewUrl(window);
  expect(interstitialUrl).not.toContain('app.pirate');
  expect(interstitialUrl).not.toContain('interstitial-secret');
  await expect.poll(() => activeWebviewEval(
    window,
    `document.getElementById('destination')?.textContent || null`
  )).toBe('app.pirate');

  const history = await window.evaluate(() => window.electronAPI.getHistory());
  expect(history.some((entry) => String(entry.url).includes('interstitial-secret'))).toBe(false);

  await setHnsState(electronApp, {
    api: 'http://127.0.0.1:44041',
    mode: 'bundled',
    synced: true,
    height: 123456,
    testDirect: true,
  });

  await expect.poll(() => activeWebviewEval(
    window,
    `document.querySelector('[data-test="harness-http-stub-url"]')?.textContent || null`
  )).toBe(target);
});

test('crash and disable transitions gate the next navigation and recover in place', async ({
  electronApp,
  window,
}) => {
  await setHnsState(electronApp, {
    api: 'http://127.0.0.1:44041',
    mode: 'bundled',
    synced: true,
    testDirect: true,
  });
  const input = window.locator('[data-test="address-input"]');
  await input.fill('https://first.pirate/');
  await input.press('Enter');
  await expect.poll(() => activeWebviewEval(
    window,
    `document.querySelector('[data-test="harness-http-stub-url"]')?.textContent || null`
  )).toBe('https://first.pirate/');

  // Simulate the registry transition produced synchronously when the helper
  // exits. The already-loaded page stays visible; the next name is gated.
  await setHnsState(electronApp, { mode: 'none', synced: false });
  const heldTarget = 'https://after-crash.pirate/';
  await input.fill(heldTarget);
  await input.press('Enter');
  await expect.poll(() => activeWebviewUrl(window)).toMatch(/\/pages\/hns-syncing\.html$/);

  await setHnsState(electronApp, { mode: 'disabled', synced: false });
  await expect.poll(() => activeWebviewEval(
    window,
    `document.getElementById('state')?.textContent || null`
  )).toBe('Handshake is disabled for this profile');

  await setHnsState(electronApp, {
    api: 'http://127.0.0.1:44042',
    mode: 'bundled',
    synced: true,
    testDirect: true,
  });
  await expect.poll(() => activeWebviewEval(
    window,
    `document.querySelector('[data-test="harness-http-stub-url"]')?.textContent || null`
  )).toBe(heldTarget);
});
