const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROFILE_REGISTRY_FILE,
  getCheckoutId,
  loadCatalog,
  sanitizeProfileId,
} = require('../src/main/profile-catalog');
const { isProfileLocked } = require('../src/main/profile-lock');

const CURRENT_DEV_SCOPE = 'dev';
const ALL_DEV_SCOPE = 'all-dev';
const PROD_SCOPE = 'prod';

const ANT_CACHE_ENTRIES = ['chunks.sqlite', 'peers.json'];
const OPTIONAL_UPLOAD_ENTRIES = ['uploads'];
const LEGACY_BEE_CACHE_ENTRIES = ['localstore', 'statestore', 'kademlia-metrics'];

function printHelp() {
  console.log(`
Reset Freedom-managed Ant cache files without changing profile identity.

Dry-run by default:
  npm run ant:cache:reset

Apply to every profile in the current dev checkout:
  npm run ant:cache:reset -- --yes

Useful options:
  --profile <id>              Limit to one profile id.
  --scope dev|all-dev|prod    Target current checkout dev data, all dev checkouts, or packaged data.
  --app-root <path>           Target an explicit Freedom app data root.
  --include-uploads           Also remove in-flight upload resume state.
  --include-legacy-bee-cache  Also remove migrated Bee cache dirs when Ant identity exists.
  --yes                       Actually remove files. Without this, only prints what would happen.
`.trim());
}

function parseArgs(argv) {
  const options = {
    appRoot: null,
    includeLegacyBeeCache: false,
    includeUploads: false,
    profiles: [],
    scope: CURRENT_DEV_SCOPE,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--include-uploads') {
      options.includeUploads = true;
    } else if (arg === '--include-legacy-bee-cache') {
      options.includeLegacyBeeCache = true;
    } else if (arg === '--all-dev') {
      options.scope = ALL_DEV_SCOPE;
    } else if (arg === '--prod') {
      options.scope = PROD_SCOPE;
    } else if (arg === '--scope') {
      index += 1;
      options.scope = argv[index];
    } else if (arg.startsWith('--scope=')) {
      options.scope = arg.slice('--scope='.length);
    } else if (arg === '--app-root') {
      index += 1;
      options.appRoot = argv[index];
    } else if (arg.startsWith('--app-root=')) {
      options.appRoot = arg.slice('--app-root='.length);
    } else if (arg === '--profile') {
      index += 1;
      options.profiles.push(sanitizeProfileId(argv[index]));
    } else if (arg.startsWith('--profile=')) {
      options.profiles.push(sanitizeProfileId(arg.slice('--profile='.length)));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.appRoot && ![CURRENT_DEV_SCOPE, ALL_DEV_SCOPE, PROD_SCOPE].includes(options.scope)) {
    throw new Error(`Unsupported scope: ${options.scope}`);
  }

  return options;
}

function getAppDataRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function getRepoRoot() {
  return fs.realpathSync(path.join(__dirname, '..'));
}

function getCurrentDevAppRoot() {
  if (process.env.FREEDOM_DEV_HOME) {
    return path.resolve(process.env.FREEDOM_DEV_HOME);
  }

  return path.join(getAppDataRoot(), 'Freedom Dev', getCheckoutId(getRepoRoot()));
}

function listDevAppRoots() {
  const devRoot = path.join(getAppDataRoot(), 'Freedom Dev');
  if (!fs.existsSync(devRoot)) {
    return [];
  }

  return fs.readdirSync(devRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('freedom-browser-'))
    .map((entry) => path.join(devRoot, entry.name));
}

function getTargetAppRoots(options) {
  if (options.appRoot) {
    return [path.resolve(options.appRoot)];
  }

  if (options.scope === ALL_DEV_SCOPE) {
    return listDevAppRoots();
  }

  if (options.scope === PROD_SCOPE) {
    return [path.join(getAppDataRoot(), 'Freedom')];
  }

  return [getCurrentDevAppRoot()];
}

function pathInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch path outside ${resolvedRoot}: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function hasCatalog(appRoot) {
  return fs.existsSync(path.join(appRoot, PROFILE_REGISTRY_FILE));
}

function getProfileRecords(appRoot, profileIds) {
  if (!hasCatalog(appRoot)) {
    return [];
  }

  const profileFilter = profileIds.length ? new Set(profileIds) : null;
  return loadCatalog(appRoot).profiles
    .filter((record) => !profileFilter || profileFilter.has(record.id))
    .map((record) => ({
      displayName: record.displayName || record.id,
      id: record.id,
      userDataDir: record.dir,
    }));
}

function targetIfPresent(root, entryName) {
  const target = pathInside(root, path.join(root, entryName));
  return fs.existsSync(target) ? target : null;
}

function getResetTargets(profile, options) {
  const antDataDir = path.join(profile.userDataDir, 'ant-data');
  const targets = [];

  for (const entry of ANT_CACHE_ENTRIES) {
    const target = targetIfPresent(antDataDir, entry);
    if (target) targets.push(target);
  }

  if (options.includeUploads) {
    for (const entry of OPTIONAL_UPLOAD_ENTRIES) {
      const target = targetIfPresent(antDataDir, entry);
      if (target) targets.push(target);
    }
  }

  if (options.includeLegacyBeeCache && fs.existsSync(path.join(antDataDir, 'keys', 'swarm.key'))) {
    const beeDataDir = path.join(profile.userDataDir, 'bee-data');
    for (const entry of LEGACY_BEE_CACHE_ENTRIES) {
      const target = targetIfPresent(beeDataDir, entry);
      if (target) targets.push(target);
    }
  }

  return targets;
}

function resetProfileCache(profile, options) {
  const label = `${profile.displayName} (${profile.id})`;
  if (isProfileLocked({ ...profile, isDev: options.isDev })) {
    console.log(`- ${label}: skipped because the profile is currently open`);
    return { removed: 0, skipped: true };
  }

  const targets = getResetTargets(profile, options);
  if (!targets.length) {
    console.log(`- ${label}: no cache files found`);
    return { removed: 0, skipped: false };
  }

  console.log(`- ${label}:`);
  for (const target of targets) {
    if (options.yes) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`  removed ${target}`);
    } else {
      console.log(`  would remove ${target}`);
    }
  }

  return { removed: targets.length, skipped: false };
}

function resetAppRoot(appRoot, options) {
  const isDev = options.scope === CURRENT_DEV_SCOPE
    || options.scope === ALL_DEV_SCOPE
    || path.basename(path.dirname(appRoot)) === 'Freedom Dev'
    || path.basename(appRoot).startsWith('freedom-browser-');
  console.log(`\nApp data root: ${appRoot}`);

  if (!hasCatalog(appRoot)) {
    console.log('  no profile catalog found');
    return { profiles: 0, targets: 0 };
  }

  const profiles = getProfileRecords(appRoot, options.profiles);
  if (!profiles.length) {
    console.log('  no matching profiles found');
    return { profiles: 0, targets: 0 };
  }

  let targets = 0;
  for (const profile of profiles) {
    const result = resetProfileCache(profile, {
      ...options,
      isDev,
    });
    targets += result.removed;
  }

  return { profiles: profiles.length, targets };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.yes) {
    console.log('Dry run only. Re-run with --yes to remove the listed files.');
  }
  if (options.includeUploads) {
    console.log('Including upload resume state.');
  }
  if (options.includeLegacyBeeCache) {
    console.log('Including migrated Bee cache dirs when Ant identity exists.');
  }

  const appRoots = getTargetAppRoots(options);
  if (!appRoots.length) {
    console.log('No app data roots matched.');
    return;
  }

  let profileCount = 0;
  let targetCount = 0;
  for (const appRoot of appRoots) {
    const result = resetAppRoot(appRoot, options);
    profileCount += result.profiles;
    targetCount += result.targets;
  }

  const verb = options.yes ? 'removed' : 'would remove';
  console.log(`\nDone: ${verb} ${targetCount} cache path(s) across ${profileCount} profile(s).`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
