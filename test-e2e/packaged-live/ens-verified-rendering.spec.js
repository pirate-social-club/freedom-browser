// Resolve and render a real ENS contenthash using the installed application's
// unchanged resolver, Colibri worker and IPFS protocol handlers. The existing
// ENSv2 checker overrides those handlers and cannot qualify this path.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { closeApp } = require('../close-app');
const { watchProcessExit } = require('../live-fixtures');
const {
  NODES_OFF, gateLiveSpec, installedResourcesDir, anyPackagedHelpers, isRunningPid,
  makeScratchRoot, launchInstalled, evidenceDir, writeJson, quitCleanly,
  waitForNodeToSettle, navigate, navigateFromStartPage, evalInActiveWebview, activeHref,
} = require('./installed-acceptance');

const NAME = 'ur.integration-tests.eth';
const EXPECTED_BODY = 'Hello from IPFS Gateway Checker';

test.describe('installed ENS verified rendering', () => {
  gateLiveSpec(test, {
    flag: 'FREEDOM_E2E_ENS_VERIFIED_LIVE',
    purpose: 'to require live Colibri verification and rendered ENS content in normal and private windows',
  });

  // Playwright requires a destructured fixture argument even without fixtures.
  // eslint-disable-next-line no-empty-pattern
  test('the committed ENS document renders with Colibri verification in both windows', async ({}, testInfo) => {
    test.setTimeout(900_000);
    const dirs = makeScratchRoot('freedom-ens-verified-');
    const evidence = evidenceDir('freedom-ens-verified-evidence-');
    const resources = installedResourcesDir();
    const summary = { name: NAME, expectedBody: EXPECTED_BODY, scratchRoot: dirs.root, windows: [] };
    let launched;
    try {
      expect(anyPackagedHelpers(resources), 'the package must have exclusive runtime custody').toEqual([]);
      launched = await launchInstalled(dirs, { settings: { ...NODES_OFF, startIpfsAtLaunch: true } });
      const { app, window } = launched;
      const cleanExit = watchProcessExit(app, { timeout: 100_000 });
      const ipfs = await waitForNodeToSettle(window, 'ipfs', { label: 'native IPFS', timeout: 180_000 });
      expect(ipfs.status).toBe('running');

      for (const mode of ['normal', 'private']) {
        let page = window;
        if (mode === 'private') {
          await window.evaluate(() => window.electronAPI.newPrivateWindow());
          await expect.poll(() => {
            page = app.windows().find((candidate) => candidate.url().includes('privatePartition=private-'));
            return Boolean(page);
          }, { timeout: 30_000 }).toBe(true);
          await page.waitForSelector('[data-test="address-input"]');
        }
        await navigateFromStartPage(page, NAME);
        await expect.poll(() => evalInActiveWebview(page, 'document.body.innerText'), {
          message: `${mode}: ENS must render the expected document, not a refusal or a successful lookup alone`,
          timeout: 120_000,
        }).toContain(EXPECTED_BODY);
        const href = await activeHref(page);
        expect(new URL(href).protocol).toBe('ipfs:');
        expect(new URL(href).hostname).toBe(NAME);
        const shield = page.locator('#trust-shield');
        await expect(shield).toBeVisible();
        await expect(shield).toHaveAttribute('data-trust', 'verified');
        await shield.click();
        await expect(page.locator('#trust-popover')).toBeVisible();
        await expect(page.locator('#trust-popover-title')).toHaveText(NAME);
        const verifier = page.locator('#trust-popover-trust-fields .trust-popover-field')
          .filter({ has: page.locator('.trust-popover-field-label', { hasText: /^Verified by$/ }) });
        await expect(verifier.locator('.trust-popover-field-value')).toHaveText('Colibri');
        const trust = await page.locator('#trust-popover').innerText();
        // Re-read the document after the proof UI: a stale badge or intervening
        // navigation must not qualify a different document.
        expect(await activeHref(page)).toBe(href);
        expect(await evalInActiveWebview(page, 'document.body.innerText')).toContain(EXPECTED_BODY);
        const screenshot = testInfo.outputPath(`ens-verified-${mode}.png`);
        await page.screenshot({ path: screenshot });
        summary.windows.push({ mode, href, trust, screenshot, rendered: true });
        await shield.click();
        await navigate(page, 'about:blank');
        await expect.poll(() => activeHref(page), { timeout: 30_000 }).toBe('about:blank');
        await expect(shield).not.toBeVisible();
        const absentName = `freedom-refusal-${randomUUID()}.eth`;
        const refusal = page.waitForEvent('dialog', { timeout: 60_000 });
        await navigate(page, absentName);
        const dialog = await refusal;
        const message = dialog.message();
        await dialog.accept();
        expect(message).toBe(`ENS resolution failed for ${absentName}: NO_RESOLVER`);
        expect(await activeHref(page), 'a missing ENS record must not load content').toBe('about:blank');
        await expect(shield).not.toBeVisible();
        summary.windows.at(-1).refusal = { name: absentName, message, href: await activeHref(page) };
      }
      summary.quit = await quitCleanly(app, resources, 'after verified ENS rendering');
      launched = null;
      await cleanExit();
      summary.accepted = true;
    } catch (error) {
      summary.failure = { name: error.name, message: error.message };
      throw error;
    } finally {
      if (launched) {
        try { await closeApp(launched.app, { timeout: 100_000 }); }
        catch (error) { summary.cleanupError = error.message; }
        summary.failureCleanup = {
          exit: launched.app.exitResult(),
          mainRunning: isRunningPid(launched.app.process().pid),
          helpers: anyPackagedHelpers(resources),
        };
      }
      // Failed profiles are evidence, and may still have live descendants.
      // The outer acceptance owner reclaims them only after its process check.
      summary.scratchPreserved = summary.accepted !== true;
      writeJson(evidence, 'ens-verified-rendering.json', summary);
      if (summary.accepted) fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
