const { createSessionProxyController } = require('./session-proxy-controller');

function makeSession() {
  return {
    setProxy: jest.fn(async () => {}),
    forceReloadProxyConfig: jest.fn(async () => {}),
    closeAllConnections: jest.fn(async () => {}),
  };
}

describe('session proxy controller', () => {
  test('updates every enrolled session once, including the default', async () => {
    const main = makeSession();
    const privateSession = makeSession();
    const controller = createSessionProxyController(() => main);
    controller.register(main);
    controller.register(privateSession);
    controller.register(privateSession);
    await controller.apply({ mode: 'direct' });
    for (const target of [main, privateSession]) {
      expect(target.setProxy).toHaveBeenCalledTimes(1);
      expect(target.forceReloadProxyConfig).toHaveBeenCalledTimes(1);
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(target.setProxy.mock.invocationCallOrder[0])
        .toBeLessThan(target.forceReloadProxyConfig.mock.invocationCallOrder[0]);
      expect(target.forceReloadProxyConfig.mock.invocationCallOrder[0])
        .toBeLessThan(target.closeAllConnections.mock.invocationCallOrder[0]);
    }
  });

  test('waits for earlier updates and closes their sockets before the next update', async () => {
    let finishClose;
    let observeClose;
    const closing = new Promise((resolve) => { observeClose = resolve; });
    const main = makeSession();
    main.closeAllConnections.mockImplementationOnce(() => new Promise((resolve) => {
      finishClose = resolve;
      observeClose();
    }));
    const controller = createSessionProxyController(() => main);
    const first = controller.enqueue(() => controller.apply({ pacScript: 'first' }));
    const second = controller.enqueue(() => controller.apply({ pacScript: 'second' }));
    await closing;
    expect(main.setProxy).toHaveBeenCalledTimes(1);
    expect(finishClose).toEqual(expect.any(Function));
    finishClose();
    await Promise.all([first, second]);
    expect(main.setProxy.mock.calls.map(([config]) => config.pacScript)).toEqual(['first', 'second']);
  });

  test('attempts all sessions, reports failure and allows a successful retry', async () => {
    const main = makeSession();
    const failing = makeSession();
    const other = makeSession();
    failing.setProxy.mockRejectedValueOnce(new Error('configuration failed'));
    const controller = createSessionProxyController(() => main);
    controller.register(failing);
    controller.register(other);
    await expect(controller.enqueue(() => controller.apply({ mode: 'direct' })))
      .rejects.toThrow('Session proxy update failed');
    expect(other.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(failing.closeAllConnections).not.toHaveBeenCalled();
    await controller.enqueue(() => controller.apply({ mode: 'direct' }));
    expect(failing.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test.each(['forceReloadProxyConfig', 'closeAllConnections'])('%s failures reject setup', async (method) => {
    const main = makeSession();
    main[method].mockRejectedValue(new Error('session unavailable'));
    const controller = createSessionProxyController(() => main);
    await expect(controller.apply({ mode: 'direct' })).rejects.toThrow('Session proxy update failed');
  });

  test('released sessions are absent from later updates', async () => {
    const main = makeSession();
    const closed = makeSession();
    const controller = createSessionProxyController(() => main);
    controller.register(closed);
    controller.unregister(closed);
    await controller.apply({ mode: 'direct' });
    expect(closed.setProxy).not.toHaveBeenCalled();
    expect(main.setProxy).toHaveBeenCalledTimes(1);
  });

  test('rejects unavailable sessions instead of reporting setup complete', async () => {
    const controller = createSessionProxyController(() => null);
    expect(() => controller.register({})).toThrow('Session proxy configuration is unavailable');
    await expect(controller.apply({ mode: 'direct' })).rejects.toThrow('Session proxy configuration is unavailable');
  });
});
