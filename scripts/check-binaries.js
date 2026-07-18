const fs = require('fs');
const path = require('path');

const ANT_BIN_DIR = path.join(__dirname, '..', 'ant-bin');
const FREEDOM_IPFS_NATIVE_PREBUILDS_DIR = path.join(
  __dirname,
  '..',
  'native',
  'freedom-ipfs-node',
  'prebuilds'
);
const FREEDOM_IPFS_NATIVE_ADDON = 'freedom_ipfs_native.node';
const RADICLE_BIN_DIR = path.join(__dirname, '..', 'radicle-bin');
const HNS_BIN_DIR = path.join(__dirname, '..', 'hns-bin');

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

function checkBinaries(platforms) {
  const missing = [];

  for (const { os, arch } of platforms) {
    const platformDir = `${os}-${arch}`;
    const antExt = os === 'win' ? '.exe' : '';

    const antPath = path.join(ANT_BIN_DIR, platformDir, `antd${antExt}`);

    if (!fs.existsSync(antPath)) {
      missing.push(`antd binary for ${platformDir}: ${antPath}`);
    }

    const freedomIpfsAddonPath = path.join(
      FREEDOM_IPFS_NATIVE_PREBUILDS_DIR,
      platformDir,
      FREEDOM_IPFS_NATIVE_ADDON
    );
    if (!fs.existsSync(freedomIpfsAddonPath)) {
      missing.push(`freedom-ipfs native addon for ${platformDir}: ${freedomIpfsAddonPath}`);
    }

    // Radicle: no official Windows binaries yet — skip check for win targets
    if (os !== 'win') {
      const nodePath = path.join(RADICLE_BIN_DIR, platformDir, 'radicle-node');
      const httpdPath = path.join(RADICLE_BIN_DIR, platformDir, 'radicle-httpd');

      if (!fs.existsSync(nodePath)) {
        missing.push(`radicle-node binary for ${platformDir}: ${nodePath}`);
      }
      if (!fs.existsSync(httpdPath)) {
        missing.push(`radicle-httpd binary for ${platformDir}: ${httpdPath}`);
      }
    }

    // HNS is Linux x64 only for the first resync release. Unsupported targets
    // are UI-gated and must not be satisfied by placeholder binaries.
    if (os === 'linux' && arch === 'x64') {
      for (const binary of ['fingertipd', 'hnsd']) {
        const binaryPath = path.join(HNS_BIN_DIR, platformDir, binary);
        if (!fs.existsSync(binaryPath)) {
          missing.push(`${binary} binary for ${platformDir}: ${binaryPath}`);
        }
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
    console.error('\n❌ Build cannot proceed. Missing binaries:\n');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('\nRun the following commands to download binaries:');
    console.error('  npm run ant:download');
    console.error('  npm run ipfs:download');
    console.error('  npm run radicle:download\n');
    console.error('  npm run hns:download\n');
    process.exit(1);
  }

  console.log('✅ All required binaries found.\n');
  process.exit(0);
}

main();
