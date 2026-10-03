const { EventEmitter } = require('events');
const {
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');
const { setDynamicHnsPublicSuffixes } = require('../shared/hns-hosts');

function makeProxySession() {
  return {
    setProxy: jest.fn(async () => {}),
    forceReloadProxyConfig: jest.fn(async () => {}),
    closeAllConnections: jest.fn(async () => {}),
    webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map((event) => [event, jest.fn()])),
  };
}

function loadNetworkManagerModule(options = {}) {
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const setProxy = jest.fn(() => Promise.resolve());
  const webRequest = makeProxySession().webRequest;
  const defaultSession = { ...makeProxySession(), setProxy, webRequest };
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
      destroyed: false,
      destroy: jest.fn(() => {
        if (socket.destroyed) return;
        socket.destroyed = true;
        socket.emit('close');
      }),
      on: jest.fn((event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
        return socket;
      }),
      pipe: jest.fn(),
      setTimeout: jest.fn((timeout, handler) => {
        if (handler) handlers.set('timeout', [handler]);
        return socket;
      }),
      write: jest.fn(),
      emit(event, ...args) {
        for (const handler of handlers.get(event) || []) handler(...args);
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

  const dispatcher = require('./webrequest-dispatcher');
  const onFatal = jest.fn();
  if (!options.deferRouting) mod.initializeSessionRouting(onFatal);
  return {
    mod,
    dispatcher,
    onFatal,
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

  test.each([
    [false, false, false], [false, true, false], [true, false, false], [true, true, false],
    [false, false, true], [false, true, true], [true, false, true], [true, true, true],
  ])('onion classification with Tor=%s HNS=%s dVPN=%s', async (tor, hns, dvpn) => {
    const ctx = loadNetworkManagerModule();
    if (hns) ctx.mod.setHnsProxy('127.0.0.1:5380');
    if (dvpn) ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.setTorProxy('192.0.2.20:9150');
    if (!tor) await ctx.mod.clearTorProxy();
    const route = evaluatePac(ctx.mod.buildPacScript(), 'missing.example.onion');
    expect(route).toBe(tor ? 'SOCKS5 192.0.2.20:9150' : dvpn
      ? 'SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; DIRECT' : 'DIRECT');
    expect(route).not.toContain('PROXY');
  });

  test('a malformed Tor endpoint cannot enter the PAC script', () => {
    const ctx = loadNetworkManagerModule();
    expect(() => ctx.mod.setTorProxy('127.0.0.1:9150; DIRECT')).toThrow('Invalid Tor SOCKS endpoint');
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

  test.each([
    '127.0.0.1',
    '127.0.1.1',
    '10.42.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.10.20',
    '::1',
    'fc00::1',
    'fdff:ffff::1',
    'fe80::1',
    'febf:ffff::1',
    '::ffff:192.168.1.1',
  ])('local or private literal %s remains DIRECT while dVPN is connected', (host) => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(evaluatePac(pac, host)).toBe('DIRECT');
  });

  test.each([
    '1.2.3.4',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '[2001:4860:4860::8888]',
  ])('public literal %s uses dVPN instead of bypassing it', (host) => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(evaluatePac(pac, host)).toBe('SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; DIRECT');
  });

  test('localhost remains DIRECT while dVPN is connected', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    expect(evaluatePac(ctx.mod.buildPacScript(), 'localhost')).toBe('DIRECT');
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
    const socksStart = pac.lastIndexOf('SOCKS5');

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
    expect(evaluatePac(pac, 'xn--pokmon-dva')).toBe('PROXY 127.0.0.1:9999');
    expect(evaluatePac(pac, 'v.xn--pokmon-dva')).toBe('PROXY 127.0.0.1:9999');
    expect(evaluatePac(pac, 'not-imported')).toBe('PROXY 127.0.0.1:9999');
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

    expect(ctx.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
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

  test('late session enrollment adopts the live HNS and dVPN policy', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.rebuild();
    const privateSession = makeProxySession();
    await ctx.mod.registerProxySession(privateSession);
    expect(privateSession.setProxy).toHaveBeenCalledWith(ctx.setProxy.mock.calls[0][0]);
    expect(evaluatePac(ctx.mod.buildPacScript(), 'app.pirate')).toBe('PROXY 127.0.0.1:9999');
    expect(evaluatePac(ctx.mod.buildPacScript(), 'example.com')).toContain('SOCKS5 127.0.0.1:10808');
    expect(ctx.setProxy).toHaveBeenCalledTimes(1);
    expect(ctx.session.defaultSession.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test('PAC updates keep the existing URL valid and serve the new policy', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.rebuild();
    const pacServer = ctx.createServerCalls[0];
    ctx.mod.setDvpnProxy('127.0.0.1', 10809);
    await ctx.mod.rebuild();
    expect(ctx.httpMock.createServer).toHaveBeenCalledTimes(1);
    expect(pacServer.server.close).not.toHaveBeenCalled();
    const response = { writeHead: jest.fn(), end: jest.fn() };
    pacServer.handler({}, response);
    expect(response.end.mock.calls[0][0]).toContain('SOCKS5 127.0.0.1:10809');
    expect(ctx.session.defaultSession.forceReloadProxyConfig).toHaveBeenCalledTimes(2);
  });

  test('shared route preparation waits for an old guard socket close while retaining the old PAC body and denied permission', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    await ctx.mod.rebuild();
    const client = new EventEmitter();
    let entered;
    const draining = new Promise((resolve) => { entered = resolve; });
    client.destroyed = false;
    client.destroy = jest.fn(() => { client.destroyed = true; entered(); });
    client.write = jest.fn(); client.pipe = jest.fn();
    ctx.createServerCalls[0].handlers.get('connect')({ url: 'app.pirate:443', httpVersion: '1.1', headers: {} }, client);
    ctx.netSockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    const update = ctx.mod.rebuild();
    await draining;
    expect(ctx.setProxy).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getProxySessionPolicy(ctx.session.defaultSession).allowed).toBe(false);
    const before = { writeHead: jest.fn(), end: jest.fn() };
    ctx.createServerCalls[1].handler({}, before);
    expect(before.end.mock.calls[0][0]).not.toContain('SOCKS5');
    client.emit('close');
    await update;
    const after = { writeHead: jest.fn(), end: jest.fn() };
    ctx.createServerCalls[1].handler({}, after);
    expect(after.end.mock.calls[0][0]).toContain('SOCKS5 127.0.0.1:10808');
    expect(ctx.setProxy).toHaveBeenCalledTimes(2);
    expect(ctx.mod.getProxySessionPolicy(ctx.session.defaultSession).allowed).toBe(true);
  });

  test('opening another session and rebuilding unchanged policy preserve existing connections', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.rebuild();
    const first = makeProxySession();
    const second = makeProxySession();
    await ctx.mod.registerProxySession(first);
    await ctx.mod.registerProxySession(second);
    await ctx.mod.rebuild();
    await ctx.mod.registerProxySession(second);
    for (const target of [ctx.session.defaultSession, first, second]) {
      expect(target.setProxy).toHaveBeenCalledTimes(1);
      expect(target.forceReloadProxyConfig).toHaveBeenCalledTimes(1);
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
    }
    ctx.mod.setDvpnProxy('127.0.0.1', 10809);
    await ctx.mod.rebuild();
    for (const target of [ctx.session.defaultSession, first, second]) {
      expect(target.forceReloadProxyConfig).toHaveBeenCalledTimes(2);
      expect(target.closeAllConnections).toHaveBeenCalledTimes(2);
    }
  });

  test('initial enrollment configures only the new session', async () => {
    const ctx = loadNetworkManagerModule();
    const added = makeProxySession();
    await ctx.mod.registerProxySession(added);
    expect(added.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(ctx.setProxy).not.toHaveBeenCalled();
    expect(ctx.session.defaultSession.closeAllConnections).not.toHaveBeenCalled();
  });

  test('routing withdrawal cancels every intercepted phase for default and enrolled sessions without a contents ID exemption', async () => {
    const ctx = loadNetworkManagerModule();
    const added = makeProxySession();
    await ctx.mod.registerProxySession(added);
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    for (const target of [ctx.session.defaultSession, added]) {
      expect(ctx.mod.getProxySessionPolicy(target).allowed).toBe(false);
      for (const event of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']) {
        const listener = target.webRequest[event].mock.calls[0][0];
        for (const url of ['https://example.com/', 'http://127.0.0.1:8080/', 'wss://example.com/']) {
          const result = await new Promise((resolve) => listener({ url, webContentsId: 0 }, resolve));
          expect(result).toEqual({ cancel: true });
        }
      }
    }
    await ctx.mod.rebuild();
    for (const target of [ctx.session.defaultSession, added]) {
      expect(ctx.mod.getProxySessionPolicy(target).allowed).toBe(true);
    }
  });

  test('enrollment queued behind a policy change adopts that policy once', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.rebuild();
    let observeClose;
    let finishClose;
    const closing = new Promise((resolve) => { observeClose = resolve; });
    ctx.session.defaultSession.closeAllConnections.mockImplementationOnce(() => new Promise((resolve) => {
      finishClose = resolve;
      observeClose();
    }));
    ctx.mod.setDvpnProxy('127.0.0.1', 10809);
    const update = ctx.mod.rebuild();
    await closing;
    const added = makeProxySession();
    const enrollment = ctx.mod.registerProxySession(added);
    expect(added.setProxy).not.toHaveBeenCalled();
    finishClose();
    await Promise.all([update, enrollment]);
    expect(added.setProxy).toHaveBeenCalledWith(ctx.setProxy.mock.calls[1][0]);
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
    const response = { writeHead: jest.fn(), end: jest.fn() };
    ctx.createServerCalls[0].handler({}, response);
    expect(response.end.mock.calls[0][0]).toContain('SOCKS5 127.0.0.1:10809');
  });

  test('helper and resolver changes close sockets even with identical PAC bytes', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    await ctx.mod.rebuild();
    const pac = ctx.mod.buildPacScript();
    ctx.mod.setHnsProxy('127.0.0.1:5381');
    await ctx.mod.rebuild();
    expect(ctx.mod.buildPacScript()).toBe(pac);
    ctx.mod.setHnsResolverAddrs({ rootAddr: '127.0.0.1:5354' });
    await ctx.mod.rebuild();
    expect(ctx.mod.buildPacScript()).toBe(pac);
    expect(ctx.session.defaultSession.closeAllConnections).toHaveBeenCalledTimes(3);
  });

  test('failed enrollment leaves existing sessions untouched', async () => {
    const ctx = loadNetworkManagerModule();
    await ctx.mod.rebuild();
    const existing = makeProxySession();
    await ctx.mod.registerProxySession(existing);
    const added = makeProxySession();
    added.forceReloadProxyConfig.mockRejectedValueOnce(new Error('reload failed'));
    await expect(ctx.mod.registerProxySession(added)).rejects.toThrow('Session proxy update failed');
    await ctx.mod.registerProxySession(added);
    expect(added.setProxy).toHaveBeenCalledTimes(2);
    expect(existing.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(ctx.session.defaultSession.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test('same-address CA rotation closes existing sockets while duplicate ready and enrollment preserve them', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380', { generation: 1, caFingerprint: 'first-ca' });
    await ctx.mod.rebuild();
    const existing = makeProxySession();
    await ctx.mod.registerProxySession(existing);
    const pac = ctx.mod.buildPacScript();
    ctx.mod.setHnsProxy('127.0.0.1:5380', { generation: 1, caFingerprint: 'second-ca' });
    await ctx.mod.rebuild();
    expect(ctx.mod.buildPacScript()).toBe(pac);
    ctx.mod.setHnsProxy('127.0.0.1:5380', { generation: 1, caFingerprint: 'second-ca' });
    await ctx.mod.rebuild();
    const added = makeProxySession();
    await ctx.mod.registerProxySession(added);
    expect(ctx.session.defaultSession.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(existing.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test('overlapping withdrawal and same-address reactivation apply the new helper identity once', async () => {
    const ctx = loadNetworkManagerModule();
    const identity = { generation: 1, caFingerprint: 'same-ca' };
    ctx.mod.setHnsProxy('127.0.0.1:5380', identity);
    await ctx.mod.rebuild();
    const existing = makeProxySession();
    await ctx.mod.registerProxySession(existing);
    const originalConfiguration = ctx.setProxy.mock.calls[0][0];
    ctx.mod.clearHnsProxy();
    const withdrawal = ctx.mod.rebuild();
    ctx.mod.setHnsProxy('127.0.0.1:5380', { ...identity, generation: 2 });
    const activation = ctx.mod.rebuild();
    const added = makeProxySession();
    const enrollment = ctx.mod.registerProxySession(added);
    await Promise.all([withdrawal, activation, enrollment]);
    expect(ctx.setProxy).toHaveBeenLastCalledWith(originalConfiguration);
    expect(ctx.session.defaultSession.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(existing.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getHnsProxyAddr()).toBe('127.0.0.1:9999');
  });

  test('HNS callers without trust identity conservatively reset reused routes', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    await ctx.mod.rebuild();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    await ctx.mod.rebuild();
    expect(ctx.session.defaultSession.closeAllConnections).toHaveBeenCalledTimes(2);
  });

  test.each(['guard', 'PAC'])('failed %s preparation cannot enroll a session on cached direct policy', async (phase) => {
    const ctx = loadNetworkManagerModule();
    await ctx.mod.rebuild();
    const createServer = ctx.httpMock.createServer.getMockImplementation();
    ctx.httpMock.createServer.mockImplementation((handler) => {
      if (phase === 'guard' || ctx.mod.getHnsProxyAddr()) throw new Error('preparation failed');
      return createServer(handler);
    });
    ctx.mod.setHnsProxy('127.0.0.1:5380', { generation: 1, caFingerprint: 'current-ca' });
    await expect(ctx.mod.rebuild()).rejects.toThrow('prepare_failed');
    const added = makeProxySession();
    await expect(ctx.mod.registerProxySession(added)).rejects.toThrow('policy_unprepared');
    expect(added.setProxy).not.toHaveBeenCalled();
    ctx.httpMock.createServer.mockImplementation(createServer);
    await ctx.mod.rebuild();
    await ctx.mod.registerProxySession(added);
    expect(added.setProxy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'pac_script' }));
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
    await ctx.mod.rebuild();
    expect(ctx.setProxy).toHaveBeenLastCalledWith(added.setProxy.mock.calls[0][0]);
    expect(added.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test('stopping one service preserves the other for every session', async () => {
    const ctx = loadNetworkManagerModule();
    const privateSession = makeProxySession();
    await ctx.mod.registerProxySession(privateSession);
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.rebuild();
    ctx.mod.clearDvpnProxy();
    await ctx.mod.rebuild();
    expect(evaluatePac(ctx.mod.buildPacScript(), 'app.pirate')).toBe('PROXY 127.0.0.1:9999');
    expect(evaluatePac(ctx.mod.buildPacScript(), 'example.com')).toBe('DIRECT');
    ctx.mod.clearHnsProxy();
    await ctx.mod.rebuild();
    expect(privateSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' });
  });

  test('failed enrollment rejects and does not prevent a retry', async () => {
    const ctx = loadNetworkManagerModule();
    const privateSession = makeProxySession();
    privateSession.setProxy.mockRejectedValueOnce(new Error('unavailable'));
    await expect(ctx.mod.registerProxySession(privateSession)).rejects.toThrow('Session proxy update failed');
    await ctx.mod.registerProxySession(privateSession);
    expect(privateSession.setProxy).toHaveBeenCalledTimes(2);
    ctx.mod.unregisterProxySession(privateSession);
    await ctx.mod.rebuild();
    expect(privateSession.setProxy).toHaveBeenCalledTimes(2);
  });

  test('a failed direct update retains the PAC server until recovery', async () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);
    await ctx.mod.rebuild();
    const pacServer = ctx.createServerCalls[0].server;
    ctx.setProxy.mockRejectedValueOnce(new Error('unavailable'));
    ctx.mod.clearDvpnProxy();
    await expect(ctx.mod.rebuild()).rejects.toThrow('Session proxy update failed');
    expect(pacServer.close).not.toHaveBeenCalled();
    await ctx.mod.rebuild();
    expect(pacServer.close).toHaveBeenCalledTimes(1);
  });

  test('closing a session cancels queued enrollment without reviving its membership', async () => {
    const ctx = loadNetworkManagerModule();
    const privateSession = makeProxySession();
    const enrollment = ctx.mod.registerProxySession(privateSession);
    const refused = expect(enrollment).rejects.toThrow('enrollment_cancelled');
    ctx.mod.unregisterProxySession(privateSession);
    await refused;
    await ctx.mod.rebuild();
    expect(privateSession.setProxy).not.toHaveBeenCalled();
  });

  test('a retired Electron session cannot enroll again or revive a retained guard', async () => {
    const ctx = loadNetworkManagerModule();
    const retired = makeProxySession();
    const enrollment = ctx.mod.registerProxySession(retired);
    const refused = expect(enrollment).rejects.toThrow('enrollment_cancelled');
    ctx.mod.unregisterProxySession(retired);
    await expect(ctx.mod.registerProxySession(retired)).rejects.toThrow('session_retired');
    await refused;
    expect(ctx.mod.getProxySessionPolicy(retired)).toMatchObject({ allowed: false, state: 'retired' });
    const fresh = makeProxySession();
    await ctx.mod.registerProxySession(fresh);
    expect(fresh.setProxy).toHaveBeenCalledTimes(1);
    expect(retired.setProxy).not.toHaveBeenCalled();
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
      '[Network] Blocked non-HNS proxy CONNECT'
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
    expect(res.writeHead).toHaveBeenCalledWith(503);
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
    const ctx = loadNetworkManagerModule({ deferRouting: true });

    ctx.mod.registerApiRequestDiagnostics(ctx.session.defaultSession);
    ctx.dispatcher.attachWebRequestDispatcher(ctx.session.defaultSession);

    expect(ctx.webRequest.onCompleted).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.webRequest.onErrorOccurred).toHaveBeenCalledWith(expect.any(Function));

    const onCompleted = ctx.webRequest.onCompleted.mock.calls[0][0];
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
    const ctx = loadNetworkManagerModule({ isPackaged: true, deferRouting: true });

    ctx.mod.registerApiRequestDiagnostics(ctx.session.defaultSession);

    expect(ctx.webRequest.onCompleted).not.toHaveBeenCalled();
    expect(ctx.webRequest.onErrorOccurred).not.toHaveBeenCalled();
  });


  test('API diagnostics preserve explicit session scope', () => {
    const ctx = loadNetworkManagerModule({ deferRouting: true });
    const privateSession = { webRequest: { onCompleted: jest.fn(), onErrorOccurred: jest.fn() } };
    ctx.mod.registerApiRequestDiagnostics(ctx.session.defaultSession);
    ctx.dispatcher.attachWebRequestDispatcher(privateSession);
    ctx.dispatcher.attachWebRequestDispatcher(ctx.session.defaultSession);
    expect(privateSession.webRequest.onCompleted).not.toHaveBeenCalled();
    expect(privateSession.webRequest.onErrorOccurred).not.toHaveBeenCalled();
    expect(ctx.webRequest.onCompleted).toHaveBeenCalledTimes(1);
  });

  test.each([
    'https://other.example/fail', 'http://api.pirate.sc/fail',
    'https://api.pirate.sc.other.example/fail', 'not-a-url',
  ])('API diagnostics ignore unrelated URL %s', (url) => {
    const ctx = loadNetworkManagerModule({ deferRouting: true });
    ctx.mod.registerApiRequestDiagnostics();
    ctx.dispatcher.attachWebRequestDispatcher(ctx.session.defaultSession);
    ctx.webRequest.onCompleted.mock.calls[0][0]({ url, statusCode: 500 });
    ctx.webRequest.onErrorOccurred.mock.calls[0][0]({ url, error: 'failed' });
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  test('API error diagnostics keep query redaction and repeat suppression', () => {
    const ctx = loadNetworkManagerModule({ deferRouting: true });
    ctx.mod.registerApiRequestDiagnostics();
    ctx.dispatcher.attachWebRequestDispatcher(ctx.session.defaultSession);
    const listener = ctx.webRequest.onErrorOccurred.mock.calls[0][0];
    const details = { url: 'https://api-staging.pirate.sc/feed?token=secret&code=private', error: 'net::ERR_FAILED' };
    listener(details);
    listener(details);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn.mock.calls[0][0]).toContain('net::ERR_FAILED');
    expect(ctx.log.warn.mock.calls[0][0]).not.toMatch(/secret|private/);
  });

});
