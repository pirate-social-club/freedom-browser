const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const artifacts = require('./binary-artifacts.lock.json').ipfs;
const { downloadVerified } = require('./download-verified');

const outputDir = path.join(__dirname, '..', 'ipfs-bin');

function selectedArtifacts() {
  const args = process.argv.slice(2);
  const targetIndex = args.indexOf('--target');
  if (targetIndex === -1) return Object.entries(artifacts.targets);
  const target = args[targetIndex + 1];
  if (!artifacts.targets[target]) throw new Error(`Unsupported Kubo target: ${target}`);
  return [[target, artifacts.targets[target]]];
}

function extract(archive, targetDir, kind) {
  const command = kind === 'zip' ? 'unzip' : 'tar';
  const args = kind === 'zip' ? ['-o', archive, '-d', targetDir] : ['-xzf', archive, '-C', targetDir];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

async function main() {
  console.log(`Installing pinned Kubo ${artifacts.version}`);

  for (const [target, artifact] of selectedArtifacts()) {
    const targetDir = path.join(outputDir, target);
    const archiveName = path.basename(new URL(artifact.url).pathname);
    const archivePath = path.join(targetDir, archiveName);
    const executable = target.startsWith('win-') ? 'ipfs.exe' : 'ipfs';
    const destination = path.join(targetDir, executable);
    fs.mkdirSync(targetDir, { recursive: true });

    await downloadVerified(artifact.url, archivePath, 'sha512', artifact.sha512);
    extract(archivePath, targetDir, artifact.archive);
    fs.rmSync(archivePath, { force: true });

    const extracted = path.join(targetDir, 'kubo', executable);
    if (!fs.existsSync(extracted)) throw new Error(`Kubo executable missing after extracting ${target}`);
    fs.rmSync(destination, { force: true });
    fs.renameSync(extracted, destination);
    fs.rmSync(path.join(targetDir, 'kubo'), { recursive: true, force: true });
    if (!target.startsWith('win-')) fs.chmodSync(destination, 0o755);
    console.log(`Installed verified Kubo for ${target}`);
  }
}

main().catch((error) => {
  console.error('Kubo download failed:', error.message);
  process.exit(1);
});
