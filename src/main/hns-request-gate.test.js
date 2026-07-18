jest.mock('./service-registry', () => ({
  MODE: { BUNDLED: 'bundled' },
  getService: jest.fn(),
}));
jest.mock('./webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));

const registry = require('./service-registry');
const dispatcher = require('./webrequest-dispatcher');
const {
  gateHnsRequest,
  installHnsRequestGate,
  isHnsServiceReady,
  registerHnsRequestGateIpc,
  syncingPageUrl,
} = require('./hns-request-gate');

describe('HNS request readiness gate', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['not initialized', null],
    ['disabled', { mode: 'disabled', synced: false, api: null }],
    ['syncing', { mode: 'bundled', synced: false, api: 'http://127.0.0.1:44041' }],
    ['missing proxy', { mode: 'bundled', synced: true, api: null }],
  ])('cancels HNS requests while %s', (_label, service) => {
    registry.getService.mockReturnValue(service);
    expect(gateHnsRequest({ url: 'https://app.pirate/private?q=secret' }))
      .toEqual({ cancel: true });
  });

  test('admits HNS traffic only when registry telemetry is fully ready', () => {
    const service = { mode: 'bundled', synced: true, api: 'http://127.0.0.1:44041' };
    registry.getService.mockReturnValue(service);
    expect(isHnsServiceReady()).toBe(true);
    expect(gateHnsRequest({ url: 'https://app.pirate/' })).toBeNull();
    expect(gateHnsRequest({ url: 'https://single-label/' })).toBeNull();
  });

  test('does not intercept ordinary, loopback, or non-HTTP requests', () => {
    registry.getService.mockReturnValue(null);
    expect(gateHnsRequest({ url: 'https://example.com/' })).toBeNull();
    expect(gateHnsRequest({ url: 'http://localhost/' })).toBeNull();
    expect(gateHnsRequest({ url: 'ipfs://bafybeigdyr/' })).toBeNull();
    expect(gateHnsRequest({ url: 'not a URL' })).toBeNull();
  });

  test('blocks HNS WebSockets while the resolver is not ready', () => {
    registry.getService.mockReturnValue({ mode: 'bundled', synced: false, api: null });
    expect(gateHnsRequest({ url: 'wss://room.app.pirate/socket' })).toEqual({ cancel: true });
    expect(gateHnsRequest({ url: 'ws://single-label/socket' })).toEqual({ cancel: true });
  });

  test('registers through the shared dispatcher', () => {
    installHnsRequestGate();
    expect(dispatcher.registerWebRequestHandler).toHaveBeenCalledWith(
      'onBeforeRequest',
      'hns-readiness-gate',
      gateHnsRequest
    );
  });

  test('redirects a blocked top-level navigation without putting its URL in the interstitial', async () => {
    registry.getService.mockReturnValue({ mode: 'bundled', synced: false, api: null });
    const original = 'https://app.pirate/private?token=secret';
    expect(gateHnsRequest({
      url: original,
      resourceType: 'mainFrame',
      webContentsId: 42,
    })).toEqual({ redirectURL: syncingPageUrl });
    expect(syncingPageUrl).not.toContain('app.pirate');
    expect(syncingPageUrl).not.toContain('secret');

    let handler;
    const ipcMain = { handle: jest.fn((_channel, fn) => { handler = fn; }) };
    registerHnsRequestGateIpc(ipcMain);
    expect(handler({ sender: { id: 42 } })).toBe(original);
    expect(handler({ sender: { id: 42 } })).toBeNull();
  });
});
