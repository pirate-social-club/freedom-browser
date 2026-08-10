const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { pipeline } = require('stream/promises');

const MAX_REDIRECTS = 5;

function assertDigest(actual, algorithm, expected, context = 'content') {
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${algorithm} mismatch for ${context}: expected ${expected}, received ${actual}`);
  }
}

function verifyDigest(buffer, algorithm, expected) {
  const actual = crypto.createHash(algorithm).update(buffer).digest('hex');
  assertDigest(actual, algorithm, expected);
}

async function downloadVerified(url, destination, algorithm, expected, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS download: ${url}`);
  }

  const temporary = `${destination}.download`;
  fs.rmSync(temporary, { force: true });

  const response = await new Promise((resolve, reject) => {
    const request = https.get(parsedUrl, { headers: { 'User-Agent': 'Freedom-Updater' } }, resolve);
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error(`Download timed out: ${url}`)));
  });

  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    const location = response.headers.location;
    if (!location) {
      throw new Error(`Redirect from ${url} did not include a location`);
    }
    return downloadVerified(new URL(location, parsedUrl).toString(), destination, algorithm, expected, redirectCount + 1);
  }

  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`HTTP ${response.statusCode} for ${url}`);
  }

  const hash = crypto.createHash(algorithm);
  response.on('data', (chunk) => hash.update(chunk));

  try {
    await pipeline(response, fs.createWriteStream(temporary, { flags: 'wx' }));
    const actual = hash.digest('hex');
    assertDigest(actual, algorithm, expected, url);
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

module.exports = { downloadVerified, verifyDigest };
