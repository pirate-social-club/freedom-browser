const {
  createAppMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function loadSanitizer(options = {}) {
  const app = createAppMock({ userDataDir: options.userDataDir || '/tmp/freedom-user-data' });
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
  };
  const history = {
    getAllHistory: jest.fn(() => options.historyEntries || []),
    removeHistoryEntry: jest.fn((id) => !(options.failedRemovals || []).includes(id)),
  };

  const { mod } = loadMainModule(require.resolve('./browser-state-sanitizer'), {
    app,
    extraMocks: {
      [require.resolve('./logger')]: () => log,
      [require.resolve('./history')]: () => history,
    },
  });

  return {
    mod,
    app,
    history,
    log,
  };
}

describe('browser-state-sanitizer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('classifies unknown single-label URLs without treating known HNS roots as stale', () => {
    const { mod } = loadSanitizer();
    const isKnownHnsHost = jest.fn((hostname) => hostname === 'pirate');

    expect(mod.isUnknownSingleLabelUrl('https://unknown-single-label/', isKnownHnsHost)).toBe(true);
    expect(mod.isUnknownSingleLabelUrl('https://pirate/', isKnownHnsHost)).toBe(false);
    expect(mod.isUnknownSingleLabelUrl('https://app.pirate/', isKnownHnsHost)).toBe(false);
    expect(mod.isUnknownSingleLabelUrl('https://localhost/', isKnownHnsHost)).toBe(false);
  });

  test('clears persisted Chromium Session Storage from the active profile', () => {
    const { mod } = loadSanitizer({ userDataDir: '/profile' });
    const fsImpl = {
      existsSync: jest.fn(() => true),
      rmSync: jest.fn(),
    };
    const pathImpl = {
      join: jest.fn((...parts) => parts.join('/')),
    };

    expect(mod.clearPersistedSessionStorage({ fsImpl, pathImpl })).toBe(true);

    expect(fsImpl.rmSync).toHaveBeenCalledWith('/profile/Session Storage', {
      recursive: true,
      force: true,
    });
  });

  test('clears persisted browser request replay state without touching durable site data', () => {
    const { mod } = loadSanitizer({ userDataDir: '/profile' });
    const existingPaths = new Set([
      '/profile/Session Storage',
      '/profile/Service Worker',
      '/profile/Network Persistent State',
    ]);
    const fsImpl = {
      existsSync: jest.fn((target) => existingPaths.has(target)),
      rmSync: jest.fn(),
    };
    const pathImpl = {
      join: jest.fn((...parts) => parts.join('/')),
    };

    expect(mod.clearPersistedBrowserRequestState({ fsImpl, pathImpl })).toEqual([
      'Session Storage',
      'Service Worker',
      'Network Persistent State',
    ]);

    expect(fsImpl.rmSync).toHaveBeenCalledWith('/profile/Session Storage', {
      recursive: true,
      force: true,
    });
    expect(fsImpl.rmSync).toHaveBeenCalledWith('/profile/Service Worker', {
      recursive: true,
      force: true,
    });
    expect(fsImpl.rmSync).toHaveBeenCalledWith('/profile/Network Persistent State', {
      recursive: true,
      force: true,
    });
    expect(fsImpl.rmSync).not.toHaveBeenCalledWith(
      '/profile/Local Storage',
      expect.anything()
    );
    expect(fsImpl.rmSync).not.toHaveBeenCalledWith('/profile/Cookies', expect.anything());
  });

  test('prunes unknown single-label history entries only', () => {
    const { mod, history } = loadSanitizer({
      historyEntries: [
        { id: 1, url: 'https://unknown-single-label/' },
        { id: 2, url: 'https://pirate/' },
        { id: 3, url: 'https://example.com/' },
      ],
    });
    const isKnownHnsHost = jest.fn((hostname) => hostname === 'pirate');

    expect(mod.pruneUnknownSingleLabelHistory({ isKnownHnsHost })).toBe(1);
    expect(history.removeHistoryEntry).toHaveBeenCalledWith(1);
    expect(history.removeHistoryEntry).not.toHaveBeenCalledWith(2);
    expect(history.removeHistoryEntry).not.toHaveBeenCalledWith(3);
  });
});
