const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalDocument = global.document;
const originalWindow = global.window;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const loadNetworkUi = async () => {
  jest.resetModules();

  const elements = {};
  [
    'anyone-toggle-btn',
    'anyone-toggle-switch',
    'anyone-info-panel',
    'anyone-menu-status-value',
    'anyone-menu-ip-row',
    'anyone-menu-ip-value',
    'anyone-menu-error-row',
    'anyone-menu-error-value',
    'hns-menu-status',
    'hns-open-pirate-btn',
    'sentinel-menu-status',
    'sentinel-fund-btn',
    'sentinel-connect-btn',
    'sentinel-disconnect-btn',
    'sentinel-menu-balance-row',
    'sentinel-menu-balance',
    'sentinel-funding-modal',
    'sentinel-funding-qr',
    'sentinel-funding-address',
    'close-sentinel-funding',
    'sentinel-funding-copy',
    'sentinel-funding-refresh',
    'sentinel-funding-balance',
    'sentinel-backup-reveal',
    'sentinel-backup-panel',
    'sentinel-backup-words',
    'sentinel-backup-copy',
  ].forEach((id) => {
    elements[id] = createElement(id.includes('qr') ? 'img' : 'div');
  });

  elements['sentinel-fund-btn'] = createElement('button');
  elements['sentinel-connect-btn'] = createElement('button');
  elements['sentinel-disconnect-btn'] = createElement('button');
  elements['close-sentinel-funding'] = createElement('button');
  elements['sentinel-funding-copy'] = createElement('button');
  elements['sentinel-funding-refresh'] = createElement('button');
  elements['sentinel-backup-reveal'] = createElement('button');
  elements['sentinel-backup-copy'] = createElement('button');
  elements['sentinel-backup-panel'].hidden = true;
  elements['sentinel-funding-modal'].showModal = jest.fn();
  elements['sentinel-funding-modal'].close = jest.fn();

  global.document = createDocument({ elementsById: elements });
  global.window = {
    anyone: {},
    hns: {},
    electronAPI: {
      copyText: jest.fn().mockResolvedValue({ success: true }),
    },
    dvpn: {
      getStatus: jest.fn().mockResolvedValue({ state: 'off' }),
      getBalance: jest.fn().mockResolvedValue({ success: true }),
      createWallet: jest.fn().mockResolvedValue({ success: true }),
      exportMnemonic: jest.fn().mockResolvedValue({
        success: true,
        mnemonic: 'alpha beta gamma delta',
      }),
      checkPrerequisites: jest.fn().mockResolvedValue({ success: true, ok: true }),
      generateQR: jest.fn().mockResolvedValue({
        success: true,
        dataUrl: 'data:image/png;base64,qr',
      }),
    },
  };

  const mod = await import('./network-ui.js');
  mod.initNetworkUi();

  return {
    elements,
    mod,
    window: global.window,
  };
};

describe('network-ui Sentinel controls', () => {
  afterEach(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('renders no-wallet, unfunded, and funded Sentinel states', async () => {
    const { elements, mod } = await loadNetworkUi();

    mod.updateSentinelMenuDisplay({ state: 'off' });

    expect(elements['sentinel-menu-status'].textContent).toBe('Setup required');
    expect(elements['sentinel-menu-balance'].textContent).toBe('-');
    expect(elements['sentinel-menu-balance-row'].style.display).toBe('');
    expect(elements['sentinel-fund-btn'].style.display).toBe('inline-flex');
    expect(elements['sentinel-fund-btn'].textContent).toBe('Setup Wallet');
    expect(elements['sentinel-connect-btn'].style.display).toBe('none');

    mod.updateSentinelMenuDisplay({
      state: 'wallet_ready',
      walletAddress: 'sentinel1unfunded',
      funded: false,
    });

    expect(elements['sentinel-menu-status'].textContent).toBe('Needs P2P');
    expect(elements['sentinel-menu-balance'].textContent).toBe('0 P2P');
    expect(elements['sentinel-fund-btn'].textContent).toBe('Add P2P');

    mod.updateSentinelMenuDisplay({
      state: 'wallet_ready',
      walletAddress: 'sentinel1funded',
      funded: true,
      balance: '2.5',
    });

    expect(elements['sentinel-menu-status'].textContent).toBe('Ready');
    expect(elements['sentinel-menu-balance'].textContent).toBe('2.5 P2P');
    expect(elements['sentinel-fund-btn'].style.display).toBe('none');
    expect(elements['sentinel-connect-btn'].style.display).toBe('inline-flex');
  });

  test('renders Sentinel errors before funding prompts', async () => {
    const { elements, mod } = await loadNetworkUi();

    mod.updateSentinelMenuDisplay({
      state: 'error',
      walletAddress: 'sentinel1error',
      funded: false,
      error: 'balance lookup failed',
    });

    expect(elements['sentinel-menu-status'].textContent).toBe('Error · balance lookup failed');
    expect(elements['sentinel-fund-btn'].textContent).toBe('Add P2P');
  });

  test('disables Sentinel actions when prerequisites are missing', async () => {
    const { elements, mod } = await loadNetworkUi();

    mod.updateSentinelMenuDisplay({
      state: 'wallet_ready',
      walletAddress: 'sentinel1funded',
      funded: true,
      balance: '2.5',
      prerequisites: { ok: false, error: 'V2Ray is missing' },
    });

    expect(elements['sentinel-menu-status'].textContent).toBe('Unavailable');
    expect(elements['sentinel-connect-btn'].style.display).toBe('none');
  });

  test('opens funding modal, creates wallet, copies address, and refreshes balance', async () => {
    const { elements, window } = await loadNetworkUi();

    window.dvpn.getStatus
      .mockResolvedValueOnce({ state: 'off' })
      .mockResolvedValueOnce({
        state: 'wallet_ready',
        walletAddress: 'sentinel1new',
        funded: false,
      })
      .mockResolvedValueOnce({
        state: 'wallet_ready',
        walletAddress: 'sentinel1new',
        balance: '1.25',
        funded: true,
      });

    elements['sentinel-fund-btn'].handlers.click[0]();
    await flushMicrotasks();

    expect(elements['sentinel-funding-modal'].showModal).toHaveBeenCalled();
    expect(window.dvpn.createWallet).toHaveBeenCalled();
    expect(window.dvpn.generateQR).toHaveBeenCalledWith('sentinel1new', {
      width: 192,
      margin: 1,
    });
    expect(elements['sentinel-funding-address'].textContent).toBe('sentinel1new');
    expect(elements['sentinel-funding-balance'].textContent).toBe('0 P2P');
    expect(elements['sentinel-funding-qr'].src).toBe('data:image/png;base64,qr');

    await elements['sentinel-funding-copy'].handlers.click[0]();

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('sentinel1new');

    await elements['sentinel-backup-reveal'].handlers.click[0]();

    expect(window.dvpn.exportMnemonic).toHaveBeenCalled();
    expect(elements['sentinel-backup-panel'].hidden).toBe(false);
    expect(elements['sentinel-backup-words'].children).toHaveLength(4);

    await elements['sentinel-backup-copy'].handlers.click[0]();

    expect(window.electronAPI.copyText).toHaveBeenCalledWith('alpha beta gamma delta');

    elements['sentinel-funding-refresh'].handlers.click[0]();
    await flushMicrotasks();

    expect(window.dvpn.getBalance).toHaveBeenCalled();
    expect(elements['sentinel-funding-balance'].textContent).toBe('1.25 P2P');
    expect(elements['sentinel-menu-status'].textContent).toBe('Ready');
  });
});
