const path = require('path');
const { spawnSync } = require('child_process');

function getExtractionInvocation(archive, targetDir, kind, pathImpl = path) {
  const archiveName = pathImpl.basename(archive);
  if (!archiveName || archiveName === '.' || archiveName === pathImpl.sep) {
    throw new Error('Archive path must include a filename');
  }

  if (kind === 'zip') {
    return {
      command: 'unzip',
      args: ['-o', archiveName, '-d', '.'],
      options: { cwd: targetDir, stdio: 'inherit' },
    };
  }

  if (kind === 'tar.gz') {
    return {
      command: 'tar',
      args: ['-xzf', archiveName, '-C', '.'],
      options: { cwd: targetDir, stdio: 'inherit' },
    };
  }

  throw new Error(`Unsupported archive format: ${kind}`);
}

function extractArchive(archive, targetDir, kind, spawnImpl = spawnSync) {
  const invocation = getExtractionInvocation(archive, targetDir, kind);
  const result = spawnImpl(invocation.command, invocation.args, invocation.options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${invocation.command} failed with status ${result.status}`);
  }
}

module.exports = {
  extractArchive,
  getExtractionInvocation,
};
