const fs = require('fs');
const path = require('path');

// libveritas verifies Spaces proofs and ships only as an ES module wrapping
// WebAssembly. Its package entry for Node awaits the wasm at top level, which
// `require()` cannot load, so this requires the wasm-bindgen glue directly
// (Node's require(esm), in Electron's main process and inside app.asar) and
// instantiates the wasm synchronously from the bytes beside it. Nothing here
// fetches: the glue only reaches for `import.meta.url` when it is given no
// bytes.
let lib = null;

function loadVeritas() {
  if (lib) return lib;
  const dir = path.dirname(require.resolve('@spacesprotocol/libveritas'));
  const glue = require(path.join(dir, 'libveritas.js'));
  glue.initSync({ module: fs.readFileSync(path.join(dir, 'libveritas_bg.wasm')) });
  lib = glue;
  return lib;
}

module.exports = { loadVeritas };
