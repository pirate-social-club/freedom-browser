/**
 * Electron-hosted probe for `session-transport-proxy.test.js`.
 *
 * ENS resolution, its CCIP-Read gateways, the Colibri verifier's prover and RPC
 * traffic, and the chain-data router's RPC reads are dialled on the Electron
 * session of the window they are for (`src/main/browsing-transport.js`), so a
 * private window's lookups follow its own partition's proxy policy instead of
 * the default session's. The unit suites pin that wiring on fakes; only a real
 * main process shows Chromium actually routing each dial through the session
 * it was given. This probe drives the real `gateway-transport.js`, the real
 * quorum-leg provider from `ens-resolver.js`, the real Colibri worker host
 * and worker thread, the real CCIP-Read fetch and `session.fetch` (the Spaces
 * resolver's transport).
 *
 * It also sets the User-Agent up the way `src/main/index.js` does, before any
 * session exists, and the origin records the `User-Agent` header of every
 * request it is asked: that traffic inherits the session's User-Agent, so it
 * must carry plain Chrome's, not Electron's default with `freedom/` and
 * `Electron/` tokens.
 *
 * Nothing leaves the machine:
 *   - one HTTPS origin on 127.0.0.1 with the throwaway test certificate in
 *     `test/fixtures/ccip-gateway-tls/` (SAN `ccip.example.test`), trusted for
 *     that one name by a `setCertificateVerifyProc` on every session and
 *     refused (-3) for anything else;
 *   - `--host-resolver-rules` mapping only `ccip.example.test` to 127.0.0.1;
 *   - two SOCKS5 recorders, one per session, which record the host:port
 *     Chromium asked for and splice every tunnel to the local origin, whatever
 *     it named (the verifier's built-in public hosts included: they then fail
 *     the certificate check, here, without a byte leaving);
 *   - spellchecker languages cleared on every session, so no dictionary is
 *     fetched.
 * The origin attributes every TCP connection it accepts to the recorder whose
 * spliced upstream socket it came from, so a connection that came straight
 * from Chromium (no proxy) is seen as such.
 *
 * Sessions: A is the default session behind recorder A; B is an in-memory
 * `probe-private-<random>` partition behind recorder B; C points at a closed
 * local port; D is DIRECT, the control that shows a direct connection is
 * detected when there is one.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const HOST = 'ccip.example.test';

app.commandLine.appendSwitch('host-resolver-rules', `MAP ${HOST} 127.0.0.1`);
// As in src/main/index.js: the packaged Linux name, then the web User-Agent,
// before any session exists. The name puts the `freedom/<version>` token into
// Electron's default, which is kept for the report as the control.
app.setName('freedom');
const ELECTRON_USER_AGENT = app.userAgentFallback;
require('../../web-user-agent').applyWebUserAgent(app);
// The Jest wrapper owns the profile directory and removes it when this process
// and its GPU and Crashpad children are gone; a direct run makes its own.
const OWN_USER_DATA = !process.env.FREEDOM_PROBE_USER_DATA;
const PROBE_USER_DATA =
  process.env.FREEDOM_PROBE_USER_DATA ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-session-transport-probe-'));
app.setPath('userData', PROBE_USER_DATA);
// The probe isolates the session transport; HNS has its own installed acceptance.
fs.writeFileSync(path.join(PROBE_USER_DATA, 'settings.json'),
  JSON.stringify({ enableHnsIntegration: false }));
process.on('exit', () => {
  if (!OWN_USER_DATA) return;
  try {
    fs.rmSync(PROBE_USER_DATA, { recursive: true, force: true });
  } catch {
    /* cleaned up with the temp dir */
  }
});

// What the origin was asked, and on which TCP connection.
const originRequests = [];
const originConnections = [];
const hangRequests = [];
let hangClosed = 0;

function startOrigin() {
  const fixtures = path.join(__dirname, '../../../../test/fixtures/ccip-gateway-tls');
  return new Promise((resolve) => {
    const server = https.createServer(
      {
        key: fs.readFileSync(path.join(fixtures, 'ccip-gateway-test.key')),
        cert: fs.readFileSync(path.join(fixtures, 'ccip-gateway-test.crt')),
      },
      (req, res) => {
        const pathname = req.url.split('?')[0];
        const route = pathname.split('/')[1];
        originRequests.push({
          route,
          method: req.method,
          peerPort: req.socket.remotePort,
          userAgent: req.headers['user-agent'] ?? null,
        });
        if (route === 'x') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
          return;
        }
        if (route === 'ccip') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: '0x01' }));
          return;
        }
        if (route === 'rpc') {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const answer = (one) => ({ jsonrpc: '2.0', id: one.id, result: '0x1' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
          });
          return;
        }
        if (route === 'hang') {
          // Never answers. Its connection closing before an answer is the
          // client tearing the request down.
          hangRequests.push(pathname);
          res.on('close', () => {
            if (!res.writableEnded) hangClosed += 1;
          });
          return;
        }
        // The fake prover, and anything else: a fast, plain failure.
        res.writeHead(404);
        res.end();
      }
    );
    server.on('connection', (socket) => originConnections.push(socket.remotePort));
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Minimal SOCKS5 CONNECT server (as in the CCIP probe): records the destination
// Chromium asked for, splices the tunnel to the local origin whatever it
// named, and remembers the local port of each spliced upstream socket so the
// origin can tell which recorder a connection came through.
function startRecorder(originPort) {
  const recorder = { seen: [], upstreamPorts: new Set(), port: null };
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once('data', (request) => {
          const atyp = request[3];
          let host = '';
          let offset = 0;
          if (atyp === 0x03) {
            const len = request[4];
            host = request.subarray(5, 5 + len).toString('utf8');
            offset = 5 + len;
          } else if (atyp === 0x01) {
            host = Array.from(request.subarray(4, 8)).join('.');
            offset = 8;
          }
          const port = request.readUInt16BE(offset);
          recorder.seen.push(`${host}:${port}`);
          const upstream = net.connect(originPort, '127.0.0.1', () => {
            recorder.upstreamPorts.add(upstream.localPort);
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      recorder.port = server.address().port;
      resolve(recorder);
    });
  });
}

// A port nothing listens on: bound once, then released.
function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (predicate()) return true;
    await settle(25);
  }
  return predicate();
}

function within(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ value }), (err) => ({
      error: String(err && err.message).slice(0, 300),
      code: err && err.code,
    })),
    settle(ms).then(() => ({ timedOut: true })),
  ]);
}

async function main() {
  const originPort = await startOrigin();
  const recorderA = await startRecorder(originPort);
  const recorderB = await startRecorder(originPort);
  const unreachable = await closedPort();
  const origin = `https://${HOST}:${originPort}`;

  const A = session.defaultSession;
  const B = session.fromPartition(`probe-private-${crypto.randomUUID()}`);
  const C = session.fromPartition(`probe-unreachable-${crypto.randomUUID()}`);
  const D = session.fromPartition(`probe-direct-${crypto.randomUUID()}`);
  for (const ses of [A, B, C, D]) {
    ses.setSpellCheckerLanguages([]);
    // Only the fixture's own name; everything else keeps a refusal.
    ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === HOST ? 0 : -3));
  }
  await A.setProxy({ proxyRules: `socks5://127.0.0.1:${recorderA.port}` });
  await B.setProxy({ proxyRules: `socks5://127.0.0.1:${recorderB.port}` });
  await C.setProxy({ proxyRules: `socks5://127.0.0.1:${unreachable}` });
  await D.setProxy({ mode: 'direct' });

  // Loaded only now: the logger and settings read the probe's own userData.
  const { gatewayFetch } = require('../../ipfs/gateway-transport');
  const {
    requireBrowsingSession,
    retireBrowsingSession,
    runWithBrowsingSession,
  } = require('../../browsing-transport');
  const { runWithPrivateLogContext } = require('../../private/private-log-context');
  const { createEthereumProvider } = require('../../ens-resolver');
  const { ccipReadFetch } = require('../../ens/ccip-fetch');
  const host = require('../../ens/colibri-worker-host');
  host.resetForTest({ storageDir: path.join(PROBE_USER_DATA, 'colibri') });

  const via = (port) => {
    if (recorderA.upstreamPorts.has(port)) return 'A';
    if (recorderB.upstreamPorts.has(port)) return 'B';
    return 'direct';
  };
  const reset = async (...sessions) => {
    for (const ses of sessions) await ses.closeAllConnections();
    recorderA.seen.length = 0;
    recorderB.seen.length = 0;
    originRequests.length = 0;
    originConnections.length = 0;
  };
  const snapshot = () => ({
    recorderA: [...recorderA.seen],
    recorderB: [...recorderB.seen],
    originRoutes: originRequests.map((entry) => ({ route: entry.route, via: via(entry.peerPort) })),
    directConnections: originConnections.filter((port) => via(port) === 'direct').length,
    userAgents: originRequests.map((entry) => entry.userAgent),
  });
  const fetchOn = async (ses) => {
    const outcome = await within(
      gatewayFetch(`${origin}/x`, {}, { session: ses }).then(async (response) => ({
        status: response.status,
        body: await response.text(),
      })),
      10_000
    );
    return { ...outcome, ...snapshot() };
  };
  const results = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    originPort,
    userAgent: {
      electronDefault: ELECTRON_USER_AGENT,
      fallback: app.userAgentFallback,
      sessions: [A, B, C, D].map((ses) => ses.getUserAgent()),
    },
  };

  // ---- 1. gatewayFetch follows the session it is given --------------------
  await reset(A, B);
  results.fetchB = await fetchOn(B);
  await reset(A, B);
  results.fetchA = await fetchOn(A);

  // ---- 2. An unreachable proxy fails the dial; nothing goes DIRECT --------
  await reset(C);
  results.fetchC = await fetchOn(C);
  await reset(D);
  results.fetchDirectControl = await fetchOn(D);

  // ---- 3. The ENS quorum-leg provider dials on its captured session -------
  const chainIdOn = async (ses) => {
    const provider = runWithBrowsingSession(ses, () => createEthereumProvider(`${origin}/rpc`));
    try {
      return { ...(await within(provider.send('eth_chainId', []), 10_000)), ...snapshot() };
    } finally {
      provider.destroy();
    }
  };
  await reset(A, B);
  results.ensB = await chainIdOn(B);
  await reset(A, B);
  results.ensA = await chainIdOn(A);

  // ---- 4. The real Colibri worker's traffic goes out through the bridge ---
  await reset(A, B);
  const colibri = host.createClient({
    chainId: 1, proverUrl: `${origin}/prover`, zkProof: false, session: B,
  });
  const colibriOutcome = await within(
    colibri.request({ method: 'eth_blockNumber' }, { deadlineMs: 5_000 }),
    20_000
  );
  await waitFor(() => recorderB.seen.some((dest) => dest.startsWith(`${HOST}:`)), 5_000);
  results.colibriB = { ...colibriOutcome, ...snapshot() };
  colibri.destroy();

  // ---- 7. A CCIP-Read gateway and `session.fetch` on the private session --
  // A resolver names its own gateways, so this header reaches a host it picks.
  await reset(A, B);
  const ccip = await within(
    ccipReadFetch({ to: `0x${'11'.repeat(20)}` }, '0x1234', [`${origin}/ccip/{sender}/{data}`],
      undefined, { session: B }),
    10_000
  );
  results.ccipB = { ...ccip, ...snapshot() };
  // The Spaces resolver's relay requests (`spaces-resolver.js`, `resolverFor`).
  await reset(A, B);
  const sessionFetch = await within(
    B.fetch(`${origin}/x`).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    })),
    10_000
  );
  results.sessionFetchB = { ...sessionFetch, ...snapshot() };

  // ---- 6. A private caller without a session is refused, for real ---------
  results.privateWithoutSession = runWithPrivateLogContext(true, () => {
    try {
      requireBrowsingSession();
      return { threw: false };
    } catch (err) {
      return { threw: true, code: err.code };
    }
  });
  results.noContextIsDefault = requireBrowsingSession() === A;

  // ---- 5. Retiring B tears down its in-flight bridge fetch ----------------
  // Last, since B stays retired from here on.
  await reset(A, B);
  hangRequests.length = 0;
  hangClosed = 0;
  const hanging = host.createClient({
    chainId: 1, proverUrl: `${origin}/hang`, zkProof: false, session: B,
  });
  const hangingRequest = hanging.request({ method: 'eth_blockNumber' }, { deadlineMs: 30_000 });
  hangingRequest.catch(() => {});
  // Neither of these passes a signal of its own: only B's retirement, through
  // the shared transport, can end them.
  const plainFetch = within(gatewayFetch(`${origin}/hang`, {}, { session: B }), 15_000);
  const ensProvider = runWithBrowsingSession(B, () => createEthereumProvider(`${origin}/hang`));
  const ensLeg = within(ensProvider.send('eth_chainId', []), 15_000);
  const reachedHang = await waitFor(() => hangRequests.length >= 3, 15_000);
  await settle(200);
  const openBeforeRetire = hangRequests.length - hangClosed;
  const retiredAt = Date.now();
  retireBrowsingSession(B);
  const allClosed = await waitFor(() => hangClosed >= hangRequests.length, 5_000);
  results.retireB = {
    reachedHang,
    openBeforeRetire,
    hangRequests: hangRequests.length,
    hangClosed,
    allClosed,
    closeMs: Date.now() - retiredAt,
    plainFetch: await plainFetch,
    ensLeg: await ensLeg,
  };
  ensProvider.destroy();

  await reset(A);
  const refusedFetch = await within(gatewayFetch(`${origin}/x`, {}, { session: B }), 5_000);
  const refusedBridge = host.createClient({
    chainId: 1, proverUrl: `${origin}/prover`, zkProof: false, session: B,
  });
  const refusedBridgeOutcome = await within(
    refusedBridge.request({ method: 'eth_blockNumber' }, { deadlineMs: 5_000 }),
    10_000
  );
  results.afterRetireB = {
    fetch: refusedFetch,
    bridge: refusedBridgeOutcome,
    ...snapshot(),
  };
  hanging.destroy();
  refusedBridge.destroy();

  host.resetForTest();
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
