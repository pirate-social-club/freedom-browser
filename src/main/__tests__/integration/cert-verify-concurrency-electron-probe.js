/**
 * Electron-hosted probe for `cert-verify-concurrency.test.js`.
 *
 * Handshake browsing trusts a site's certificate only through the session's
 * `setCertificateVerifyProc` (`src/main/hns-manager.js`), after DANE. Before
 * Electron 44.9.0 that verifier was occasionally not applied to a request
 * issued concurrently with the first request to a host (electron#55046): the
 * request fell back to Chromium's default verification instead. This probe
 * opens several fresh hosts at once, each with a burst of concurrent first
 * requests, on an in-memory session whose verifier is the only thing that can
 * accept the throwaway self-signed certificate. Every request succeeding, on
 * every host, shows the verifier decided each one.
 *
 * The origin is HTTPS on 127.0.0.1 with the fixture in
 * `test/fixtures/cert-verify-concurrency-tls/` (SAN `*.certprobe.test`);
 * `--host-resolver-rules` maps those names to it and nothing else.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, session } = require('electron');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const HOST_SUFFIX = '.certprobe.test';
const ACCEPTED_HOSTS = Array.from({ length: 6 }, (_, index) => `h${index}${HOST_SUFFIX}`);
const REFUSED_HOST = `refused${HOST_SUFFIX}`;
const REQUESTS_PER_HOST = 8;
const REQUEST_TIMEOUT_MS = 15_000;

app.commandLine.appendSwitch('host-resolver-rules', `MAP *${HOST_SUFFIX} 127.0.0.1`);
const PROBE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cert-verify-probe-'));
app.setPath('userData', PROBE_USER_DATA);

function startOrigin() {
  const fixtures = path.join(__dirname, '../../../../test/fixtures/cert-verify-concurrency-tls');
  return new Promise((resolve) => {
    const server = https.createServer(
      {
        key: fs.readFileSync(path.join(fixtures, 'cert-verify-test.key')),
        cert: fs.readFileSync(path.join(fixtures, 'cert-verify-test.crt')),
      },
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        res.end('ok');
      }
    );
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function fetchOnce(ses, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await ses.fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function burst(ses, host, port) {
  const urls = Array.from(
    { length: REQUESTS_PER_HOST },
    (_, index) => `https://${host}:${port}/request-${index}`
  );
  return Promise.all(urls.map((url) => fetchOnce(ses, url)));
}

async function main() {
  const { server, port } = await startOrigin();
  const ses = session.fromPartition('cert-verify-concurrency-probe');
  const verifiedHosts = new Set();
  let verifierCalls = 0;
  ses.setCertificateVerifyProc((request, callback) => {
    verifierCalls += 1;
    verifiedHosts.add(request.hostname);
    if (request.hostname === REFUSED_HOST) {
      callback(-2);
      return;
    }
    callback(request.hostname.endsWith(HOST_SUFFIX) ? 0 : -3);
  });

  // All hosts at once: each burst is a set of first requests to a fresh host.
  const accepted = await Promise.all(ACCEPTED_HOSTS.map((host) => burst(ses, host, port)));
  const refused = await burst(ses, REFUSED_HOST, port);

  const results = {
    electron: process.versions.electron,
    hosts: ACCEPTED_HOSTS.length,
    requestsPerHost: REQUESTS_PER_HOST,
    acceptedOk: accepted.flat().filter((result) => result.ok && result.body === 'ok').length,
    acceptedFailures: accepted.flat().filter((result) => !result.ok),
    refusedOk: refused.filter((result) => result.ok).length,
    verifierCalls,
    verifiedHosts: [...verifiedHosts].sort(),
  };

  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(PROBE_USER_DATA, { recursive: true, force: true });
  } catch {
    /* cleaned up with the temp dir */
  }
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
