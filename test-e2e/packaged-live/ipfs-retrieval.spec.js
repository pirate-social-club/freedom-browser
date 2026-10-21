// Installed IPFS retrieval through the bundled freedom-ipfs node
// (release-readiness acceptance, plan v3 step 5 item 6 and "The Swarm and IPFS
// retrieval sequence").
//
// It shows that the package's own native IPFS node served the content, not an
// external gateway: in external mode `serveNativeGatewayRequest` hands every
// request to that gateway (src/main/ipfs-manager.js). In order:
//   1. Backend identity. The registry must say mode `bundled` with backend
//      `freedom-ipfs`. The node runs in the main process (a worker thread,
//      src/main/ipfs/freedom-ipfs-native-node.js), so its facts come from the
//      launched main process's /proc entries: its open descriptor on
//      freedom-ipfs.sqlite3 must lie in the data directory the manager derives
//      from the FREEDOM_IPFS_DATA this spec passed (<FREEDOM_IPFS_DATA>/
//      freedom-ipfs, ipfs-manager.js getIpfsDataPath), and its maps must map
//      resources/freedom-ipfs-node/freedom_ipfs_native.node, the very inode on
//      disk, with the expected sha256.
//   2. Cold retrieval of pinned CID A through the address bar. The data
//      directories are created empty for this run and listed before launch,
//      so A is absent beforehand by construction. The document's bytes must
//      equal the pinned bytes. The node's own progress record
//      (`window.ipfs.getStatus().diagnostics.progress`) for A's request must
//      show `cache_miss` followed by `fetching_bitswap` or
//      `fetching_http_provider`, with no `cache_hit` before them. After the
//      stop, a copy of freedom-ipfs.sqlite3 (with its -wal and -shm) must hold a
//      `blocks` row keyed by A's binary CID.
//   3. Cold negative control with pinned CID B, never requested before. The
//      node is stopped through `window.ipfs.stop()`; the stop is complete once
//      the manager reports stopped and the registry entry is what
//      clearService leaves (mode `none`, null api and gateway). Then B is
//      requested twice, with the state read immediately before and after each:
//      through the address bar, which must land on the renderer's node-down
//      error page (src/renderer/lib/navigation.js isIpfsNodeUnavailable →
//      ERR_CONNECTION_REFUSED), and through a direct webview load, which
//      reaches the `ipfs:` handler and must answer exactly 503
//      {"code":503,"message":"freedom-ipfs node is not running"}
//      (ipfs-manager.js serveNativeGatewayRequest). No read may show an
//      external node or a new API URL.
//   4. Chromium's NetLog must show no request to a public Swarm or IPFS
//      gateway. Its limit: the NetLog does not see the native node's own
//      networking, which includes its HTTP providers (delegated-ipfs.dev
//      routing, trustless gateways reached with `fetching_http_provider`).
//      Its silence shows only that Chromium itself went to no public gateway;
//      the claim that the bundled node served the content rests on 1–3.
//   5. A clean quit with exit code 0, after which no process whose executable
//      lies under the package's resources survives. The IPFS node has no pid
//      of its own; the main process's exit covers it.
//
// Bounds: the node running within 5 minutes of launch (a run that never gets
// there fails as "not established" and is rerun, never counted), the
// retrieval within 3 minutes, the stop within 30 seconds.
//
//   FREEDOM_E2E_IPFS_RETRIEVAL_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//   FREEDOM_E2E_EVIDENCE_DIR=<dir> \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/ipfs-retrieval.spec.js

const fs = require('fs');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { isPackagedRun } = require('../packaged-launch');
const { closeApp } = require('../close-app');
const { watchProcessExit } = require('../live-fixtures');
const {
  NODES_OFF,
  installedResourcesDir,
  anyPackagedHelpers,
  packagedHelpers,
  quitCleanly,
  tcpListeners,
  openFiles,
  mappedFiles,
  expectedNativeDigests,
  sha256,
  sha256File,
  pinnedReferences,
  cidV1Bytes,
  makeScratchRoot,
  listScratch,
  launchInstalled,
  evidenceDir,
  writeJson,
  waitForNodeToSettle,
  readNodeState,
  isClearedState,
  navigate,
  navigateFromStartPage,
  loadInActiveWebview,
  waitForErrorPage,
  watchDocuments,
  describeDocument,
  copySqlite,
  scanNetlogForGateways,
  progressItemsFor,
  phaseOrderEvidence,
} = require('./installed-acceptance');

const ENABLED = process.env.FREEDOM_E2E_IPFS_RETRIEVAL_LIVE === '1';

const RUNNING_TIMEOUT_MS = 5 * 60_000;
const RETRIEVAL_TIMEOUT_MS = 3 * 60_000;
const STOP_TIMEOUT_MS = 30_000;
const ANT_DEFAULT_PORT = 1633;
const NOT_RUNNING_BODY = JSON.stringify({ code: 503, message: 'freedom-ipfs node is not running' });

// Collect every distinct item the native node's progress snapshot reports,
// in arrival order, until stop() is called. The snapshot is a bounded view, so
// it is polled throughout the retrieval rather than read once afterwards.
function collectProgress(window) {
  const items = [];
  const seen = new Set();
  let running = true;
  let polls = 0;
  let errors = 0;
  const loop = (async () => {
    while (running) {
      try {
        const status = await window.evaluate(() => window.ipfs.getStatus());
        polls += 1;
        const snapshot = JSON.parse(status?.diagnostics?.progress || '{}');
        for (const [list, entries] of Object.entries(snapshot)) {
          if (!Array.isArray(entries)) continue;
          for (const item of entries) {
            const key = `${list}:${JSON.stringify(item)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ list, seenAt: Date.now(), item });
          }
        }
      } catch {
        errors += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  return {
    items,
    stop: async () => {
      running = false;
      await loop;
      return { polls, errors };
    },
  };
}

test.describe('installed IPFS retrieval', () => {
  test.skip(!ENABLED, 'set FREEDOM_E2E_IPFS_RETRIEVAL_LIVE=1 to retrieve pinned IPFS content over the network');
  test.skip(ENABLED && !isPackagedRun(), 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary');

  test('the bundled freedom-ipfs node serves a pinned CID cold and refuses it once stopped', async () => {
    test.setTimeout(15 * 60_000);
    const { A, B } = pinnedReferences().ipfs;
    const digests = expectedNativeDigests();
    const resourcesDir = installedResourcesDir();
    const evidence = evidenceDir('freedom-ipfs-retrieval-');
    const netlog = path.join(evidence, 'netlog.json');
    const dirs = makeScratchRoot('freedom-ipfs-retrieval-');
    const nodeDataDir = path.join(dirs.ipfs, 'freedom-ipfs');
    const summary = { references: { A: A.cid, B: B.cid }, digestSource: digests.source };
    const record = () => writeJson(evidence, 'summary.json', summary);

    summary.port1633Listeners = tcpListeners(ANT_DEFAULT_PORT);
    expect(summary.port1633Listeners, `something already listens on TCP ${ANT_DEFAULT_PORT}; the test profile would reuse it`).toEqual([]);
    expect(anyPackagedHelpers(resourcesDir), 'packaged helpers already running before launch').toEqual([]);
    summary.scratchBeforeLaunch = listScratch(dirs);
    expect(summary.scratchBeforeLaunch.ant, 'Ant data directory empty before launch').toEqual([]);
    expect(summary.scratchBeforeLaunch.ipfs, 'IPFS data directory empty before launch').toEqual([]);

    let session = null;
    try {
      const launchedAt = Date.now();
      session = await launchInstalled(dirs, {
        settings: { ...NODES_OFF, startIpfsAtLaunch: true },
        args: [`--log-net-log=${netlog}`],
      });
      const { app, window } = session;
      const mainPid = app.process().pid;
      const expectCleanExit = watchProcessExit(app, { timeout: 100_000 });
      summary.mainPid = mainPid;

      // 1. Backend identity.
      let settled = null;
      try {
        settled = await waitForNodeToSettle(window, 'ipfs', { label: 'native IPFS', timeout: RUNNING_TIMEOUT_MS });
      } catch (error) {
        throw new Error(
          `not established: the native IPFS node did not settle within ${RUNNING_TIMEOUT_MS / 60_000} minutes ` +
            `of launch. This run proves nothing either way; rerun it.\n${error.message}`,
          { cause: error }
        );
      }
      const atStart = await readNodeState(window, 'ipfs');
      summary.stateAtStart = { ...atStart, msAfterLaunch: Date.now() - launchedAt };
      expect(settled.status, `native IPFS did not start: ${settled.error || 'no error reported'}`).toBe('running');
      expect(atStart.mode, `the registry must name the bundled node, not "${atStart.mode}"`).toBe('bundled');
      expect(atStart.backend, 'the bundled node is the freedom-ipfs addon').toBe('freedom-ipfs');

      const stores = openFiles(mainPid).filter((file) => path.basename(file) === 'freedom-ipfs.sqlite3');
      const addonPath = path.join(resourcesDir, 'freedom-ipfs-node', 'freedom_ipfs_native.node');
      const mapped = mappedFiles(mainPid, 'freedom_ipfs_native.node');
      const onDisk = fs.statSync(addonPath);
      summary.identity = {
        storeDescriptors: [...new Set(stores)],
        expectedStoreDir: nodeDataDir,
        mappedAddons: mapped,
        addonPath,
        addonInode: onDisk.ino,
        addonSha256: sha256File(addonPath),
        expectedAddonSha256: digests.ipfsAddon,
      };
      record();
      expect(summary.identity.storeDescriptors.length, 'the main process holds freedom-ipfs.sqlite3 open').toBeGreaterThan(0);
      for (const file of summary.identity.storeDescriptors) {
        expect(path.dirname(file), 'the node store lies in the data directory derived from FREEDOM_IPFS_DATA').toBe(nodeDataDir);
      }
      expect(mapped.map((entry) => entry.path), "the main process maps the package's own addon, and only that").toEqual([addonPath]);
      expect(mapped[0].inode, 'the mapped addon is the inode on disk').toBe(onDisk.ino);
      expect(summary.identity.addonSha256, 'the mapped addon has the expected sha256').toBe(digests.ipfsAddon);
      summary.helpersAtStart = packagedHelpers(mainPid, resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));

      // 2. Cold retrieval of A through the address bar.
      const aUrl = `ipfs://${A.cid}`;
      const aDocs = await watchDocuments(app, (url) => url.startsWith(aUrl));
      const progress = collectProgress(window);
      const retrievalStart = Date.now();
      let aDoc;
      try {
        await navigateFromStartPage(window, aUrl);
        aDoc = await aDocs.settled((doc) => doc.status !== undefined && !doc.failedAt, RETRIEVAL_TIMEOUT_MS);
        await window.waitForTimeout(1_000);
      } finally {
        summary.progressPolls = await progress.stop();
        await aDocs.stop();
      }
      const aItems = progressItemsFor(progress.items, A.cid);
      summary.retrievalA = {
        ...describeDocument(aDoc),
        msAfterNavigation: aDoc.finishedAt - retrievalStart,
        documents: aDocs.documents.map(describeDocument),
      };
      summary.progressA = { items: aItems, order: phaseOrderEvidence(aItems) };
      writeJson(evidence, 'ipfs-progress.json', progress.items);
      record();
      expect(aDoc.status, `${aUrl} answered`).toBe(200);
      expect(aDoc.body, `${aUrl} body read (${aDoc.bodyError || ''})`).toBeTruthy();
      expect(aDoc.body.length, 'A has the pinned length').toBe(A.expected.length);
      expect(sha256(aDoc.body), 'A has the pinned sha256').toBe(A.expected.sha256);
      expect(summary.retrievalA.msAfterNavigation, 'A was retrieved within the bound').toBeLessThanOrEqual(RETRIEVAL_TIMEOUT_MS);
      // Soft, so that a run which fails here still carries out and records
      // the stop, the negative control, the node store, the NetLog and the
      // quit. The test fails all the same.
      expect.soft(summary.progressA.order.cacheMissAt, "the node reported a cache miss for A's request").not.toBeNull();
      expect.soft(summary.progressA.order.fetchAt, 'and a network fetch after it').not.toBeNull();
      expect.soft(summary.progressA.order.cacheHitBeforeFetch, 'no cache hit before the fetch').toBe(false);

      // 3. Stop through the app's own path, and wait for it to finish.
      summary.beforeStop = await readNodeState(window, 'ipfs');
      const stopStart = Date.now();
      summary.stopResult = await window.evaluate(() => window.ipfs.stop());
      let afterStop = null;
      await expect
        .poll(
          async () => {
            afterStop = await readNodeState(window, 'ipfs');
            return afterStop.status === 'stopped' && isClearedState(afterStop);
          },
          { message: 'the node reports stopped and the registry is cleared', timeout: STOP_TIMEOUT_MS, intervals: [250, 500] }
        )
        .toBe(true);
      summary.stop = {
        ms: Date.now() - stopStart,
        state: afterStop,
        storeDescriptorsAfter: openFiles(mainPid).filter((file) => path.basename(file).startsWith('freedom-ipfs.sqlite3')),
      };
      record();
      expect(summary.stop.ms, 'the stop finished within the bound').toBeLessThanOrEqual(STOP_TIMEOUT_MS);

      // Node-store evidence, from a copy taken after the clean stop.
      const store = copySqlite(path.join(nodeDataDir, 'freedom-ipfs.sqlite3'), path.join(evidence, 'node-store'));
      try {
        const lookup = store.db.prepare('SELECT hex(cid) AS cid, codec, size, inserted_at FROM blocks WHERE cid = ?');
        summary.nodeStore = {
          copied: store.copied,
          blocks: store.db.prepare('SELECT COUNT(*) AS n FROM blocks').get().n,
          blockA: lookup.get(cidV1Bytes(A.cid)) ?? null,
          blockB: lookup.get(cidV1Bytes(B.cid)) ?? null,
        };
      } finally {
        store.db.close();
      }
      record();
      expect(summary.nodeStore.blockA, "freedom-ipfs.sqlite3 holds a block keyed by A's binary CID").not.toBeNull();
      expect(summary.nodeStore.blockB, 'and none for B').toBeNull();

      // Cold negative control: B through the address bar, then a direct load.
      const bUrl = `ipfs://${B.cid}`;
      const bDocs = await watchDocuments(app, (url) => url.startsWith(bUrl));
      const reads = [];
      reads.push({ phase: 'before the address-bar request', ...(await readNodeState(window, 'ipfs')) });
      await navigate(window, bUrl);
      summary.addressBarB = await waitForErrorPage(
        window,
        (params) => params.error === 'ERR_CONNECTION_REFUSED' && (params.url || '').startsWith(bUrl),
        { message: `${bUrl} from the address bar must land on the node-down error page` }
      );
      reads.push({ phase: 'after the address-bar request', ...(await readNodeState(window, 'ipfs')) });
      summary.addressBarDocumentsB = bDocs.documents.map(describeDocument);

      reads.push({ phase: 'before the direct webview load', ...(await readNodeState(window, 'ipfs')) });
      await loadInActiveWebview(window, bUrl);
      const direct = await bDocs.settled((doc) => doc.status !== undefined || doc.failedAt, 60_000);
      reads.push({ phase: 'after the direct webview load', ...(await readNodeState(window, 'ipfs')) });
      await bDocs.stop();
      summary.directB = { ...describeDocument(direct), body: direct.body ? direct.body.toString('utf8') : null };
      summary.negativeControlReads = reads;
      summary.documentsB = bDocs.documents.map(describeDocument);
      record();

      expect(summary.addressBarB.protocol, 'the error page is the IPFS node-down page').toBe('ipfs');
      expect(summary.addressBarDocumentsB, 'the address bar sent no request for B to the handler').toEqual([]);
      expect(direct.status, `${bUrl} loaded directly answers 503`).toBe(503);
      expect(summary.directB.body, 'with exactly the not-running body').toBe(NOT_RUNNING_BODY);
      expect(bDocs.documents.filter((doc) => doc.status >= 200 && doc.status < 300), 'no request for B succeeded').toEqual([]);
      for (const read of reads) {
        expect(isClearedState(read), `the registry stays cleared ${read.phase}: ${JSON.stringify(read)}`).toBe(true);
        expect(['external', 'reused'], `no external node ${read.phase}`).not.toContain(read.mode);
        expect(read.status, `the node stays stopped ${read.phase}`).toBe('stopped');
      }

      // 5. Shutdown and orphans.
      summary.helpersBeforeQuit = packagedHelpers(mainPid, resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));
      summary.notExercised = [
        'v2ray (dVPN) runs only with a dVPN connection, which this spec does not make',
        'the IPFS node is a worker thread in the main process and has no pid of its own',
      ];
      summary.quit = await quitCleanly(app, resourcesDir, 'after IPFS retrieval');
      session = null;
      await expectCleanExit();
      record();

      // 4. NetLog, written at quit.
      summary.netlog = {
        ...scanNetlogForGateways(netlog, [A.cid, B.cid]),
        limit:
          "Chromium's NetLog does not record the native IPFS node's own networking, including its HTTP providers and delegated routing. Its silence shows only that Chromium itself went to no public gateway.",
      };
      record();
      expect(summary.netlog.requests, 'the NetLog recorded requests').toBeGreaterThan(0);
      expect(summary.netlog.gatewayRequests, 'Chromium made no request to a public Swarm or IPFS gateway').toEqual([]);
    } finally {
      if (session) await closeApp(session.app, { timeout: 100_000 }).catch(() => {});
      record();
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
