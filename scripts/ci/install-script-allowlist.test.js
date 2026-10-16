/**
 * Guard: every locked package with an install script is either on the
 * install-node-deps allowlist or on the deliberate skip list below.
 *
 * `.github/actions/install-node-deps` installs with `--ignore-scripts` and then
 * rebuilds only the packages it names, because the dVPN SDKs' setup scripts
 * re-enter `npm install` without end and may `sudo` a WireGuard install. A new
 * dependency whose install script matters would otherwise be skipped silently,
 * and a package dropped from the lock would linger on the allowlist.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const ACTION = path.join(repoRoot, '.github', 'actions', 'install-node-deps', 'action.yml');
const LOCK = path.join(repoRoot, 'package-lock.json');

// Install scripts CI deliberately never runs, and why.
const SKIPPED = {
  'blue-js-sdk': 'setup re-enters npm install without end, downloads V2Ray unverified and may sudo-install WireGuard; Freedom ships pinned dvpn-bin instead',
  'sentinel-ai-connect': 'same dVPN setup as blue-js-sdk',
  '@parcel/watcher': 'only builds from source when npm_config_build_from_source is set; the platform prebuild is an optional dependency',
};

const allowlisted = () => {
  const match = fs.readFileSync(ACTION, 'utf8').match(/^\s*npm rebuild ([^\n]+)$/m);
  if (!match) throw new Error('install-node-deps names no `npm rebuild` allowlist');
  return match[1].trim().split(/\s+/).sort();
};

const withInstallScripts = () =>
  [
    ...new Set(
      Object.entries(JSON.parse(fs.readFileSync(LOCK, 'utf8')).packages)
        .filter(([key, entry]) => key && entry.hasInstallScript)
        .map(([key]) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length))
    ),
  ].sort();

describe('install-script allowlist', () => {
  test('every locked install script is allowlisted or deliberately skipped', () => {
    const covered = new Set([...allowlisted(), ...Object.keys(SKIPPED)]);
    expect(withInstallScripts().filter((name) => !covered.has(name))).toEqual([]);
  });

  test('the allowlist and skip list name only packages the lock still installs with scripts', () => {
    const locked = new Set(withInstallScripts());
    expect([...allowlisted(), ...Object.keys(SKIPPED)].filter((name) => !locked.has(name))).toEqual([]);
  });

  test('no package is both allowlisted and skipped', () => {
    expect(allowlisted().filter((name) => name in SKIPPED)).toEqual([]);
  });
});
