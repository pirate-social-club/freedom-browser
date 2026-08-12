const path = require('path');
const { extractArchive, getExtractionInvocation } = require('./extract-archive');

describe('archive extraction', () => {
  test('uses a target-relative archive name for Windows drive paths', () => {
    expect(getExtractionInvocation(
      'D:\\a\\freedom-browser\\bee-bin\\mac-arm64\\bee.tar.gz',
      'D:\\a\\freedom-browser\\bee-bin\\mac-arm64',
      'tar.gz',
      path.win32
    )).toEqual({
      command: 'tar',
      args: ['-xzf', 'bee.tar.gz', '-C', '.'],
      options: {
        cwd: 'D:\\a\\freedom-browser\\bee-bin\\mac-arm64',
        stdio: 'inherit',
      },
    });
  });

  test('extracts zip archives from their target directory', () => {
    const spawnImpl = jest.fn(() => ({ status: 0 }));
    extractArchive('/tmp/downloads/tool.zip', '/tmp/downloads', 'zip', spawnImpl);
    expect(spawnImpl).toHaveBeenCalledWith(
      'unzip',
      ['-o', 'tool.zip', '-d', '.'],
      { cwd: '/tmp/downloads', stdio: 'inherit' }
    );
  });

  test('rejects unknown formats before spawning a command', () => {
    expect(() => getExtractionInvocation('/tmp/tool.rar', '/tmp', 'rar')).toThrow(
      'Unsupported archive format'
    );
  });
});
