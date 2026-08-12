const {
  getCapabilityBinaries,
  getCapabilityStatus,
  getTarget,
  manifest,
  normalizePlatform,
} = require('./platform-capabilities');

describe('platform capabilities', () => {
  test('normalizes runtime platform names to packaging targets', () => {
    expect(normalizePlatform('darwin')).toBe('mac');
    expect(normalizePlatform('win32')).toBe('win');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(getTarget('linux', 'x64')).toBe('linux-x64');
  });

  test.each([
    ['hns', 'linux', 'x64', true],
    ['dvpn', 'linux', 'x64', true],
    ['hns', 'linux', 'arm64', false],
    ['dvpn', 'linux', 'arm64', false],
    ['hns', 'darwin', 'x64', false],
    ['dvpn', 'darwin', 'arm64', false],
    ['hns', 'win32', 'x64', false],
    ['dvpn', 'win32', 'x64', false],
  ])('%s support on %s-%s is %s', (capability, platform, arch, supported) => {
    const status = getCapabilityStatus(capability, platform, arch);
    expect(status.supported).toBe(supported);
    if (supported) {
      expect(status.unsupportedReason).toBeNull();
    } else {
      expect(status.unsupportedReason).toEqual(expect.any(String));
    }
  });

  test('unknown targets fail closed', () => {
    expect(getCapabilityStatus('hns', 'freebsd', 'x64')).toMatchObject({
      target: 'freebsd-x64',
      supported: false,
    });
  });

  test('declares every supported capability binary in the manifest', () => {
    for (const [capability, definition] of Object.entries(manifest.capabilities)) {
      expect(definition.supportedTargets).toEqual(['linux-x64']);
      expect(definition.binaryDirectory).toMatch(/-bin$/);
      expect(getCapabilityBinaries(capability, 'linux')).not.toHaveLength(0);
    }
  });
});
