const { execFileSync } = require('node:child_process');
const path = require('node:path');

// What electron-builder puts in app.asar, decided by the locked builder's own
// code: its config normalization (doMergeConfigs) and main file matcher
// (getMainFileMatchers), run in a child under the real Node loader. Nothing is
// built or downloaded.
//
// The trap this guards: electron-builder normalizes the top-level `files` into
// a file set of its own, so a platform `files` list holding only exclusions
// becomes a matcher with no inclusions, and the builder fills that in with
// `**/*`. The union then ships the whole repository (docs, ops, tests, agent
// files), which the 0.8.7 Linux deb did.
const ROOT = path.resolve(__dirname, '..');

function admitted(platform, paths) {
  const output = execFileSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '-e',
      `
      const fs = require('fs');
      const path = require('path');
      const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
      const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher');
      const root = ${JSON.stringify(ROOT)};
      const config = doMergeConfigs([JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build]);
      const info = { isPrepackedAppAsar: false, config, projectDir: root, buildResourcesDir: 'build', debugLogger: { isEnabled: false } };
      const matchers = getMainFileMatchers(root, '/app', (s) => s.split('\${arch}').join('x64'), config[${JSON.stringify(platform)}] || {}, { info }, path.join(root, 'dist'), false);
      const filters = matchers.map((m) => m.createFilter());
      const result = {};
      for (const rel of ${JSON.stringify(paths)}) {
        const file = path.join(root, rel);
        result[rel] = filters.some((filter) => filter(file, fs.statSync(file)));
      }
      console.log(JSON.stringify(result));
    `,
    ],
    { cwd: ROOT, timeout: 120000, encoding: 'utf8' }
  );
  return JSON.parse(output.trim());
}

const SHIPPED = ['src', 'src/main/index.js', 'src/main/spaces/anchors.js', 'package.json'];
const NOT_SHIPPED = [
  'docs',
  'ops',
  'test',
  'test/fixtures/spaces/query-yahoo-cosmos.bin',
  'test-e2e',
  'research',
  'scripts',
  'AGENTS.md',
  'src/main/spaces/anchors.test.js',
  'src/main/__tests__/integration/ccip-proxy-electron-probe.js',
  'src/main/wallet/safe/__tests__/helpers/stub-chain.js',
];

describe.each(['linux', 'mac', 'win'])('%s app.asar contents', (platform) => {
  test('hold the app sources and package.json, never the rest of the repository', () => {
    const result = admitted(platform, [...SHIPPED, ...NOT_SHIPPED]);
    expect(
      Object.entries(result)
        .filter(([, shipped]) => shipped)
        .map(([rel]) => rel)
    ).toEqual(SHIPPED);
  });
});
