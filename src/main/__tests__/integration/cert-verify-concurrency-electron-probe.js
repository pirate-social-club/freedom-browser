/**
 * Electron-hosted probe for `cert-verify-concurrency.test.js`.
 *
 * Handshake browsing trusts a site's certificate only through the session's
 * `setCertificateVerifyProc` (`src/main/hns-manager.js`), after DANE. Before
 * Electron 44.9.0, a second request issued while the first request to a host
 * was still being verified could leave the verifier's verdict unapplied
 * (electron#55046): on 44.7.0 the first request then fails with Chromium's
 * default verdict even though the verifier accepted it.
 *
 * The probe makes that overlap certain rather than likely, the way Electron's
 * own regression test does: when the verifier first sees a host, it issues a
 * second request to the same host from inside the callback and answers the
 * first only after a delay. The certificate is a throwaway self-signed one
 * (`test/fixtures/cert-verify-concurrency-tls/`, SAN `*.certprobe.test`) that
 * Chromium's default verification refuses, and each response closes its
 * connection, so a request succeeds only when the verifier accepted it.
 * `--host-resolver-rules` maps those names to the local origin and nothing else.
 *
 * Results are printed as one JSON line prefixed with `PROBE-RESULT `.
 */

const { app, session } = require('electron');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const HOST_SUFFIX = '.certprobe.test';
const ACCEPTED_HOSTS = ['h0', 'h1', 'h2'].map((label) => `${label}${HOST_SUFFIX}`);
const REFUSED_HOST = `refused${HOST_SUFFIX}`;
// Long enough that the second request is certain to be issued while the
// first is still unverified; Electron's own test uses the same order.
const VERIFIER_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

app.commandLine.appendSwitch('host-resolver-rules', `MAP *${HOST_SUFFIX} 127.0.0.1`);
// The Jest wrapper owns the profile directory and removes it when this process
// and its GPU and Crashpad children are gone; a direct run makes its own.
const OWN_USER_DATA = !process.env.FREEDOM_PROBE_USER_DATA;
const PROBE_USER_DATA =
  process.env.FREEDOM_PROBE_USER_DATA ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cert-verify-probe-'));
app.setPath('userData', PROBE_USER_DATA);
process.on('exit', () => {
  if (!OWN_USER_DATA) return;
  try {
    fs.rmSync(PROBE_USER_DATA, { recursive: true, force: true });
  } catch {
    /* cleaned up with the temp dir */
  }
});

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
    return { url, ok: response.ok && (await response.text()) === 'ok' };
  } catch (err) {
    return { url, ok: false, error: String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { server, port } = await startOrigin();
  const ses = session.fromPartition('cert-verify-concurrency-probe');
  // A fresh session starts fetching its spellchecker dictionary from a Google
  // host as soon as it exists; with no languages there is nothing to fetch.
  ses.setSpellCheckerLanguages([]);
  const verifierSaw = [];
  const firstSeen = new Set();
  const overlapping = [];
  ses.setCertificateVerifyProc((request, callback) => {
    // Anything but the probe's own names keeps Chromium's verdict.
    if (!request.hostname.endsWith(HOST_SUFFIX)) {
      callback(-3);
      return;
    }
    verifierSaw.push({ hostname: request.hostname, errorCode: request.errorCode });
    const verdict = request.hostname === REFUSED_HOST ? -2 : 0;
    if (!firstSeen.has(request.hostname)) {
      firstSeen.add(request.hostname);
      overlapping.push(fetchOnce(ses, `https://${request.hostname}:${port}/overlapping`));
      setTimeout(() => callback(verdict), VERIFIER_DELAY_MS);
      return;
    }
    callback(verdict);
  });

  const firsts = await Promise.all(
    ACCEPTED_HOSTS.map((host) => fetchOnce(ses, `https://${host}:${port}/first`))
  );
  const refusedFirst = await fetchOnce(ses, `https://${REFUSED_HOST}:${port}/first`);
  const seconds = await Promise.all(overlapping);

  const accepted = [...firsts, ...seconds.filter((result) => !result.url.includes(REFUSED_HOST))];
  const refused = [refusedFirst, ...seconds.filter((result) => result.url.includes(REFUSED_HOST))];
  const results = {
    electron: process.versions.electron,
    hosts: ACCEPTED_HOSTS,
    acceptedCount: accepted.length,
    acceptedFailures: accepted.filter((result) => !result.ok),
    refusedOk: refused.filter((result) => result.ok).length,
    verifiedHosts: [...new Set(verifierSaw.map((entry) => entry.hostname))].sort(),
    // Chromium's own verdict on each request the verifier saw. Nonzero means
    // default verification refused the certificate, so a success can only be
    // the verifier's.
    defaultVerdicts: [...new Set(verifierSaw.map((entry) => entry.errorCode))],
  };

  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(`PROBE-RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    process.stdout.write(`PROBE-FAILED ${err && err.stack}\n`);
    app.exit(1);
  })
);
