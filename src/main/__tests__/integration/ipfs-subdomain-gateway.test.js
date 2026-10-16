/**
 * Integration test: Kubo's subdomain gateway behaviour on `localhost`,
 * plus the ipfs-protocol handler's contract for consuming the redirect
 * inside the main process.
 *
 * Freedom routes IPFS content through `http://localhost:<port>/ipfs/<CID>` and
 * relies on Kubo redirecting to `http://<cidv1>.ipfs.localhost:<port>/` so that
 * `_redirects` files (e.g. SPA fallbacks on ENS-hosted sites) work correctly.
 *
 * That redirect behaviour is load-bearing for the `ipfs:` standard scheme —
 * the protocol handler in `src/main/ipfs/ipfs-protocol.js` MUST follow the
 * redirect itself. Surfacing the 301 to Chromium would put the page back
 * on the gateway origin (the exact bug `ipfs:` as a standard scheme fixes).
 *
 * Two assertions in one test process:
 *   1. Kubo's redirect contract — guards against Kubo silently dropping
 *      the `localhost` subdomain rewrite on an upgrade.
 *   2. The handler returns a 200 with the file body even though Kubo
 *      replied 301 — guards against the handler regressing to
 *      `redirect: 'manual'` and surfacing the redirect.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

function getIpfsBinaryPath() {
  const arch = process.arch;
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  const projectRoot = path.resolve(__dirname, '../../../..');
  const binPath = path.join(projectRoot, 'ipfs-bin', `${platform}-${arch}`, binName);
  return fs.existsSync(binPath) ? binPath : null;
}

function waitForIpfsReady(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/v0/id', method: 'POST', timeout: 2000 },
        (res) => {
          if (res.statusCode === 200) resolve(true);
          else if (Date.now() - start < timeout) setTimeout(check, 500);
          else reject(new Error(`IPFS not ready after ${timeout}ms`));
        }
      );
      req.on('error', () => {
        if (Date.now() - start < timeout) setTimeout(check, 500);
        else reject(new Error(`IPFS not ready after ${timeout}ms`));
      });
      req.end();
    };
    check();
  });
}

function addFileViaApi(port, content, fileName = 'index.html') {
  const boundary = `----freedom-${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: text/plain\r\n\r\n`
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v0/add?cid-version=0',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            // The /add endpoint returns one JSON object per line; we only add one file.
            const line = data.trim().split('\n')[0];
            resolve(JSON.parse(line));
          } catch {
            reject(new Error(`Failed to parse /add response: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function headRequest(host, port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: urlPath, method: 'HEAD', timeout: 5000 },
      (res) => {
        resolve({ statusCode: res.statusCode, headers: res.headers });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function responseFromHttp(res, body) {
  return new Response(body, {
    status: res.statusCode,
    headers: res.headers,
  });
}

function requestViaHttp(url, init = {}) {
  const parsed = new URL(url);
  const headers = {};
  for (const [name, value] of (init.headers || new Headers()).entries()) {
    headers[name] = value;
  }
  const hostHeader = parsed.host;
  const dialHost = parsed.hostname.endsWith('.localhost') ? '127.0.0.1' : parsed.hostname;
  headers.host = hostHeader;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: dialHost,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method || 'GET',
        headers,
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(responseFromHttp(res, Buffer.concat(chunks))));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout for ${url}`)));
    if (init.signal) {
      init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function fetchFollowingLocalhostRedirects(url, init = {}) {
  expect(init.redirect).toBe('follow');
  let currentUrl = url;
  for (let redirects = 0; redirects < 5; redirects++) {
    const res = await requestViaHttp(currentUrl, init);
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error(`Too many redirects while fetching ${url}`);
}

describe('Kubo subdomain gateway redirect', () => {
  const ipfsBinary = getIpfsBinaryPath();
  let tempDir;
  let ipfsProcess;
  const TEST_API_PORT = 15011;
  const TEST_GATEWAY_PORT = 18091;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-subdomain-test-'));
  });

  afterEach(async () => {
    if (ipfsProcess && !ipfsProcess.killed) {
      ipfsProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        timer.unref?.();
        ipfsProcess.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      ipfsProcess = null;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeTest = ipfsBinary && process.env.FREEDOM_TEST_KUBO_LEGACY ? test : test.skip;

  maybeTest(
    'redirects localhost path-gateway request to <cid>.ipfs.localhost subdomain form',
    async () => {
      execSync(`"${ipfsBinary}" init`, {
        env: { ...process.env, IPFS_PATH: tempDir },
        stdio: 'pipe',
      });

      const configPath = path.join(tempDir, 'config');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config.Addresses.API = `/ip4/127.0.0.1/tcp/${TEST_API_PORT}`;
      config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${TEST_GATEWAY_PORT}`;
      config.Addresses.Swarm = [];
      config.Bootstrap = [];
      config.Routing = { Type: 'none' };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      ipfsProcess = spawn(ipfsBinary, ['daemon', '--offline'], {
        env: { ...process.env, IPFS_PATH: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ipfsProcess.stderr.on('data', () => {});

      await waitForIpfsReady(TEST_API_PORT, 60000);

      const added = await addFileViaApi(
        TEST_API_PORT,
        '<!doctype html><title>hi</title>',
        'index.html'
      );
      const cid = added.Hash;
      expect(cid).toMatch(/^Qm/); // CIDv0 (cid-version=0)

      // (1) Kubo redirect contract: hitting the path gateway on hostname
      // `localhost` must redirect to the subdomain gateway form. This is
      // what makes `_redirects` work.
      const res = await headRequest('localhost', TEST_GATEWAY_PORT, `/ipfs/${cid}/`);
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toMatch(
        new RegExp(`^http://[a-z0-9]+\\.ipfs\\.localhost:${TEST_GATEWAY_PORT}/`)
      );

      // Sanity check: hitting 127.0.0.1 with the same path does NOT redirect to
      // subdomain form (Kubo only applies subdomain rewriting for `localhost`).
      const resLoopback = await headRequest('127.0.0.1', TEST_GATEWAY_PORT, `/ipfs/${cid}/`);
      expect(resLoopback.statusCode).toBe(200);

      // (2) Protocol-handler contract: handleRequest must follow the
      // redirect itself and return a 200 with the file body. If this
      // regresses to 301 + Location header, the page would land on the
      // gateway origin (`http://<cidv1>.ipfs.localhost:<port>`) and the
      // whole `ipfs:` standard scheme migration would fall over. Mock the
      // service registry to point at the test daemon's gateway port; the
      // handler reads the URL via `getIpfsGatewayUrl`.
      jest.resetModules();
      jest.doMock('../../service-registry', () => ({
        getIpfsGatewayUrl: () => `http://localhost:${TEST_GATEWAY_PORT}`,
      }));
      jest.doMock('../../ens-resolver', () => ({ resolveEnsContent: async () => null }));
      jest.doMock('../../logger', () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      }));
      // Legacy Kubo mode resolved `<cid>.ipfs.localhost` redirects via
      // Electron's `net.fetch` (Chromium's network stack — RFC 6761
      // *.localhost resolution) because Node's getaddrinfo on macOS
      // returns ENOTFOUND for those hosts. Jest doesn't run inside an
      // Electron context so `require('electron').net.fetch` isn't
      // available. This shim follows Kubo's redirect while preserving the
      // redirected `Host: <cid>.ipfs.localhost:<port>` header and dialing
      // loopback directly, which mirrors the Electron/Chromium behavior
      // the handler relies on in production.
      jest.doMock('electron', () => ({
        net: { fetch: fetchFollowingLocalhostRedirects },
      }));
      const { handleRequest } = require('../../ipfs/ipfs-protocol');
      const fetchImpl = globalThis.fetch.bind(globalThis);

      const handlerReq = {
        url: `ipfs://${cid}/`,
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      };
      const handlerRes = await handleRequest('ipfs', handlerReq, { fetchImpl });
      expect(handlerRes.status).toBe(200);
      expect(handlerRes.headers.get('location')).toBeNull();
      const body = await handlerRes.text();
      expect(body).toBe('<!doctype html><title>hi</title>');
    },
    120000
  );
});
