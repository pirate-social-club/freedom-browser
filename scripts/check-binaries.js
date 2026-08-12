const fs = require('fs');
const path = require('path');
const {
  getCapabilityBinaries,
  getCapabilityDefinition,
  getCapabilityStatus,
} = require('../src/shared/platform-capabilities');

const ROOT_DIR = path.join(__dirname, '..');
const FORBIDDEN_HNS_BINARY_STRINGS = [['shake', 'station'].join('')];
const FORBIDDEN_HNSD_DYNAMIC_STRINGS = ['libunbound.so'];

function findForbiddenBinaryString(binaryPath, forbiddenStrings, fsImpl = fs) {
  if (!fsImpl.existsSync(binaryPath)) return null;

  const binaryData = fsImpl.readFileSync(binaryPath);
  return forbiddenStrings.find((value) => binaryData.includes(Buffer.from(value))) || null;
}

function isExecutable(binaryPath, fsImpl = fs) {
  return (fsImpl.statSync(binaryPath).mode & 0o111) !== 0;
}

function getPlatformArch() {
  const args = process.argv.slice(2);
  const platforms = [];

  // Parse command line args to determine target platforms
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--mac') {
      const nextArg = args[i + 1];
      if (nextArg === '--arm64' || args.includes('--arm64')) {
        platforms.push({ os: 'mac', arch: 'arm64' });
      }
      if (nextArg === '--x64' || args.includes('--x64')) {
        platforms.push({ os: 'mac', arch: 'x64' });
      }
      if (!args.includes('--arm64') && !args.includes('--x64')) {
        // Default to current architecture
        platforms.push({ os: 'mac', arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
      }
    } else if (arg === '--linux') {
      if (args.includes('--arm64')) {
        platforms.push({ os: 'linux', arch: 'arm64' });
      }
      if (args.includes('--x64')) {
        platforms.push({ os: 'linux', arch: 'x64' });
      }
      if (!args.includes('--arm64') && !args.includes('--x64')) {
        platforms.push({ os: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
      }
    } else if (arg === '--win') {
      if (args.includes('--arm64')) {
        platforms.push({ os: 'win', arch: 'arm64' });
      }
      if (args.includes('--x64')) {
        platforms.push({ os: 'win', arch: 'x64' });
      }
      if (!args.includes('--arm64') && !args.includes('--x64')) {
        platforms.push({ os: 'win', arch: 'x64' });
      }
    }
    i++;
  }

  // If no platform specified, use current platform
  if (platforms.length === 0) {
    let os;
    switch (process.platform) {
      case 'darwin':
        os = 'mac';
        break;
      case 'win32':
        os = 'win';
        break;
      default:
        os = 'linux';
    }
    platforms.push({ os, arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
  }

  return platforms;
}

function checkCapabilityBinaries(capability, platform, options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const fsImpl = options.fsImpl || fs;
  const status = getCapabilityStatus(capability, platform.os, platform.arch);
  const definition = getCapabilityDefinition(capability);

  if (!status.supported) {
    options.onUnsupported?.(
      `${definition.displayName} is intentionally unsupported for ${status.target}.`
    );
    return [];
  }

  const platformDir = path.join(rootDir, definition.binaryDirectory, status.target);
  const missing = [];

  for (const binary of getCapabilityBinaries(capability, platform.os)) {
    const binaryPath = path.join(platformDir, binary.name);
    if (!fsImpl.existsSync(binaryPath)) {
      missing.push(`${definition.displayName} artifact for ${status.target}: ${binaryPath}`);
      continue;
    }

    if (binary.executable && platform.os !== 'win' && !isExecutable(binaryPath, fsImpl)) {
      missing.push(`${definition.displayName} artifact is not executable for ${status.target}: ${binaryPath}`);
    }

    if (capability === 'hns' && binary.name.startsWith('fingertipd')) {
      const forbiddenString = findForbiddenBinaryString(
        binaryPath,
        FORBIDDEN_HNS_BINARY_STRINGS,
        fsImpl
      );
      if (forbiddenString) {
        missing.push(
          `${definition.displayName} artifact for ${status.target} contains obsolete string "${forbiddenString}": ${binaryPath}`
        );
      }
    }

    if (capability === 'hns' && platform.os === 'linux' && binary.name === 'hnsd') {
      const dynamicDependency = findForbiddenBinaryString(
        binaryPath,
        FORBIDDEN_HNSD_DYNAMIC_STRINGS,
        fsImpl
      );
      if (dynamicDependency) {
        missing.push(
          `${definition.displayName} artifact for ${status.target} is not self-contained (` +
          `${dynamicDependency}): ${binaryPath}`
        );
      }
    }
  }

  return missing;
}

function checkBinaries(platforms, options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const fsImpl = options.fsImpl || fs;
  const onUnsupported = options.onUnsupported || ((message) => console.warn(message));
  const missing = [];
  const beeBinDir = path.join(rootDir, 'bee-bin');
  const ipfsBinDir = path.join(rootDir, 'ipfs-bin');
  const radicleBinDir = path.join(rootDir, 'radicle-bin');

  for (const { os, arch } of platforms) {
    const platformDir = `${os}-${arch}`;
    const beeExt = os === 'win' ? '.exe' : '';
    const ipfsExt = os === 'win' ? '.exe' : '';

    const beePath = path.join(beeBinDir, platformDir, `bee${beeExt}`);
    const ipfsPath = path.join(ipfsBinDir, platformDir, `ipfs${ipfsExt}`);

    if (!fsImpl.existsSync(beePath)) {
      missing.push(`bee binary for ${platformDir}: ${beePath}`);
    }
    if (!fsImpl.existsSync(ipfsPath)) {
      missing.push(`ipfs binary for ${platformDir}: ${ipfsPath}`);
    }

    missing.push(...checkCapabilityBinaries('hns', { os, arch }, {
      rootDir,
      fsImpl,
      onUnsupported,
    }));
    missing.push(...checkCapabilityBinaries('dvpn', { os, arch }, {
      rootDir,
      fsImpl,
      onUnsupported,
    }));

    // Radicle: no official Windows binaries yet — skip check for win targets
    if (os !== 'win') {
      const nodePath = path.join(radicleBinDir, platformDir, 'radicle-node');
      const httpdPath = path.join(radicleBinDir, platformDir, 'radicle-httpd');

      if (!fsImpl.existsSync(nodePath)) {
        missing.push(`radicle-node binary for ${platformDir}: ${nodePath}`);
      }
      if (!fsImpl.existsSync(httpdPath)) {
        missing.push(`radicle-httpd binary for ${platformDir}: ${httpdPath}`);
      }
    }
  }

  return missing;
}

function main() {
  const platforms = getPlatformArch();
  console.log(`Checking binaries for: ${platforms.map((p) => `${p.os}-${p.arch}`).join(', ')}`);

  const missing = checkBinaries(platforms);

  if (missing.length > 0) {
    console.error('\n❌ Build cannot proceed. Missing or invalid binaries:\n');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('\nRun the following commands to download binaries:');
    console.error('  npm run bee:download');
    console.error('  npm run ipfs:download');
    console.error('  npm run radicle:download\n');
    process.exit(1);
  }

  console.log('✅ All required binaries found.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkBinaries,
  checkCapabilityBinaries,
  findForbiddenBinaryString,
  getPlatformArch,
  isExecutable,
};
