const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPOSITORY = 'pirate-social-club/fingertipd';
const RELEASE_TAG = 'v0.1.10';
const ARCHIVE_NAME = 'freedom-hns-linux-x64.tar.gz';
const SUMS_NAME = 'SHA256SUMS';
const PINNED_SUMS_DIGEST = '7b454ede4953f42306613ad7549176c15a25039426c10915fa914b8e2e7b1e2e';
const OUTPUT_DIR = path.join(__dirname, '..', 'hns-bin', 'linux-x64');
const RELEASE_ROOT = `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}`;
const REQUEST_TIMEOUT_MS = 60_000;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64})\s+\*?([^/]+)$/i);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

function download(url, destination, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error(`Too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Freedom-HNS-Updater' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${token}`;
    const request = https.get(url, { headers }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (!location) return reject(new Error(`Redirect without location from ${url}`));
        return download(new URL(location, url).toString(), destination, redirects + 1)
          .then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(destination, { mode: 0o600 });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`Timed out: ${url}`)));
    request.on('error', reject);
  });
}

function validateArchive(archivePath) {
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const allowedFiles = new Set([
    './fingertipd',
    './hnsd',
    './licenses/fingertipd-MIT.txt',
    './licenses/hnsd-MIT.txt',
    './licenses/letsdane-Apache-2.0.txt',
  ]);
  for (const entry of entries) {
    if (entry === './' || entry === './licenses/') continue;
    if (!allowedFiles.has(entry)) throw new Error(`Unexpected archive entry: ${entry}`);
  }
  for (const required of ['./fingertipd', './hnsd']) {
    if (!entries.includes(required)) throw new Error(`Archive is missing ${required}`);
  }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('HNS binaries are currently available only for linux-x64');
  }
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-'));
  try {
    const sumsPath = path.join(temporaryDir, SUMS_NAME);
    const archivePath = path.join(temporaryDir, ARCHIVE_NAME);
    await download(`${RELEASE_ROOT}/${SUMS_NAME}`, sumsPath);
    if (sha256(sumsPath) !== PINNED_SUMS_DIGEST) {
      throw new Error('HNS SHA256SUMS does not match the in-repo trust pin');
    }
    const checksums = parseChecksums(fs.readFileSync(sumsPath, 'utf8'));
    await download(`${RELEASE_ROOT}/${ARCHIVE_NAME}`, archivePath);
    if (sha256(archivePath) !== checksums.get(ARCHIVE_NAME)) {
      throw new Error('HNS archive checksum mismatch');
    }
    validateArchive(archivePath);
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryDir, './fingertipd', './hnsd']);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const binary of ['fingertipd', 'hnsd']) {
      const source = path.join(temporaryDir, binary);
      if (sha256(source) !== checksums.get(binary)) {
        throw new Error(`${binary} checksum mismatch after extraction`);
      }
      const destination = path.join(OUTPUT_DIR, binary);
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o755);
    }
    console.log(`Installed verified HNS binaries from ${REPOSITORY} ${RELEASE_TAG}`);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`HNS binary download failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseChecksums, validateArchive };
