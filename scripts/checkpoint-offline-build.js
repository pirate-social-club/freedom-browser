const fs = require('fs');
const os = require('os');
const path = require('path');

// Builder's Get 5 override is accepted only with prepared Linux x64 inputs.
// This hook runs before native dependency rebuilding and Electron preparation.
module.exports = function checkpointOfflineBuild(context, options = {}) {
  const fileSystem = options.fs || fs;
  const interfaces = options.interfaces || os.networkInterfaces();
  const environment = options.env || process.env;
  const platform = options.platform || process.platform;
  const config = context.packager.config;
  if (platform !== 'linux' || context.electronPlatformName !== 'linux' || context.arch !== 1) {
    throw new Error('Checkpoint packaging requires the reviewed Linux x64 recipe');
  }
  if (Object.keys(interfaces).some((name) => name !== 'lo')) {
    throw new Error('Checkpoint packaging requires a network namespace with only loopback');
  }
  if (fileSystem.readlinkSync('/proc/self/ns/net') === fileSystem.readlinkSync('/proc/1/ns/net')) {
    throw new Error('Checkpoint packaging requires a separate network namespace');
  }
  if (config.npmRebuild !== false || config.nodeGypRebuild !== false || config.downloadAlternateFFmpeg !== false) {
    throw new Error('Checkpoint packaging requires prepared native inputs and no alternate FFmpeg download');
  }
  if (!config.electronDist || !path.isAbsolute(config.electronDist) ||
      !fileSystem.statSync(path.join(config.electronDist, 'electron')).isFile()) {
    throw new Error('Checkpoint packaging requires the prepared Electron distribution');
  }
  const fpm = environment.CUSTOM_FPM_PATH;
  if (!fpm || !path.isAbsolute(fpm) || !fileSystem.statSync(fpm).isFile()) {
    throw new Error('Checkpoint packaging requires the prepared pinned FPM executable');
  }
};
