// The guard uses the committed route, never mutable desired routing state.
// Downstream cancellation destroys the paired Node operations as well.
function createHnsGuardForwarding({ net, http, resources, getRoute, isAllowed,
  markHost, parseAuthority, writeError, fallbackConnect, fallbackHttp, log, timeoutMs }) {
  function connect(req, client, head = Buffer.alloc(0)) {
    if (client.destroyed) return;
    const route = getRoute();
    if (!route) return writeError(client, 503, 'HNS routing unavailable');
    if (!isAllowed(req.url)) {
      log.warn('[Network] Blocked non-HNS proxy CONNECT');
      return writeError(client, 502, 'HNS host not allowed');
    }
    markHost(parseAuthority(req.url).host);
    resources.track(client);
    let upstream;
    let cancelled = false;
    let settled = false;
    let buffered = Buffer.alloc(0);

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      settled = true;
      upstream?.destroy();
      client.destroy();
    };
    client.on('close', cancel);
    client.on('error', cancel);
    const refuse = (reason) => {
      if (client.destroyed) { cancel(); return; }
      if (cancelled || settled) return;
      settled = true;
      // The fallback remains a refusal. Do not run it after cancellation.
      Promise.resolve(fallbackConnect(req, client, head, reason)).catch(() => {
        if (!cancelled && !client.destroyed) writeError(client, 502, 'HNS lookup failed');
      });
      // Preserve the refusal response before upstream closure cancels the pair.
      upstream.destroy();
    };
    upstream = net.connect(route.port, route.host, () => {
      if (client.destroyed) { cancel(); return; }
      if (cancelled || settled) return;
      const lines = [`CONNECT ${req.url} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries(req.headers || {})) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
    });
    upstream.on('error', () => {
      if (settled) cancel();
      else refuse('local upstream error');
    });
    upstream.on('close', () => {
      if (!settled) refuse('local upstream closed');
      cancel();
    });
    resources.track(upstream);
    if (cancelled || client.destroyed) { upstream.destroy(); cancel(); return; }
    upstream.setTimeout(timeoutMs, () => refuse('local upstream timeout'));
    upstream.on('data', (chunk) => {
      if (client.destroyed) { cancel(); return; }
      if (cancelled || settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length > 64 * 1024) refuse('local upstream invalid response');
        return;
      }
      const header = buffered.subarray(0, end).toString('latin1');
      const status = Number((header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i) || [])[1]);
      if (status >= 200 && status < 300) {
        settled = true;
        upstream.setTimeout(0);
        client.write(buffered);
        upstream.pipe(client);
        client.pipe(upstream);
      } else if (status >= 500 || !status || Number.isNaN(status)) {
        refuse(`local upstream ${Number.isNaN(status) ? 'invalid response' : status}`);
      } else {
        settled = true;
        client.write(buffered);
        cancel();
      }
    });
  }

  function request(req, res) {
    if (req.aborted || res.destroyed) return;
    const route = getRoute();
    if (!route) {
      res.writeHead(503);
      res.end('HNS routing unavailable');
      return;
    }
    let host = req.headers.host || '';
    let path = req.url || '/';
    let defaultPort = 80;
    try {
      const url = new URL(req.url);
      host = url.host || host;
      path = `${url.pathname || '/'}${url.search || ''}`;
      defaultPort = url.protocol === 'https:' ? 443 : 80;
    } catch { /* Origin-form requests use Host. */ }
    if (!isAllowed(host)) {
      log.warn('[Network] Blocked non-HNS proxy request');
      res.writeHead(502);
      res.end('HNS host not allowed');
      return;
    }
    markHost(parseAuthority(host).host);
    let proxyReq;
    let proxyRes;
    let proxySocket;
    let cancelled = false;
    let settled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      proxyReq?.destroy();
      proxyRes?.destroy();
      proxySocket?.destroy();
    };
    req.on('aborted', cancel);
    req.on('error', cancel);
    res.on('error', cancel);
    res.on('close', () => { if (!res.writableFinished) cancel(); });
    const refuse = (reason) => {
      if (cancelled || settled || res.destroyed) return;
      settled = true;
      if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())) {
        Promise.resolve(fallbackHttp(req, res, host, defaultPort, path, reason)).catch(() => {
          if (!cancelled && !res.destroyed) res.destroy();
        });
      } else {
        res.writeHead(502);
        res.end('HNS proxy upstream failed');
      }
    };
    proxyReq = http.request({ host: route.host, port: route.port, method: req.method, agent: false,
      path: req.url, headers: req.headers }, (incoming) => {
      proxyRes = incoming;
      incoming.on('error', () => { cancel(); res.destroy(); });
      resources.track(incoming);
      if (cancelled || res.destroyed) { incoming.destroy(); return; }
      if ((incoming.statusCode || 0) >= 500 && ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())) {
        incoming.resume();
        refuse(`local upstream ${incoming.statusCode}`);
        return;
      }
      settled = true;
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
      incoming.on('close', () => { if (!incoming.complete && !res.writableFinished) res.destroy(); });
    });
    proxyReq.on('error', () => refuse('local upstream error'));
    proxyReq.on('socket', (socket) => {
      proxySocket = socket;
      socket.on('error', () => {});
      resources.track(socket);
      if (cancelled) socket.destroy();
    });
    resources.track(proxyReq);
    if (cancelled || req.aborted || res.destroyed) { cancel(); proxyReq.destroy(); }
    else req.pipe(proxyReq);
  }

  return { connect, request };
}

module.exports = { createHnsGuardForwarding };
