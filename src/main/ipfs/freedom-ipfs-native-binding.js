const fs = require('fs');
const path = require('path');

function addonPathCandidates() {
  const devPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'native',
    'freedom-ipfs-node',
    'build',
    'Release',
    'freedom_ipfs_native.node'
  );
  const packagedPath =
    process.resourcesPath &&
    path.join(process.resourcesPath, 'freedom-ipfs-node', 'freedom_ipfs_native.node');
  return [devPath, packagedPath].filter(Boolean);
}

function loadNativeBinding() {
  const tried = [];
  for (const candidate of addonPathCandidates()) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    return require(candidate);
  }
  const message = `freedom-ipfs native addon not found. Tried: ${tried.join(', ')}`;
  const err = new Error(message);
  err.code = 'FREEDOM_IPFS_NATIVE_ADDON_MISSING';
  throw err;
}

function isNativeBindingAvailable() {
  try {
    loadNativeBinding();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  loadNativeBinding,
  isNativeBindingAvailable,
  addonPathCandidates,
};
