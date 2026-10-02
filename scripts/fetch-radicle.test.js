jest.mock('fs');
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('./download-verified', () => ({ downloadVerified: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { downloadVerified } = require('./download-verified');
const artifacts = require('./binary-artifacts.lock.json').radicle;
const { installTarget } = require('./fetch-radicle');

const binaries = ['rad', 'radicle-node', 'radicle-httpd', 'git-remote-rad'];

describe('pinned Radicle installation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    downloadVerified.mockResolvedValue(undefined);
    spawnSync.mockReturnValue({ status: 0 });
    fs.readdirSync.mockReturnValue(binaries.map((name) => ({
      name, isFile: () => true, isDirectory: () => false,
    })));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test.each(Object.keys(artifacts.targets))(
    'uses versioned official URLs and existing digests for %s', async (targetKey) => {
      const artifact = artifacts.targets[targetKey];
      await installTarget(targetKey);
      const targetDir = path.join(__dirname, '..', 'radicle-bin', targetKey);
      const mainName = `radicle-${artifacts.version}-${artifact.target}.tar.xz`;
      const httpdName = `radicle-httpd-${artifacts.httpdVersion}-${artifact.target}.tar.xz`;
      expect(downloadVerified.mock.calls).toEqual([
        [`https://files.radicle.dev/releases/${artifacts.version}/${mainName}`,
          path.join(targetDir, mainName), 'sha256', artifact.mainSha256],
        [`https://files.radicle.dev/releases/radicle-httpd/${artifacts.httpdVersion}/${httpdName}`,
          path.join(targetDir, httpdName), 'sha256', artifact.httpdSha256],
      ]);
      expect(spawnSync.mock.calls).toEqual([
        ['tar', ['-xJf', path.join(targetDir, mainName), '-C', targetDir], { stdio: 'inherit' }],
        ['tar', ['-xJf', path.join(targetDir, httpdName), '-C', targetDir], { stdio: 'inherit' }],
      ]);
      expect(fs.chmodSync.mock.calls).toEqual(binaries.map((name) => [path.join(targetDir, name), 0o755]));
    }
  );

  test('rejects an unsupported target before filesystem or download operations', async () => {
    await expect(installTarget('unsupported')).rejects.toThrow('Unsupported Radicle target');
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(downloadVerified).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('does not extract or fall back when verified download rejects a digest', async () => {
    downloadVerified.mockRejectedValueOnce(new Error('sha256 mismatch'));
    await expect(installTarget('linux-x64')).rejects.toThrow('sha256 mismatch');
    expect(downloadVerified).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fs.chmodSync).not.toHaveBeenCalled();
  });

  test('stops after failed extraction', async () => {
    spawnSync.mockReturnValueOnce({ status: 2 });
    await expect(installTarget('linux-x64')).rejects.toThrow('tar failed with status 2');
    expect(downloadVerified).toHaveBeenCalledTimes(1);
    expect(fs.chmodSync).not.toHaveBeenCalled();
  });

  test('rejects archives missing a required executable', async () => {
    fs.readdirSync.mockReturnValue([]);
    await expect(installTarget('linux-x64')).rejects.toThrow('missing rad');
    expect(fs.chmodSync).not.toHaveBeenCalled();
  });
});
