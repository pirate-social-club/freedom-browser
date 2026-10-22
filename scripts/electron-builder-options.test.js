const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Use the real Node loader: Jest's loader cannot import the builder's nested ESM dependencies.
// This child parses fixed arguments only; it never calls build or downloads anything.
function parseWithNode(expression) {
  // Source checks can be throttled to ten percent of one CPU.
  const output = execFileSync(process.execPath, ['--max-old-space-size=128', '-e', `
    const { createYargs, configureBuildCommand } = require('electron-builder/out/builder');
    const parser = configureBuildCommand(createYargs()).exitProcess(false).strict();
    ${expression}
  `], { cwd: path.resolve(__dirname, '..'), timeout: 120000, encoding: 'utf8' });
  return JSON.parse(output.trim());
}

describe('Linux deb version', () => {
  test('carries Debian epoch 1, so it orders above upstream 0.8.x debs of the same package name', () => {
    const { build } = require('../package.json');
    const fpm = build.deb.fpm;
    expect(fpm.slice(fpm.indexOf('--epoch'), fpm.indexOf('--epoch') + 2)).toEqual(['--epoch', '1']);
  });
});

describe('locked electron-builder deb argument parser', () => {
  test('accepts the actual offline Linux deb target without invoking build', () => {
    const parsed = parseWithNode(`
      const args = parser.parse(['--linux', 'deb', '--x64', '--publish', 'never']);
      console.log(JSON.stringify({ linux: args.linux, x64: args.x64, publish: args.publish }));
    `);
    expect(parsed.linux).toEqual(['deb']);
    expect(parsed.x64).toBe(true);
    expect(parsed.publish).toBe('never');
  });

  test('refuses an invented standalone deb option', () => {
    const result = parseWithNode(`
      parser.fail(message => { throw new Error(message); });
      let refused = false;
      try { parser.parse(['--linux', '--x64', '--deb']); }
      catch (error) { refused = /Unknown argument.*deb/.test(error.message); }
      console.log(JSON.stringify({ refused }));
    `);
    expect(result.refused).toBe(true);
  });
});
