// Package payloads must not be replaceable by another local user. Inspect
// lstat metadata only: chmod or traversal must never follow a package symlink.
const fs = require('fs');
const path = require('path');

function walk(root, visit) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Package root must be a directory');
  const descend = (file) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Unexpected package entry: ${path.relative(root, file)}`);
    }
    visit(file, stat.mode & 0o7777);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) descend(path.join(file, name));
    }
  };
  descend(root);
}

function normalizeLinuxPermissions(root) {
  walk(root, (file, mode) => {
    if (mode & 0o022) fs.chmodSync(file, mode & ~0o022);
  });
}

function inspectLinuxPermissions(root) {
  const defects = [];
  walk(root, (file, mode) => {
    if (mode & 0o022) {
      defects.push(`${path.relative(root, file) || '.'}: group/other writable (0${mode.toString(8)})`);
    }
  });
  return defects;
}

module.exports = { normalizeLinuxPermissions, inspectLinuxPermissions };
