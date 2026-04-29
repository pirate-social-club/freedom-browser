const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalDocument = global.document;
const originalWindow = global.window;

function loadHomePageModule(options = {}) {
  jest.resetModules();

  const anyoneStatus = createElement('div');
  const anyoneToggle = createElement('button');
  const sentinelStatus = createElement('div');
  const sentinelFund = createElement('button');
  const sentinelConnect = createElement('button');
  const sentinelDisconnect = createElement('button');
  const sentinelFunding = createElement('div');
  const sentinelAddress = createElement('code');
  const sentinelQr = createElement('img');
  const sentinelCopy = createElement('button');
  const sentinelBalance = createElement('span');
  const sentinelRefresh = createElement('button');
  const sentinelBackupReveal = createElement('button');
  const sentinelBackupPanel = createElement('div');
  const sentinelBackupWords = createElement('div');
  const sentinelBackupCopy = createElement('button');
  const handshakeStatus = createElement('div');
  sentinelBackupPanel.hidden = true;

  const document = createDocument({
    elementsById: {
      'anyone-status': anyoneStatus,
      'anyone-toggle': anyoneToggle,
      'sentinel-status': sentinelStatus,
      'sentinel-fund': sentinelFund,
      'sentinel-connect': sentinelConnect,
      'sentinel-disconnect': sentinelDisconnect,
      'sentinel-funding': sentinelFunding,
      'sentinel-address': sentinelAddress,
      'sentinel-qr': sentinelQr,
      'sentinel-copy': sentinelCopy,
      'sentinel-balance': sentinelBalance,
      'sentinel-refresh': sentinelRefresh,
      'sentinel-backup-reveal': sentinelBackupReveal,
      'sentinel-backup-panel': sentinelBackupPanel,
      'sentinel-backup-words': sentinelBackupWords,
      'sentinel-backup-copy': sentinelBackupCopy,
      'handshake-status': handshakeStatus,
    },
  });

  let registryHandler = null;
  let anyoneHandler = null;
  let dvpnHandler = null;
  const freedomAPI = {
    getSettings: jest.fn().mockResolvedValue(options.settings || { enableHnsIntegration: true }),
    getServiceRegistry: jest.fn().mockResolvedValue(options.registry || {}),
    onServiceRegistryUpdate: jest.fn((callback) => {
      registryHandler = callback;
      return jest.fn();
    }),
    getAnyoneStatus: jest.fn().mockResolvedValue(options.anyoneStatus || { state: 'off' }),
    startAnyone: jest.fn().mockResolvedValue({ status: { state: 'connected', ip: '185.1.2.3' } }),
    stopAnyone: jest.fn().mockResolvedValue({ status: { state: 'off' } }),
    onAnyoneStatusUpdate: jest.fn((callback) => {
      anyoneHandler = callback;
      return jest.fn();
    }),
    getDvpnStatus: jest.fn().mockResolvedValue(options.dvpnStatus || { state: 'off' }),
    getDvpnBalance: jest.fn().mockResolvedValue({ success: false }),
    startDvpn: jest.fn().mockResolvedValue({ success: true, status: { state: 'connected' } }),
    stopDvpn: jest.fn().mockResolvedValue({ success: true, status: { state: 'wallet_ready' } }),
    createDvpnWallet: jest.fn().mockResolvedValue({ success: true }),
    generateDvpnQR: jest.fn().mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,qr' }),
    copyText: jest.fn().mockResolvedValue({ success: true }),
    exportDvpnMnemonic: jest.fn().mockResolvedValue({
      success: true,
      mnemonic: 'alpha beta gamma delta',
    }),
    checkDvpnPrerequisites: jest.fn().mockResolvedValue(
      options.dvpnPrerequisites || { success: true, ok: true }
    ),
    onDvpnStatusUpdate: jest.fn((callback) => {
      dvpnHandler = callback;
      return jest.fn();
    }),
  };

  global.document = document;
  global.window = { freedomAPI };

  require('./home.js');

  return {
    anyoneHandler,
    anyoneStatus,
    anyoneToggle,
    document,
    dvpnHandler,
    freedomAPI,
    handshakeStatus,
    registryHandler,
    sentinelAddress,
    sentinelBalance,
    sentinelBackupCopy,
    sentinelBackupPanel,
    sentinelBackupReveal,
    sentinelBackupWords,
    sentinelCopy,
    sentinelConnect,
    sentinelDisconnect,
    sentinelFund,
    sentinelFunding,
    sentinelQr,
    sentinelRefresh,
    sentinelStatus,
  };
}

describe('home page controls', () => {
  afterEach(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    jest.restoreAllMocks();
  });

  test('renders Anyone, Sentinel, and Handshake status on new tab', async () => {
    const ctx = loadHomePageModule({
      registry: {
        hns: {
          mode: 'bundled',
          canaryReady: true,
          height: 327152,
        },
      },
      anyoneStatus: { state: 'connected', ip: '185.1.2.3' },
      dvpnStatus: {
        state: 'wallet_ready',
        walletAddress: 'sentinel1address',
        balance: '2.5',
        funded: true,
      },
    });

    await ctx.document.handlers.DOMContentLoaded();

    expect(ctx.anyoneStatus.textContent).toBe('On · exit 185.1.2.3');
    expect(ctx.anyoneToggle.textContent).toBe('Turn off');
    expect(ctx.sentinelStatus.textContent).toBe('Ready · 2.5 P2P');
    expect(ctx.sentinelConnect.style.display).toBe('');
    expect(ctx.sentinelFund.style.display).toBe('none');
    expect(ctx.handshakeStatus.textContent).toBe('Ready · block 327152');
  });

  test('toggles Anyone from the new tab page', async () => {
    const ctx = loadHomePageModule({
      anyoneStatus: { state: 'off' },
    });

    await ctx.document.handlers.DOMContentLoaded();
    await ctx.anyoneToggle.handlers.click[0]();

    expect(ctx.freedomAPI.startAnyone).toHaveBeenCalled();
    expect(ctx.anyoneStatus.textContent).toBe('On · exit 185.1.2.3');
  });

  test('creates and displays Sentinel funding details', async () => {
    const ctx = loadHomePageModule({
      dvpnStatus: { state: 'off' },
    });

    ctx.freedomAPI.getDvpnStatus
      .mockResolvedValueOnce({ state: 'off' })
      .mockResolvedValueOnce({ state: 'off' })
      .mockResolvedValueOnce({ state: 'wallet_ready', walletAddress: 'sentinel1new', funded: false });

    await ctx.document.handlers.DOMContentLoaded();
    ctx.sentinelFund.handlers.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.freedomAPI.createDvpnWallet).toHaveBeenCalled();
    expect(ctx.freedomAPI.generateDvpnQR).toHaveBeenCalledWith('sentinel1new', {
      width: 168,
      margin: 1,
    });
    expect(ctx.sentinelAddress.textContent).toBe('sentinel1new');
    expect(ctx.sentinelBalance.textContent).toBe('0 P2P');
    expect(ctx.sentinelQr.src).toBe('data:image/png;base64,qr');
    expect(ctx.sentinelFunding.classList.contains('visible')).toBe(true);
  });

  test('copies and refreshes Sentinel funding details on the new tab page', async () => {
    const ctx = loadHomePageModule({
      dvpnStatus: {
        state: 'wallet_ready',
        walletAddress: 'sentinel1ready',
        balance: '0',
        funded: false,
      },
    });

    await ctx.document.handlers.DOMContentLoaded();
    await ctx.sentinelFund.handlers.click[0]();
    await Promise.resolve();
    await Promise.resolve();

    await ctx.sentinelCopy.handlers.click[0]();

    expect(ctx.freedomAPI.copyText).toHaveBeenCalledWith('sentinel1ready');

    await ctx.sentinelBackupReveal.handlers.click[0]();

    expect(ctx.freedomAPI.exportDvpnMnemonic).toHaveBeenCalled();
    expect(ctx.sentinelBackupPanel.hidden).toBe(false);
    expect(ctx.sentinelBackupWords.children).toHaveLength(4);

    await ctx.sentinelBackupCopy.handlers.click[0]();

    expect(ctx.freedomAPI.copyText).toHaveBeenCalledWith('alpha beta gamma delta');

    ctx.freedomAPI.getDvpnStatus.mockResolvedValueOnce({
      state: 'wallet_ready',
      walletAddress: 'sentinel1ready',
      balance: '1.25',
      funded: true,
    });

    await ctx.sentinelRefresh.handlers.click[0]();

    expect(ctx.freedomAPI.getDvpnBalance).toHaveBeenCalled();
    expect(ctx.sentinelBalance.textContent).toBe('1.25 P2P');
    expect(ctx.sentinelStatus.textContent).toBe('Ready · 1.25 P2P');
  });

  test('shows Sentinel errors before funding prompts on the new tab page', async () => {
    const ctx = loadHomePageModule({
      dvpnStatus: {
        state: 'error',
        walletAddress: 'sentinel1error',
        funded: false,
        error: 'balance lookup failed',
      },
    });

    await ctx.document.handlers.DOMContentLoaded();

    expect(ctx.sentinelStatus.textContent).toBe('Error · balance lookup failed');
  });

  test('disables Sentinel connect path when prerequisites are unavailable', async () => {
    const ctx = loadHomePageModule({
      dvpnPrerequisites: {
        success: true,
        ok: false,
        error: 'V2Ray is missing',
      },
      dvpnStatus: {
        state: 'wallet_ready',
        walletAddress: 'sentinel1ready',
        balance: '2.5',
        funded: true,
      },
    });

    await ctx.document.handlers.DOMContentLoaded();

    expect(ctx.sentinelStatus.textContent).toBe('Unavailable');
    expect(ctx.sentinelConnect.style.display).toBe('none');
  });
});
