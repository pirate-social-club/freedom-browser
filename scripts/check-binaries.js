const fs = require('fs');
const path = require('path');
const { getCapabilityBinaries, getCapabilityDefinition, getCapabilityStatus } =
  require('../src/shared/platform-capabilities');
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

const { validateInstalledAddon } = require('./fetch-myotis');
const { checkInstalledElectronVersion } = require('./check-electron-version');

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
const RADICLE_EMBEDDED_ADDON = 'libradicle.node';
const MYOTIS_BIN_DIR = path.join(__dirname, '..', 'myotis-bin');
// Targets that bundle the pinned official Myotis release addon.
// Linux deb deliberately omits Myotis.
// Anything else (e.g. win-arm64) is skipped with a notice — the app degrades
// gracefully to Colibri/quorum when the addon is absent.
const MYOTIS_SUPPORTED = new Set(['mac-x64', 'mac-arm64', 'win-x64']);
const ARTI_BIN_DIR = path.join(__dirname, '..', 'arti-bin');

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

  // Platform-independent: bundled adblock filter lists (assets/adblock is
  // gitignored; populated by npm run adblock:download).
  const adblockManifest = path.join(__dirname, '..', 'assets', 'adblock', 'manifest.json');
  if (!fs.existsSync(adblockManifest)) {
    missing.push(`adblock filter lists: ${adblockManifest}`);
  }

  for (const { os, arch } of platforms) {
    for (const capability of ['hns', 'dvpn']) {
      missing.push(...checkCapabilityBinaries(capability, { os, arch }));
    }
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

    const addonPath = path.join(RADICLE_BIN_DIR, platformDir, RADICLE_EMBEDDED_ADDON);
    if (!fs.existsSync(addonPath)) {
      missing.push(`libradicle embedded addon for ${platformDir}: ${addonPath}`);
    }

    // Myotis: required where the release publishes an addon; electron-builder
    // would otherwise silently skip the missing extraResources dir and ship a
    // build with the feature permanently unavailable.
    if (MYOTIS_SUPPORTED.has(platformDir)) {
      const myotisAddonPath = path.join(MYOTIS_BIN_DIR, platformDir, 'myotis-node.node');
      if (!fs.existsSync(myotisAddonPath)) {
        missing.push(`myotis-node addon for ${platformDir}: ${myotisAddonPath}`);
      }
      const provenanceError = validateInstalledAddon(path.dirname(myotisAddonPath));
      if (provenanceError) {
        missing.push(`myotis checkpoint addon for ${platformDir}: ${provenanceError}; run npm run myotis:download`);
      }
      const supervisorPath = path.join(MYOTIS_BIN_DIR, platformDir,
        `myotis-supervisor${os === 'win' ? '.exe' : ''}`);
      if (!fs.existsSync(supervisorPath)) {
        missing.push(`myotis supervisor for ${platformDir}: ${supervisorPath}`);
      }
    } else {
      console.log(`  (myotis-node: not bundled for ${platformDir} — skipping)`);
    }
  }

  return missing;
}

/**
 * Arti (Tor) is OPTIONAL and built from source via `npm run tor:download`
 * (cargo), unlike the prebuilt node/addon downloads. It is intentionally not
 * a required build binary: when absent, Tor simply isn't bundled and the
 * in-app toggle stays disabled. We still create the per-platform resource dir
 * so electron-builder's `extraResources` entry resolves cleanly instead of
 * failing late during packaging.
 */
function ensureOptionalArti(platforms) {
  for (const { os, arch } of platforms) {
    if (os === 'linux') continue; // Linux deb omits bundled Arti.
    const platformDir = `${os}-${arch}`;
    // Same name `scripts/fetch-arti.js` writes and `tor-manager.js` looks for.
    const artiPath = path.join(ARTI_BIN_DIR, platformDir, os === 'win' ? 'arti.exe' : 'arti');
    if (!fs.existsSync(artiPath)) {
      fs.mkdirSync(path.join(ARTI_BIN_DIR, platformDir), { recursive: true });
      console.warn(
        `⚠️  Arti (Tor) binary not found for ${platformDir} — Tor will not be bundled.\n` +
          `   Optional; build it with: npm run tor:download  (requires a Rust toolchain)`
      );
    }
  }
}

function main() {
  const platforms = getPlatformArch();
  console.log(`Checking binaries for: ${platforms.map((p) => `${p.os}-${p.arch}`).join(', ')}`);

  // electron-builder packages whatever Electron is in node_modules
  // (app-builder-lib's computeElectronVersion() reads
  // node_modules/electron/package.json), not what the lockfile pins. A stale
  // install ships — and gets smoke-tested as — a different Electron from the
  // one CI tested (issue #346).
  const electronProblems = checkInstalledElectronVersion();
  if (electronProblems.length > 0) {
    console.error('\n❌ Build cannot proceed. Electron version mismatch:\n');
    electronProblems.forEach((p) => console.error(`  - ${p}`));
    console.error('');
    process.exit(1);
  }

  const missing = checkBinaries(platforms);

  if (missing.length > 0) {
    console.error('\n❌ Build cannot proceed. Missing binaries:\n');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('\nRun the following commands to download binaries:');
    console.error('  npm run ant:download');
    console.error('  npm run ipfs:download');
    for (const { os, arch } of platforms) {
      console.error(`  npm run radicle:download -- --${os} --${arch}`);
    }
    console.error('  npm run myotis:download');
    console.error('  npm run adblock:download\n');
    process.exit(1);
  }

  // Optional binaries (non-fatal): warn and prepare resource dirs.
  ensureOptionalArti(platforms);

  console.log('✅ All required binaries found.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { getPlatformArch, checkBinaries, checkCapabilityBinaries, ensureOptionalArti, main };
