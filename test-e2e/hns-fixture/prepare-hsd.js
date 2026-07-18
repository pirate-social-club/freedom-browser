const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BDB_VERSION = '1.4.0';
const LEVEL_BROWSER_SHA256 = '19b95f293b2e6c0e9974d40350fea187551ce67bbe1b30d7e15efb9ac9a4e444';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const bdbRoot = path.dirname(require.resolve('bdb/package.json'));
const metadata = JSON.parse(fs.readFileSync(path.join(bdbRoot, 'package.json'), 'utf8'));
if (metadata.version !== BDB_VERSION) {
  throw new Error(`Refusing to prepare unexpected bdb ${metadata.version}`);
}

// hsd 4.0.1's bdb entry point eagerly requires the native LevelDB binding,
// even when every fixture database has memory:true. Its own browser mapping is
// the supported pure-JS backend. Copy that exact, lockfile-pinned source over
// the eager native entry point so Node 24 can run the hermetic in-memory peer.
const pureJsBackend = path.join(bdbRoot, 'lib', 'level-browser.js');
if (sha256(pureJsBackend) !== LEVEL_BROWSER_SHA256) {
  throw new Error('Refusing to prepare an unrecognized bdb pure-JS backend');
}
fs.copyFileSync(pureJsBackend, path.join(bdbRoot, 'lib', 'level.js'));
console.log(`Prepared bdb ${BDB_VERSION} for in-memory-only HNS tests`);
