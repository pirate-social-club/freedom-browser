const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { createHnsEncryptedRelay } = require('./hns-encrypted-relay');
const { createHnsNativeCustody, assertNoUnresolvedNativeGeneration } = require('./hns-native-custody');

const HNSD_SOURCE = 'a5c7c287e848f46d3e97f16b698e2027c8dc96c3';
const HNSD_PATCH_SHA256 = '1b9749f6275c0814ecea487072b979cd263ed84823fe8a3a2a48cc88e8752c96';

function validateEncryptedHnsd(binaryPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(binaryPath), 'encrypted-validator.json'), 'utf8'));
  const digest = createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
  if (manifest.schema !== 1 || manifest.source_commit !== HNSD_SOURCE ||
      manifest.patch_sha256 !== HNSD_PATCH_SHA256 || manifest.sha256 !== digest) {
    throw new Error('Encrypted HNS validator provenance mismatch');
  }
}

async function createHnsValidatorTransport({ rootAddr, dataDir, binaryPath, assetsDir, onFailure }) {
  const journalPath = path.join(dataDir, 'encrypted-validator-custody.json');
  assertNoUnresolvedNativeGeneration(journalPath);
  validateEncryptedHnsd(binaryPath);
  const launcher = path.join(assetsDir, 'hns', 'hnsd-encrypted');
  fs.accessSync(launcher, fs.constants.X_OK);
  const relay = createHnsEncryptedRelay({ rootAddr, onFailure });
  try {
    const address = await relay.start();
    const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
    if (!match) throw new Error('Invalid local encrypted relay endpoint');
    const nonce = randomUUID();
    const generationDir = path.join(dataDir, `encrypted-validator-${nonce}`);
    fs.mkdirSync(generationDir, { mode: 0o700 });
    const config = path.join(generationDir, 'validator.conf');
    const receipt = path.join(generationDir, 'resolver.stat');
    // No iterative/plaintext fallback. hnsd supplies its owned root stub and
    // trust anchor; the relay keeps root authority on that local endpoint.
    fs.writeFileSync(config, [
      'server:', '  serve-expired: no', '  val-permissive-mode: no',
      '  harden-dnssec-stripped: yes',
      'forward-zone:', '  name: "."', `  forward-addr: 127.0.0.1@${match[1]}`,
      '  forward-first: no', '',
    ].join('\n'), { mode: 0o600 });
    return { relay, launcher, custody: createHnsNativeCustody(receipt, { journalPath }), env: { ...process.env,
      FREEDOM_HNSD_BINARY: binaryPath, FREEDOM_HNSD_CONFIG: config, FREEDOM_HNSD_PIDFILE: receipt } };
  } catch (error) { await relay.close(); throw error; }
}

module.exports = { createHnsValidatorTransport, validateEncryptedHnsd, HNSD_SOURCE, HNSD_PATCH_SHA256 };
