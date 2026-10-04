describe('ipfs-progress-status', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.window;
  });

  const loadModule = async () => {
    jest.resetModules();
    const linkStatusMocks = {
      showLoadingStatus: jest.fn(),
      clearLoadingStatus: jest.fn(),
    };
    jest.doMock('./link-status.js', () => linkStatusMocks);
    const mod = await import('./ipfs-progress-status.js');
    return { mod, linkStatusMocks };
  };

  test('maps active Rust progress phases to concise loading copy', async () => {
    const { mod } = await loadModule();

    expect(
      mod.deriveIpfsProgressMessage({
        active: [{ kind: 'gateway_request', phase: 'provider_lookup', status: 'active' }],
      })
    ).toBe('IPFS: Finding providers…');

    expect(
      mod.deriveIpfsProgressMessage({
        active: [{ kind: 'block_fetch', phase: 'fetching_bitswap', status: 'active' }],
      })
    ).toBe('IPFS: Fetching from peers…');
  });

  test('prefers the most user-meaningful active phase over generic events', async () => {
    const { mod } = await loadModule();

    expect(
      mod.deriveIpfsProgressMessage({
        active: [
          { kind: 'gateway_request', phase: 'started', status: 'active' },
          { kind: 'block_fetch', phase: 'retrying', status: 'active' },
        ],
      })
    ).toBe('IPFS: Retrying slow provider…');
  });

  test('falls back to sanitized Rust message and ignores malformed snapshots', async () => {
    const { mod } = await loadModule();

    expect(
      mod.deriveIpfsProgressMessage({
        active: [{ kind: 'gateway_request', message: 'Finding providers', status: 'active' }],
      })
    ).toBe('IPFS: Finding providers');
    expect(mod.deriveIpfsProgressMessage('not json')).toBeNull();
    expect(mod.deriveIpfsProgressMessage({ active: [], events: [] })).toBeNull();
  });

  test('ignores terminal events when no request is active', async () => {
    const { mod } = await loadModule();

    expect(
      mod.deriveIpfsProgressMessage({
        active: [],
        events: [
          { kind: 'gateway_request', phase: 'completed', status: 'completed' },
          { kind: 'gateway_request', phase: 'failed', message: 'deadline elapsed' },
        ],
      })
    ).toBeNull();

    expect(
      mod.deriveIpfsProgressMessage({
        active: [],
        events: [
          { kind: 'gateway_request', phase: 'completed', status: 'completed' },
          { kind: 'provider_lookup', phase: 'provider_lookup', status: 'active' },
        ],
      })
    ).toBe('IPFS: Finding providers…');
  });

  test('poller writes and clears the shared loading status surface', async () => {
    jest.useFakeTimers();
    const { mod, linkStatusMocks } = await loadModule();
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({
        diagnostics: {
          progress: JSON.stringify({
            active: [{ kind: 'gateway_request', phase: 'provider_lookup', status: 'active' }],
          }),
        },
      })
      .mockResolvedValueOnce({ diagnostics: { progress: '{"active":[],"events":[]}' } });

    mod.startIpfsProgressStatus({ getStatus, intervalMs: 50 });
    await Promise.resolve();
    await Promise.resolve();
    expect(linkStatusMocks.showLoadingStatus).toHaveBeenCalledWith('IPFS: Finding providers…');

    jest.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();
    expect(linkStatusMocks.clearLoadingStatus).toHaveBeenCalled();

    mod.stopIpfsProgressStatus({ immediate: true });
    expect(linkStatusMocks.clearLoadingStatus).toHaveBeenLastCalledWith({ immediate: true });
  });
});
