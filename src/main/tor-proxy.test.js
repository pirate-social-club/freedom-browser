jest.mock('./network-manager', () => ({ setTorProxy: jest.fn().mockResolvedValue(undefined), clearTorProxy: jest.fn().mockResolvedValue(undefined) }));
const routing = require('./network-manager');
jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('./logger');
const { buildOnionPacScript, applyOnionProxy, clearOnionProxy } = require('./tor-proxy');

// Compile the PAC text into a callable FindProxyForURL, supplying the
// `dnsDomainIs` built-in that Chromium provides to PAC scripts (it isn't a
// plain-JS global). Standard semantics: host ends with the given domain.
function compilePac(pac) {
  return new Function('dnsDomainIs', `${pac}; return FindProxyForURL;`)((host, domain) =>
    String(host).toLowerCase().endsWith(String(domain).toLowerCase())
  );
}

describe('buildOnionPacScript', () => {
  const pac = buildOnionPacScript('127.0.0.1:9150');

  test('is a syntactically valid PAC FindProxyForURL function', () => {
    expect(pac).toContain('function FindProxyForURL(url, host)');
    expect(() => compilePac(pac)).not.toThrow();
  });

  test('routes .onion (and subdomains) through the SOCKS5 proxy', () => {
    const find = compilePac(pac);
    expect(find('http://abc.onion/', 'abc.onion')).toContain('SOCKS5 127.0.0.1:9150');
    expect(find('http://sub.abc.onion/', 'sub.abc.onion')).toContain('SOCKS5 127.0.0.1:9150');
  });

  test('returns DIRECT for clearnet hosts', () => {
    const find = compilePac(pac);
    expect(find('https://example.com/', 'example.com')).toBe('DIRECT');
    expect(find('https://onion.example.com/', 'onion.example.com')).toBe('DIRECT');
  });

  test('embeds the provided host:port', () => {
    const custom = buildOnionPacScript('127.0.0.1:9999');
    expect(custom).toContain('127.0.0.1:9999');
  });
});

describe('applyOnionProxy / clearOnionProxy', () => {
  test('applyOnionProxy changes the shared policy and verifies the session route', async () => {
    const setProxy = jest.fn().mockResolvedValue(undefined);
    const forceReloadProxyConfig = jest.fn().mockResolvedValue(undefined);
    const closeAllConnections = jest.fn().mockResolvedValue(undefined);
    const resolveProxy = jest.fn().mockResolvedValue('SOCKS5 127.0.0.1:9150');
    await applyOnionProxy(
      { setProxy, forceReloadProxyConfig, closeAllConnections, resolveProxy },
      '127.0.0.1:9150'
    );
    expect(routing.setTorProxy).toHaveBeenCalledWith('127.0.0.1:9150');
    expect(setProxy).not.toHaveBeenCalled();
    expect(forceReloadProxyConfig).not.toHaveBeenCalled();
    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(resolveProxy).toHaveBeenCalledWith('https://freedom-proxy-check.onion/');
    expect(log.info).toHaveBeenCalledWith(
      '[tor-proxy] Chromium resolves .onion via SOCKS5 127.0.0.1:9150'
    );
  });

  test('clearOnionProxy resets the session to direct', async () => {
    const setProxy = jest.fn().mockResolvedValue(undefined);
    const forceReloadProxyConfig = jest.fn().mockResolvedValue(undefined);
    const closeAllConnections = jest.fn().mockResolvedValue(undefined);
    await clearOnionProxy({ setProxy, forceReloadProxyConfig, closeAllConnections });
    expect(routing.clearTorProxy).toHaveBeenCalled();
    expect(setProxy).not.toHaveBeenCalled();
  });

  test('no-ops gracefully when session has no setProxy', async () => {
    await expect(applyOnionProxy(null, '127.0.0.1:9150')).resolves.toBeUndefined();
    await expect(clearOnionProxy({})).resolves.toBeUndefined();
  });
});
