const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyHelperStartupDiagnostics,
  classifyRequestFailure,
  createSmokeBudget,
  installPackagedCheckpoint,
  installCheckpointWithinBudget,
  reserveTcpPort,
  canBindUdpPort,
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

  test('reports startup categories without echoing helper diagnostics', () => {
    const raw = 'loader: libunbound.so.8: cannot open shared object file';
    const category = classifyHelperStartupDiagnostics(raw);
    expect(category).toBe('the packaged HNS daemon has a missing runtime dependency');
    expect(category).not.toContain('libunbound.so.8');
  });
});


test('caps requests against one monotonic budget and reserves cleanup', () => {
  let now = 100;
  const budget = createSmokeBudget(20000, () => now);
  expect(budget.requestTimeout()).toBe(13000);
  now += 12500;
  expect(budget.requestTimeout()).toBe(500);
  now += 500;
  expect(() => budget.requestTimeout()).toThrow('deadline');
  expect(budget.remaining()).toBe(7000);
  expect(() => parseArgs(['--resources-dir', '/unused', '--timeout-ms', '7000'])).toThrow('cleanup reserve');
});

test('retains refusal categories and never echoes raw host or certificate errors', () => {
  expect(classifyRequestFailure(new Error('Proxy CONNECT returned 502'))).toBe('connect-status-502');
  expect(classifyRequestFailure(new Error('HTTPS request returned 421'))).toBe('http-status-421');
  expect(classifyRequestFailure(new Error('HTTPS request timed out'))).toBe('request-timeout');
  const secret = Object.assign(new Error('private.test certificate issuer and IP'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  expect(classifyRequestFailure(secret)).toBe('tls-validation-or-protocol');
  expect(classifyRequestFailure(new Error('private.test unknown failure'))).toBe('request-failure');
});

test('uses the shipped validator and rejects altered checkpoint before writing state', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-smoke-checkpoint-test-'));
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-smoke-resources-test-'));
  const source = fs.readFileSync(require.resolve('../src/main/hns-checkpoint'));
  try {
    fs.mkdirSync(path.join(resourcesDir, 'assets/hns'), { recursive: true });
    const checkpoint = fs.readFileSync(path.join(__dirname, '../assets/hns/checkpoint_main.dat'));
    const bundled = path.join(resourcesDir, 'assets/hns/checkpoint_main.dat');
    fs.writeFileSync(bundled, checkpoint);
    await expect(installPackagedCheckpoint(resourcesDir, dataDir, async () => source, () => { throw new Error('deadline'); }))
      .rejects.toThrow('deadline');
    expect(fs.existsSync(path.join(dataDir, 'hnsd'))).toBe(false);
    await expect(installPackagedCheckpoint(resourcesDir, dataDir, async () => Buffer.from('different source')))
      .rejects.toThrow('validator differs');
    expect(fs.existsSync(path.join(dataDir, 'hnsd'))).toBe(false);
    const corrupt = Buffer.from(checkpoint);
    corrupt[corrupt.length - 1] ^= 1;
    fs.writeFileSync(bundled, corrupt);
    await expect(installPackagedCheckpoint(resourcesDir, dataDir, async () => source)).rejects.toThrow('integrity');
    expect(fs.existsSync(path.join(dataDir, 'hnsd'))).toBe(false);
    fs.writeFileSync(bundled, checkpoint);
    await expect(installPackagedCheckpoint(resourcesDir, dataDir, async () => source)).resolves.toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'hnsd/checkpoint_main.dat'))).toEqual(checkpoint);
    const saved = Buffer.from('saved state');
    fs.writeFileSync(path.join(dataDir, 'hnsd/checkpoint_main.dat'), saved);
    await expect(installPackagedCheckpoint(resourcesDir, dataDir, async () => source)).resolves.toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'hnsd/checkpoint_main.dat'))).toEqual(saved);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
});


test('a timed-out checkpoint source cannot write state when it resolves late', async () => {
  jest.useFakeTimers();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-smoke-late-source-test-'));
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-smoke-late-resources-test-'));
  fs.mkdirSync(path.join(resourcesDir, 'assets/hns'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../assets/hns/checkpoint_main.dat'),
    path.join(resourcesDir, 'assets/hns/checkpoint_main.dat'));
  let resolveSource;
  const source = new Promise((resolve) => { resolveSource = resolve; });
  let now = 0;
  try {
    const budget = createSmokeBudget(60000, () => now);
    const stage = installCheckpointWithinBudget(resourcesDir, dataDir, budget, () => source);
    const rejected = expect(stage).rejects.toThrow('deadline');
    now = 30000;
    await jest.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(budget.remaining()).toBe(30000);
    fs.rmSync(dataDir, { recursive: true, force: true });
    resolveSource(fs.readFileSync(require.resolve('../src/main/hns-checkpoint')));
    await Promise.resolve();
    await Promise.resolve();
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'hnsd'))).toBe(false);
  } finally {
    jest.useRealTimers();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('cancelled port reservations close late TCP and UDP handles', async () => {
  const { EventEmitter } = require('events');
  const tcp = Object.assign(new EventEmitter(), {
    unref: jest.fn(), close: jest.fn((callback) => callback?.()), listen: jest.fn(),
  });
  const udp = Object.assign(new EventEmitter(), {
    unref: jest.fn(), close: jest.fn(), bind: jest.fn(),
  });
  jest.spyOn(require('net'), 'createServer').mockReturnValue(tcp);
  jest.spyOn(require('dgram'), 'createSocket').mockReturnValue(udp);
  try {
    const cancellation = new AbortController();
    const tcpAttempt = reserveTcpPort(cancellation.signal);
    const rejected = expect(tcpAttempt).rejects.toThrow('cancelled');
    const udpAttempt = canBindUdpPort(12345, cancellation.signal);
    cancellation.abort();
    await rejected;
    await expect(udpAttempt).resolves.toBe(false);
    tcp.emit('listening');
    udp.emit('listening');
    expect(tcp.close).toHaveBeenCalledTimes(2);
    expect(udp.close).toHaveBeenCalledTimes(2);
  } finally {
    jest.restoreAllMocks();
  }
});
