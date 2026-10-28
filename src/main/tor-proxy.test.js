jest.mock('./network-manager', () => ({ setTorProxy: jest.fn().mockResolvedValue(undefined), clearTorProxy: jest.fn().mockResolvedValue(undefined) }));
const routing = require('./network-manager');
jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('./logger');
const { applyOnionProxy, clearOnionProxy } = require('./tor-proxy');

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
