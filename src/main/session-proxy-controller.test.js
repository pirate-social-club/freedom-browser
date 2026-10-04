const { createSessionProxyController } = require('./session-proxy-controller');
const createController = (getDefaultSession) => createSessionProxyController(getDefaultSession, { onFatal: jest.fn() });

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
    const controller = createController(() => main);
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
    const controller = createController(() => main);
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
    const controller = createController(() => main);
    controller.register(failing);
    controller.register(other);
    await expect(controller.enqueue(() => controller.apply({ mode: 'direct' })))
      .rejects.toThrow('Session proxy update failed');
    expect(other.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(failing.closeAllConnections).toHaveBeenCalledTimes(1);
    await controller.enqueue(() => controller.apply({ mode: 'direct' }));
    expect(failing.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(main.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(other.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test('single-session setup leaves existing sessions untouched and skips an unchanged policy', async () => {
    const main = makeSession();
    const existing = makeSession();
    const added = makeSession();
    const controller = createController(() => main);
    controller.register(existing);
    await controller.apply({ mode: 'direct' });
    controller.register(added);
    await controller.applyTo(added, { mode: 'direct' });
    await controller.apply({ mode: 'direct' });
    for (const target of [main, existing, added]) {
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
    }
    await controller.apply({ mode: 'pac_script', pacScript: 'changed' });
    for (const target of [main, existing, added]) {
      expect(target.closeAllConnections).toHaveBeenCalledTimes(2);
    }
  });

  test('changed PAC content reloads even when its URL stays the same', async () => {
    const main = makeSession();
    const controller = createController(() => main);
    const config = { mode: 'pac_script', pacScript: 'same-url' };
    await controller.apply(config, 'first-content');
    await controller.apply(config, 'second-content');
    expect(main.forceReloadProxyConfig).toHaveBeenCalledTimes(2);
  });

  test('a failed changed policy invalidates the previous successful receipt', async () => {
    const main = makeSession();
    const controller = createController(() => main);
    await controller.apply({ mode: 'direct' });
    main.forceReloadProxyConfig.mockRejectedValueOnce(new Error('reload failed'));
    await expect(controller.apply({ mode: 'pac_script', pacScript: 'changed' })).rejects.toThrow('Session proxy update failed');
    await controller.apply({ mode: 'direct' });
    expect(main.setProxy).toHaveBeenCalledTimes(3);
    expect(main.closeAllConnections).toHaveBeenCalledTimes(3);
  });

  test('retirement refuses reuse and a late update cannot reopen the retained guard', async () => {
    const main = makeSession();
    const added = makeSession();
    const controller = createController(() => main);
    controller.register(added);
    const getter = controller.getPolicyGetter(added);
    let finishClose;
    let observeClose;
    const closing = new Promise((resolve) => { observeClose = resolve; });
    added.closeAllConnections.mockImplementationOnce(() => new Promise((resolve) => {
      finishClose = resolve;
      observeClose();
    }));
    const oldSetup = controller.enqueue(() => controller.applyTo(added, { mode: 'direct' }));
    const refused = expect(oldSetup).rejects.toThrow('Session proxy update failed');
    await closing;
    controller.unregister(added);
    expect(() => controller.register(added)).toThrow('session_retired');
    finishClose();
    await refused;
    expect(getter()).toMatchObject({ allowed: false, state: 'retired' });
  });

  test.each(['setProxy', 'forceReloadProxyConfig', 'closeAllConnections'])('requires %s before enrollment or changing any session', async (method) => {
    const main = makeSession();
    const incomplete = makeSession();
    incomplete[method] = undefined;
    const controller = createController(() => main);
    expect(() => controller.register(incomplete)).toThrow(method);
    await expect(controller.applyTo(incomplete, { mode: 'direct' })).rejects.toThrow('Session proxy update failed');
    expect(main.setProxy).not.toHaveBeenCalled();
    const globalController = createController(() => main);
    const added = makeSession();
    globalController.register(added);
    added[method] = 'unavailable';
    await expect(globalController.apply({ mode: 'direct' })).rejects.toThrow('Session proxy update failed');
    expect(main.setProxy).not.toHaveBeenCalled();
    if (method !== 'setProxy') expect(added.setProxy).not.toHaveBeenCalled();
  });

  test.each(['forceReloadProxyConfig', 'closeAllConnections'])('%s failures reject setup', async (method) => {
    const main = makeSession();
    main[method].mockRejectedValue(new Error('session unavailable'));
    const controller = createController(() => main);
    await expect(controller.apply({ mode: 'direct' })).rejects.toThrow('Session proxy update failed');
  });

  test('released sessions are absent from later updates', async () => {
    const main = makeSession();
    const closed = makeSession();
    const controller = createController(() => main);
    controller.register(closed);
    controller.unregister(closed);
    await controller.apply({ mode: 'direct' });
    expect(closed.setProxy).not.toHaveBeenCalled();
    expect(main.setProxy).toHaveBeenCalledTimes(1);
  });

  test('rejects unavailable sessions instead of reporting setup complete', async () => {
    const controller = createController(() => null);
    expect(() => controller.register({})).toThrow('capability_setProxy');
    await expect(controller.apply({ mode: 'direct' })).rejects.toThrow('session_unavailable');
  });
});
