const path = require('path');
const { checkCapabilityBinaries } = require('./check-binaries');

function createFsMock(files = {}) {
  return {
    existsSync: jest.fn((target) => Object.prototype.hasOwnProperty.call(files, target)),
    readFileSync: jest.fn((target) => Buffer.from(files[target]?.contents || 'current helper')),
    statSync: jest.fn((target) => ({ mode: files[target]?.mode ?? 0o755 })),
  };
}

function capabilityFiles(rootDir, directory, target, names) {
  return Object.fromEntries(names.map((name) => [
    path.join(rootDir, directory, target, name),
    { mode: name.endsWith('.dat') || name.endsWith('.md') ? 0o644 : 0o755 },
  ]));
}

describe('capability binary checks', () => {
  const rootDir = '/release-source';

  test.each([
    ['hns', 'mac', 'x64'],
    ['hns', 'mac', 'arm64'],
    ['hns', 'linux', 'arm64'],
    ['hns', 'win', 'x64'],
    ['dvpn', 'mac', 'x64'],
    ['dvpn', 'mac', 'arm64'],
    ['dvpn', 'linux', 'arm64'],
    ['dvpn', 'win', 'x64'],
  ])('records %s as intentionally unsupported on %s-%s', (capability, os, arch) => {
    const onUnsupported = jest.fn();
    expect(checkCapabilityBinaries(capability, { os, arch }, {
      rootDir,
      fsImpl: createFsMock(),
      onUnsupported,
    })).toEqual([]);
    expect(onUnsupported).toHaveBeenCalledWith(expect.stringContaining(`${os}-${arch}`));
  });

  test('requires every declared HNS artifact on Linux x64', () => {
    const files = capabilityFiles(rootDir, 'hns-bin', 'linux-x64', [
      'fingertipd',
      'hnsd',
    ]);
    const missing = checkCapabilityBinaries('hns', { os: 'linux', arch: 'x64' }, {
      rootDir,
      fsImpl: createFsMock(files),
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('PROVENANCE.md');
  });

  test('requires every declared dVPN artifact on Linux x64', () => {
    const files = capabilityFiles(rootDir, 'dvpn-bin', 'linux-x64', ['v2ray']);
    const missing = checkCapabilityBinaries('dvpn', { os: 'linux', arch: 'x64' }, {
      rootDir,
      fsImpl: createFsMock(files),
    });
    expect(missing).toHaveLength(2);
    expect(missing.join('\n')).toContain('geoip.dat');
    expect(missing.join('\n')).toContain('geosite.dat');
  });

  test('rejects non-executable supported binaries', () => {
    const files = capabilityFiles(rootDir, 'dvpn-bin', 'linux-x64', [
      'v2ray',
      'geoip.dat',
      'geosite.dat',
    ]);
    files[path.join(rootDir, 'dvpn-bin', 'linux-x64', 'v2ray')].mode = 0o644;
    const missing = checkCapabilityBinaries('dvpn', { os: 'linux', arch: 'x64' }, {
      rootDir,
      fsImpl: createFsMock(files),
    });
    expect(missing).toEqual([expect.stringContaining('not executable')]);
  });

  test('rejects an HNS daemon with an unbundled libunbound dependency', () => {
    const files = capabilityFiles(rootDir, 'hns-bin', 'linux-x64', [
      'fingertipd',
      'hnsd',
      'PROVENANCE.md',
    ]);
    files[path.join(rootDir, 'hns-bin', 'linux-x64', 'hnsd')].contents =
      'ELF metadata libunbound.so.8';
    const missing = checkCapabilityBinaries('hns', { os: 'linux', arch: 'x64' }, {
      rootDir,
      fsImpl: createFsMock(files),
    });
    expect(missing).toEqual([expect.stringContaining('not self-contained')]);
  });

  test('accepts complete supported capability bundles', () => {
    const hnsFiles = capabilityFiles(rootDir, 'hns-bin', 'linux-x64', [
      'fingertipd',
      'hnsd',
      'PROVENANCE.md',
    ]);
    const dvpnFiles = capabilityFiles(rootDir, 'dvpn-bin', 'linux-x64', [
      'v2ray',
      'geoip.dat',
      'geosite.dat',
    ]);
    const fsImpl = createFsMock({ ...hnsFiles, ...dvpnFiles });
    expect(checkCapabilityBinaries('hns', { os: 'linux', arch: 'x64' }, { rootDir, fsImpl })).toEqual([]);
    expect(checkCapabilityBinaries('dvpn', { os: 'linux', arch: 'x64' }, { rootDir, fsImpl })).toEqual([]);
  });
});
