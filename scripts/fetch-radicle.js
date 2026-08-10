const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const artifacts = require('./binary-artifacts.lock.json').radicle;
const { downloadVerified } = require('./download-verified');

const outputDir = path.join(__dirname, '..', 'radicle-bin');
const requiredBinaries = ['rad', 'radicle-node', 'radicle-httpd', 'git-remote-rad'];

function selectedTargets() {
  const args = process.argv.slice(2);
  if (args.includes('--all')) return Object.keys(artifacts.targets);
  const targetIndex = args.indexOf('--target');
  if (targetIndex !== -1 && args[targetIndex + 1]) return [args[targetIndex + 1]];
  const os = process.platform === 'darwin' ? 'mac' : process.platform;
  return [`${os}-${process.arch}`];
}

function extract(archive, targetDir) {
  const result = spawnSync('tar', ['-xJf', archive, '-C', targetDir], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`);
}

function findBinaries(directory, found = {}) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && requiredBinaries.includes(entry.name)) found[entry.name] = candidate;
    if (entry.isDirectory()) findBinaries(candidate, found);
  }
  return found;
}

async function installTarget(targetKey) {
  const artifact = artifacts.targets[targetKey];
  if (!artifact) throw new Error(`Unsupported Radicle target: ${targetKey}`);

  const targetDir = path.join(outputDir, targetKey);
  fs.mkdirSync(targetDir, { recursive: true });
  const mainName = `radicle-${artifacts.version}-${artifact.target}.tar.xz`;
  const httpdName = `radicle-httpd-${artifacts.httpdVersion}-${artifact.target}.tar.xz`;
  const downloads = [
    {
      name: mainName,
      url: `https://files.radicle.xyz/releases/latest/${mainName}`,
      digest: artifact.mainSha256,
    },
    {
      name: httpdName,
      url: `https://files.radicle.xyz/releases/radicle-httpd/latest/${httpdName}`,
      digest: artifact.httpdSha256,
    },
  ];

  for (const download of downloads) {
    const archive = path.join(targetDir, download.name);
    await downloadVerified(download.url, archive, 'sha256', download.digest);
    extract(archive, targetDir);
    fs.rmSync(archive, { force: true });
  }

  const found = findBinaries(targetDir);
  for (const name of requiredBinaries) {
    const source = found[name];
    if (!source) throw new Error(`Radicle archive for ${targetKey} is missing ${name}`);
    const destination = path.join(targetDir, name);
    if (source !== destination) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(source, destination);
    }
    fs.chmodSync(destination, 0o755);
  }

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
  }
  console.log(`Installed verified Radicle binaries for ${targetKey}`);
}

async function main() {
  console.log(`Installing pinned Radicle ${artifacts.version} and HTTPD ${artifacts.httpdVersion}`);
  for (const target of selectedTargets()) await installTarget(target);
}

main().catch((error) => {
  console.error('Radicle download failed:', error.message);
  process.exit(1);
});
