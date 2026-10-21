// Installed Linux evaluation acceptance for verified Spaces browsing.
//
// Types Spaces names into the installed package's address bar and reads what
// the browser concluded. Nothing is stubbed: the anchors come from the live
// upstream relays and Blockstream, and libveritas runs from inside app.asar in
// the main process, so the run also proves the packaged verifier loads. Run it
// on whatever network the machine is on (with the VPN connected, to prove
// VPN-on resolution).
//
// Opt-in, because it needs the public relays:
//
//   FREEDOM_E2E_SPACES_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/spaces-browsing.spec.js
//
// @yahoo now publishes its owner-signed staging website. The default expected
// URL is that approved destination; FREEDOM_E2E_SPACES_YAHOO_URL can name a later
// approved destination. FREEDOM_E2E_SPACES_WEBSITE=`@space=https://url/` adds
// another positive website check, such as @csca.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget } = require('../packaged-launch');
const { closeApp } = require('../close-app');
const { gateLiveSpec } = require('./installed-acceptance');

const YAHOO_URL =
  process.env.FREEDOM_E2E_SPACES_YAHOO_URL || 'https://web-next-staging.pirate.sc/c/@yahoo';
const WEBSITE = (() => {
  const raw = process.env.FREEDOM_E2E_SPACES_WEBSITE;
  if (!raw) return null;
  const at = raw.indexOf('=');
  if (at <= 0) throw new Error(`FREEDOM_E2E_SPACES_WEBSITE needs @space=https://url/: ${raw}`);
  return { handle: raw.slice(0, at).trim(), url: raw.slice(at + 1).trim() };
})();
const ABSENT = `@freedomabsent${Date.now().toString(36)}`;
const RESOLVE_TIMEOUT_MS = 90_000;

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (source) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    try {
      return await webview.executeJavaScript(source);
    } catch {
      return null;
    }
  }, snippet);

// The active tab's document: its URL, and on the Spaces result page the
// status line and detail rows its script wrote.
const activePage = (window) =>
  evalInActiveWebview(
    window,
    'JSON.stringify({ href: location.href, ' +
      'status: document.getElementById("status")?.textContent ?? null, ' +
      'rows: [...document.querySelectorAll("#details > div")].map((row) => [...row.children].map((cell) => cell.textContent)) })'
  ).then((value) => (value ? JSON.parse(value) : null));

async function navigate(window, address) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
}

// Navigate and wait for the result page for `handle`; returns what it shows.
async function resultFor(window, handle) {
  await navigate(window, handle);
  let seen = null;
  await expect
    .poll(
      async () => {
        seen = await activePage(window);
        if (!seen?.href.includes('/pages/space-browser.html')) return null;
        return new URL(seen.href).searchParams.get('handle');
      },
      {
        message: `${handle} must end on the Spaces result page`,
        timeout: RESOLVE_TIMEOUT_MS,
        intervals: [1_000],
      }
    )
    .toBe(handle);
  return { ...seen, params: Object.fromEntries(new URL(seen.href).searchParams) };
}

async function launch(dirs) {
  const app = await launchApp({
    ...packagedLaunchTarget(),
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      FREEDOM_TEST_USER_DATA: dirs.userData,
      FREEDOM_ANT_DATA: dirs.ant,
      FREEDOM_IPFS_DATA: dirs.ipfs,
      FREEDOM_IDENTITY_DATA: dirs.identity,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    timeout: 90_000,
  });
  try {
    const window = await app.firstWindow({ timeout: 90_000 });
    await window.waitForLoadState('domcontentloaded', { timeout: 90_000 });
    await window.waitForSelector('[data-test="address-input"]', {
      state: 'visible',
      timeout: 90_000,
    });
    return { app, window };
  } catch (error) {
    await closeApp(app, { timeout: 100_000 }).catch(() => {});
    throw error;
  }
}

test.describe('installed Spaces browsing', () => {
  // Skipped without its flag or executable; in acceptance mode
  // (FREEDOM_E2E_ACCEPTANCE=1) either fails instead (installed-acceptance.js).
  gateLiveSpec(test, { flag: 'FREEDOM_E2E_SPACES_LIVE', purpose: 'to resolve names through the public Spaces relays' });

  test('verifies a real space, refuses what it cannot verify, and quits cleanly', async () => {
    test.setTimeout(10 * 60_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-spaces-acceptance-'));
    const dirs = {
      userData: path.join(root, 'userData'),
      ant: path.join(root, 'ant-data'),
      ipfs: path.join(root, 'ipfs-data'),
      identity: path.join(root, 'identity'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    // Only Spaces is under test; the other bundled nodes stay off. HNS keeps
    // the package default, so lookups take the same routing as browsing.
    fs.writeFileSync(
      path.join(dirs.userData, 'settings.json'),
      JSON.stringify({
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableTorIntegration: false,
        startTorAtLaunch: false,
      })
    );

    let session = null;
    try {
      session = await launch(dirs);
      const { window } = session;
      const address = window.locator('[data-test="address-input"]');

      await navigate(window, '@yahoo');
      await expect
        .poll(async () => (await activePage(window))?.href, {
          message: '@yahoo must open its owner-signed website',
          timeout: RESOLVE_TIMEOUT_MS,
          intervals: [1_000],
        })
        .toBe(YAHOO_URL);
      await expect(address).toHaveValue('@yahoo');
      test.info().annotations.push({
        type: '@yahoo website',
        description: JSON.stringify({
          expected: YAHOO_URL,
          href: (await activePage(window))?.href,
          addressBar: await address.inputValue(),
        }),
      });

      const absent = await resultFor(window, ABSENT);
      expect(absent.params, `${ABSENT} result`).toMatchObject({
        type: 'refused',
        reason: 'SPACE_NOT_FOUND',
      });
      expect(absent.status).toBe('Not found');
      test.info().annotations.push({ type: 'absent name', description: JSON.stringify(absent.params) });

      const member = await resultFor(window, 'member@yahoo');
      expect(member.params).toMatchObject({ type: 'refused', reason: 'MEMBER_NAMES_UNSUPPORTED' });
      test.info().annotations.push({ type: 'member name', description: JSON.stringify(member.params) });

      if (WEBSITE) {
        await navigate(window, WEBSITE.handle);
        await expect
          .poll(async () => (await activePage(window))?.href, {
            message: `${WEBSITE.handle} must open its signed website`,
            timeout: RESOLVE_TIMEOUT_MS,
            intervals: [1_000],
          })
          .toBe(WEBSITE.url);
        await expect(address).toHaveValue(WEBSITE.handle);
        const landed = await activePage(window);
        test.info().annotations.push({
          type: `${WEBSITE.handle} website`,
          description: JSON.stringify({
            expected: WEBSITE.url,
            href: landed?.href,
            addressBar: await address.inputValue(),
          }),
        });
      } else {
        test
          .info()
          .annotations.push({
            type: 'website check',
            description: 'additional website not run: FREEDOM_E2E_SPACES_WEBSITE unset',
          });
      }

      await closeApp(session.app, { timeout: 100_000 });
      const exit = session.app.exitResult();
      session = null;
      expect(exit, 'the app must quit by itself with code 0').toEqual({
        code: 0,
        signal: null,
        forced: false,
      });
      test.info().annotations.push({ type: 'clean quit', description: JSON.stringify(exit) });
    } catch (error) {
      await test.info().attach('installed-browser-diagnostic', {
        body: Buffer.from(
          JSON.stringify({
            exit: session?.app.exitResult?.(),
            output: session?.app.outputText?.(),
          })
        ),
        contentType: 'application/json',
      });
      throw error;
    } finally {
      if (session) await closeApp(session.app, { timeout: 100_000 }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
