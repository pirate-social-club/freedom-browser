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
// @yahoo is a real space whose owner has published no records, so it must end
// verified, on the "Website not published" result. When a space publishes a
// signed website, FREEDOM_E2E_SPACES_WEBSITE=`@space=https://url/` adds the
// positive check that the browser lands on exactly that URL.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget, isPackagedRun } = require('../packaged-launch');
const { closeApp } = require('../close-app');

const ENABLED = process.env.FREEDOM_E2E_SPACES_LIVE === '1';
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
  test.skip(
    !ENABLED,
    'set FREEDOM_E2E_SPACES_LIVE=1 to resolve names through the public Spaces relays'
  );
  test.skip(
    ENABLED && !isPackagedRun(),
    'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary'
  );

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

      const yahoo = await resultFor(window, '@yahoo');
      expect(yahoo.params, '@yahoo result').toMatchObject({
        type: 'refused',
        reason: 'NO_WEBSITE_RECORD',
      });
      expect(yahoo.status).toBe('Website not published');
      expect(Number(yahoo.params.anchorHeight), '@yahoo verified anchor height').toBeGreaterThan(
        970000
      );
      expect(yahoo.rows).toContainEqual(['Verified at Bitcoin block', yahoo.params.anchorHeight]);
      await expect(address).toHaveValue('@yahoo');
      test.info().annotations.push({ type: '@yahoo', description: JSON.stringify(yahoo.params) });

      const absent = await resultFor(window, ABSENT);
      expect(absent.params, `${ABSENT} result`).toMatchObject({
        type: 'refused',
        reason: 'SPACE_NOT_FOUND',
      });
      expect(absent.status).toBe('Not found');

      const member = await resultFor(window, 'member@yahoo');
      expect(member.params).toMatchObject({ type: 'refused', reason: 'MEMBER_NAMES_UNSUPPORTED' });

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
            description: 'not run: FREEDOM_E2E_SPACES_WEBSITE unset',
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
    } finally {
      if (session) await closeApp(session.app, { timeout: 100_000 }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
