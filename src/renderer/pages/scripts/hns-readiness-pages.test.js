function element() {
  return { textContent: '' };
}

function installPage({ pendingUrl = null, registry = {} } = {}) {
  const elements = new Map();
  global.document = {
    getElementById: jest.fn((id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }),
  };
  global.location = { replace: jest.fn() };
  let registryListener;
  global.window = {
    freedomAPI: {
      getPendingHnsNavigation: jest.fn(async () => pendingUrl),
      getServiceRegistry: jest.fn(async () => registry),
      onServiceRegistryUpdated: jest.fn((listener) => { registryListener = listener; }),
    },
  };
  return { elements, getRegistryListener: () => registryListener };
}

describe('HNS readiness pages', () => {
  afterEach(() => {
    jest.resetModules();
    delete global.document;
    delete global.location;
    delete global.window;
  });

  test('home reports sync height and opens app.pirate only when ready', async () => {
    const page = installPage({
      registry: { hns: { mode: 'bundled', synced: false, height: 12345, api: null } },
    });
    require('./hns-home');
    await Promise.resolve();
    await Promise.resolve();

    expect(page.elements.get('hns-home-detail').textContent).toContain('12345');
    expect(global.location.replace).not.toHaveBeenCalled();
    page.getRegistryListener()({
      hns: { mode: 'bundled', synced: true, height: 12346, api: 'http://127.0.0.1:44041' },
    });
    expect(global.location.replace).toHaveBeenCalledWith('https://app.pirate/');
  });

  test('interstitial displays only the hostname and resumes the held navigation on ready', async () => {
    const target = 'https://app.pirate/private?token=secret';
    const page = installPage({
      pendingUrl: target,
      registry: { hns: { mode: 'bundled', synced: false, height: 54321, api: null } },
    });
    require('./hns-syncing');
    await Promise.resolve();
    await Promise.resolve();

    expect(page.elements.get('destination').textContent).toBe('app.pirate');
    expect(page.elements.get('destination').textContent).not.toContain('secret');
    expect(page.elements.get('detail').textContent).toContain('54321');
    page.getRegistryListener()({
      hns: { mode: 'bundled', synced: true, api: 'http://127.0.0.1:44041' },
    });
    expect(global.location.replace).toHaveBeenCalledWith(target);
  });
});
