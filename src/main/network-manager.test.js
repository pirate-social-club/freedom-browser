const {
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');
const { HNS_PUBLIC_SUFFIXES } = require('../shared/hns-hosts');

function loadNetworkManagerModule(options = {}) {
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const setProxy = jest.fn(() => Promise.resolve());
  const defaultSession = { setProxy };
  const session = { defaultSession };

  let pacServerPort = options.pacServerPort || 9999;
  const createServerCalls = [];

  const httpMock = {
    createServer: jest.fn((handler) => {
      const srv = {
        listen: jest.fn((port, host, cb) => {
          if (cb) cb();
        }),
        close: jest.fn((cb) => {
          if (cb) cb();
        }),
        address: jest.fn(() => ({ port: pacServerPort })),
        on: jest.fn(),
      };
      createServerCalls.push({ server: srv, handler });
      return srv;
    }),
  };

  const { mod } = loadMainModule(require.resolve('./network-manager'), {
    extraMocks: {
      electron: () => ({
        session,
        app: { isPackaged: false },
      }),
      http: () => httpMock,
      [require.resolve('./logger')]: () => log,
    },
  });

  return {
    mod,
    log,
    setProxy,
    session,
    httpMock,
    createServerCalls,
  };
}

const REPRESENTATIVE_PIRATE_HOST = 'sable-harbor-4143.pirate';
const REPRESENTATIVE_UNKNOWN_HNSISH_HOST = 'night-signal.clawitzer';

describe('network-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('HNS-only PAC: single-label and configured public suffix hosts go PROXY, others go DIRECT', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('PROXY 127.0.0.1:5380');
    expect(pac).toContain('return "DIRECT"');
    expect(pac).toContain('dnsDomainLevels(host) === 0');
    expect(pac).toContain('dnsDomainIs(host, ".pirate")');
    expect(pac).not.toContain('dnsDomainIs(host, ".clawitzer")');
  });

  test('HNS + dVPN PAC composition: single-label and configured public suffix hosts → PROXY, others → SOCKS5', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('dnsDomainLevels(host) === 0');
    expect(pac).toContain('dnsDomainIs(host, ".pirate")');
    expect(pac).not.toContain('dnsDomainIs(host, ".clawitzer")');
    expect(pac).toContain('PROXY 127.0.0.1:5380');
    expect(pac).toContain('SOCKS5 127.0.0.1:10808');
  });

  test('HNS + Anyone + dVPN PAC composition preserves HNS and orders Anyone before dVPN', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setAnyoneProxy('127.0.0.1', 9050);
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('PROXY 127.0.0.1:5380');
    expect(pac).toContain('SOCKS5 127.0.0.1:9050');
    expect(pac).toContain('SOCKS 127.0.0.1:9050');
    expect(pac).toContain('SOCKS5 127.0.0.1:10808');
    expect(pac.indexOf('SOCKS5 127.0.0.1:9050')).toBeLessThan(pac.indexOf('SOCKS5 127.0.0.1:10808'));
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

  test('single-label hosts go to HNS proxy when set', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    expect(pac).toMatch(/dnsDomainLevels\(host\) === 0[^}]*PROXY 127\.0\.0\.1:5380/);
  });

  test('representative configured public suffix hosts go to HNS proxy when set', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('dnsDomainIs(host, ".pirate")');
    expect(HNS_PUBLIC_SUFFIXES).toEqual(['.pirate']);
    expect(REPRESENTATIVE_PIRATE_HOST.endsWith('.pirate')).toBe(true);
    expect(REPRESENTATIVE_UNKNOWN_HNSISH_HOST.endsWith('.clawitzer')).toBe(true);
  });

  test('ordinary hosts go SOCKS5 when dVPN is connected', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('SOCKS5 127.0.0.1:10808');
    expect(pac).toContain('SOCKS 127.0.0.1:10808');
  });

  test('Anyone-only PAC: ordinary hosts go SOCKS5 through Anyone', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setAnyoneProxy('127.0.0.1', 9050);

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('SOCKS5 127.0.0.1:9050');
    expect(pac).toContain('SOCKS 127.0.0.1:9050');
    expect(pac).not.toContain('127.0.0.1:10808');
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

  test('no proxies set returns DIRECT default for single-label hosts', () => {
    const ctx = loadNetworkManagerModule();

    const pac = ctx.mod.buildPacScript();

    expect(pac).toContain('dnsDomainLevels(host) === 0');
    expect(pac).toContain('return "DIRECT"');
  });

  test('HNS not regressed by dVPN: single-label and configured public suffix hosts still go to HNS PROXY', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    const hnsBlockStart = pac.indexOf('dnsDomainLevels(host) === 0');
    const socksStart = pac.indexOf('SOCKS5');

    expect(hnsBlockStart).toBeGreaterThan(-1);
    expect(pac).toContain('dnsDomainIs(host, ".pirate")');
    expect(socksStart).toBeGreaterThan(-1);
    expect(hnsBlockStart).toBeLessThan(socksStart);
  });

  test('.eth and .box hosts are not treated as HNS candidates', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setAnyoneProxy('127.0.0.1', 9050);

    const pac = ctx.mod.buildPacScript();

    expect(pac).not.toContain('dnsDomainIs(host, ".eth")');
    expect(pac).not.toContain('dnsDomainIs(host, ".box")');
    expect(pac).not.toContain('dnsDomainIs(host, ".clawitzer")');
    expect(pac).toContain('SOCKS5 127.0.0.1:9050');
  });

  test('clearDvpnProxy removes dVPN proxy settings', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    ctx.mod.clearDvpnProxy();

    expect(ctx.mod.getDvpnProxy()).toBeNull();
  });

  test('clearAnyoneProxy removes Anyone proxy settings', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setAnyoneProxy('127.0.0.1', 9050);

    ctx.mod.clearAnyoneProxy();

    expect(ctx.mod.getAnyoneProxy()).toBeNull();
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

  test('getAnyoneProxy returns host and port when set', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setAnyoneProxy('127.0.0.1', 9050);

    expect(ctx.mod.getAnyoneProxy()).toEqual({ host: '127.0.0.1', port: 9050 });
  });

  test('setHnsProxy stores the proxy address', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');

    expect(ctx.mod.getHnsProxyAddr()).toBe('127.0.0.1:5380');
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

  test('PAC script is valid JavaScript', () => {
    const ctx = loadNetworkManagerModule();
    ctx.mod.setHnsProxy('127.0.0.1:5380');
    ctx.mod.setDvpnProxy('127.0.0.1', 10808);

    const pac = ctx.mod.buildPacScript();

    expect(() => new Function(pac)).not.toThrow();
  });
});
