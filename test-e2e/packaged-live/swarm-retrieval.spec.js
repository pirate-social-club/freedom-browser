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
//   5. A clean quit with antd running, then no survivor. Once the negative
//      control is complete, Ant is started again through `window.ant.start()`;
//      it must come back bundled on the same API URL with /readiness 200 within
//      the bound, and its new pid must pass the same identity checks as in 1.
//      The app then quits with exit code 0, antd must have been running at the
//      quit, and afterwards no process whose executable lies under the
//      package's resources may survive, that antd's pid included. Restarting
//      after the control does not touch it: every request for B and every read
//      around them is already done. The helpers that really ran are recorded.
//
// Bounds: /readiness 200 within 5 minutes of launch (and of the restart), the
// retrieval within 3 minutes, the stop within 30 seconds. A run whose Ant never
// reaches readiness fails as "not established": rerun it; it never counts as a
// pass.
//
// Expected digests come from scripts/linux-native-inventory.json at the commit
// under test. FREEDOM_EXPECTED_NATIVE_DIGESTS may name another JSON file only in
// a calibration run against a baseline (FREEDOM_E2E_CALIBRATION=1); set without
// that flag it fails at once, and acceptance mode (FREEDOM_E2E_ACCEPTANCE=1)
// refuses it (installed-acceptance.js nativeDigestSource). In acceptance mode a
// missing live flag or executable fails instead of skipping. The pinned
// references and their provenance are in pinned-references.json.
//
//   FREEDOM_E2E_SWARM_RETRIEVAL_LIVE=1 FREEDOM_E2E_EXECUTABLE=/opt/Freedom/freedom \
//   FREEDOM_E2E_EVIDENCE_DIR=<dir> \
//     npx playwright test --project=packaged-live test-e2e/packaged-live/swarm-retrieval.spec.js

const fs = require('fs');
const path = require('path');

const { test, expect } = require('@playwright/test');
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
  gateLiveSpec,
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

// The process behind the registry's API port, from /proc: the listening
// sockets matched to pids through /proc/net/tcp and /proc/<pid>/fd, and the one
// holder's parent, executable, sha256 and configured data directory.
function antdFacts(port) {
  const listeners = tcpListeners(port);
  const holders = [...new Set(listeners.flatMap((listener) => pidsHoldingSocket(listener.inode)))];
  const facts = { port, listeners: listeners.length, holders };
  if (holders.length !== 1) return facts;
  const pid = holders[0];
  const antd = processInfo(pid);
  const configArg = antd?.cmdline.find((arg) => arg.startsWith('--config='));
  const configPath = configArg ? configArg.slice('--config='.length) : null;
  return {
    ...facts,
    pid,
    ppid: antd?.ppid ?? null,
    exe: antd?.exe ?? null,
    sha256: sha256File(`/proc/${pid}/exe`),
    configPath,
    dataDir: configPath ? antConfigDataDir(configPath) : null,
  };
}

// Those facts against the launched main process, the package's own binary and
// its expected sha256, and the data directory this run passed.
function expectBundledAntd(facts, { mainPid, resourcesDir, expectedSha256, dataDir, phase }) {
  expect(facts.listeners, `a socket listens on the registry's API port ${facts.port} (${phase})`).toBeGreaterThan(0);
  expect(facts.holders.length, `exactly one process holds the listening socket on ${facts.port} (${phase}): ${facts.holders}`).toBe(1);
  expect(facts.ppid, `antd is a child of the launched main process (${phase})`).toBe(mainPid);
  expect(facts.exe, `antd runs the package's own binary (${phase})`).toBe(path.join(resourcesDir, 'ant-bin', 'antd'));
  expect(facts.sha256, `the running antd has the expected sha256 (${phase})`).toBe(expectedSha256);
  expect(facts.configPath, `antd was started with --config= (${phase})`).not.toBeNull();
  expect(facts.dataDir, `antd's data-dir is the FREEDOM_ANT_DATA this run passed (${phase})`).toBe(dataDir);
}

test.describe('installed Swarm retrieval', () => {
  gateLiveSpec(test, { flag: 'FREEDOM_E2E_SWARM_RETRIEVAL_LIVE', purpose: 'to retrieve pinned Swarm content over the network' });

  test('the bundled Ant serves pinned content cold and refuses it once stopped', async () => {
    test.setTimeout(15 * 60_000);
    const { A, B } = pinnedReferences().swarm;
    const digests = expectedNativeDigests();
    const resourcesDir = installedResourcesDir();
    const evidence = evidenceDir('freedom-swarm-retrieval-');
    const netlog = path.join(evidence, 'netlog.json');
    const dirs = makeScratchRoot('freedom-swarm-retrieval-');
    const summary = {
      references: { A: A.reference, B: B.reference },
      digestSource: digests.source,
      digestSourceKind: digests.kind,
      calibration: digests.calibration,
      acceptance: digests.acceptance,
    };
    const record = () => writeJson(evidence, 'summary.json', summary);
    if (digests.calibration) {
      test.info().annotations.push({ type: 'calibration', description: `expected native digests from ${digests.source}` });
    }
    if (digests.acceptance) expect(digests.kind, 'acceptance takes its digests from the inventory').toBe('inventory');

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

      const expected = { mainPid, resourcesDir, expectedSha256: digests.antd, dataDir: dirs.ant };
      summary.antd = { ...antdFacts(port), expectedSha256: digests.antd, expectedDataDir: dirs.ant };
      record();
      expectBundledAntd(summary.antd, { ...expected, phase: 'at start' });
      const antPid = summary.antd.pid;
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

      // 3. Stop through the app's own path, and wait for it to finish. Just
      // before it, the backend must still be the one identified at start.
      summary.beforeStop = await readNodeState(window, 'ant');
      summary.beforeStopListeners = [...new Set(tcpListeners(port).flatMap((listener) => pidsHoldingSocket(listener.inode)))];
      record();
      expect(summary.beforeStop.mode, 'Ant is still the bundled node before the stop').toBe('bundled');
      expect(summary.beforeStop.api, 'on the API URL it started with').toBe(atStart.api);
      expect(summary.beforeStopListeners, 'served by the antd identified at start').toEqual([antPid]);
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

      // 5. Shutdown and orphans, with antd running. The control is complete,
      // so Ant is started again for the quit to have to stop it.
      const restartStart = Date.now();
      summary.restartResult = await window.evaluate(() => window.ant.start());
      const restarted = await waitForNodeToSettle(window, 'ant', { label: 'Ant (restart)', timeout: READINESS_TIMEOUT_MS });
      const atRestart = await readNodeState(window, 'ant');
      summary.restart = { state: atRestart, settledMs: Date.now() - restartStart };
      record();
      expect(restarted.status, `Ant did not start again: ${restarted.error || 'no error reported'}`).toBe('running');
      expect(atRestart.mode, `the restarted node is the package's own antd, not "${atRestart.mode}"`).toBe('bundled');
      expect(atRestart.api, 'on the same API URL').toBe(atStart.api);
      summary.restart.antd = antdFacts(port);
      record();
      expectBundledAntd(summary.restart.antd, { ...expected, phase: 'after the restart' });
      expect(summary.restart.antd.pid, 'the restart spawned a new antd').not.toBe(antPid);
      const restartReadiness = await waitForReadiness(atRestart.api, restartStart + READINESS_TIMEOUT_MS);
      summary.restart.readiness = {
        ok: restartReadiness.ok,
        last: restartReadiness.last,
        msAfterRestart: restartReadiness.ok ? restartReadiness.at - restartStart : null,
      };
      record();
      if (!restartReadiness.ok) {
        throw new Error(
          `not established: the restarted Ant's /readiness did not answer 200 within ${READINESS_TIMEOUT_MS / 60_000} ` +
            `minutes (last: ${restartReadiness.last}). This run proves nothing either way; rerun it.`
        );
      }

      summary.helpersBeforeQuit = packagedHelpers(mainPid, resourcesDir).map((proc) => ({ pid: proc.pid, exe: proc.exe }));
      summary.notExercised = ['v2ray (dVPN) runs only with a dVPN connection, which this spec does not make'];
      summary.quit = await quitCleanly(app, resourcesDir, 'after Swarm retrieval', {
        requiredHelpers: ['antd'],
        label: 'antd and the other helpers',
      });
      session = null;
      await expectCleanExit();
      summary.quit.restartedAntdRunning = isRunningPid(summary.restart.antd.pid);
      record();
      expect(summary.quit.helpers.map((proc) => proc.pid), 'the restarted antd was running at the quit').toContain(summary.restart.antd.pid);
      expect(summary.quit.restartedAntdRunning, 'the restarted antd did not survive the quit').toBe(false);

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
