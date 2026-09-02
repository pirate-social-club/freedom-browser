const http = require('http');
const {
  copyForwardHeaders,
  parseProxyRequest,
  rememberSpacesBinding,
  resetSpacesProxyForTests,
  startSpacesProxy,
  buildSpacesProxyUrl,
} = require('./spaces-proxy');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('spaces-proxy', () => {
  afterEach(async () => {
    await resetSpacesProxyForTests();
  });

  test('strips hop-by-hop headers and sets Host to the handle', () => {
    expect(
      copyForwardHeaders(
        {
          host: '127.0.0.1:9',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          accept: 'text/html',
        },
        'void@space'
      )
    ).toEqual({
      accept: 'text/html',
      host: 'void@space',
    });
  });

  test('parses encoded handle paths', () => {
    expect(parseProxyRequest({ url: '/void%40space/docs?q=1' })).toEqual({
      handle: 'void@space',
      path: '/docs',
      search: '?q=1',
    });
  });

  test('forwards the request path to the bound IPv4 with Host: handle', async () => {
    const upstream = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${req.headers.host}:${req.url}`);
    });

    rememberSpacesBinding('void@space', '127.0.0.1', upstream.port);
    const origin = await startSpacesProxy();
    const target = buildSpacesProxyUrl('void@space', '/hello');
    expect(target.startsWith(origin)).toBe(true);

    const response = await request(target);
    expect(response.status).toBe(200);
    expect(response.body).toBe('void@space:/hello');

    await new Promise((resolve) => upstream.server.close(resolve));
  });
});
