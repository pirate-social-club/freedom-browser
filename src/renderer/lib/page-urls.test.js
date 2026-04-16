describe('page-urls', () => {
  const originalWindow = global.window;

  const loadModule = async (internalPages = {}) => {
    jest.resetModules();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: internalPages },
    };
    return import('./page-urls.js');
  };

  afterEach(() => {
    global.window = originalWindow;
  });

  test('builds internal page urls from window.internalPages', async () => {
    const routablePages = {
      history: 'history.html',
    };
    routablePages['protocol-test'] = 'protocol-test.html';

    const mod = await loadModule(routablePages);

    expect(mod.internalPages).toEqual({
      history: 'file:///app/pages/history.html',
      'protocol-test': 'file:///app/pages/protocol-test.html',
    });
    expect(mod.homeUrl).toBe('https://pirate.sc/');
    expect(mod.errorUrlBase).toBe('file:///app/pages/error.html');
  });

  test('detects protocols for history recording', async () => {
    const mod = await loadModule();

    expect(mod.detectProtocol('ens://vitalik.eth')).toBe('ens');
    expect(mod.detectProtocol('bzz://hash')).toBe('swarm');
    expect(mod.detectProtocol('ipfs://cid')).toBe('ipfs');
    expect(mod.detectProtocol('ipns://name')).toBe('ipns');
    expect(mod.detectProtocol('rad://rid')).toBe('radicle');
    expect(mod.detectProtocol('https://example.com')).toBe('https');
    expect(mod.detectProtocol('http://example.com')).toBe('http');
    expect(mod.detectProtocol('')).toBe('unknown');
  });

  test('filters non-recordable history entries', async () => {
    const mod = await loadModule();

    expect(mod.isHistoryRecordable('', 'https://example.com')).toBe(false);
    expect(mod.isHistoryRecordable('freedom://history', 'file:///app/pages/history.html')).toBe(false);
    expect(mod.isHistoryRecordable('view-source:https://example.com', 'view-source:https://example.com')).toBe(false);
    expect(mod.isHistoryRecordable('https://example.com', 'file:///app/pages/error.html')).toBe(false);
    expect(mod.isHistoryRecordable('https://example.com', mod.homeUrl)).toBe(true);
    expect(mod.isHistoryRecordable('https://example.com', 'https://example.com')).toBe(true);
  });

  test('maps internal page urls back to freedom:// names', async () => {
    const mod = await loadModule({
      history: 'history.html',
      links: 'links.html',
    });

    expect(mod.getInternalPageName('file:///app/pages/history.html')).toBe('history');
    expect(mod.getInternalPageName('file:///app/pages/links.html')).toBe('links');
    expect(mod.getInternalPageName('https://example.com')).toBeNull();
  });

  test('parses ens inputs with prefixes, paths, and invalid names', async () => {
    const mod = await loadModule();

    expect(mod.parseEnsInput('ens://Vitalik.ETH/docs?q=1')).toEqual({
      name: 'vitalik.eth',
      suffix: '/docs?q=1',
    });
    expect(mod.parseEnsInput('name.box#top')).toEqual({
      name: 'name.box',
      suffix: '#top',
    });
    expect(mod.parseEnsInput('example.com')).toBeNull();
    expect(mod.parseEnsInput('')).toBeNull();
  });

  test('homeUrl defaults to ICANN URL', async () => {
    const mod = await loadModule();
    expect(mod.homeUrl).toBe('https://pirate.sc/');
    expect(mod.homeUrlNormalized).toBe('https://pirate.sc/');
  });

  test('isHnsHomeReady returns false when no registry state', async () => {
    const mod = await loadModule();
    expect(mod.isHnsHomeReady()).toBe(false);
  });

  test('isHomeUrl treats both ICANN and HNS homepages as equivalent', async () => {
    const mod = await loadModule();

    expect(mod.isHomeUrl('https://pirate.sc/')).toBe(true);
    expect(mod.isHomeUrl('https://pirate/')).toBe(true);
    expect(mod.isHomeUrl('https://pirate.sc/docs')).toBe(false);
    expect(mod.isHomeUrl('https://example.com')).toBe(false);
  });

  test('isHnsHomeReady returns false when HNS integration disabled', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: false,
      registry: {
        hns: { mode: 'bundled', canaryReady: true },
      },
    };
    expect(mod.isHnsHomeReady()).toBe(false);
    delete global.window.__rendererState;
  });

  test('isHnsHomeReady returns false when mode is not bundled', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'none', canaryReady: true },
      },
    };
    expect(mod.isHnsHomeReady()).toBe(false);
    delete global.window.__rendererState;
  });

  test('isHnsHomeReady returns false when canaryReady is false', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: false },
      },
    };
    expect(mod.isHnsHomeReady()).toBe(false);
    delete global.window.__rendererState;
  });

  test('isHnsHomeReady returns true when all conditions met', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: true },
      },
    };
    expect(mod.isHnsHomeReady()).toBe(true);
    delete global.window.__rendererState;
  });

  test('updateHomeUrl switches to HNS URL when ready', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: true },
      },
    };
    const changed = mod.updateHomeUrl();
    expect(changed).toBe(true);
    expect(mod.homeUrl).toBe('https://pirate/');
    expect(mod.homeUrlNormalized).toBe('https://pirate/');
    delete global.window.__rendererState;
  });

  test('updateHomeUrl keeps ICANN URL when not ready', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: false },
      },
    };
    const changed = mod.updateHomeUrl();
    expect(changed).toBe(false);
    expect(mod.homeUrl).toBe('https://pirate.sc/');
    delete global.window.__rendererState;
  });

  test('updateHomeUrl returns false when URL already matches', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: true },
      },
    };
    mod.updateHomeUrl();
    const changed = mod.updateHomeUrl();
    expect(changed).toBe(false);
    delete global.window.__rendererState;
  });

  test('updateHomeUrl reverts to ICANN when HNS becomes unavailable', async () => {
    const mod = await loadModule();
    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: true },
      },
    };
    mod.updateHomeUrl();
    expect(mod.homeUrl).toBe('https://pirate/');

    global.window.__rendererState = {
      enableHnsIntegration: true,
      registry: {
        hns: { mode: 'bundled', canaryReady: false },
      },
    };
    const changed = mod.updateHomeUrl();
    expect(changed).toBe(true);
    expect(mod.homeUrl).toBe('https://pirate.sc/');
    delete global.window.__rendererState;
  });
});
