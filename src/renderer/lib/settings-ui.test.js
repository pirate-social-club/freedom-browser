const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalCustomEvent = global.CustomEvent;
const originalNavigator = global.navigator;

const createCheckbox = () => {
  const checkbox = createElement('input');
  checkbox.checked = false;
  checkbox.disabled = false;
  return checkbox;
};

const loadSettingsModule = async (options = {}) => {
  jest.resetModules();

  const {
    platform = 'darwin',
    settingsResponses = [
      {
        theme: 'system',
        startBeeAtLaunch: true,
        startIpfsAtLaunch: true,
        enableRadicleIntegration: false,
        startRadicleAtLaunch: false,
        enableHnsIntegration: true,
        startHnsAtLaunch: true,
        enableIdentityWallet: false,
        autoUpdate: true,
        enableAnyone: false,
        anyoneAutoStart: false,
        dvpnMaxSpendP2P: 50.0,
        dvpnLowBalanceStop: 0.5,
        dvpnMaxDurationMinutes: 120,
      },
    ],
    saveSettingsResult = true,
    prefersDark = true,
  } = options;

  const settingsQueue = [...settingsResponses];
  const settingsBtn = createElement('button');
  const settingsModal = createElement('dialog');
  const closeSettingsBtn = createElement('button');
  const themeModeSelect = createElement('select');
  const startBeeAtLaunchCheckbox = createCheckbox();
  const startIpfsAtLaunchCheckbox = createCheckbox();
  const enableRadicleIntegrationCheckbox = createCheckbox();
  const startRadicleRow = createElement('div');
  const startRadicleAtLaunchCheckbox = createCheckbox();
  const autoUpdateCheckbox = createCheckbox();
  const experimentalSection = createElement('section');
  const enableHnsIntegrationCheckbox = createCheckbox();
  const startHnsRow = createElement('div');
  const startHnsAtLaunchCheckbox = createCheckbox();
  const enableIdentityWalletCheckbox = createCheckbox();
  const enableAnyoneCheckbox = createCheckbox();
  const startAnyoneRow = createElement('div');
  const anyoneAutoStartCheckbox = createCheckbox();
  const dvpnMaxSpend = createElement('input');
  const dvpnLowBalanceStop = createElement('input');
  const dvpnMaxDuration = createElement('input');
  const mediaQueryList = {
    matches: prefersDark,
    addEventListener: jest.fn(),
  };
  const document = createDocument({
    elementsById: {
      'settings-btn': settingsBtn,
      'settings-modal': settingsModal,
      'close-settings': closeSettingsBtn,
      'theme-mode': themeModeSelect,
      'start-bee-at-launch': startBeeAtLaunchCheckbox,
      'start-ipfs-at-launch': startIpfsAtLaunchCheckbox,
      'enable-radicle-integration': enableRadicleIntegrationCheckbox,
      'start-radicle-row': startRadicleRow,
      'start-radicle-at-launch': startRadicleAtLaunchCheckbox,
      'auto-update': autoUpdateCheckbox,
      'experimental-section': experimentalSection,
      'enable-hns-integration': enableHnsIntegrationCheckbox,
      'start-hns-row': startHnsRow,
      'start-hns-at-launch': startHnsAtLaunchCheckbox,
      'enable-identity-wallet': enableIdentityWalletCheckbox,
      'enable-anyone': enableAnyoneCheckbox,
      'start-anyone-row': startAnyoneRow,
      'anyone-auto-start': anyoneAutoStartCheckbox,
      'dvpn-max-spend': dvpnMaxSpend,
      'dvpn-low-balance-stop': dvpnLowBalanceStop,
      'dvpn-max-duration': dvpnMaxDuration,
    },
  });
  const settingsUpdatedEvents = [];
  const radicleStopResult = {
    catch: jest.fn(),
  };
  const electronAPI = {
    getSettings: jest.fn().mockImplementation(async () => {
      if (settingsQueue.length === 0) {
        return settingsResponses[settingsResponses.length - 1] || null;
      }
      return settingsQueue.shift();
    }),
    saveSettings: jest.fn().mockImplementation(async () => saveSettingsResult),
    getPlatform: jest.fn().mockResolvedValue(platform),

  };
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const menuMocks = {
    setMenuOpen: jest.fn(),
  };

  settingsModal.showModal = jest.fn();
  settingsModal.close = jest.fn();
  document.documentElement = {
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
  };

  global.window = {
    electronAPI,
    matchMedia: jest.fn(() => mediaQueryList),
    dispatchEvent: jest.fn((event) => {
      settingsUpdatedEvents.push(event);
    }),
    radicle: {
      stop: jest.fn(() => radicleStopResult),
    },
    hns: {
      start: jest.fn(() => ({ catch: jest.fn() })),
      stop: jest.fn(() => ({ catch: jest.fn() })),
      getStatus: jest.fn().mockResolvedValue({ status: 'stopped', height: 0, synced: false, error: null }),
      onStatusUpdate: jest.fn(),
    },
    anyone: {
      start: jest.fn(() => ({ catch: jest.fn() })),
      stop: jest.fn(() => ({ catch: jest.fn() })),
      getStatus: jest.fn().mockResolvedValue({
        state: 'off',
        connected: false,
        proxy: null,
        socksPort: null,
        controlPort: null,
        circuitState: null,
        ip: null,
        error: null,
      }),
      onStatusUpdate: jest.fn(),
    },
    dvpn: {
      start: jest.fn(),
      stop: jest.fn(() => ({ catch: jest.fn() })),
      getStatus: jest.fn().mockResolvedValue({
        state: 'off',
        walletAddress: null,
        connected: false,
        balance: null,
        funded: false,
        lastDisconnectReason: null,
        error: null,
      }),
      onStatusUpdate: jest.fn(),
    },
  };
  global.document = document;
  global.CustomEvent = jest.fn((type, init) => ({
    type,
    detail: init.detail,
  }));
  global.navigator = {
    clipboard: {
      writeText: jest.fn().mockResolvedValue(undefined),
    },
  };

  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./menus.js', () => menuMocks);

  const mod = await import('./settings-ui.js');

  return {
    mod,
    elements: {
      settingsBtn,
      settingsModal,
      closeSettingsBtn,
      themeModeSelect,
      startBeeAtLaunchCheckbox,
      startIpfsAtLaunchCheckbox,
      enableRadicleIntegrationCheckbox,
      startRadicleRow,
      startRadicleAtLaunchCheckbox,
      autoUpdateCheckbox,
      experimentalSection,
      enableHnsIntegrationCheckbox,
      startHnsAtLaunchCheckbox,
      enableIdentityWalletCheckbox,
      enableAnyoneCheckbox,
      startAnyoneRow,
      anyoneAutoStartCheckbox,

    },
    electronAPI,
    mediaQueryList,
    settingsUpdatedEvents,
    radicleStopResult,
    debugMocks,
    menuMocks,
    documentElement: document.documentElement,
  };
};

describe('settings-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    global.navigator = originalNavigator;
    jest.restoreAllMocks();
  });

  test('applies light and dark themes and reacts to system theme changes', async () => {
    const { mod, mediaQueryList, documentElement, electronAPI } = await loadSettingsModule({
      settingsResponses: [
        {
          theme: 'system',
          enableRadicleIntegration: true,
          enableHnsIntegration: true,
          startHnsAtLaunch: true,
          enableIdentityWallet: false,
        },
      ],
      prefersDark: true,
    });

    mod.applyTheme('light');
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');

    mod.applyTheme('dark');
    expect(documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');

    await mod.initTheme();

    expect(electronAPI.getSettings).toHaveBeenCalledTimes(1);
    expect(documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');
    expect(mediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    mediaQueryList.matches = false;
    mediaQueryList.addEventListener.mock.calls[0][1]();

    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
  });

  test('initializes settings modal and saves updated settings successfully', async () => {
    const onSettingsChanged = jest.fn();
    const { mod, elements, electronAPI, settingsUpdatedEvents, radicleStopResult, debugMocks, menuMocks, documentElement } =
      await loadSettingsModule({
        platform: 'darwin',
        settingsResponses: [
          {
            theme: 'dark',
            enableRadicleIntegration: true,
            enableHnsIntegration: true,
            startHnsAtLaunch: true,
            enableIdentityWallet: false,
            enableAnyone: false,
            anyoneAutoStart: false,
                dvpnMaxSpendP2P: 50.0,
            dvpnLowBalanceStop: 0.5,
            dvpnMaxDurationMinutes: 120,
          },
          {
            theme: 'dark',
            startBeeAtLaunch: true,
            startIpfsAtLaunch: false,
            enableRadicleIntegration: true,
            startRadicleAtLaunch: true,
            enableHnsIntegration: true,
            startHnsAtLaunch: true,
            enableIdentityWallet: false,
            autoUpdate: false,
            enableAnyone: true,
            anyoneAutoStart: true,
                dvpnMaxSpendP2P: 50.0,
            dvpnLowBalanceStop: 0.5,
            dvpnMaxDurationMinutes: 120,
          },
        ],
        saveSettingsResult: true,
        prefersDark: true,
      });

    mod.setOnSettingsChanged(onSettingsChanged);
    await mod.initTheme();
    await mod.initSettings();

    elements.settingsBtn.dispatch('click');
    await Promise.resolve();

    expect(menuMocks.setMenuOpen).toHaveBeenCalledWith(false);
    expect(elements.themeModeSelect.value).toBe('dark');
    expect(elements.startBeeAtLaunchCheckbox.checked).toBe(true);
    expect(elements.startIpfsAtLaunchCheckbox.checked).toBe(false);
    expect(elements.enableRadicleIntegrationCheckbox.checked).toBe(true);
    expect(elements.startRadicleAtLaunchCheckbox.checked).toBe(true);
    expect(elements.enableHnsIntegrationCheckbox.checked).toBe(true);
    expect(elements.startHnsAtLaunchCheckbox.checked).toBe(true);
    expect(elements.enableIdentityWalletCheckbox.checked).toBe(false);
    expect(elements.enableAnyoneCheckbox.checked).toBe(true);
    expect(elements.anyoneAutoStartCheckbox.checked).toBe(true);
    expect(elements.autoUpdateCheckbox.checked).toBe(false);
    expect(elements.startRadicleAtLaunchCheckbox.disabled).toBe(false);
    expect(elements.startHnsAtLaunchCheckbox.disabled).toBe(false);
    expect(elements.settingsModal.showModal).toHaveBeenCalled();

    elements.themeModeSelect.value = 'light';
    elements.startBeeAtLaunchCheckbox.checked = false;
    elements.startIpfsAtLaunchCheckbox.checked = true;
    elements.enableRadicleIntegrationCheckbox.checked = false;
    elements.startRadicleAtLaunchCheckbox.checked = true;
    elements.enableHnsIntegrationCheckbox.checked = true;
    elements.startHnsAtLaunchCheckbox.checked = true;
    elements.enableIdentityWalletCheckbox.checked = false;
    elements.enableAnyoneCheckbox.checked = true;
    elements.anyoneAutoStartCheckbox.checked = true;
    elements.autoUpdateCheckbox.checked = true;
    elements.enableRadicleIntegrationCheckbox.dispatch('change');
    await Promise.resolve();

    expect(elements.startRadicleRow.classList.toggle).toHaveBeenCalledWith('disabled', true);
    expect(elements.startRadicleAtLaunchCheckbox.disabled).toBe(true);
    expect(electronAPI.saveSettings).toHaveBeenCalledWith({
      theme: 'light',
      startBeeAtLaunch: false,
      startIpfsAtLaunch: true,
      enableRadicleIntegration: false,
      startRadicleAtLaunch: true,
      enableHnsIntegration: true,
      startHnsAtLaunch: true,
      enableIdentityWallet: false,
      autoUpdate: true,
      enableAnyone: true,
      anyoneAutoStart: true,
      dvpnMaxSpendP2P: 50,
      dvpnLowBalanceStop: 0.5,
      dvpnMaxDurationMinutes: 120,
    });
    expect(global.window.radicle.stop).toHaveBeenCalled();
    expect(radicleStopResult.catch).toHaveBeenCalledWith(expect.any(Function));
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Settings saved');
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(settingsUpdatedEvents).toContainEqual({
      type: 'settings:updated',
      detail: {
        theme: 'light',
        startBeeAtLaunch: false,
        startIpfsAtLaunch: true,
        enableRadicleIntegration: false,
        startRadicleAtLaunch: true,
        enableHnsIntegration: true,
        startHnsAtLaunch: true,
        enableIdentityWallet: false,
        autoUpdate: true,
        enableAnyone: true,
        anyoneAutoStart: true,
        dvpnMaxSpendP2P: 50,
        dvpnLowBalanceStop: 0.5,
        dvpnMaxDurationMinutes: 120,
      },
    });
    expect(onSettingsChanged).toHaveBeenCalled();
  });

  test('handles windows-specific settings behavior and failed saves', async () => {
    const { mod, elements, electronAPI, debugMocks } = await loadSettingsModule({
      platform: 'win32',
      settingsResponses: [
        {
          theme: 'system',
          enableRadicleIntegration: false,
          enableHnsIntegration: true,
          startHnsAtLaunch: true,
          enableIdentityWallet: false,
          enableAnyone: false,
          anyoneAutoStart: false,
            dvpnMaxSpendP2P: 50.0,
          dvpnLowBalanceStop: 0.5,
          dvpnMaxDurationMinutes: 120,
        },
        {
          theme: 'system',
          startBeeAtLaunch: false,
          startIpfsAtLaunch: false,
          enableRadicleIntegration: true,
          startRadicleAtLaunch: true,
          enableHnsIntegration: true,
          startHnsAtLaunch: true,
          enableIdentityWallet: false,
          autoUpdate: true,
          enableAnyone: false,
          anyoneAutoStart: false,
            dvpnMaxSpendP2P: 50.0,
          dvpnLowBalanceStop: 0.5,
          dvpnMaxDurationMinutes: 120,
        },
        ],
      saveSettingsResult: false,
      prefersDark: false,
    });

    await mod.initTheme();
    await mod.initSettings();

    expect(elements.experimentalSection.style.display).toBe('none');

    elements.settingsBtn.dispatch('click');
    await Promise.resolve();

    elements.enableRadicleIntegrationCheckbox.checked = true;
    elements.startRadicleAtLaunchCheckbox.checked = true;
    elements.autoUpdateCheckbox.checked = false;
    elements.autoUpdateCheckbox.dispatch('change');
    await Promise.resolve();

    expect(electronAPI.saveSettings).toHaveBeenCalledWith({
      theme: 'system',
      startBeeAtLaunch: false,
      startIpfsAtLaunch: false,
      enableRadicleIntegration: false,
      startRadicleAtLaunch: false,
      enableHnsIntegration: true,
      startHnsAtLaunch: true,
      enableIdentityWallet: false,
      autoUpdate: false,
      enableAnyone: false,
      anyoneAutoStart: false,
      dvpnMaxSpendP2P: 50,
      dvpnLowBalanceStop: 0.5,
      dvpnMaxDurationMinutes: 120,
    });
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Failed to save settings');

    elements.closeSettingsBtn.dispatch('click');
    expect(elements.settingsModal.close).toHaveBeenCalledTimes(1);

    elements.settingsModal.dispatch('click', { target: elements.settingsModal });
    expect(elements.settingsModal.close).toHaveBeenCalledTimes(2);
  });

  test('connects and disconnects Anyone through the settings controls', async () => {
    const { mod, elements } = await loadSettingsModule({
      settingsResponses: [
        {
          theme: 'system',
          startBeeAtLaunch: true,
          startIpfsAtLaunch: true,
          enableRadicleIntegration: false,
          startRadicleAtLaunch: false,
          enableHnsIntegration: true,
          startHnsAtLaunch: true,
          enableIdentityWallet: false,
          autoUpdate: true,
          enableAnyone: true,
          anyoneAutoStart: false,
            dvpnMaxSpendP2P: 50.0,
          dvpnLowBalanceStop: 0.5,
          dvpnMaxDurationMinutes: 120,
        },
      ],
    });

    await mod.initTheme();
    await mod.initSettings();

    elements.settingsBtn.dispatch('click');
    await Promise.resolve();

    elements.enableAnyoneCheckbox.checked = false;
    elements.enableAnyoneCheckbox.dispatch('change');
    await Promise.resolve();

    elements.enableAnyoneCheckbox.checked = true;
    elements.enableAnyoneCheckbox.dispatch('change');
    await Promise.resolve();

    expect(window.anyone.stop).toHaveBeenCalled();
    expect(window.anyone.start).toHaveBeenCalled();
  });
});
