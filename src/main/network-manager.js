const log = require('./logger');
const { session } = require('electron');
const http = require('http');

let hnsProxyAddr = null;
let dvpnProxyHost = null;
let dvpnProxyPort = null;

let pacServer = null;
let pacPort = null;

function buildPacScript() {
  const hnsLine = hnsProxyAddr
    ? `  if (dnsDomainLevels(host) === 0) {\n    return "PROXY ${hnsProxyAddr}";\n  }`
    : `  if (dnsDomainLevels(host) === 0) {\n    return "DIRECT";\n  }`;

  const dvpnLine = dvpnProxyHost && dvpnProxyPort
    ? `  return "SOCKS5 ${dvpnProxyHost}:${dvpnProxyPort}; SOCKS ${dvpnProxyHost}:${dvpnProxyPort}; DIRECT";`
    : `  return "DIRECT";`;

  return `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "127.0.0.*") || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
${hnsLine}
${dvpnLine}
}`;
}

async function startPacServer(pacContent) {
  if (pacServer) {
    pacServer.close();
    pacServer = null;
    pacPort = null;
  }

  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      res.end(pacContent);
    });

    srv.listen(0, '127.0.0.1', () => {
      pacServer = srv;
      pacPort = srv.address().port;
      resolve(pacPort);
    });

    srv.on('error', (err) => {
      pacServer = null;
      pacPort = null;
      reject(err);
    });
  });
}

async function stopPacServer() {
  if (!pacServer) return;
  return new Promise((resolve) => {
    pacServer.close(() => {
      pacServer = null;
      pacPort = null;
      resolve();
    });
  });
}

async function applyProxy() {
  const pac = buildPacScript();
  const port = await startPacServer(pac);
  const pacUrl = `http://127.0.0.1:${port}/proxy.pac`;
  await session.defaultSession.setProxy({ pacScript: pacUrl });
  log.info(`[Network] Proxy configured via PAC at ${pacUrl}`);
}

async function clearProxy() {
  await stopPacServer();
  await session.defaultSession.setProxy({ proxyRules: '' });
  log.info('[Network] Proxy configuration cleared');
}

function setHnsProxy(proxyAddr) {
  hnsProxyAddr = proxyAddr;
  log.info(`[Network] HNS proxy set to ${proxyAddr}`);
}

function clearHnsProxy() {
  hnsProxyAddr = null;
  log.info('[Network] HNS proxy cleared');
}

function setDvpnProxy(host, port) {
  dvpnProxyHost = host;
  dvpnProxyPort = port;
  log.info(`[Network] dVPN proxy set to ${host}:${port}`);
}

function clearDvpnProxy() {
  dvpnProxyHost = null;
  dvpnProxyPort = null;
  log.info('[Network] dVPN proxy cleared');
}

async function rebuild() {
  if (!hnsProxyAddr && !dvpnProxyHost) {
    await clearProxy();
    return;
  }
  await applyProxy();
}

function getHnsProxyAddr() {
  return hnsProxyAddr;
}

function getDvpnProxy() {
  if (!dvpnProxyHost || !dvpnProxyPort) return null;
  return { host: dvpnProxyHost, port: dvpnProxyPort };
}

module.exports = {
  setHnsProxy,
  clearHnsProxy,
  setDvpnProxy,
  clearDvpnProxy,
  rebuild,
  clearProxy,
  getHnsProxyAddr,
  getDvpnProxy,
  buildPacScript,
};
