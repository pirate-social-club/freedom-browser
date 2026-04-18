const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalDocument = global.document;
const originalWindow = global.window;

function loadHomePageModule(options = {}) {
  jest.resetModules();

  const destination = createElement('span');
  const status = createElement('span');
  const heightRow = createElement('div');
  const height = createElement('span');
  const openLink = createElement('a');
  const note = createElement('span');

  const document = createDocument({
    elementsById: {
      'home-destination': destination,
      'home-status': status,
      'home-height-row': heightRow,
      'home-height': height,
      'home-open-link': openLink,
      'home-note': note,
    },
  });

  let registryHandler = null;
  const freedomAPI = {
    getSettings: jest.fn().mockResolvedValue(
      options.settings || { enableHnsIntegration: true }
    ),
    getServiceRegistry: jest.fn().mockResolvedValue(options.registry || {}),
    onServiceRegistryUpdate: jest.fn((callback) => {
      registryHandler = callback;
      return jest.fn();
    }),
  };

  const replace = jest.fn();

  global.document = document;
  global.window = {
    freedomAPI,
    location: {
      replace,
    },
  };

  require('./home.js');

  return {
    destination,
    document,
    freedomAPI,
    height,
    heightRow,
    note,
    openLink,
    registryHandler,
    replace,
    status,
  };
}

describe('home page bootstrap', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    global.document = originalDocument;
    global.window = originalWindow;
    jest.restoreAllMocks();
  });

  test('shows pirate.sc fallback while HNS is not ready', async () => {
    const ctx = loadHomePageModule({
      registry: {
        hns: {
          mode: 'bundled',
          canaryReady: false,
          height: 325297,
          statusMessage: 'Syncing block 325297',
        },
      },
    });

    await ctx.document.handlers.DOMContentLoaded();

    expect(ctx.destination.textContent).toBe('pirate.sc');
    expect(ctx.status.textContent).toBe('Syncing block 325297');
    expect(ctx.heightRow.hidden).toBe(false);
    expect(ctx.height.textContent).toBe('325297');
    expect(ctx.openLink.href).toBe('https://pirate.sc/');
    expect(ctx.note.textContent).toBe('Using pirate.sc until HNS is ready.');
    expect(ctx.replace).not.toHaveBeenCalled();
  });

  test('redirects to pirate once bundled HNS is ready', async () => {
    const ctx = loadHomePageModule({
      registry: {
        hns: {
          mode: 'bundled',
          canaryReady: true,
          height: 325297,
        },
      },
    });

    await ctx.document.handlers.DOMContentLoaded();

    expect(ctx.destination.textContent).toBe('pirate');
    expect(ctx.status.textContent).toBe('Ready');
    expect(ctx.openLink.href).toBe('https://pirate/');
    expect(ctx.note.textContent).toBe('Opening pirate/');

    jest.advanceTimersByTime(350);

    expect(ctx.replace).toHaveBeenCalledWith('https://pirate/');
  });

  test('stays on pirate.sc when HNS integration is disabled', async () => {
    const ctx = loadHomePageModule({
      settings: {
        enableHnsIntegration: false,
      },
      registry: {
        hns: {
          mode: 'bundled',
          canaryReady: true,
          height: 325297,
        },
      },
    });

    await ctx.document.handlers.DOMContentLoaded();

    expect(ctx.destination.textContent).toBe('pirate.sc');
    expect(ctx.status.textContent).toBe('Disabled');
    expect(ctx.openLink.href).toBe('https://pirate.sc/');
    expect(ctx.note.textContent).toBe('HNS is off. Using the web fallback.');
    expect(ctx.replace).not.toHaveBeenCalled();
  });
});
