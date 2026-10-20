const fs = require('node:fs');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync('.github/workflows/release.yml', 'utf8'));
const targets = workflow.jobs.build.strategy.matrix.include;

// Evaluate the actual workflow expressions offline. No workflow is dispatched,
// and no command from a run step is executed. Refuse unsupported syntax so an
// expression change cannot silently weaken this release-policy check.
function enabled(expression, context) {
  if (expression === undefined) return true;
  const code = String(expression).replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
  const remainder = code
    .replace(/'[^']*'/g, '')
    .replace(/\b(?:runner\.os|github\.event_name|github\.ref|matrix\.publish_on_tag|startsWith|true|false)\b/g, '')
    .replace(/[\s()!,=&|]/g, '');
  if (remainder) throw new Error(`Unsupported workflow condition: ${expression}`);
  return Boolean(vm.runInNewContext(code, {
    ...context,
    startsWith: (value, prefix) => value.startsWith(prefix),
  }, { timeout: 100 }));
}

function contextFor(target, event) {
  return {
    runner: { os: target.os.startsWith('windows') ? 'Windows' : target.os.startsWith('macos') ? 'macOS' : 'Linux' },
    github: { event_name: event, ref: event === 'push' ? 'refs/tags/v0.0.0-offline-fixture' : 'refs/heads/offline-fixture' },
    matrix: target,
  };
}

function stepsFor(target, event) {
  const context = contextFor(target, event);
  return workflow.jobs.build.steps.filter((step) => enabled(step.if, context)).map((step) => step.name);
}

const shared = [
  'Check out repository',
  'Check out sentinel-ai-connect dependency',
  'Set up Node.js',
  'Cache Electron build downloads',
  'Download platform binaries',
  'Upload build artifacts',
];
const unix = [
  'Prepare sentinel-ai-connect file dependency',
  'Install dependencies',
  'Audit dependencies',
];
const windows = [
  'Prepare sentinel-ai-connect file dependency (Windows)',
  'Install dependencies (Windows)',
  'Audit dependencies (Windows)',
  'Build Windows release artifacts',
];

describe('release workflow platform eligibility', () => {
  test('only the qualified Linux x64 target is eligible for a tag', () => {
    expect(targets.filter((target) => target.publish_on_tag).map((target) => target.binary_target)).toEqual(['linux-x64']);
    expect(targets.map((target) => target.binary_target).sort()).toEqual(['linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']);
  });

  test.each(targets)('$binary_target has a coherent tag path', (target) => {
    const expected = target.binary_target === 'linux-x64'
      ? [...shared, ...unix, 'Build non-macOS release artifacts', 'Smoke packaged HNS HTTPS']
      : [];
    expect(stepsFor(target, 'push').sort()).toEqual(expected.sort());
  });

  test.each(targets)('$binary_target retains complete manual qualification', (target) => {
    const expected = target.binary_target === 'win-x64'
      ? [...shared, ...windows]
      : [...shared, ...unix, target.binary_target === 'linux-x64' ? 'Build non-macOS release artifacts' : 'Build macOS release artifacts',
        ...(target.binary_target === 'linux-x64' ? ['Smoke packaged HNS HTTPS'] : [])];
    expect(stepsFor(target, 'workflow_dispatch').sort()).toEqual(expected.sort());
  });

  test('manual qualification cannot enter the public tag publisher', () => {
    const linux = targets.find((target) => target.binary_target === 'linux-x64');
    expect(enabled(workflow.jobs.publish.if, contextFor(linux, 'workflow_dispatch'))).toBe(false);
    expect(enabled(workflow.jobs.publish.if, contextFor(linux, 'push'))).toBe(true);
    expect(workflow.jobs.publish.needs).toBe('build');
    expect(workflow.on.push.tags).toEqual(['v*']);
  });

  test('the publisher gathers only artifacts uploaded by eligible build legs', () => {
    const uploads = targets.filter((target) => stepsFor(target, 'push').includes('Upload build artifacts'));
    expect(uploads.map((target) => target.artifact_name)).toEqual(['linux-x64']);
    const download = workflow.jobs.publish.steps.find((step) => String(step.uses || '').startsWith('actions/download-artifact@'));
    expect(download.with['merge-multiple']).toBe(true);
  });
});
