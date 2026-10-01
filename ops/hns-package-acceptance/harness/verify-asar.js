const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const BUILDER_VERSION = '26.15.3';
const TRANSFORMER_SHA256 = '0c4e855d5c9c6682a165c78dfc7206f35b17fd57321627cbb5259dce433c6ec9';
const RUNTIME_FIELDS = ['name', 'version', 'main', 'type', 'dependencies', 'exports', 'imports', 'browser', 'engines'];
const FAILURE_MESSAGES = Object.freeze({
  'locked builder version changed': 'builder_version_changed',
  'locked metadata transformer changed': 'transformer_changed',
  'unexpected extraMetadata': 'unexpected_metadata_config',
  'unexpected electronCompile': 'unexpected_metadata_config',
  'invalid source digest': 'invalid_source_digest',
  'source entry escapes repository': 'invalid_source_path',
  'raw source changed': 'raw_source_changed',
  'app transformed metadata mismatch': 'app_metadata_mismatch',
  'Axios transformed metadata mismatch': 'axios_metadata_mismatch',
  'Axios nested transformed metadata mismatch': 'axios_nested_metadata_mismatch',
  'runtime field presence changed': 'runtime_field_presence_changed',
  'runtime field changed': 'runtime_field_changed',
  'packaged Axios version changed': 'axios_version_changed',
  'app code mismatch': 'app_code_mismatch',
  'Axios code mismatch': 'axios_code_mismatch',
  'packaged code mismatch': 'packaged_code_mismatch',
  'app metadata proof missing': 'app_metadata_proof_missing',
  'Axios metadata proof missing': 'axios_metadata_proof_missing',
});
const FAILURE_CODES = Object.freeze([...new Set([...Object.values(FAILURE_MESSAGES), 'extractor_failure', 'unknown', 'success_proof_missing'])]);
class ExtractorFailure extends Error {}
function failureCode(error) {
  if (error instanceof ExtractorFailure) return 'extractor_failure';
  if (error instanceof assert.AssertionError) {
    const message = String(error.message).split('\n')[0];
    return Object.hasOwn(FAILURE_MESSAGES, message) ? FAILURE_MESSAGES[message] : 'unknown';
  }
  return 'unknown';
}
function emitFailure(error, output) {
  output.write(JSON.stringify({ passed: false, code: failureCode(error) }) + '\n');
}
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function verifyAsar({ repository, archive, sourceManifest }, overrides = {}) {
  const root = path.resolve(repository);
  const requireFromRepo = createRequire(path.join(root, 'package.json'));
  for (const moduleName of ['electron-builder', 'app-builder-lib']) {
    assert.equal(requireFromRepo(`${moduleName}/package.json`).version, BUILDER_VERSION, 'locked builder version changed');
  }
  const transformerFile = requireFromRepo.resolve('app-builder-lib/out/fileTransformer');
  assert.equal(digest(fs.readFileSync(transformerFile)), TRANSFORMER_SHA256, 'locked metadata transformer changed');
  const sourceMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const config = sourceMetadata.build || {};
  assert.equal(config.extraMetadata, undefined, 'unexpected extraMetadata');
  assert.equal(config.electronCompile, undefined, 'unexpected electronCompile');
  const { createTransformer } = requireFromRepo('app-builder-lib/out/fileTransformer');
  const transformer = createTransformer(root, config, undefined);
  const extractFile = overrides.extractFile || requireFromRepo('@electron/asar').extractFile;
  const checks = JSON.parse(fs.readFileSync(sourceManifest));
  const metadataProofs = [];
  let strictCodeFiles = 0;
  for (const [name, expectedRaw] of Object.entries(checks)) {
    assert.match(expectedRaw, /^[0-9a-f]{64}$/, 'invalid source digest');
    const sourceFile = path.resolve(root, name);
    assert.ok(sourceFile.startsWith(root + path.sep), 'source entry escapes repository');
    const raw = fs.readFileSync(sourceFile);
    assert.equal(digest(raw), expectedRaw, 'raw source changed');
    let actual;
    try { actual = extractFile(archive, name); } catch { throw new ExtractorFailure(); }
    if (name === 'package.json' || (name.startsWith('node_modules/axios/') && name.endsWith('/package.json'))) {
      const transformed = await transformer(sourceFile);
      const expected = transformed === null ? raw : Buffer.from(transformed);
      assert.equal(digest(actual), digest(expected), name === 'package.json' ? 'app transformed metadata mismatch' : name === 'node_modules/axios/package.json' ? 'Axios transformed metadata mismatch' : 'Axios nested transformed metadata mismatch');
      const before = JSON.parse(raw);
      const after = JSON.parse(actual);
      for (const field of RUNTIME_FIELDS) {
        assert.equal(Object.hasOwn(after, field), Object.hasOwn(before, field), 'runtime field presence changed');
        if (Object.hasOwn(before, field)) assert.deepEqual(after[field], before[field], 'runtime field changed');
      }
      if (name === 'node_modules/axios/package.json') assert.equal(after.version, '1.20.0', 'packaged Axios version changed');
      metadataProofs.push({ path: name, raw_source_sha256: expectedRaw, expected_transformed_sha256: digest(expected), actual_sha256: digest(actual), runtime_fields_verified: RUNTIME_FIELDS });
    } else {
      assert.equal(digest(actual), expectedRaw, name.startsWith('src/') ? 'app code mismatch' : name.startsWith('node_modules/axios/') ? 'Axios code mismatch' : 'packaged code mismatch');
      strictCodeFiles += 1;
    }
  }
  assert.ok(metadataProofs.some((entry) => entry.path === 'package.json'), 'app metadata proof missing');
  assert.ok(metadataProofs.some((entry) => entry.path === 'node_modules/axios/package.json'), 'Axios metadata proof missing');
  return { passed: true, builder_version: BUILDER_VERSION, metadata_transformer_sha256: TRANSFORMER_SHA256, strict_code_files_compared: strictCodeFiles, metadata_proofs: metadataProofs };
}

if (require.main === module) {
  const [repository, sourceManifest, archive, receipt] = process.argv.slice(2);
  verifyAsar({ repository, sourceManifest, archive }).then((proof) => {
    fs.writeFileSync(receipt, JSON.stringify(proof, null, 2) + '\n');
  }).catch((error) => {
    emitFailure(error, process.stdout);
    process.exitCode = 1;
  });
}

module.exports = { verifyAsar, RUNTIME_FIELDS, TRANSFORMER_SHA256, failureCode, emitFailure, FAILURE_CODES, ExtractorFailure };
