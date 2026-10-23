// Installed Radicle: the embedded node's identity, and the repository viewer
// (release-readiness acceptance, plan v3 step 5 item 7, with the viewer checks
// pull request 9 adds).
//
//   1. The embedded libradicle node starts in the installed browser (registry
//      mode `embedded`, API radapi://local) and returns its identity. A page
//      that the browser's own consent prompts grant access calls
//      `window.radicle.getIdentity()`, which the main process answers from the
//      node's `identity()` (src/main/radicle/cob-service.js getIdentity). The
//      answer must be a did:key whose suffix is the NID, and equal to the DID
//      the main process logged when the node started (src/main/
//      radicle-manager.js, "Embedded node started").
//   2. The repository viewer (pages/rad-browser.html) loads the node's local
//      repository list over radapi: and the public seed's list from
//      https://seed.radicle.xyz, on the page for a repository this node does not
//      hold. Then it renders one public-seed repository from local storage:
//      Freedom's own, which the node fetches from the public seeds when it
//      starts (radicle-manager.js connectAndSeedDefault). The local list must
//      name that repository. No Content Security Policy violation may be
//      reported for either viewer page, read from the tab's DevTools Log
//      (console) and Audits domains. Afterwards the spec inserts an inline
//      script into the viewer, which its script-src refuses, and the watcher
//      must report that, so the silence is not a blind watcher's.
//   3. A clean quit with exit code 0, after which no process whose executable
//      lies under the package's resources survives. The Radicle node is an
//      addon in the main process and has no pid of its own.
//
// In acceptance mode (FREEDOM_E2E_ACCEPTANCE=1) a missing live flag or
// executable fails instead of skipping, and the calibration override is
// refused, as for the retrieval specs; summary.json records the digest source.
//
//   FREEDOM_E2E_RADICLE_VIEWER_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//   FREEDOM_E2E_EVIDENCE_DIR=<dir> \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/radicle-viewer.spec.js

const fs = require('fs');
const http = require('http');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { CHROME_PAGE } = require('../packaged-launch');
const { closeApp } = require('../close-app');
const { watchProcessExit } = require('../live-fixtures');
const {
  REPO_ROOT,
  NODES_OFF,
  installedResourcesDir,
  anyPackagedHelpers,
  packagedHelpers,
  quitCleanly,
  makeScratchRoot,
  launchInstalled,
  evidenceDir,
  writeJson,
  expectNodeRunning,
  registryEntry,
  evalInActiveWebview,
  activeHref,
  navigate,
  navigateFromStartPage,
  nativeDigestSource,
  gateLiveSpec,
} = require('./installed-acceptance');

const NODE_START_TIMEOUT_MS = 3 * 60_000;
// connectAndSeedDefault: a 15 s seed bootstrap, then a clone bounded at 120 s.
const DEFAULT_REPO_TIMEOUT_MS = 4 * 60_000;
const PAGE_TIMEOUT_MS = 60_000;
// A structurally valid repository this node never seeds: radicle-desktop's,
// which test-e2e/live/radicle-provider.spec.js also uses as the absent one.
const ABSENT_RID = 'z4D5UCArafTzTQpDZNQRuqswh3ury';

// The repository the node fetches from the public seeds at start, read from
// the source rather than copied, so the two cannot drift.
function defaultRepositoryRid() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/radicle-manager.js'), 'utf8');
  const match = /FREEDOM_BROWSER_RID\s*=\s*'rad:(z[1-9A-HJ-NP-Za-km-z]+)'/.exec(source);
  if (!match) throw new Error('FREEDOM_BROWSER_RID not found in src/main/radicle-manager.js');
  return match[1];
}

// A blank page on loopback for the provider calls: `window.radicle` is
// injected into web pages, not into Freedom's internal ones.
function startProbePage() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Radicle identity probe</title><p>probe</p>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((done) => server.close(done)) })
    );
  });
}

// Call a `window.radicle` method from the active tab, approve the browser's
// consent prompt it opens, and return the method's answer and the prompt's title.
async function providerCallWithConsent(window, method) {
  await evalInActiveWebview(
    window,
    `window.__radicleCall = null;
     window.radicle.${method}().then(
       (value) => { window.__radicleCall = { value }; },
       (error) => { window.__radicleCall = { error: String((error && error.message) || error) }; }
     );
     true`
  );
  const approve = window.locator('#radicle-consent-approve');
  await expect(approve, `the ${method} consent prompt must open`).toBeVisible({ timeout: 30_000 });
  const title = (await window.locator('#radicle-consent-title').textContent())?.trim() || null;
  await approve.click();
  let answer = null;
  await expect
    .poll(
      async () => {
        answer = JSON.parse((await evalInActiveWebview(window, 'JSON.stringify(window.__radicleCall)')) || 'null');
        return Boolean(answer);
      },
      { message: `window.radicle.${method}() must answer`, timeout: PAGE_TIMEOUT_MS }
    )
    .toBe(true);
  return { title, ...answer };
}

// Content Security Policy reports from every tab webview: the console's Log
// entries that name the policy, and the Audits domain's CSP issues. Console
// errors and exceptions are kept as context.
async function watchSecurityReports(app) {
  const reports = { csp: [], cspIssues: [], consoleErrors: [], exceptions: [] };
  const sessions = [];
  for (const page of app.context().pages()) {
    if (CHROME_PAGE.test(page.url())) continue;
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Log.entryAdded', ({ entry }) => {
      const record = { source: entry.source, level: entry.level, text: entry.text, url: entry.url || null };
      if (/content security policy/i.test(entry.text || '')) reports.csp.push(record);
      else if (entry.level === 'error') reports.consoleErrors.push(record);
    });
    cdp.on('Audits.issueAdded', ({ issue }) => {
      if (issue.code === 'ContentSecurityPolicyIssue') reports.cspIssues.push(issue.details?.contentSecurityPolicyIssueDetails || issue);
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type !== 'error') return;
      const text = args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (/content security policy/i.test(text)) reports.csp.push({ source: 'console-api', level: 'error', text });
      else reports.consoleErrors.push({ source: 'console-api', level: 'error', text });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      reports.exceptions.push(exceptionDetails?.exception?.description || exceptionDetails?.text || null);
    });
    await cdp.send('Log.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Audits.enable');
    sessions.push(cdp);
  }
  return { reports, guests: sessions.length, stop: () => Promise.all(sessions.map((cdp) => cdp.detach().catch(() => {}))) };
}

// What the viewer is showing, read from its own DOM.
const VIEWER_STATE = `JSON.stringify((() => {
  const visible = (id) => { const el = document.getElementById(id); return Boolean(el) && !el.classList.contains('hidden'); };
  const rids = (id) => [...document.querySelectorAll('#' + id + ' .repo-item')].map((el) => el.dataset.rid);
  return {
    href: location.href,
    loading: visible('loading-state'),
    error: visible('error-state'),
    success: visible('success-state'),
    connectionError: visible('connection-error'),
    localRids: rids('repo-list'),
    localCount: document.getElementById('repo-count')?.textContent ?? null,
    networkRids: rids('network-list'),
    networkCount: document.getElementById('network-count')?.textContent ?? null,
    title: document.querySelector('.header-text h1')?.textContent ?? null,
    repoName: document.querySelector('#repo-header h2')?.textContent ?? null,
    treeRows: document.querySelectorAll('.file-tree-row').length,
  };
})())`;

async function viewerState(window) {
  return JSON.parse((await evalInActiveWebview(window, VIEWER_STATE)) || 'null');
}

test.describe('installed Radicle node and viewer', () => {
  gateLiveSpec(test, {
    flag: 'FREEDOM_E2E_RADICLE_VIEWER_LIVE',
    purpose: 'to start the embedded Radicle node and reach the public seeds',
  });

  test('the embedded node returns its identity and the viewer loads local and public-seed repositories', async () => {
    test.setTimeout(12 * 60_000);
    const resourcesDir = installedResourcesDir();
    const evidence = evidenceDir('freedom-radicle-viewer-');
    const dirs = makeScratchRoot('freedom-radicle-viewer-');
    // sockaddr_un caps the control socket path near 108 bytes on Linux.
    const controlSocket = path.join(dirs.radicle, 'node', 'control.sock');
    expect(controlSocket.length, `the Radicle control socket path is short enough: ${controlSocket}`).toBeLessThan(100);
    const defaultRid = defaultRepositoryRid();
    // No native digest is asserted here, but the same source rules apply, so
    // a stray override fails this gate too.
    const digests = nativeDigestSource();
    const summary = {
      defaultRid,
      absentRid: ABSENT_RID,
      digestSource: digests.source,
      digestSourceKind: digests.kind,
      calibration: digests.calibration,
      acceptance: digests.acceptance,
    };
    const record = () => writeJson(evidence, 'summary.json', summary);

    expect(anyPackagedHelpers(resourcesDir), 'packaged helpers already running before launch').toEqual([]);
    const probe = await startProbePage();
    let session = null;
    try {
      session = await launchInstalled(dirs, { settings: { ...NODES_OFF, enableIdentityWallet: true } });
      const { app, window } = session;
      const mainPid = app.process().pid;
      const expectCleanExit = watchProcessExit(app, { timeout: 100_000 });

      // A five-byte alias leaves the OpenSSH private section aligned. The
      // native Radicle parser must load the packaged encoder's output, which
      // used to contain an invalid extra block of padding (upstream #755).
      // Generate only a scratch vault and never return its mnemonic to the driver.
      summary.injectedIdentity = await window.evaluate(async () => {
        const created = await window.identity.createVault('Installed-Radicle-padding-test-2026!');
        if (!created.success) return { success: false, error: created.error };
        const result = await window.identity.injectAll('gate5');
        return { success: result.success, did: result.radicle?.did };
      });
      expect(summary.injectedIdentity.success).toBe(true);
      expect(summary.injectedIdentity.did).toMatch(/^did:key:z6Mk/);

      // 1. The node starts, and returns its identity.
      const startedAt = Date.now();
      const started = await window.evaluate(() => window.radicle.start());
      expect(started.status).toBe('running');
      await expectNodeRunning(window, 'radicle', { label: 'Radicle', timeout: NODE_START_TIMEOUT_MS });
      summary.startMs = Date.now() - startedAt;
      summary.registry = await registryEntry(window, 'radicle');
      expect(summary.registry.mode, 'the libradicle addon in this package is serving').toBe('embedded');
      expect(summary.registry.api).toBe('radapi://local');

      await navigateFromStartPage(window, probe.url);
      await expect
        .poll(async () => (await activeHref(window)) === probe.url && (await evalInActiveWebview(window, 'typeof window.radicle?.getIdentity')) === 'function', {
          message: 'the probe page must load with window.radicle injected',
          timeout: PAGE_TIMEOUT_MS,
        })
        .toBe(true);
      summary.access = await providerCallWithConsent(window, 'requestAccess');
      summary.identityCall = await providerCallWithConsent(window, 'getIdentity');
      const identity = summary.identityCall.value;
      const logFile = path.join(dirs.userData, 'logs', 'main.log');
      const logged = /\[Radicle\] Embedded node started: (\S+)/.exec(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
      summary.loggedDid = logged ? logged[1] : null;
      record();
      expect(summary.access.error, 'access was granted').toBeUndefined();
      expect(summary.identityCall.error, 'getIdentity answered').toBeUndefined();
      expect(identity?.did, 'the identity is a did:key').toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
      expect(identity.did, 'the DID names the NID').toBe(`did:key:${identity.nid}`);
      expect(identity.did, 'and equals the DID the node reported when it started').toBe(summary.loggedDid);
      expect(identity.did, 'the native parser loaded the injected key').toBe(summary.injectedIdentity.did);
      expect(identity.alias, 'the aligned alias is preserved').toBe('gate5');

      // 2. The viewer: local and public-seed lists, then a public-seed repository.
      let connections = null;
      await expect
        .poll(
          async () => {
            connections = await window.evaluate(() => window.radicle.getConnections());
            return (connections?.reposCount ?? 0) >= 1;
          },
          { message: `the node must fetch rad:${defaultRid} from the public seeds`, timeout: DEFAULT_REPO_TIMEOUT_MS, intervals: [2_000, 5_000] }
        )
        .toBe(true);
      summary.connections = connections;

      const security = await watchSecurityReports(app);
      summary.watchedGuests = security.guests;
      let lists = null;
      await navigate(window, `rad://${ABSENT_RID}`);
      await expect
        .poll(
          async () => {
            lists = await viewerState(window);
            return Boolean(lists?.error && lists.localRids.length > 0 && lists.networkRids.length > 0);
          },
          { message: 'the viewer must list the local and the public-seed repositories', timeout: PAGE_TIMEOUT_MS, intervals: [500, 1_000] }
        )
        .toBe(true);
      summary.listPage = lists;
      record();
      expect(lists.href, 'the lists come from the internal viewer').toMatch(/\/pages\/rad-browser\.html\?/);
      expect(lists.localRids, 'the local list names the repository the node fetched').toContain(defaultRid);

      let repo = null;
      await navigate(window, `rad://${defaultRid}`);
      await expect
        .poll(
          async () => {
            repo = await viewerState(window);
            return Boolean(repo?.success && repo.treeRows > 0 && repo.repoName);
          },
          { message: `the viewer must render rad:${defaultRid} from local storage`, timeout: PAGE_TIMEOUT_MS, intervals: [500, 1_000] }
        )
        .toBe(true);
      // Let the readme and its images settle, so their reports are counted too.
      await window.waitForTimeout(5_000);
      summary.repoPage = await viewerState(window);
      summary.securityReports = JSON.parse(JSON.stringify(security.reports));
      // Positive control, after the reading above: an inline script inserted
      // into the same viewer page breaks its script-src, and the watcher must
      // report it, so the silence above is not a blind watcher.
      await evalInActiveWebview(
        window,
        "(() => { const s = document.createElement('script'); s.textContent = 'window.__cspControl = 1'; document.head.appendChild(s); return true; })()"
      );
      await expect
        .poll(() => security.reports.csp.length + security.reports.cspIssues.length, {
          message: 'the CSP watcher must report the control violation',
          timeout: 10_000,
        })
        .toBeGreaterThan(summary.securityReports.csp.length + summary.securityReports.cspIssues.length);
      summary.cspControl = {
        reports: security.reports.csp.slice(summary.securityReports.csp.length),
        issues: security.reports.cspIssues.length - summary.securityReports.cspIssues.length,
        executed: await evalInActiveWebview(window, 'window.__cspControl === 1'),
      };
      await security.stop();
      record();
      expect(summary.repoPage.href).toMatch(/\/pages\/rad-browser\.html\?/);
      expect(summary.securityReports.csp, 'no CSP violation in the viewer console').toEqual([]);
      expect(summary.securityReports.cspIssues, 'no CSP issue reported for the viewer').toEqual([]);
      expect(summary.cspControl.executed, 'the control script was refused').toBe(false);

      // 3. Shutdown and orphans.
      summary.helpersBeforeQuit = packagedHelpers(mainPid, resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));
      summary.notExercised = [
        'v2ray (dVPN) runs only with a dVPN connection, which this spec does not make',
        'the Radicle node is an addon in the main process and has no pid of its own',
      ];
      summary.quit = await quitCleanly(app, resourcesDir, 'after the Radicle viewer');
      session = null;
      await expectCleanExit();
      record();
    } finally {
      if (session) await closeApp(session.app, { timeout: 100_000 }).catch(() => {});
      await probe.close();
      record();
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
