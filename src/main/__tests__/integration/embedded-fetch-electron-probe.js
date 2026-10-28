// Exercise Electron's embedded fetch in its main thread and a Node worker.
// No external Undici import, dispatcher replacement, or application shim.
const { isMainThread, Worker, workerData, parentPort } = require('node:worker_threads');
const { once } = require('node:events');

async function requests(origin) {
  const cases = [];
  for (const name of ['json', 'gzip', 'excessive-encoding', 'early-close', 'json-after-errors']) {
    try {
      const response = await fetch(`${origin}/${name}`, { signal: AbortSignal.timeout(5000) });
      cases.push({ name, status: response.status, value: await response.json() });
    } catch (error) {
      cases.push({ name, error: error.name, cause: error.cause?.message, code: error.cause?.code });
    }
  }
  // Closing the existing embedded dispatcher waits for all request streams.
  // Merely catching fetch's rejection missed the orphan-stream crash.
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (!dispatcher || typeof dispatcher.close !== 'function') throw new Error('Embedded dispatcher unavailable');
  await dispatcher.close();
  await new Promise((resolve) => setImmediate(resolve));
  return { versions: process.versions, cases };
}

if (!isMainThread) {
  requests(workerData.origin).then((result) => {
    parentPort.postMessage(result);
    parentPort.close();
  }).catch((error) => { throw error; });
} else {
  const { app } = require('electron');
  const http = require('node:http');
  const { gzipSync } = require('node:zlib');
  const fs = require('node:fs');
  if (!process.env.FREEDOM_PROBE_USER_DATA) throw new Error('An isolated profile is required');
  app.setPath('userData', process.env.FREEDOM_PROBE_USER_DATA);
  app.disableHardwareAcceleration();
  // Electron otherwise opens an error dialog. This is a failing probe exit,
  // never a swallowed exception or a claim about the uninstrumented UI.
  process.on('uncaughtException', (error) => {
    fs.writeSync(2, `UNCAUGHT ${error.stack}\n`);
    process.exit(42);
  });
  app.whenReady().then(async () => {
    const served = [];
    const server = http.createServer((request, response) => {
      served.push(request.url);
      if (['/excessive-encoding', '/early-close'].includes(request.url)) {
        response.writeHead(200, {
          'content-type': 'application/json', 'content-length': '128', connection: 'close',
          ...(request.url === '/excessive-encoding' ? { 'content-encoding': Array(6).fill('gzip').join(', ') } : {}),
        });
        response.flushHeaders();
        response.socket.end();
        return;
      }
      const plain = Buffer.from(JSON.stringify({ ok: true }));
      const gzip = request.url === '/gzip';
      const body = gzip ? gzipSync(plain) : plain;
      response.writeHead(200, {
        'content-type': 'application/json', 'content-length': body.length, connection: 'close',
        ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      });
      response.end(body);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    let worker;
    try {
      const main = await requests(origin);
      worker = new Worker(__filename, { workerData: { origin } });
      const [[result], [code]] = await Promise.all([once(worker, 'message'), once(worker, 'exit')]);
      if (code !== 0) throw new Error(`Worker exited ${code}`);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      fs.writeSync(1, `PROBE-RESULT ${JSON.stringify({ main, worker: result, served, workerExit: code })}\n`);
      app.exit(0);
    } finally {
      if (worker) await worker.terminate();
      server.closeAllConnections();
      server.close();
    }
  }).catch((error) => {
    fs.writeSync(2, `${error.stack}\n`);
    app.exit(1);
  });
}
