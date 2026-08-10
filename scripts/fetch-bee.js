const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const artifacts = require('./binary-artifacts.lock.json').bee;
const { downloadVerified } = require('./download-verified');

const outputDir = path.join(__dirname, '..', 'bee-bin');

function selectedArtifacts() {
  const args = process.argv.slice(2);
  const targetIndex = args.indexOf('--target');
  if (targetIndex === -1) return Object.entries(artifacts.targets);
  const target = args[targetIndex + 1];
  if (!artifacts.targets[target]) throw new Error(`Unsupported Bee target: ${target}`);
  return [[target, artifacts.targets[target]]];
}

function extract(archive, targetDir, kind) {
  const command = kind === 'zip' ? 'unzip' : 'tar';
  const args = kind === 'zip' ? ['-o', archive, '-d', targetDir] : ['-xzf', archive, '-C', targetDir];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function findBinary(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && (entry.name === 'bee' || entry.name === 'bee.exe')) return candidate;
    if (entry.isDirectory()) {
      const found = findBinary(candidate);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  console.log(`Installing pinned Bee ${artifacts.version}`);

  for (const [target, artifact] of selectedArtifacts()) {
    const targetDir = path.join(outputDir, target);
    const executable = target.startsWith('win-') ? 'bee.exe' : 'bee';
    const destination = path.join(targetDir, executable);
    const archiveName = path.basename(new URL(artifact.url).pathname);
    const downloadPath = artifact.archive ? path.join(targetDir, archiveName) : destination;
    fs.mkdirSync(targetDir, { recursive: true });

    await downloadVerified(artifact.url, downloadPath, 'sha256', artifact.sha256);
    if (artifact.archive) {
      extract(downloadPath, targetDir, artifact.archive);
      fs.rmSync(downloadPath, { force: true });
      const found = findBinary(targetDir);
      if (!found) throw new Error(`Bee executable missing after extracting ${target}`);
      if (found !== destination) fs.renameSync(found, destination);
    }

    if (!target.startsWith('win-')) fs.chmodSync(destination, 0o755);
    console.log(`Installed verified Bee for ${target}`);
  }

  if (selectedArtifacts().some(([target]) => target === 'win-x64')) {
    const windowsArmDirectory = path.join(outputDir, 'win-arm64');
    fs.mkdirSync(windowsArmDirectory, { recursive: true });
    fs.copyFileSync(
      path.join(outputDir, 'win-x64', 'bee.exe'),
      path.join(windowsArmDirectory, 'bee.exe')
    );
  }
}

main().catch((error) => {
  console.error('Bee download failed:', error.message);
  process.exit(1);
});
