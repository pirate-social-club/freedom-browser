const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const BUILDER_VERSION = '26.15.3';
const TRANSFORMER_SHA256 = '0c4e855d5c9c6682a165c78dfc7206f35b17fd57321627cbb5259dce433c6ec9';
const RUNTIME_FIELDS = ['name', 'version', 'main', 'type', 'dependencies', 'exports', 'imports', 'browser', 'engines'];
const COLLECTOR_PINS = Object.freeze({
  'node-module-collector/npmNodeModulesCollector.js': '8cbc8cfbd43092a9da8851711bc82a7ebf0d73a3b4ac5d5faac8ff3bea61dc51',
  'node-module-collector/nodeModulesCollector.js': '490b05e03bb2276dea3e965213cb15d088fea796db733c995b1e4a8d67b814c3',
  'node-module-collector/moduleManager.js': '111927198ed7a61344194f70512c6cadd3763e236f7034f9cd43fd223cf0c10c',
  'node-module-collector/hoist.js': '41b466e2245944f9492a9f938a2c5a90f5b8fae80c0aa09044c9a2d54862fd6e',
  'node-module-collector/packageManager.js': 'ff348915c27c3625f856a2d81b33374361fe5f3871aa5c9a26cfd6ee424b93d2',
  'util/appFileCopier.js': 'fffe1c6f9e8dd95b47799a88202714dbe0aa55fb1e57255d17090036f6094512'
});
const FAILURE_MESSAGES = Object.freeze({
  'selected Axios source missing': 'selected_axios_source_missing',
  'selected Axios source escapes module': 'selected_axios_source_escape',
  'selected Axios source byte mismatch': 'selected_axios_source_mismatch',
  'production collector implementation changed': 'collector_changed',
  'production collector returned no modules': 'collector_empty',
  'invalid production destination': 'mapping_invalid_destination',
  'duplicate production destination': 'mapping_ambiguous',
  'nested source owner missing': 'mapping_owner_missing',
  'nested source owner ambiguous': 'mapping_ambiguous',
  'source module version changed': 'mapping_version_changed',
  'top Axios production destination changed': 'mapping_top_axios_changed',
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
const EXTRACT_SCOPES = ['app_code', 'app_metadata', 'axios_code', 'axios_metadata', 'axios_nested_code', 'axios_nested_metadata'];
class ExtractorFailure extends Error {
  constructor(scope, kind) { super(); this.scope = scope; this.kind = kind; }
}
function extractionScope(name) {
  if (name === 'package.json') return 'app_metadata';
  if (name.startsWith('src/')) return 'app_code';
  const nested = name.startsWith('node_modules/axios/node_modules/');
  return nested ? (name.endsWith('/package.json') ? 'axios_nested_metadata' : 'axios_nested_code') : (name.endsWith('/package.json') ? 'axios_metadata' : 'axios_code');
}

const TOP_FIELDS = ['top_source_count', 'top_destination_root', 'axios_120_count', 'axios_other_version_present'];
const countKind = (count) => count === 0 ? 'zero' : count === 1 ? 'one' : 'many';
class TopAxiosFailure extends Error {
  constructor(entries, root) {
    super();
    const top = entries.filter((entry) => entry.source === root);
    const axios = entries.filter((entry) => entry.name === 'axios');
    this.diagnostic = Object.freeze({ top_source_count: countKind(top.length), top_destination_root: top.some((entry) => entry.destination === 'node_modules/axios'), axios_120_count: countKind(axios.filter((entry) => entry.version === '1.20.0').length), axios_other_version_present: axios.some((entry) => entry.version !== '1.20.0') });
  }
}
function failurePayload(error) {
  const payload = { passed: false, code: failureCode(error) };
  if (!(error instanceof TopAxiosFailure)) return payload;
  const diagnostic = error.diagnostic;
  if (!diagnostic || Object.keys(diagnostic).length !== 4 || !TOP_FIELDS.every((field) => Object.hasOwn(diagnostic, field))) return payload;
  if (!['zero', 'one', 'many'].includes(diagnostic.top_source_count) || !['zero', 'one', 'many'].includes(diagnostic.axios_120_count) || typeof diagnostic.top_destination_root !== 'boolean' || typeof diagnostic.axios_other_version_present !== 'boolean') return payload;
  return { ...payload, top_source_count: diagnostic.top_source_count, top_destination_root: diagnostic.top_destination_root, axios_120_count: diagnostic.axios_120_count, axios_other_version_present: diagnostic.axios_other_version_present };
}

const FAILURE_CODES = Object.freeze([...new Set([...Object.values(FAILURE_MESSAGES), 'extractor_failure', 'unknown', 'success_proof_missing', ...EXTRACT_SCOPES.flatMap((scope) => ['missing_entry', 'read_error'].map((kind) => `extractor_${scope}_${kind}`))])]);
function failureCode(error) {
  if (error instanceof TopAxiosFailure) return 'mapping_top_axios_changed';
  if (error instanceof ExtractorFailure) return EXTRACT_SCOPES.includes(error.scope) && ['missing_entry', 'read_error'].includes(error.kind) ? `extractor_${error.scope}_${error.kind}` : 'extractor_failure';
  if (error instanceof assert.AssertionError) {
    const message = String(error.message).split('\n')[0];
    return Object.hasOwn(FAILURE_MESSAGES, message) ? FAILURE_MESSAGES[message] : 'unknown';
  }
  return 'unknown';
}
function emitFailure(error, output) {
  output.write(JSON.stringify(failurePayload(error)) + '\n');
}
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function productionDestinations(nodes, parent = '', entries = [], destinations = new Set()) {
  for (const node of nodes) {
    assert.ok(typeof node.name === 'string' && !node.name.includes('..') && !path.isAbsolute(node.name), 'invalid production destination');
    const destination = path.posix.join(parent, 'node_modules', node.name);
    assert.ok(destination.startsWith('node_modules/'), 'invalid production destination');
    assert.ok(!destinations.has(destination), 'duplicate production destination');
    destinations.add(destination);
    entries.push({ name: node.name, source: fs.realpathSync(node.dir), destination, version: node.version });
    productionDestinations(node.dependencies || [], destination, entries, destinations);
  }
  return entries;
}
function archiveDestination(root, name, entries) {
  const axiosRoot = fs.realpathSync(path.join(root, 'node_modules/axios'));
  if (!name.startsWith('node_modules/axios/node_modules/')) return { destination: name };
  const sourceFile = path.resolve(root, name);
  let owner = path.dirname(sourceFile);
  while (owner.startsWith(path.join(root, 'node_modules/axios') + path.sep) && !fs.existsSync(path.join(owner, 'package.json'))) owner = path.dirname(owner);
  assert.ok(owner.startsWith(path.join(root, 'node_modules/axios/node_modules') + path.sep) && fs.existsSync(path.join(owner, 'package.json')), 'nested source owner missing');
  owner = fs.realpathSync(owner);
  assert.ok(owner !== axiosRoot, 'nested source owner missing');
  const candidates = entries.filter((entry) => entry.source === owner);
  assert.ok(candidates.length > 0, 'nested source owner missing');
  assert.equal(candidates.length, 1, 'nested source owner ambiguous');
  const selected = candidates[0];
  const metadata = JSON.parse(fs.readFileSync(path.join(owner, 'package.json')));
  assert.equal(metadata.version, selected.version, 'source module version changed');
  const realFile = fs.realpathSync(sourceFile);
  assert.ok(realFile.startsWith(owner + path.sep), 'nested source owner missing');
  const relative = path.relative(owner, realFile).split(path.sep).join('/');
  return { destination: path.posix.join(selected.destination, relative), source_module: path.relative(root, owner), module_destination: selected.destination, version: selected.version };
}
async function productionMappings(root, sourceMetadata, requireFromRepo, overrides) {
  for (const [moduleFile, expected] of Object.entries(COLLECTOR_PINS)) {
    const actual = requireFromRepo.resolve(`app-builder-lib/out/${moduleFile}`);
    assert.equal(digest(fs.readFileSync(actual)), expected, 'production collector implementation changed');
  }
  assert.equal(requireFromRepo('temp-file/package.json').version, '3.4.0', 'production collector implementation changed');
  const { NpmNodeModulesCollector } = requireFromRepo('app-builder-lib/out/node-module-collector/npmNodeModulesCollector');
  const { TmpDir } = requireFromRepo('temp-file');
  const temporary = new TmpDir();
  try {
    const collector = new NpmNodeModulesCollector(root, temporary);
    if (overrides.dependencyTree) collector.getDependenciesTree = async () => overrides.dependencyTree;
    const result = await collector.getNodeModules({ packageName: sourceMetadata.name });
    assert.ok(result.nodeModules.length > 0, 'production collector returned no modules');
    const entries = productionDestinations(result.nodeModules);
    const axiosRoot = fs.realpathSync(path.join(root, 'node_modules/axios'));
    const top = entries.filter((entry) => entry.name === 'axios');
    if (!(top.length === 1 && top[0].version === '1.20.0' && top[0].destination === 'node_modules/axios')) throw new TopAxiosFailure(entries, axiosRoot);
    return { entries, axiosSource: top[0].source };
  } finally { await temporary.cleanup(); }
}
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
  const { entries, axiosSource } = await productionMappings(root, sourceMetadata, requireFromRepo, overrides);
  const privateMapping = [];
  const checks = JSON.parse(fs.readFileSync(sourceManifest));
  const metadataProofs = [];
  let strictCodeFiles = 0;
  let equivalentAxiosFiles = 0;
  for (const [name, expectedRaw] of Object.entries(checks)) {
    assert.match(expectedRaw, /^[0-9a-f]{64}$/, 'invalid source digest');
    const sourceFile = path.resolve(root, name);
    assert.ok(sourceFile.startsWith(root + path.sep), 'source entry escapes repository');
    const raw = fs.readFileSync(sourceFile);
    assert.equal(digest(raw), expectedRaw, 'raw source changed');
    if (name.startsWith('node_modules/axios/') && !name.startsWith('node_modules/axios/node_modules/')) {
      const selectedFile = path.resolve(axiosSource, name.slice('node_modules/axios/'.length));
      let realSelected;
      try { realSelected = fs.realpathSync(selectedFile); } catch { assert.fail('selected Axios source missing'); }
      assert.ok(realSelected.startsWith(axiosSource + path.sep), 'selected Axios source escapes module');
      let selectedRaw;
      try { selectedRaw = fs.readFileSync(realSelected); } catch { assert.fail('selected Axios source missing'); }
      assert.equal(digest(selectedRaw), expectedRaw, 'selected Axios source byte mismatch');
      equivalentAxiosFiles += 1;
    }
    const mapping = archiveDestination(root, name, entries);
    if (name.startsWith('node_modules/axios/node_modules/')) privateMapping.push({ source: name, ...mapping });
    let actual;
    try { actual = extractFile(archive, mapping.destination); } catch (error) {
      const missing = error instanceof Error && error.message === `"${mapping.destination}" was not found in this archive`;
      throw new ExtractorFailure(extractionScope(name), missing ? 'missing_entry' : 'read_error');
    }
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
  privateMapping.unshift({ source: 'node_modules/axios', selected_source_module: axiosSource, destination: 'node_modules/axios', raw_equivalence_files: equivalentAxiosFiles });
  return { passed: true, collector_Axios_source_equivalence_files: equivalentAxiosFiles, private_production_mapping: privateMapping, production_mapping_sha256: digest(Buffer.from(JSON.stringify(privateMapping, null, 2) + '\n')), collector_implementation_pins: COLLECTOR_PINS, builder_version: BUILDER_VERSION, metadata_transformer_sha256: TRANSFORMER_SHA256, strict_code_files_compared: strictCodeFiles, metadata_proofs: metadataProofs };
}

if (require.main === module) {
  const [repository, sourceManifest, archive, receipt] = process.argv.slice(2);
  const keepAlive = setInterval(() => {}, 1000);
  verifyAsar({ repository, sourceManifest, archive }).then((proof) => {
    const { private_production_mapping: privateMapping, ...publicProof } = proof;
    fs.writeFileSync(path.join(path.dirname(receipt), 'asar-production-mapping.json'), JSON.stringify(privateMapping, null, 2) + '\n');
    fs.writeFileSync(receipt, JSON.stringify(publicProof, null, 2) + '\n');
    clearInterval(keepAlive);
  }).catch((error) => {
    clearInterval(keepAlive);
    fs.writeSync(process.stdout.fd, JSON.stringify(failurePayload(error)) + '\n');
    process.exit(1);
  });
}

module.exports = { verifyAsar, RUNTIME_FIELDS, TRANSFORMER_SHA256, failureCode, emitFailure, FAILURE_CODES, ExtractorFailure, productionDestinations, archiveDestination, TopAxiosFailure, failurePayload };
