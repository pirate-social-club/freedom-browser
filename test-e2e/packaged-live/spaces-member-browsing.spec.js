// A separate installed gate: the existing root matrix cannot stand in for a
// real finalized member with a published owner-signed website. Supply its exact
// expected destination; there is no fixture or root-name fallback.
// FREEDOM_E2E_SPACES_MEMBER_LIVE=1
// FREEDOM_E2E_SPACES_MEMBER_WEBSITE='member@space=https://site.example/path'
// FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom
// Run with the system VPN connected. Hosted CI only collects this opt-in gate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { closeApp } = require('../close-app');
const {
  anyPackagedHelpers, gateLiveSpec, installedResourcesDir, quitCleanly,
} = require('./installed-acceptance');
const { activePage, launch, memberWebsite, navigate, resultFor, RESOLVE_TIMEOUT_MS } = require('./spaces-acceptance');

async function opensMember(window, target, phase) {
  await navigate(window, target.handle);
  await expect.poll(async () => (await activePage(window))?.href, {
    message: `the member's exact signed website must open (${phase})`,
    timeout: RESOLVE_TIMEOUT_MS, intervals: [1_000],
  }).toBe(target.url);
  const address = window.locator('[data-test="address-input"]');
  await expect(address).toHaveValue(target.handle);
  return { phase, handle: target.handle, expected: target.url, page: await activePage(window), address: await address.inputValue() };
}

test.describe('installed member browsing', () => {
  gateLiveSpec(test, {
    flag: 'FREEDOM_E2E_SPACES_MEMBER_LIVE',
    purpose: 'to verify a real finalized member through the public Spaces relays',
  });

  test('opens a member in normal and private windows, refuses an absent member, and survives restart', async () => {
    test.setTimeout(15 * 60_000);
    const target = memberWebsite(process.env.FREEDOM_E2E_SPACES_MEMBER_WEBSITE);
    const parent = target.handle.slice(target.handle.indexOf('@'));
    const absent = `freedomabsent${Date.now().toString(36)}${parent}`;
    const resources = installedResourcesDir();
    expect(anyPackagedHelpers(resources), 'no packaged helpers may predate this gate').toEqual([]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-member-acceptance-'));
    const dirs = Object.fromEntries(['userData', 'ant', 'ipfs', 'identity'].map((name) => [name, path.join(root, name)]));
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify({
      startAntAtLaunch: false, startIpfsAtLaunch: false, startRadicleAtLaunch: false,
      enableTorIntegration: false, startTorAtLaunch: false,
    }));
    const evidence = { target, absent, launches: [] };
    let session = null;
    try {
      for (const phase of ['first launch', 'after full restart']) {
        session = await launch(dirs);
        const current = { phase, pid: session.app.process().pid, normal: await opensMember(session.window, target, phase) };
        evidence.launches.push(current);
        // Use the real chrome preload bridge, which creates a separate private
        // browsing partition. Packaged runs have no main-process evaluator.
        await session.window.evaluate(() => window.electronAPI.newPrivateWindow());
        let privateWindow;
        await expect.poll(() => {
          privateWindow = session.app.windows().find((page) => page.url().includes('privatePartition=private-'));
          return Boolean(privateWindow);
        }, { timeout: 30_000 }).toBe(true);
        await privateWindow.waitForSelector('[data-test="address-input"]', { state: 'visible' });
        await expect(privateWindow.locator('[data-test="private-badge"]')).toBeVisible();
        current.private = await opensMember(privateWindow, target, `${phase}, private`);
        current.privatePartition = new URL(privateWindow.url()).searchParams.get('privatePartition');
        expect(current.privatePartition).toMatch(/^private-/);
        if (evidence.launches.length > 1) {
          expect(current.pid).not.toBe(evidence.launches[0].pid);
          expect(current.privatePartition).not.toBe(evidence.launches[0].privatePartition);
        }
        current.absent = await resultFor(privateWindow, absent);
        expect(current.absent.params).toMatchObject({ type: 'refused', reason: 'SPACE_NOT_FOUND' });
        await privateWindow.close();
        current.quit = await quitCleanly(session.app, resources, phase);
        session = null;
      }
    } catch (error) {
      evidence.failure = { message: error.message, output: session?.app.outputText?.(), exit: session?.app.exitResult?.() };
      throw error;
    } finally {
      await test.info().attach('installed-member-browsing', {
        body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json',
      });
      if (session) await closeApp(session.app, { timeout: 100_000 }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
