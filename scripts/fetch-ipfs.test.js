const artifacts = require('./binary-artifacts.lock.json').ipfs;

jest.mock('./download-verified', () => ({ downloadVerified: jest.fn() }));
jest.mock('./extract-archive', () => ({ extractArchive: jest.fn() }));
jest.mock('fs', () => ({ mkdirSync: jest.fn(), rmSync: jest.fn(), existsSync: jest.fn(() => true), renameSync: jest.fn(), chmodSync: jest.fn() }));
const { downloadVerified } = require('./download-verified');
const { extractArchive } = require('./extract-archive');
const { main } = require('./fetch-ipfs');

describe('pinned Kubo mirror', () => {
  let previousArgv;
  beforeEach(() => {
    previousArgv = process.argv;
    process.argv = ['node', 'fetch-ipfs.js', '--target', 'linux-x64'];
    jest.clearAllMocks();
    downloadVerified.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { process.argv = previousArgv; jest.restoreAllMocks(); });
  test('uses the official mirror with the same locked digest after primary failure', async () => {
    downloadVerified.mockRejectedValueOnce(new Error('primary unavailable')).mockResolvedValueOnce(undefined);
    await main();
    const artifact = artifacts.targets['linux-x64'];
    expect(downloadVerified).toHaveBeenCalledTimes(2);
    const first = downloadVerified.mock.calls[0];
    const second = downloadVerified.mock.calls[1];
    expect(first[0]).toBe(artifact.url);
    expect(second).toEqual([artifact.mirrorUrl, first[1], 'sha512', artifact.sha512]);
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });
  test('never extracts when both verified sources fail', async () => {
    downloadVerified.mockRejectedValue(new Error('sha512 mismatch'));
    await expect(main()).rejects.toThrow('sha512 mismatch');
    expect(extractArchive).not.toHaveBeenCalled();
  });
});
