// Shared renderer-only navigation for installed Spaces acceptance. Every
// lookup goes through the packaged browser; no relay or verifier is stubbed.
const path = require('path');
const { expect } = require('@playwright/test');
const { launchApp, packagedLaunchTarget } = require('../packaged-launch');
const { closeApp } = require('../close-app');
const { parseSpaceHandle } = require('../../src/main/spaces/names');
const { parseWebsiteUrl } = require('../../src/main/spaces/website');

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

function memberWebsite(raw) {
  const separator = typeof raw === 'string' ? raw.indexOf('=') : -1;
  const name = parseSpaceHandle(separator > 0 ? raw.slice(0, separator).trim() : '');
  const url = separator > 0 ? parseWebsiteUrl(raw.slice(separator + 1).trim()) : null;
  if (!name?.member || !url) {
    throw new Error('FREEDOM_E2E_SPACES_MEMBER_WEBSITE must name a real member@space=https://website/');
  }
  return { handle: name.handle, url };
}

module.exports = { activePage, launch, memberWebsite, navigate, resultFor, RESOLVE_TIMEOUT_MS };
