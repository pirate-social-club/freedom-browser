#!/usr/bin/env node
// Source preparation only until independent source AND hosted execution review.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CASES, classifyAll } = require('./classify-results');

const DEB_SHA = 'f22cb91bf0acd76d5f649ada25500fb18eb95595f9afdef5d6fa6218984a42a2';
const ASAR_SHA = '7abca4093198f1890f9ed7555bb22d1fb256ef326d7de2a97de3103a0955638d';
const BASE = 'ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 ** 2, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, name + ' failed: ' + String(result.stderr).slice(-2000));
  return result.stdout.trim();
}

function inventory(root, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const target = path.join(root, relative);
    if (entry.isDirectory()) Object.assign(result, inventory(root, relative));
    else if (entry.isFile() && relative !== 'resources/app.asar') result[relative] = sha(target);
    else if (entry.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(target) };
  }
  return result;
}

function removeOwned(kind, name, owner) {
  const args = kind === 'image' ? ['image', 'inspect', name] : ['inspect', name];
  const read = spawnSync('docker', [...args, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (read.status !== 0 && /No such (image|object|container)/i.test(read.stderr || '')) return false;
  assert.equal(read.status, 0, 'Cannot establish ownership for cleanup');
  assert.equal(JSON.parse(read.stdout)['sc.pirate.freedom.diagnostic'], owner);
  command('docker', kind === 'image' ? ['image', 'rm', name] : ['rm', '--force', name]);
  return true;
}

async function execute(root, deb) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Hosted execution only');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, 'pirate-social-club/freedom-browser');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'No automatic or manual diagnostic retry');
  const source = process.env.SOURCE_SHA;
  assert.match(source || '', /^[a-f0-9]{40}$/);
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  assert.equal(command('git', ['rev-parse', 'HEAD']), source);
  assert.equal(command('git', ['status', '--porcelain']), '');
  assert.ok(path.isAbsolute(root) && path.isAbsolute(deb));
  const results = path.join(root, 'results');
  fs.mkdirSync(results, { recursive: true });
  const receipt = { diagnosticOnly: true, accepted: false, complete: false, source, cases: [], originalDebSha256: DEB_SHA };
  const save = () => fs.writeFileSync(path.join(results, 'summary.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  let image;
  let ownedContainer;
  let executionError;
  const owner = source + '-' + process.env.GITHUB_RUN_ID;
  try {
    assert.equal(sha(deb), DEB_SHA, 'Original deb provenance mismatch');
    const work = path.join(root, 'execution');
    assert.equal(fs.existsSync(work), false, 'One attempt only; preserve old output');
    fs.mkdirSync(work, { mode: 0o700 });
    const extracted = path.join(work, 'rootfs');
    command('dpkg-deb', ['--extract', deb, extracted]);
    const appRoot = path.join(extracted, 'opt/Freedom');
    const originalAsar = path.join(appRoot, 'resources/app.asar');
    assert.equal(sha(originalAsar), ASAR_SHA);
    const before = inventory(appRoot);
    const binaryHash = sha(path.join(appRoot, 'freedom'));
    const probe = path.join(work, 'probe');
    fs.mkdirSync(probe);
    for (const name of ['main.js', 'worker.js', 'request.js']) fs.copyFileSync(path.join(__dirname, name), path.join(probe, name));
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'freedom-runtime-fetch-diagnostic', version: '0.0.0', main: 'main.js' }));
    await require('@electron/asar').createPackage(probe, path.join(work, 'probe.asar'));
    fs.copyFileSync(path.join(work, 'probe.asar'), originalAsar);
    assert.deepEqual(inventory(appRoot), before, 'Native files or fuses changed');
    receipt.provenance = { originalAsarSha256: ASAR_SHA, probeAsarSha256: sha(originalAsar), binarySha256: binaryHash,
      allOtherFilesUnchanged: true, nativeFilesAndFusesUnchanged: true, fullApplicationExecuted: false };
    fs.writeFileSync(path.join(results, 'unchanged-native-inventory.json'), JSON.stringify(before, null, 2) + '\n');
    fs.copyFileSync(path.join(__dirname, 'supervise-probe.py'), path.join(work, 'supervise-probe.py'));
    image = 'freedom-runtime-fetch-probe:' + owner;
    const dockerfile = `FROM ${BASE}\nLABEL sc.pirate.freedom.diagnostic="${owner}"\n` +
      'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 xvfb xauth libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 libuuid1 libsecret-1-0 libunbound8 libudev1 libasound2t64 libgbm1\n' +
      'RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin diagnostic\n' +
      'COPY rootfs/opt/Freedom /opt/Freedom\nCOPY supervise-probe.py /probe/supervise-probe.py\nUSER 10001:10001\n' +
      'ENTRYPOINT ["xvfb-run", "-a", "python3", "/probe/supervise-probe.py"]\n';
    fs.writeFileSync(path.join(work, 'Dockerfile'), dockerfile);
    const build = spawnSync('docker', ['build', '--tag', image, work], {
      encoding: 'utf8', timeout: 900000, maxBuffer: 2 * 1024 ** 2,
    });
    fs.writeFileSync(path.join(results, 'image-build.stdout'), build.stdout || '');
    fs.writeFileSync(path.join(results, 'image-build.stderr'), build.stderr || '');
    receipt.imageBuild = { exitCode: build.status, clientError: build.error?.code || null };
    save();
    if (build.error) throw build.error;
    assert.equal(build.status, 0, 'Bounded diagnostic image provisioning failed');
    receipt.image = command('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    save();
    for (const [index, sample] of CASES.entries()) {
      ownedContainer = 'freedom-runtime-fetch-' + process.env.GITHUB_RUN_ID + '-' + index;
      const args = ['run', '--rm', '--name', ownedContainer, '--label', 'sc.pirate.freedom.diagnostic=' + owner,
        '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=128m',
        '--tmpfs', '/home/diagnostic:rw,nosuid,size=32m,uid=10001,gid=10001,mode=0700', '--cpus', '1',
        '--cpu-period', '100000', '--cpuset-cpus', '0', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '256',
        '--env', 'UV_THREADPOOL_SIZE=1', '--env', 'PROBE_BINARY_SHA256=' + binaryHash,
        image, sample.context, sample.representation];
      const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 ** 2 });
      fs.writeFileSync(path.join(results, `case-${index}.stdout`), run.stdout || '');
      fs.writeFileSync(path.join(results, `case-${index}.stderr`), run.stderr || '');
      receipt.cases.push({ ...sample, dockerExit: run.status, clientError: run.error?.code || null });
      save();
      assert.equal(run.error, undefined, 'Container client failed or exceeded a bound');
      assert.equal(run.status, 0, 'Diagnostic container failed');
      const row = JSON.parse(run.stdout);
      assert.equal(row.context, sample.context);
      assert.equal(row.representation, sample.representation);
      receipt.cases[index].observation = row;
      assert.equal(command('docker', ['ps', '--all', '--quiet', '--filter', 'name=^/' + ownedContainer + '$']), '');
      ownedContainer = null;
      save();
    }
    Object.assign(receipt, classifyAll(receipt.cases.map((row) => row.observation), binaryHash));
  } catch (error) {
    receipt.failure = { name: error.name, message: String(error.message).slice(0, 2000) };
    executionError = error;
  } finally {
    try {
      if (ownedContainer) receipt.ownedContainerRemoved = removeOwned('container', ownedContainer, owner);
      if (image) receipt.ownedImageRemoved = removeOwned('image', image, owner);
      assert.equal(command('docker', ['ps', '--all', '--quiet', '--filter', 'label=sc.pirate.freedom.diagnostic=' + owner]), '');
      receipt.ownedContainersGone = true;
    } catch (error) {
      receipt.complete = false;
      receipt.cleanupFailure = { name: error.name, message: String(error.message).slice(0, 2000) };
      executionError = executionError || error;
    } finally {
      save();
    }
  }
  if (executionError) throw executionError;
}

if (require.main === module) {
  if (process.argv.length === 2 || process.argv.slice(2).join(' ') === '--describe') {
    console.log(JSON.stringify({ diagnosticOnly: true, accepted: false, originalDeb: DEB_SHA, originalAsar: ASAR_SHA,
      baseImage: BASE, cases: CASES, hostedOnly: true, localExecutionAllowed: false }));
  } else {
    assert.equal(process.argv[2], '--execute', 'Default is read-only --describe; inspect source before execution');
    execute(process.argv[3], process.argv[4]).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { inventory, execute };
