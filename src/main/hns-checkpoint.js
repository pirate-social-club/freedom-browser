const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHECKPOINT_SHA256 = 'c23b485e961e406d9d302932feeb2aaea8f39c47001a04435c426c03414ceea1';
const CHECKPOINT_HEIGHT = 348000;

// This is a release-pinned mainnet anchor, not a checkpoint fetched at runtime.
function installHnsCheckpoint(bundledPath, dataDir, fsImpl = fs) {
  const checkpoint = fsImpl.readFileSync(bundledPath);
  const digest = crypto.createHash('sha256').update(checkpoint).digest('hex');
  if (digest !== CHECKPOINT_SHA256 || checkpoint.length !== 35441 ||
      checkpoint.readUInt32BE(0) !== 0x5b6ef2d3 || checkpoint[4] !== 0 ||
      checkpoint.readUInt32BE(5) !== CHECKPOINT_HEIGHT) {
    throw new Error('Bundled HNS checkpoint failed integrity validation');
  }
  const directory = path.join(dataDir, 'hnsd');
  const destination = path.join(directory, 'checkpoint_main.dat');
  fsImpl.mkdirSync(directory, { recursive: true });
  if (fsImpl.existsSync(destination)) return false;
  try {
    fsImpl.writeFileSync(destination, checkpoint, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

module.exports = { CHECKPOINT_HEIGHT, CHECKPOINT_SHA256, installHnsCheckpoint };
