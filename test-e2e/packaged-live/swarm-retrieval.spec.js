// Installed Swarm retrieval through the bundled Ant node (release-readiness
// acceptance, plan v3 step 5 item 5 and "The Swarm and IPFS retrieval
// sequence").
//
// It shows that the installed package's own antd served the content, not some
// other node: `bzz:` uses whatever API address the service registry holds, and
// the scratch test profile (metadata null, src/main/profile-resolver.js) reuses
// anything answering on port 1633 (src/main/ant-manager.js startAnt,
// detectExistingDaemon). In order:
//   1. Backend identity. The registry must say `bundled` (anything `external`,
//      `reused` or `disabled` fails at once). The socket listening on the
//      registry's API port is matched to a pid through /proc/net/tcp and
//      /proc/<pid>/fd; that pid's parent must be the launched main process,
//      its executable resources/ant-bin/antd with the expected sha256, and the
//      `data-dir:` of the config named on its command line the directory this
//      spec passed in FREEDOM_ANT_DATA. The config's `password:` line is never
//      read into anything that is logged or kept.
//   2. Cold retrieval of pinned reference A through the address bar, once Ant's
//      /readiness answers 200. The data directories are created empty for this
//      run and listed before launch, so A is absent beforehand by
//      construction. The document (A's pinned path, an image that loads
//      nothing else; see pinned-references.json for why not the index page)
//      must be the pinned bytes. After
//      the stop below, a copy of chunks.sqlite (with its -wal and -shm) must
//      hold A's root chunk, whose address is the reference itself.
//   3. Cold negative control with pinned reference B, never requested before.
//      Ant is stopped through `window.ant.stop()`; the stop is complete once
//      antd's pid has exited, its port is closed, and the registry entry is
//      what clearService leaves (mode `none`, null api and gateway). Then B is
//      requested twice, with the state read immediately before and after each:
//      through the address bar, which must land on the renderer's node-down
//      error page (src/renderer/lib/navigation.js, startBzzNavigationWithProbe
//      → ERR_CONNECTION_REFUSED), and through a direct webview load, which
//      reaches the `bzz:` handler and must answer exactly 503
//      {"code":503,"message":"Swarm node is not ready"}
//      (src/main/swarm/bzz-protocol.js buildGatewayUrl). No read may show an
//      external or reused node or a new API URL.
//   4. Chromium's NetLog must show no request to a public Swarm or IPFS
//      gateway. Its limit: the NetLog does not see antd's own networking, the
//      `bzz:` handler's request to the local Ant API (Node's fetch,
//      bzz-protocol.js handleBzzRequest), or the swarm probe's HEAD (also
//      Node's fetch). Its silence shows only that Chromium itself went to no
//      public gateway; the claim that the bundled node served the content rests
//      on 1–3.
//   5. A clean quit with exit code 0, after which no process whose executable
//      lies under the package's resources survives. The helpers that really
//      ran are recorded: antd until the stop, and whatever HNS started.
//
// Bounds: /readiness 200 within 5 minutes of launch, the retrieval within 3
// minutes, the stop within 30 seconds. A run whose Ant never reaches readiness
// fails as "not established": rerun it; it never counts as a pass.
//
// Expected digests come from scripts/linux-native-inventory.json at the commit
// under test, or from the JSON file FREEDOM_EXPECTED_NATIVE_DIGESTS names
// (installed-acceptance.js expectedNativeDigests). The pinned references and
// their provenance are in pinned-references.json.
//
//   FREEDOM_E2E_SWARM_RETRIEVAL_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//   FREEDOM_E2E_EVIDENCE_DIR=<dir> \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/swarm-retrieval.spec.js

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
  processInfo,
  isRunningPid,
  tcpListeners,
  pidsHoldingSocket,
  canConnect,
  expectedNativeDigests,
  sha256,
  sha256File,
  pinnedReferences,
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
} = require('./installed-acceptance');

const ENABLED = process.env.FREEDOM_E2E_SWARM_RETRIEVAL_LIVE === '1';

const READINESS_TIMEOUT_MS = 5 * 60_000;
const RETRIEVAL_TIMEOUT_MS = 3 * 60_000;
const STOP_TIMEOUT_MS = 30_000;
// The ecosystem default the scratch profile reuses (service-registry.js DEFAULTS.ant.apiPort).
const ANT_DEFAULT_PORT = 1633;
const NOT_READY_BODY = JSON.stringify({ code: 503, message: 'Swarm node is not ready' });

// Ant's `/readiness` until it answers 200 or `deadline` passes.
async function waitForReadiness(api, deadline) {
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${api}/readiness`, { signal: AbortSignal.timeout(5_000) });
      last = response.status;
      if (response.status === 200) return { ok: true, at: Date.now(), last };
    } catch (error) {
      last = `request failed: ${error.message}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { ok: false, last };
}

// The `data-dir:` value of an antd config. Only that line is kept: the file
// also holds the node's `password:`, which must never reach a log or evidence.
function antConfigDataDir(configPath) {
  const match = /^data-dir:\s*(.+?)\s*$/m.exec(fs.readFileSync(configPath, 'utf8'));
  return match ? match[1] : null;
}

test.describe('installed Swarm retrieval', () => {
  test.skip(!ENABLED, 'set FREEDOM_E2E_SWARM_RETRIEVAL_LIVE=1 to retrieve pinned Swarm content over the network');
  test.skip(ENABLED && !isPackagedRun(), 'set FREEDOM_E2E_EXECUTABLE to the installed Freedom binary');

  test('the bundled Ant serves pinned content cold and refuses it once stopped', async () => {
    test.setTimeout(15 * 60_000);
    const { A, B } = pinnedReferences().swarm;
    const digests = expectedNativeDigests();
    const resourcesDir = installedResourcesDir();
    const evidence = evidenceDir('freedom-swarm-retrieval-');
    const netlog = path.join(evidence, 'netlog.json');
    const dirs = makeScratchRoot('freedom-swarm-retrieval-');
    const summary = { references: { A: A.reference, B: B.reference }, digestSource: digests.source };
    const record = () => writeJson(evidence, 'summary.json', summary);

    // Preconditions: nothing on Ant's default port (the scratch profile would
    // reuse it), nothing from the package already running, empty data dirs.
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
        settings: { ...NODES_OFF, startAntAtLaunch: true },
        args: [`--log-net-log=${netlog}`],
      });
      const { app, window } = session;
      const mainPid = app.process().pid;
      const expectCleanExit = watchProcessExit(app, { timeout: 100_000 });
      summary.mainPid = mainPid;

      // 1. Backend identity.
      const settled = await waitForNodeToSettle(window, 'ant', { label: 'Ant', timeout: READINESS_TIMEOUT_MS });
      const atStart = await readNodeState(window, 'ant');
      summary.stateAtStart = atStart;
      expect(settled.status, `Ant did not start: ${settled.error || 'no error reported'}`).toBe('running');
      expect(atStart.mode, `the registry must name the package's own antd, not "${atStart.mode}"`).toBe('bundled');
      const api = new URL(atStart.api);
      expect(api.protocol).toBe('http:');
      expect(api.hostname).toBe('127.0.0.1');
      expect(atStart.gateway).toBe(atStart.api);
      const port = Number(api.port);

      const listeners = tcpListeners(port);
      const holders = [...new Set(listeners.flatMap((listener) => pidsHoldingSocket(listener.inode)))];
      expect(listeners.length, `a socket listens on the registry's API port ${port}`).toBeGreaterThan(0);
      expect(holders.length, `exactly one process holds the listening socket on ${port}: ${holders}`).toBe(1);
      const antPid = holders[0];
      const antd = processInfo(antPid);
      const configArg = antd.cmdline.find((arg) => arg.startsWith('--config='));
      const configPath = configArg ? configArg.slice('--config='.length) : null;
      summary.antd = {
        pid: antPid,
        ppid: antd.ppid,
        exe: antd.exe,
        sha256: sha256File(`/proc/${antPid}/exe`),
        expectedSha256: digests.antd,
        configPath,
        dataDir: configPath ? antConfigDataDir(configPath) : null,
        expectedDataDir: dirs.ant,
      };
      record();
      expect(antd.ppid, 'antd is a child of the launched main process').toBe(mainPid);
      expect(antd.exe, "antd runs the package's own binary").toBe(path.join(resourcesDir, 'ant-bin', 'antd'));
      expect(summary.antd.sha256, 'the running antd has the expected sha256').toBe(digests.antd);
      expect(configPath, 'antd was started with --config=').not.toBeNull();
      expect(summary.antd.dataDir, "antd's data-dir is the FREEDOM_ANT_DATA this run passed").toBe(dirs.ant);
      summary.helpersAtStart = packagedHelpers(mainPid, resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));
      expect(summary.helpersAtStart.map((proc) => proc.pid)).toContain(antPid);

      const readiness = await waitForReadiness(atStart.api, launchedAt + READINESS_TIMEOUT_MS);
      summary.readiness = { ok: readiness.ok, last: readiness.last, msAfterLaunch: readiness.ok ? readiness.at - launchedAt : null };
      record();
      if (!readiness.ok) {
        throw new Error(
          `not established: Ant's /readiness did not answer 200 within ${READINESS_TIMEOUT_MS / 60_000} minutes ` +
            `of launch (last: ${readiness.last}). This run proves nothing either way; rerun it.`
        );
      }

      // 2. Cold retrieval of A through the address bar.
      const aUrl = `bzz://${A.reference}${A.expected.path}`;
      const aDocs = await watchDocuments(app, (url) => url.startsWith(`bzz://${A.reference}`));
      const retrievalStart = Date.now();
      await navigateFromStartPage(window, aUrl);
      const aDoc = await aDocs.settled((doc) => doc.status !== undefined && !doc.failedAt, RETRIEVAL_TIMEOUT_MS);
      await aDocs.stop();
      summary.retrievalA = {
        ...describeDocument(aDoc),
        msAfterNavigation: aDoc.finishedAt - retrievalStart,
        documents: aDocs.documents.map(describeDocument),
      };
      record();
      expect(aDoc.status, `${aUrl} answered`).toBe(200);
      expect(aDoc.body, `${aUrl} body read (${aDoc.bodyError || ''})`).toBeTruthy();
      expect(aDoc.body.length, 'A has the pinned length').toBe(A.expected.length);
      expect(sha256(aDoc.body), 'A has the pinned sha256').toBe(A.expected.sha256);
      expect(summary.retrievalA.msAfterNavigation, 'A was retrieved within the bound').toBeLessThanOrEqual(RETRIEVAL_TIMEOUT_MS);

      // 3. Stop through the app's own path, and wait for it to finish.
      summary.beforeStop = await readNodeState(window, 'ant');
      const stopStart = Date.now();
      summary.stopResult = await window.evaluate(() => window.ant.stop());
      let afterStop = null;
      await expect
        .poll(
          async () => {
            afterStop = await readNodeState(window, 'ant');
            return !isRunningPid(antPid) && tcpListeners(port).length === 0 && isClearedState(afterStop);
          },
          { message: 'antd has exited, its port is closed and the registry is cleared', timeout: STOP_TIMEOUT_MS, intervals: [250, 500] }
        )
        .toBe(true);
      summary.stop = { ms: Date.now() - stopStart, state: afterStop, portAcceptsConnections: await canConnect(port) };
      record();
      expect(summary.stop.ms, 'the stop finished within the bound').toBeLessThanOrEqual(STOP_TIMEOUT_MS);
      expect(summary.stop.portAcceptsConnections, `nothing accepts connections on ${port} after the stop`).toBe(false);

      // Node-store evidence, from a copy taken after the clean stop.
      const store = copySqlite(path.join(dirs.ant, 'chunks.sqlite'), path.join(evidence, 'node-store'));
      try {
        const lookup = store.db.prepare('SELECT hex(address) AS address, size, inserted_at FROM chunks WHERE address = ?');
        summary.nodeStore = {
          copied: store.copied,
          chunks: store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
          rootChunkA: lookup.get(Buffer.from(A.reference, 'hex')) ?? null,
          rootChunkB: lookup.get(Buffer.from(B.reference, 'hex')) ?? null,
        };
      } finally {
        store.db.close();
      }
      record();
      expect(summary.nodeStore.rootChunkA, "chunks.sqlite holds A's root chunk").not.toBeNull();
      expect(summary.nodeStore.rootChunkB, "chunks.sqlite holds nothing for B's root").toBeNull();

      // Cold negative control: B through the address bar, then a direct load.
      const bUrl = `bzz://${B.reference}`;
      const bDocs = await watchDocuments(app, (url) => url.startsWith(bUrl));
      const reads = [];
      reads.push({ phase: 'before the address-bar request', ...(await readNodeState(window, 'ant')) });
      await navigate(window, bUrl);
      summary.addressBarB = await waitForErrorPage(
        window,
        (params) => params.error === 'ERR_CONNECTION_REFUSED' && (params.url || '').startsWith(bUrl),
        { message: `${bUrl} from the address bar must land on the node-down error page` }
      );
      reads.push({ phase: 'after the address-bar request', ...(await readNodeState(window, 'ant')) });
      summary.addressBarDocumentsB = bDocs.documents.map(describeDocument);

      reads.push({ phase: 'before the direct webview load', ...(await readNodeState(window, 'ant')) });
      await loadInActiveWebview(window, bUrl);
      const direct = await bDocs.settled((doc) => doc.status !== undefined || doc.failedAt, 60_000);
      reads.push({ phase: 'after the direct webview load', ...(await readNodeState(window, 'ant')) });
      await bDocs.stop();
      summary.directB = { ...describeDocument(direct), body: direct.body ? direct.body.toString('utf8') : null };
      summary.negativeControlReads = reads;
      summary.documentsB = bDocs.documents.map(describeDocument);
      record();

      expect(summary.addressBarB.protocol, 'the error page is the Swarm node-down page').toBe('swarm');
      expect(summary.addressBarDocumentsB, 'the address bar sent no request for B to the handler').toEqual([]);
      expect(direct.status, `${bUrl} loaded directly answers 503`).toBe(503);
      expect(summary.directB.body, 'with exactly the not-ready body').toBe(NOT_READY_BODY);
      expect(bDocs.documents.filter((doc) => doc.status >= 200 && doc.status < 300), 'no request for B succeeded').toEqual([]);
      for (const read of reads) {
        expect(isClearedState(read), `the registry stays cleared ${read.phase}: ${JSON.stringify(read)}`).toBe(true);
        expect(['external', 'reused'], `no external or reused node ${read.phase}`).not.toContain(read.mode);
      }

      // 5. Shutdown and orphans.
      summary.helpersBeforeQuit = packagedHelpers(mainPid, resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));
      summary.notExercised = ['v2ray (dVPN) runs only with a dVPN connection, which this spec does not make'];
      summary.quit = await quitCleanly(app, resourcesDir, 'after Swarm retrieval');
      session = null;
      await expectCleanExit();
      record();

      // 4. NetLog, written at quit.
      summary.netlog = {
        ...scanNetlogForGateways(netlog, [A.reference, B.reference]),
        limit:
          "Chromium's NetLog does not record antd's own networking, the bzz: handler's request to the local Ant API (Node fetch), or the swarm probe's HEAD (Node fetch). Its silence shows only that Chromium itself went to no public gateway.",
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
