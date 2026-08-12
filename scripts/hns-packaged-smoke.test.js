const {
  extractStatusCode,
  getSmokeHosts,
  normalizeHostname,
  parseArgs,
  parseProxyAddress,
} = require('./hns-packaged-smoke');

describe('packaged HNS HTTPS smoke', () => {
  test('requires an explicit packaged resources directory', () => {
    expect(() => parseArgs([])).toThrow('--resources-dir is required');
    expect(parseArgs(['--resources-dir', 'dist/linux-unpacked/resources'])).toEqual({
      resourcesDir: 'dist/linux-unpacked/resources',
      timeoutMs: 240000,
    });
  });

  test('requires a valid third requested hostname without logging or storing it', () => {
    expect(() => getSmokeHosts('')).toThrow('FREEDOM_HNS_SMOKE_EXTRA_HOST');
    expect(getSmokeHosts('app.third-root.test')).toEqual([
      'app.pirate',
      'app.dankmeme',
      'app.third-root.test',
    ]);
    expect(() => normalizeHostname('https://app.pirate/')).toThrow('plain dotted hostname');
  });

  test('parses helper proxy addresses and HTTP response codes', () => {
    expect(parseProxyAddress('127.0.0.1:44041')).toEqual({ host: '127.0.0.1', port: 44041 });
    expect(extractStatusCode('HTTP/1.1 200 OK')).toBe(200);
    expect(extractStatusCode('not HTTP')).toBeNull();
  });
});
