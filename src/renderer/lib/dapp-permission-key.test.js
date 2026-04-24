import { getPermissionContext, getPermissionKeyFromUrl } from './dapp-permission-key.js';

describe('dapp-permission-key', () => {
  test('normalizes explicit dweb and ENS display URLs', () => {
    expect(getPermissionKeyFromUrl('ipfs://bafyabc/path')).toBe('ipfs://bafyabc');
    expect(getPermissionKeyFromUrl('bzz://abcdef/page.html')).toBe('bzz://abcdef');
    expect(getPermissionKeyFromUrl('ipns://docs.ipfs.tech/guide')).toBe(
      'ipns://docs.ipfs.tech'
    );
    expect(getPermissionKeyFromUrl('vitalik.eth/blog')).toBe('vitalik.eth');
    expect(getPermissionKeyFromUrl('ens://example.box/#/app')).toBe('example.box');
  });

  test('normalizes localhost gateway URLs back to dweb permission keys', () => {
    expect(getPermissionKeyFromUrl('http://127.0.0.1:8080/ipfs/bafyabc/app')).toBe(
      'ipfs://bafyabc'
    );
    expect(getPermissionKeyFromUrl('http://127.0.0.1:8080/ipns/docs.ipfs.tech/app')).toBe(
      'ipns://docs.ipfs.tech'
    );
    expect(getPermissionKeyFromUrl('http://127.0.0.1:1633/bzz/abcdef/index.html')).toBe(
      'bzz://abcdef'
    );
    expect(getPermissionKeyFromUrl('http://127.0.0.1:8780/api/v1/repos/z3abc/tree')).toBe(
      'rad://z3abc'
    );
  });

  test('uses requesting webview URL before active-tab-independent origin fallback', () => {
    expect(
      getPermissionContext({
        webviewUrl: 'http://127.0.0.1:8080/ipfs/bafyabc/app',
        requestOrigin: 'http://127.0.0.1:8080',
      })
    ).toEqual({
      permissionKey: 'ipfs://bafyabc',
      displayUrl: 'http://127.0.0.1:8080/ipfs/bafyabc/app',
    });

    expect(
      getPermissionContext({
        webviewUrl: 'about:blank',
        requestOrigin: 'https://app.example',
      })
    ).toEqual({
      permissionKey: 'https://app.example',
      displayUrl: 'https://app.example',
    });
  });
});
