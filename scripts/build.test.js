const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');

function run(args, environment = {}, missing = []) {
  const execSync = jest.fn();
  const buildForTargets = jest.fn();
  const assertTargetPrebuild = jest.fn(() => ({ missing, overridden: false }));
  const pruneSourceBuildFallback = jest.fn(() => ({ removed: false }));
  const readFileSync = jest.fn(() => 'production bridge');
  const existsSync = jest.fn(() => true);
  let exitCode;
  const exit = (code) => {
    exitCode = code;
    throw new Error('process exited');
  };
  const modules = {
    child_process: { execSync },
    fs: { readFileSync, existsSync },
    path,
    './build-myotis-supervisor': { buildForTargets },
    './publish-channel': { publishOverrideArgs: () => [] },
    './better-sqlite3-prebuilds': {
      SOURCE_BUILD_ENV: 'FREEDOM_BS3_SOURCE_BUILD', assertTargetPrebuild, pruneSourceBuildFallback,
    },
  };
  try {
    vm.runInNewContext(source, {
      __dirname, process: { argv: ['node', 'build.js', ...args], env: environment, exit },
      console: { log: jest.fn(), error: jest.fn() },
      require: (name) => {
        if (!modules[name]) throw new Error(`Unexpected module: ${name}`);
        return modules[name];
      },
    });
  } catch (error) {
    if (error.message !== 'process exited') throw error;
  }
  return { execSync, buildForTargets, assertTargetPrebuild, pruneSourceBuildFallback,
    readFileSync, existsSync, exitCode };
}

test.each([
  [['--linux', '--x64'], ['electron-builder --version']],
  [['--win', '--x64'], ['electron-builder --version']],
  [['--mac', '--x64', '--unsigned'], ['electron-builder --version']],
  [['--mac', '--arm64'], ['dotenv --version', 'electron-builder --version']],
])('verify-tools checks only the required CLIs for %j', (target, commands) => {
  const ctx = run(['--dist', '--verify-tools', ...target], { Path: '/original/bin' });
  expect(ctx.exitCode).toBe(0);
  expect(ctx.execSync.mock.calls.map(([command]) => command)).toEqual(commands);
  for (const [, options] of ctx.execSync.mock.calls) {
    expect(options.env.Path.split(path.delimiter)).toEqual([
      path.resolve(__dirname, '../node_modules/.bin'), '/original/bin',
    ]);
    expect(options.env.PATH).toBeUndefined();
  }
  expect(ctx.buildForTargets).not.toHaveBeenCalled();
  expect(ctx.readFileSync).not.toHaveBeenCalled();
  expect(ctx.existsSync).not.toHaveBeenCalled();
  expect(ctx.assertTargetPrebuild).not.toHaveBeenCalled();
  expect(ctx.pruneSourceBuildFallback).not.toHaveBeenCalled();
});

test('verify-tools still rejects an ambiguous target before running a CLI', () => {
  const ctx = run(['--verify-tools', '--mac', '--win']);
  expect(ctx.exitCode).toBe(1);
  expect(ctx.execSync).not.toHaveBeenCalled();
});

test('the actual build still prepares native helpers and checks target binaries', () => {
  const ctx = run(['--linux', '--x64', '--dist']);
  expect(ctx.buildForTargets).toHaveBeenCalledWith('linux', ['x64']);
  expect(ctx.assertTargetPrebuild).toHaveBeenCalledWith({ platform: 'linux', archs: ['x64'] });
  expect(ctx.pruneSourceBuildFallback).toHaveBeenCalledTimes(1);
  expect(ctx.execSync.mock.calls.map(([command]) => command)).toEqual([
    'npm run check-binaries -- --linux --x64', 'electron-builder --linux --x64',
  ]);
});

test('the actual build refuses a missing target prebuild before packaging', () => {
  const ctx = run(['--linux', '--x64', '--dist'], {}, ['linux-x64']);
  expect(ctx.exitCode).toBe(1);
  expect(ctx.pruneSourceBuildFallback).not.toHaveBeenCalled();
  expect(ctx.execSync.mock.calls.map(([command]) => command)).toEqual([
    'npm run check-binaries -- --linux --x64',
  ]);
});
