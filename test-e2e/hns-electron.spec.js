const { test, expect, PAGE_MARKER } = require('./hns-electron-fixtures');
const StubResolver = require('bns/lib/resolver/stub');
const wire = require('bns/lib/wire');

async function waitForAuthenticatedTlsa(recursiveAddr) {
  const resolver = new StubResolver({ edns: true, dnssec: true });
  resolver.setServers([recursiveAddr]);
  await resolver.open();
  try {
    await expect.poll(async () => {
      try {
        const response = await resolver.lookup('_443._tcp.app.pirate.', wire.types.TLSA);
        return response.ad && response.answer.some((answer) => answer.type === wire.types.TLSA);
      } catch {
        return false;
      }
    }, { timeout: 30_000 }).toBe(true);
  } finally {
    await resolver.close();
  }
}

const activeWebviewEval = (window, expression) => window.evaluate(async (script) => {
  const webview = document.querySelector('webview.active, webview:not(.hidden)');
  if (!webview?.executeJavaScript) return null;
  try { return await webview.executeJavaScript(script); } catch { return null; }
}, expression);

const activeWebviewUrl = (window) => window.evaluate(() => {
  const webview = document.querySelector('webview.active, webview:not(.hidden)');
  return webview?.getURL?.() || webview?.src || '';
});

test('real Electron navigation renders DANE origin through the profile CA', async ({ window }) => {
  await expect.poll(
    () => window.evaluate(() => window.hns.getStatus()),
    { timeout: 60_000 },
  ).toMatchObject({ status: 'running', synced: true });

  // Name readiness can precede completion of the delegated TLSA validation
  // path. Prime that hermetic path before navigation so an early negative
  // DNSSEC cache entry cannot turn this into a fixture-ordering test.
  const status = await window.evaluate(() => window.hns.getStatus());
  await waitForAuthenticatedTlsa(status.recursiveAddr);

  const input = window.locator('[data-test="address-input"]');
  await input.fill('https://app.pirate/');
  await input.press('Enter');

  await expect.poll(() => activeWebviewEval(
    window,
    `document.querySelector('[data-test="hns-dane-marker"]')?.textContent || null`,
  ), { timeout: 45_000 }).toBe(PAGE_MARKER);
});

test.describe('mismatched DANE fixture', () => {
  test.use({ hnsTlsaMatches: false });

  test('Electron keeps navigation fail-closed when TLSA does not match', async ({ window }) => {
    await expect.poll(
      () => window.evaluate(() => window.hns.getStatus()),
      { timeout: 60_000 },
    ).toMatchObject({ status: 'running', synced: false });

    const input = window.locator('[data-test="address-input"]');
    await input.fill('https://app.pirate/');
    await input.press('Enter');

    await expect.poll(() => activeWebviewUrl(window), { timeout: 15_000 })
      .toMatch(/\/pages\/hns-syncing\.html$/);
    await expect.poll(() => activeWebviewEval(
      window,
      `document.querySelector('[data-test="hns-dane-marker"]')?.textContent || null`,
    )).toBeNull();
  });
});
