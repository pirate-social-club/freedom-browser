const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPOSITORY = 'pirate-social-club/fingertipd';
const RELEASE_TAG = 'v0.1.10';
const ARCHIVE_NAME = 'hnsd-regtest-linux-x64.tar.gz';
const SUMS_NAME = 'TEST_SHA256SUMS';
const PINNED_SUMS_DIGEST = 'a31a716e711fed690981ea6ab1b4ca8543559913700b168b9777f2061089b7d2';
const OUTPUT_DIR = path.join(__dirname, '..', 'test-e2e', '.hns-fixture-bin');
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
    const request = https.get(url, { headers: { 'User-Agent': 'Freedom-HNS-Test-Fixture' } },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location) {
            return reject(new Error(`Redirect without location from ${url}`));
          }
          return download(new URL(response.headers.location, url).toString(), destination,
            redirects + 1).then(resolve, reject);
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
  const allowed = new Set(['./', './hnsd-regtest']);
  for (const entry of entries) {
    if (!allowed.has(entry)) throw new Error(`Unexpected test archive entry: ${entry}`);
  }
  if (!entries.includes('./hnsd-regtest')) {
    throw new Error('Test archive is missing ./hnsd-regtest');
  }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The HNS regtest fixture is available only for linux-x64');
  }
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-test-'));
  try {
    const sumsPath = path.join(temporaryDir, SUMS_NAME);
    const archivePath = path.join(temporaryDir, ARCHIVE_NAME);
    await download(`${RELEASE_ROOT}/${SUMS_NAME}`, sumsPath);
    if (sha256(sumsPath) !== PINNED_SUMS_DIGEST) {
      throw new Error('HNS test manifest does not match the independent in-repo pin');
    }
    const checksums = parseChecksums(fs.readFileSync(sumsPath, 'utf8'));
    await download(`${RELEASE_ROOT}/${ARCHIVE_NAME}`, archivePath);
    if (sha256(archivePath) !== checksums.get(ARCHIVE_NAME)) {
      throw new Error('HNS regtest archive checksum mismatch');
    }
    validateArchive(archivePath);
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryDir, './hnsd-regtest']);
    const source = path.join(temporaryDir, 'hnsd-regtest');
    if (sha256(source) !== checksums.get('hnsd-regtest')) {
      throw new Error('hnsd-regtest checksum mismatch after extraction');
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const destination = path.join(OUTPUT_DIR, 'hnsd-regtest');
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o755);
    console.log(`Installed verified test-only hnsd from ${REPOSITORY} ${RELEASE_TAG}`);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`HNS test fixture download failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseChecksums, validateArchive };
