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
  test('the matrix keeps its four targets, with only Linux x64 marked publish_on_tag', () => {
    expect(targets.filter((target) => target.publish_on_tag).map((target) => target.binary_target)).toEqual(['linux-x64']);
    expect(targets.map((target) => target.binary_target).sort()).toEqual(['linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']);
  });

  test.each(targets)('$binary_target retains complete manual qualification', (target) => {
    const expected = target.binary_target === 'win-x64'
      ? [...shared, ...windows]
      : [...shared, ...unix, target.binary_target === 'linux-x64' ? 'Build non-macOS release artifacts' : 'Build macOS release artifacts',
        ...(target.binary_target === 'linux-x64' ? ['Smoke packaged HNS HTTPS'] : [])];
    expect(stepsFor(target, 'workflow_dispatch').sort()).toEqual(expected.sort());
  });

  test('no tag push or schedule starts the workflow; only a manual dispatch does', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });
});

describe('release workflow publishes nothing', () => {
  const workflowDir = '.github/workflows';
  const files = fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));

  test('it has no publish job and its token can only read', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'quality']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
    }
  });

  // Any way a step can see the workflow token: an env entry, a with: input or
  // an inline expression, under either of its names.
  const TOKEN = /\bGITHUB_TOKEN\b|\bGH_TOKEN\b|github\.token/;
  const mentionsToken = (value) => TOKEN.test(JSON.stringify(value || {}));

  test('the token reaches only the binary download step, never npm ci', () => {
    expect(mentionsToken(workflow.env)).toBe(false);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect({ job: name, jobEnv: mentionsToken(job.env) }).toEqual({ job: name, jobEnv: false });
      for (const step of job.steps) {
        const usesToken = mentionsToken(step.env) || mentionsToken(step.with) || TOKEN.test(String(step.run || ''));
        expect({ job: name, step: step.name, usesToken }).toEqual({
          job: name,
          step: step.name,
          usesToken: name === 'build' && step.name === 'Download platform binaries',
        });
      }
    }
  });

  test('no checkout leaves the token in .git/config', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter((s) => String(s.uses || '').startsWith('actions/checkout@'))) {
        expect({ step: step.name, persist: step.with && step.with['persist-credentials'] }).toEqual({
          step: step.name,
          persist: false,
        });
      }
    }
  });

  test('both jobs pin the Node version the evaluation build uses', () => {
    for (const job of Object.values(workflow.jobs)) {
      const setup = job.steps.find((step) => String(step.uses || '').startsWith('actions/setup-node@'));
      expect(String(setup.with['node-version'])).toBe('24.14.0');
    }
  });

  test.each(files)('%s neither creates nor uploads a GitHub release', (name) => {
    const text = fs.readFileSync(`${workflowDir}/${name}`, 'utf8');
    expect(text).not.toMatch(/\bgh\s+release\b/);
    expect(text).not.toMatch(/--clobber/);
    expect(text).not.toMatch(/\brepos\/[^\s]*\/releases\b/);
    expect(text).not.toMatch(/action-gh-release|release-action|create-release|upload-release-asset/);
  });

  test('only bump-version.yml may hold contents: write', () => {
    const writers = files.filter((name) => {
      const doc = yaml.load(fs.readFileSync(`${workflowDir}/${name}`, 'utf8')) || {};
      const grants = [doc.permissions, ...Object.values(doc.jobs || {}).map((job) => job.permissions)];
      return grants.some((grant) => grant === 'write-all' || (grant && grant.contents === 'write'));
    });
    expect(writers).toEqual(['bump-version.yml']);
  });
});
