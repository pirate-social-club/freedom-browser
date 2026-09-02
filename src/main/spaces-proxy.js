const http = require('http');
const { URL } = require('url');
const log = require('./logger');
const {
  parseSpacesHandleInput,
  applySpacesSuffix,
  encodeSpacesHandlePath,
} = require('../shared/spaces-handle');

// TODO later-https-certs: fetch Spaces origins over HTTPS and validate
// certificates for the handle (SNI/Host name@space). This cut is HTTP-only.

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

let server = null;
let listenPort = null;
const bindingsByHandle = new Map();

function rememberSpacesBinding(handle, ipv4, port = 80) {
  const parsed = parseSpacesHandleInput(handle);
  if (!parsed) {
    throw new Error('Invalid Spaces handle for proxy binding');
  }
  bindingsByHandle.set(parsed.handle, {
    handle: parsed.handle,
    ipv4,
    port: port || 80,
  });
  return bindingsByHandle.get(parsed.handle);
}

function getSpacesBinding(handle) {
  const parsed = parseSpacesHandleInput(handle);
  return parsed ? bindingsByHandle.get(parsed.handle) || null : null;
}

function clearSpacesBinding(handle) {
  const parsed = parseSpacesHandleInput(handle);
  if (parsed) {
    bindingsByHandle.delete(parsed.handle);
  }
}

function getSpacesProxyOrigin() {
  if (!listenPort) return null;
  return `http://127.0.0.1:${listenPort}`;
}

function isSpacesProxyUrl(url) {
  const origin = getSpacesProxyOrigin();
  return Boolean(origin && typeof url === 'string' && url.startsWith(`${origin}/`));
}

function buildSpacesProxyUrl(handle, suffix = '/') {
  const parsed = parseSpacesHandleInput(handle);
  if (!parsed || !listenPort) {
    return null;
  }
  const base = `${getSpacesProxyOrigin()}/${encodeSpacesHandlePath(parsed.handle)}/`;
  return applySpacesSuffix(base, suffix || parsed.suffix || '/');
}

function parseProxyRequest(req) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const segments = requestUrl.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  let handle;
  try {
    handle = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }

  const parsed = parseSpacesHandleInput(handle);
  if (!parsed) {
    return null;
  }

  const restPath = `/${segments.slice(1).join('/')}`;
  return {
    handle: parsed.handle,
    path: restPath === '/' && segments.length === 1 ? '/' : restPath,
    search: requestUrl.search,
  };
}

function copyForwardHeaders(incoming, handle) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers[key] = value;
  }
  headers.host = handle;
  return headers;
}

function forwardSpacesRequest(req, res, binding, parsed) {
  const proxyReq = http.request(
    {
      host: binding.ipv4,
      port: binding.port || 80,
      method: req.method,
      path: `${parsed.path === '/' ? '/' : parsed.path}${parsed.search || ''}`,
      headers: copyForwardHeaders(req.headers, binding.handle),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    log.warn(`[spaces-proxy] upstream failed for ${binding.handle}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end('Spaces origin request failed');
  });

  req.pipe(proxyReq);
}

function onRequest(req, res) {
  const parsed = parseProxyRequest(req);
  if (!parsed) {
    res.writeHead(400);
    res.end('Invalid Spaces proxy path');
    return;
  }

  const binding = getSpacesBinding(parsed.handle);
  if (!binding?.ipv4) {
    res.writeHead(502);
    res.end('Spaces handle is not bound to an IPv4 origin');
    return;
  }

  forwardSpacesRequest(req, res, binding, parsed);
}

function startSpacesProxy() {
  if (server && listenPort) {
    return Promise.resolve(getSpacesProxyOrigin());
  }

  return new Promise((resolve, reject) => {
    server = http.createServer(onRequest);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      listenPort = server.address().port;
      log.info(`[spaces-proxy] listening on ${getSpacesProxyOrigin()} (HTTP only)`);
      resolve(getSpacesProxyOrigin());
    });
  });
}

function stopSpacesProxy() {
  return new Promise((resolve) => {
    if (!server) {
      listenPort = null;
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      listenPort = null;
      resolve();
    });
  });
}

function resetSpacesProxyForTests() {
  bindingsByHandle.clear();
  return stopSpacesProxy();
}

module.exports = {
  applySpacesSuffix,
  buildSpacesProxyUrl,
  clearSpacesBinding,
  copyForwardHeaders,
  getSpacesBinding,
  getSpacesProxyOrigin,
  isSpacesProxyUrl,
  parseProxyRequest,
  rememberSpacesBinding,
  resetSpacesProxyForTests,
  startSpacesProxy,
  stopSpacesProxy,
};
