jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({}));
jest.mock('./chains', () => ({}));
jest.mock('./provider-manager', () => ({}));
jest.mock('./transaction-service', () => ({}));
jest.mock('./tx-recorder', () => ({
  signAndRecord: jest.fn(),
  KINDS: { WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
}));
jest.mock('../identity-manager', () => ({}));
jest.mock('./rpc-manager', () => ({}));
jest.mock('./vault-access', () => ({}));
jest.mock('./dapp-permissions', () => ({ getPermission: jest.fn() }));

const { getPermission } = require('./dapp-permissions');
const { buildTxRecordContext, hasDappPermissionForWallet } = require('./wallet-ipc');

describe('wallet-ipc', () => {
  test('renderer context cannot override fixed payment-history kind', () => {
    expect(buildTxRecordContext('dapp-send', {
      kind: 'wallet-send',
      origin: 'https://app.example',
    })).toEqual({
      kind: 'dapp-send',
      origin: 'https://app.example',
    });
  });

  test('requires a matching persisted permission for dApp wallet access', () => {
    getPermission.mockReturnValue({ walletIndex: 2 });
    expect(hasDappPermissionForWallet('ipfs://bafy-app', 2)).toBe(true);
    expect(hasDappPermissionForWallet('ipfs://bafy-app', 1)).toBe(false);
    expect(hasDappPermissionForWallet('', 2)).toBe(false);
    expect(hasDappPermissionForWallet('ipfs://bafy-app', -1)).toBe(false);
  });
});
