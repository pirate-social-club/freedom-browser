// Installed production code, isolated profiles, and controlled loopback inputs.
// No test harness, main-process replacement, real wallet, or broadcast is used.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { closeApp } = require('../close-app');
const {
  NODES_OFF, REPO_ROOT, makeScratchRoot, launchInstalled, installedResourcesDir,
  anyPackagedHelpers, quitCleanly, evidenceDir, writeJson, gateLiveSpec,
} = require('./installed-acceptance');
const { CASES, startSecurityFixture, isolatedNetworkConfig } = require('./security-fixtures');

const PASSWORD = 'Installed-synthetic-wallet-acceptance-2026!';
const MESSAGE = '0x' + Buffer.from('Installed wallet attribution acceptance').toString('hex');
const SETTINGS = { ...NODES_OFF, enableIdentityWallet: true,
  enableHnsIntegration: false, startHnsAtLaunch: false };

async function createSyntheticVault(window) {
  // Keep the generated mnemonic inside the browser; neither return nor log it.
  const created = await window.evaluate(async (password) => {
    const result = await window.identity.createVault(password);
    return { success: result.success, error: result.error };
  }, PASSWORD);
  expect(created).toMatchObject({ success: true });
  const wallets = await window.evaluate(() => window.wallet.getDerivedWallets());
  expect(wallets.success).toBe(true);
  expect(wallets.wallets[0].index).toBe(0);
  return wallets.wallets[0];
}

async function inTab(window, url, script) {
  return window.evaluate(async ({ url, script }) => {
    const guest = [...document.querySelectorAll('webview')].find((view) => {
      try { return view.getURL() === url; } catch { return false; }
    });
    if (!guest) return null;
    try { return await guest.executeJavaScript(script); } catch { return null; }
  }, { url, script });
}

async function openLocal(window, url) {
  const address = window.locator('[data-test="address-input"]');
  await address.fill(url);
  await address.press('Enter');
  await expect.poll(() => inTab(window, url, 'Boolean(window.ethereum?.request)'), { timeout: 30000 }).toBe(true);
}

async function request(window, url, id, method, params = []) {
  await inTab(window, url, `window.__acceptance = window.__acceptance || {};
    window.__acceptance[${JSON.stringify(id)}] = null;
    window.ethereum.request(${JSON.stringify({ method, params })})
      .then(value => { window.__acceptance[${JSON.stringify(id)}] = { value }; })
      .catch(error => { window.__acceptance[${JSON.stringify(id)}] = { code: error.code }; }); true`);
}
const outcome = (window, url, id) => inTab(window, url, `window.__acceptance?.[${JSON.stringify(id)}]`);

async function exerciseAttribution(window, trusted, other, account, evidence, label) {
  const trustedUrl = trusted + '/trusted';
  const otherUrl = other + '/other';
  await openLocal(window, trustedUrl);
  await window.locator('[data-test="new-tab-btn"]').click();
  await openLocal(window, otherUrl);
  await window.locator('[data-test="tab"]').first().click();
  await window.evaluate(async (origin) => {
    await window.dappPermissions.grantPermission(origin, 0, 1);
    await window.dappPermissions.setSigningAutoApprove(origin, true);
  }, trusted);
  await request(window, trustedUrl, 'accounts', 'eth_accounts');
  await expect.poll(() => outcome(window, trustedUrl, 'accounts')).toEqual({ value: [account.address] });
  await request(window, trustedUrl, 'signature', 'personal_sign', [MESSAGE, account.address]);
  await expect.poll(async () => (await outcome(window, trustedUrl, 'signature'))?.value || '')
    .toMatch(/^0x[0-9a-f]{130}$/i);
  await request(window, otherUrl, 'accounts', 'eth_accounts');
  await expect.poll(() => outcome(window, otherUrl, 'accounts')).toEqual({ value: [] });
  await request(window, otherUrl, 'signature', 'personal_sign', [MESSAGE, account.address]);
  await expect.poll(() => outcome(window, otherUrl, 'signature')).toEqual({ code: 4100 });

  const checks = await window.evaluate(async ({ trustedUrl, otherUrl, origin, message }) => {
    const guestId = (url) => [...document.querySelectorAll('webview')]
      .find((view) => view.getURL() === url).getWebContentsId();
    const ownGuest = guestId(trustedUrl);
    const borrowed = await window.wallet.signMessage(message, 0, origin,
      { autoApprove: origin, webContentsId: guestId(otherUrl) });
    const absent = await window.wallet.signMessage(message, 0, origin, { autoApprove: origin });
    const own = await window.wallet.signMessage(message, 0, origin,
      { autoApprove: origin, webContentsId: ownGuest });
    return { borrowed, absent, ownSigned: own.success === true && /^0x[0-9a-f]{130}$/i.test(own.signature), ownGuest };
  }, { trustedUrl, otherUrl, origin: trusted, message: MESSAGE });
  expect(checks.borrowed).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
  expect(checks.absent).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
  expect(checks.ownSigned).toBe(true);

  await window.evaluate((origin) => window.dappPermissions.grantPermission(origin, 0, 1), other);
  await request(window, otherUrl, 'prompt', 'personal_sign', [MESSAGE, account.address]);
  await expect(window.locator('#sidebar-dapp-sign')).toBeVisible();
  await expect(window.locator('#dapp-sign-site')).toHaveText(other);
  await expect(window.locator('#dapp-connection-site')).toHaveText(trusted);
  await window.screenshot({ path: path.join(evidence, `wallet-${label}.png`) });
  await window.locator('#dapp-sign-reject').click();
  await expect.poll(() => outcome(window, otherUrl, 'prompt')).toEqual({ code: 4001 });
  return checks;
}

async function openRecipientReview(window, account, address, theme) {
  await window.evaluate(async ({ account, address, theme }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const send = await import('./lib/wallet/send.js');
    send.closeSend();
    document.documentElement.setAttribute('data-theme', theme);
    sidebar.open();
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    walletState.viewMode = 'identity';
    walletState.fullAddresses.wallet = account.address;
    walletState.derivedWallets = [account];
    walletState.activeWalletIndex = account.index;
    walletState.selectedChainId = 1;
    walletState.registeredChains = { 1: { chainId: 1, name: 'Controlled Ethereum fixture', nativeSymbol: 'ETH' } };
    walletState.registeredTokens = { 'eth-native': {
      chainId: 1, symbol: 'ETH', name: 'Ether', decimals: 18, address: null, builtin: true,
    } };
    // Display fixture only. The empty test wallet has no real funds. Every
    // estimate and reverse lookup still passes through the packaged IPC code.
    walletState.currentBalances = { 'eth-native': { formatted: '1.0', symbol: 'ETH' } };
    send.openSend({ recipient: address, chainId: 1 });
  }, { account, address, theme });
  await expect(window.locator('#sidebar-send')).toBeVisible();
  await window.locator('#send-amount').fill('0.001');
  await window.locator('#send-continue-btn').click();
  await expect(window.locator('#send-review-view')).toBeVisible({ timeout: 30000 });
}

test.describe('installed wallet and ENS security corrections', () => {
  gateLiveSpec(test, { flag: 'FREEDOM_E2E_WALLET_ENS_SECURITY_LIVE',
    purpose: 'to exercise synthetic wallet attribution and controlled ENS recipient claims' });

  test('normal and private windows bind auto-approval to their own requesting tab', async () => {
    test.setTimeout(5 * 60000);
    const evidence = evidenceDir('freedom-wallet-attribution-');
    const dirs = makeScratchRoot('freedom-wallet-attribution-');
    const resources = installedResourcesDir();
    expect(anyPackagedHelpers(resources)).toEqual([]);
    const trusted = await startSecurityFixture();
    const other = await startSecurityFixture();
    const summary = {};
    let session;
    try {
      session = await launchInstalled(dirs, { settings: SETTINGS });
      const account = await createSyntheticVault(session.window);
      summary.normal = await exerciseAttribution(session.window, trusted.origin, other.origin, account, evidence, 'normal');
      // Revoke the background test grant before repeating in the private window.
      await session.window.evaluate((origin) => window.dappPermissions.revokePermission(origin), other.origin);
      await session.window.evaluate(() => window.electronAPI.newPrivateWindow());
      let privateWindow;
      await expect.poll(() => {
        privateWindow = session.app.windows().find((page) => page.url().includes('privatePartition=private-'));
        return Boolean(privateWindow);
      }).toBe(true);
      await privateWindow.waitForSelector('[data-test="address-input"]');
      await expect(privateWindow.locator('[data-test="private-badge"]')).toBeVisible();
      await privateWindow.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      summary.private = await exerciseAttribution(privateWindow, trusted.origin, other.origin, account, evidence, 'private');
      summary.otherWindow = await privateWindow.evaluate(({ origin, id, message }) =>
        window.wallet.signMessage(message, 0, origin, { autoApprove: origin, webContentsId: id }),
      { origin: trusted.origin, id: summary.normal.ownGuest, message: MESSAGE });
      expect(summary.otherWindow).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      await privateWindow.close();
      summary.exit = await quitCleanly(session.app, resources, 'wallet-attribution');
      session = null;
    } finally {
      if (session) await closeApp(session.app, { timeout: 100000 }).catch(() => {});
      await Promise.all([trusted.close(), other.close()]);
      summary.requests = { trusted: trusted.observations, other: other.observations };
      writeJson(evidence, 'wallet-attribution-summary.json', summary);
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    expect([...trusted.observations.methods, ...other.observations.methods]).not.toContain('eth_sendRawTransaction');
    expect(anyPackagedHelpers(resources)).toEqual([]);
  });

  test('unnormalized ENS claims stay unverified through the installed send review in both themes', async () => {
    test.setTimeout(5 * 60000);
    const evidence = evidenceDir('freedom-ens-primary-');
    const dirs = makeScratchRoot('freedom-ens-primary-');
    const resources = installedResourcesDir();
    expect(anyPackagedHelpers(resources)).toEqual([]);
    const rpc = await startSecurityFixture();
    const sources = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/shared/endpoint-sources.json'), 'utf8'));
    fs.writeFileSync(path.join(dirs.userData, 'network-config.json'), JSON.stringify(isolatedNetworkConfig(rpc.origin, sources)));
    const summary = { qualification: 'Controlled direct RPC, not a public chain proof or Colibri/Myotis runtime test', cases: [] };
    let session;
    try {
      session = await launchInstalled(dirs, { settings: SETTINGS });
      const account = await createSyntheticVault(session.window);
      for (const entry of CASES) {
        const result = await session.window.evaluate((address) => window.electronAPI.resolveEnsReverse(address, 1), entry.address);
        if (entry.valid) expect(result).toMatchObject({ success: true, name: entry.name });
        else {
          expect(result).toMatchObject({ success: false, reason: 'UNVERIFIED', unverifiedCause: 'unnormalized', claimedName: entry.name });
          expect(result.name).toBeUndefined();
        }
        summary.cases.push({ address: entry.address, result });
        for (const theme of ['dark', 'light']) {
          await openRecipientReview(session.window, account, entry.address, theme);
          const recipient = session.window.locator('#send-review-to');
          if (entry.valid) await expect(recipient).toContainText(entry.name);
          else {
            await expect(recipient).not.toContainText(entry.name);
            await expect(recipient).toContainText(entry.address);
            await expect(recipient.locator('.send-review-warning')).toHaveAttribute('title', /isn't a normalized ENS name/);
          }
          await session.window.screenshot({ path: path.join(evidence, `ens-${entry.address.slice(2, 4)}-${theme}.png`) });
        }
      }
      expect(new Set(rpc.observations.reverse)).toEqual(new Set(CASES.map((entry) => entry.address)));
      expect(rpc.observations.methods).not.toContain('eth_sendRawTransaction');
      expect(rpc.observations.malformed).toBe(0);
      summary.exit = await quitCleanly(session.app, resources, 'ens-primary');
      session = null;
    } finally {
      if (session) await closeApp(session.app, { timeout: 100000 }).catch(() => {});
      await rpc.close();
      summary.rpc = rpc.observations;
      writeJson(evidence, 'ens-primary-summary.json', summary);
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    expect(anyPackagedHelpers(resources)).toEqual([]);
  });
});
