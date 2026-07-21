const {
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');
const { setDynamicHnsPublicSuffixes } = require('../shared/hns-hosts');

function loadNetworkManagerModule(options = {}) {
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const setProxy = jest.fn(() => Promise.resolve());
  const webRequest = {
    onCompleted: jest.fn(),
    onErrorOccurred: jest.fn(),
  };
  const defaultSession = { setProxy, webRequest };
  const session = { defaultSession };

  let pacServerPort = options.pacServerPort || 9999;
  const createServerCalls = [];
  const netSockets = [];
  const netConnect = jest.fn((port, host, connectHandler) => {
    const handlers = new Map();
    const socket = {
      port,
      host,
      connectHandler,
      destroy: jest.fn(),
      on: jest.fn((event, handler) => {
        handlers.set(event, handler);
        return socket;
      }),
      pipe: jest.fn(),
      setTimeout: jest.fn((timeout, handler) => {
        if (handler) handlers.set('timeout', handler);
        return socket;
      }),
      write: jest.fn(),
      emit(event, ...args) {
        handlers.get(event)?.(...args);
      },
    };
    netSockets.push(socket);
    return socket;
  });
  const httpRequest = jest.fn(() => ({
    on: jest.fn(),
  }));
  const resolveHnsDohAddresses = jest.fn(() => Promise.resolve({
    addresses: [{ address: options.hnsDohAddress || '173.199.93.117', family: 4, ttl: 60 }],
    endpoint: 'https://hnsdoh.com/dns-query',
    hostname: 'app.pirate',
  }));
  const resolveHnsLocalAddresses = jest.fn(() => {
    if (options.hnsLocalAddress === false) {
      return Promise.reject(new Error('local unavailable'));
    }
    return Promise.resolve({
      addresses: [{ address: options.hnsLocalAddress || '173.199.93.117', family: 4, ttl: 60 }],
      hostname: 'app.pirate',
      resolver: 'ns1.pirate.sc',
    });
  });

  const httpMock = {
    createServer: jest.fn((handler) => {
      const handlers = new Map();
      const srv = {
        listen: jest.fn((port, host, cb) => {
          if (cb) cb();
        }),
        close: jest.fn((cb) => {
          if (cb) cb();
        }),
        address: jest.fn(() => ({ port: pacServerPort })),
        on: jest.fn((event, eventHandler) => {
          handlers.set(event, eventHandler);
          return srv;
        }),
      };
      createServerCalls.push({ server: srv, handler, handlers });
      return srv;
    }),
    request: httpRequest,
  };

  const { mod } = loadMainModule(require.resolve('./network-manager'), {
    extraMocks: {
      electron: () => ({
        session,
        app: { isPackaged: options.isPackaged ?? false },
      }),
      http: () => httpMock,
      net: () => ({
        connect: netConnect,
        isIP: jest.requireActual('net').isIP,
      }),
      [require.resolve('./hns-doh-resolver')]: () => ({
        resolveHnsDohAddresses,
      }),
      [require.resolve('./hns-local-resolver')]: () => ({
        resolveHnsLocalAddresses,
      }),
      [require.resolve('./logger')]: () => log,
    },
  });

  return {
    mod,
    log,
    setProxy,
    session,
    webRequest,
    httpMock,
    createServerCalls,
    netConnect,
    netSockets,
    httpRequest,
    resolveHnsDohAddresses,
    resolveHnsLocalAddresses,
  };
}

const REPRESENTATIVE_PIRATE_HOST = 'sable-harbor-4143.pirate';

function evaluatePac(pac, host, url = `https://${host}/`) {
  const dnsDomainLevels = (value) => String(value || '').split('.').length - 1;
  const isResolvable = (value) => !String(value || '').startsWith('missing.');
  const shExpMatch = (value, pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value);
  };
  return new Function(
    'url',
    'host',
    'dnsDomainLevels',
    'isResolvable',
    'shExpMatch',
    `${pac}; return FindProxyForURL(url, host);`
  )(url, host, dnsDomainLevels, isResolvable, shExpMatch);
}

describe('network-manager', () => {
  afterEach(() => {
    setDynamicHnsPublicSuffixes([]);
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('HNS-only PAC: HNS candidates go PROXY, ordinary resolved hosts go DIRECT', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('PROXY 127.0.0.1:5380');
    expect(pac).toContain('return "DIRECT"');
    expect(pac).toContain('var hnsRoots = {"pirate":1}');
    expect(pac).toContain('dnsDomainLevels(host) === 0');
    expect(pac).toContain('!isResolvable(host)');
    expect(evaluatePac(pac, 'pirate')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, REPRESENTATIVE_PIRATE_HOST)).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'unknown-single-label')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'missing.example')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'example.com')).toBe('DIRECT');
  });

  test('HNS + dVPN PAC composition: known HNS hosts go PROXY, others go SOCKS5', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('var hnsRoots = {"pirate":1}');
    expect(pac).toContain('PROXY 127.0.0.1:5380');
    expect(pac).toContain('SOCKS5 127.0.0.1:10808');
    expect(evaluatePac(pac, 'pirate')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, REPRESENTATIVE_PIRATE_HOST)).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'unknown-single-label')).toBe('PROXY 127.0.0.1:5380');
  });

  test('loopback always DIRECT regardless of proxy config', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('shExpMatch(host, "127.0.0.*")');
    expect(pac).toContain('host === "localhost"');
    expect(pac).toContain('host === "::1"');
    expect(pac.match(/DIRECT/g).length).toBeGreaterThanOrEqual(1);
  });

  test('unknown single-label hosts go to the HNS proxy when set', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    expect(evaluatePac(pac, 'unknown-single-label')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'pirate')).toBe('PROXY 127.0.0.1:5380');
  });

  test('representative .pirate hosts go to HNS proxy when set', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('var hnsRoots = {"pirate":1}');
    expect(REPRESENTATIVE_PIRATE_HOST.endsWith('.pirate')).toBe(true);
    expect(evaluatePac(pac, REPRESENTATIVE_PIRATE_HOST)).toBe('PROXY 127.0.0.1:5380');
  });

  test('ordinary hosts go SOCKS5 when dVPN is connected', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('SOCKS5 127.0.0.1:10808');
    expect(pac).toContain('SOCKS 127.0.0.1:10808');
  });

  test('ordinary hosts go DIRECT when dVPN is off', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    const lines = pac.split('\n');
    const returnLines = lines.filter(l => l.includes('return'));
    const lastReturn = returnLines[returnLines.length - 1];
    expect(lastReturn).toContain('DIRECT');
  });

  test('no proxies set returns DIRECT default for HNS hosts', () => {
    const ctx = loadNetworkManagerModule();

    const pac = ctx.mod.buildPacScript();

    expect(evaluatePac(pac, 'pirate')).toBe('DIRECT');
    expect(evaluatePac(pac, REPRESENTATIVE_PIRATE_HOST)).toBe('DIRECT');
  });

  test('HNS not regressed by dVPN: known HNS hosts still go to HNS PROXY', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    const hnsBlockStart = pac.indexOf('hnsRoots[host.toLowerCase()] === 1');
    const socksStart = pac.indexOf('SOCKS5');

    expect(hnsBlockStart).toBeGreaterThan(-1);
    expect(socksStart).toBeGreaterThan(-1);
    expect(hnsBlockStart).toBeLessThan(socksStart);
    expect(evaluatePac(pac, 'pirate')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'unknown-single-label')).toBe('PROXY 127.0.0.1:5380');
  });

  test('imported namespace suffixes are routed to the HNS proxy after refresh', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.refreshImportedHnsSuffixes(async () => Response.json({
      namespaces: [
        { root_label: 'xn--pokmon-dva' },
      ],
    }));

    const pac = ctx.mod.buildPacScript();
    expect(pac).toContain('"xn--pokmon-dva":1');
    expect(evaluatePac(pac, 'xn--pokmon-dva')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'v.xn--pokmon-dva')).toBe('PROXY 127.0.0.1:5380');
    expect(evaluatePac(pac, 'not-imported')).toBe('PROXY 127.0.0.1:5380');
  });

  test('imported namespace suffix log is summarized for large lists', async () => {
    const ctx = loadNetworkManagerModule();
    const namespaces = Array.from({ length: 12 }, (_, index) => ({ root_label: `name${index}` }));

    await ctx.mod.refreshImportedHnsSuffixes(async () => Response.json({ namespaces }));

    expect(ctx.log.info).toHaveBeenCalledWith(
      '[Network] Imported HNS suffixes loaded: 13 suffixes (.pirate, .name0, .name1, .name2, .name3, .name4, .name5, .name6, +5 more)'
    );
  });
  test('clearDvpnProxy removes dVPN proxy settings', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    ctx.mod.clearDvpnProxy();

    expect(ctx.mod.getDvpnProxy()).toBeNull();
  });

  test('getDvpnProxy returns null when no dVPN proxy set', () => {
    const ctx = loadNetworkManagerModule();

    expect(ctx.mod.getDvpnProxy()).toBeNull();
  });

  test('getDvpnProxy returns host and port when set', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    expect(ctx.mod.getDvpnProxy()).toEqual({ host: '127.0.0.1', port: 10808 });
  });

  test('setHnsProxy keeps the helper proxy private until the guard starts', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    expect(ctx.mod.getHnsProxyAddr()).toBeNull();
  });

  test('clearHnsProxy removes the HNS proxy address', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.clearHnsProxy();

    expect(ctx.mod.getHnsProxyAddr()).toBeNull();
  });

  test('rebuild with no proxies calls clearProxy', async () => {
    const ctx = loadNetworkManagerModule();

    await ctx.mod.rebuild();

    expect(ctx.setProxy).toHaveBeenCalledWith({ proxyRules: '' });
  });

  test('rebuild with HNS proxy applies PAC', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.rebuild();

    expect(ctx.httpMock.createServer).toHaveBeenCalled();
    expect(ctx.setProxy).toHaveBeenCalledWith(
      expect.objectContaining({ pacScript: expect.stringContaining('proxy.pac') })
    );
  });

  test('rebuild puts an HNS guard proxy in front of the helper proxy', async () => {
    const ctx = loadNetworkManagerModule({ pacServerPort: 9181 });
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.rebuild();

    const pac = ctx.mod.buildPacScript();
    expect(ctx.httpMock.createServer).toHaveBeenCalledTimes(2);
    expect(ctx.mod.getHnsProxyAddr()).toBe('127.0.0.1:9181');
    expect(pac).toContain('PROXY 127.0.0.1:9181');
    expect(pac).not.toContain('PROXY 127.0.0.1:5380');
  });

  test('HNS guard blocks loopback CONNECT requests before the helper proxy', async () => {
    const ctx = loadNetworkManagerModule({ pacServerPort: 9181 });
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.rebuild();

    const guardConnect = ctx.createServerCalls[0].handlers.get('connect');
    const clientSocket = {
      destroyed: false,
      destroy: jest.fn(function destroy() {
        this.destroyed = true;
      }),
      on: jest.fn(),
      pipe: jest.fn(),
      write: jest.fn(),
    };

    guardConnect(
      { url: '127.0.0.1:443', httpVersion: '1.1', headers: {} },
      clientSocket,
      Buffer.alloc(0)
    );

    expect(ctx.netConnect).not.toHaveBeenCalled();
    expect(clientSocket.write).toHaveBeenCalledWith(
      'HTTP/1.1 502 HNS host not allowed\r\nConnection: close\r\n\r\n'
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      '[Network] Blocked non-HNS proxy CONNECT: 127.0.0.1:443'
    );
  });

  // The guard's last-resort path used to resolve an HNS name (locally or over
  // DoH) and then open a raw tunnel straight to the returned address, bypassing
  // fingertipd. Nothing there validated DNSSEC or DANE, and the browser-side
  // certificate check accepted any certificate for an HNS hostname, so the
  // resolver operator could MITM any HNS name. Until the DNSSEC/DANE chain is
  // validated before "200 Connection Established", this path must refuse.

  test('HNS guard refuses to tunnel CONNECT when the local upstream fails', async () => {
    const ctx = loadNetworkManagerModule({ pacServerPort: 9181 });
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.rebuild();

    const guardConnect = ctx.createServerCalls[0].handlers.get('connect');
    const clientSocket = {
      destroyed: false,
      destroy: jest.fn(function destroy() {
        this.destroyed = true;
      }),
      on: jest.fn(),
      pipe: jest.fn(),
      write: jest.fn(),
    };

    guardConnect(
      { url: 'app.pirate:443', httpVersion: '1.1', headers: {} },
      clientSocket,
      Buffer.alloc(0)
    );

    expect(ctx.netConnect).toHaveBeenCalledWith(5380, '127.0.0.1', expect.any(Function));
    ctx.netSockets[0].connectHandler();
    ctx.netSockets[0].emit('data', Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    await Promise.resolve();
    await Promise.resolve();

    // Only the helper-proxy connection may exist; no tunnel to a resolved address.
    expect(ctx.netConnect).toHaveBeenCalledTimes(1);
    expect(clientSocket.write).toHaveBeenCalledWith(expect.stringContaining('502'));
  });

  test('HNS guard does not consult any resolver on the refused fallback path', async () => {
    const ctx = loadNetworkManagerModule({ pacServerPort: 9181, hnsLocalAddress: '198.51.100.9' });
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setHnsResolverAddrs({ rootAddr: '127.0.0.1:43000' });

    await ctx.mod.rebuild();

    const guardConnect = ctx.createServerCalls[0].handlers.get('connect');
    const clientSocket = {
      destroyed: false,
      destroy: jest.fn(function destroy() {
        this.destroyed = true;
      }),
      on: jest.fn(),
      pipe: jest.fn(),
      write: jest.fn(),
    };

    guardConnect(
      { url: 'app.pirate:443', httpVersion: '1.1', headers: {} },
      clientSocket,
      Buffer.alloc(0)
    );

    ctx.netSockets[0].connectHandler();
    ctx.netSockets[0].emit('data', Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    await Promise.resolve();
    await Promise.resolve();

    // Refusing before resolution also avoids disclosing the browsed name to a
    // third-party DoH resolver on a path we cannot validate anyway.
    expect(ctx.resolveHnsLocalAddresses).not.toHaveBeenCalled();
    expect(ctx.resolveHnsDohAddresses).not.toHaveBeenCalled();
  });

  test('HNS guard refuses CONNECT for arbitrary HNS hosts, not just .pirate', async () => {
    const ctx = loadNetworkManagerModule({ pacServerPort: 9181, hnsDohAddress: '203.0.113.7' });
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.rebuild();

    const guardConnect = ctx.createServerCalls[0].handlers.get('connect');
    const clientSocket = {
      destroyed: false,
      destroy: jest.fn(function destroy() {
        this.destroyed = true;
      }),
      on: jest.fn(),
      pipe: jest.fn(),
      write: jest.fn(),
    };

    guardConnect(
      { url: 'portal.any-hns-root:443', httpVersion: '1.1', headers: {} },
      clientSocket,
      Buffer.alloc(0)
    );

    ctx.netSockets[0].connectHandler();
    ctx.netSockets[0].emit('data', Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.netConnect).toHaveBeenCalledTimes(1);
    expect(ctx.resolveHnsDohAddresses).not.toHaveBeenCalled();
  });

  test('HNS guard refuses plain HTTP requests on the unvalidated fallback path', async () => {
    const ctx = loadNetworkManagerModule({ pacServerPort: 9181 });
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    await ctx.mod.rebuild();
    ctx.mod.clearHnsProxy();

    const guardHttp = ctx.createServerCalls[0].handler;
    const req = {
      method: 'GET',
      url: 'http://app.pirate/feed?tab=home',
      headers: { host: 'app.pirate' },
      pipe: jest.fn(),
    };
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };

    await guardHttp(req, res);

    expect(ctx.httpRequest).not.toHaveBeenCalled();
    expect(ctx.resolveHnsDohAddresses).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(req.pipe).not.toHaveBeenCalled();
  });

  test('PAC script is valid JavaScript', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(() => new Function(pac)).not.toThrow();
  });

  test('API diagnostics logs failed API requests without sensitive query values', () => {
    const ctx = loadNetworkManagerModule();

    ctx.mod.registerApiRequestDiagnostics(ctx.session.defaultSession);

    expect(ctx.webRequest.onCompleted).toHaveBeenCalledWith(
      { urls: ['https://api.pirate.sc/*', 'https://api-staging.pirate.sc/*'] },
      expect.any(Function)
    );
    expect(ctx.webRequest.onErrorOccurred).toHaveBeenCalledWith(
      { urls: ['https://api.pirate.sc/*', 'https://api-staging.pirate.sc/*'] },
      expect.any(Function)
    );

    const onCompleted = ctx.webRequest.onCompleted.mock.calls[0][1];
    onCompleted({
      method: 'GET',
      statusCode: 200,
      url: 'https://api.pirate.sc/feed/home',
    });
    expect(ctx.log.warn).not.toHaveBeenCalled();

    onCompleted({
      method: 'GET',
      statusCode: 401,
      url: 'https://api.pirate.sc/feed/home?token=secret&view=home',
    });

    expect(ctx.log.warn).toHaveBeenCalledWith(
      '[Network] API request failed: GET https://api.pirate.sc/feed/home?token=%3Credacted%3E&view=home status=401'
    );
    expect(ctx.log.warn.mock.calls[0][0]).not.toContain('secret');
  });

  test('API diagnostics stay disabled in packaged builds unless explicitly enabled', () => {
    const ctx = loadNetworkManagerModule({ isPackaged: true });

    ctx.mod.registerApiRequestDiagnostics(ctx.session.defaultSession);

    expect(ctx.webRequest.onCompleted).not.toHaveBeenCalled();
    expect(ctx.webRequest.onErrorOccurred).not.toHaveBeenCalled();
  });

});
