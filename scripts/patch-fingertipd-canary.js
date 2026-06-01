#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const platformMap = {
  darwin: 'mac',
  linux: 'linux',
  win32: 'win',
};

const platform = platformMap[process.platform] || process.platform;
const binName = process.platform === 'win32' ? 'fingertipd.exe' : 'fingertipd';
const defaultBinaryPath = path.join(
  __dirname,
  '..',
  'hns-bin',
  `${platform}-${process.arch}`,
  binName
);

const binaryPath = path.resolve(process.argv[2] || defaultBinaryPath);
const obsoleteCanary = ['shake', 'station'].join('');
const inertCanary = 'unusedcanary';

const canaryCheckCallNeedle = Buffer.from(
  [
    '488b842448010000',
    '488d1da74f1200',
    'b90c000000',
    '48bf00e40b5402000000',
    'e8a6b8ffff',
    '4885c0',
  ].join(''),
  'hex'
);
const disabledCanaryCheckNeedle = Buffer.from(
  [
    '488b842448010000',
    '488d1da74f1200',
    'b90c000000',
    '48bf00e40b5402000000',
    'b801000000',
    '4885c0',
  ].join(''),
  'hex'
);
const canaryCheckCallPatch = Buffer.from('b801000000', 'hex');

function replaceAll(buffer, from, to) {
  if (from.length !== to.length) {
    throw new Error('replacement must preserve binary string length');
  }

  let count = 0;
  let offset = 0;
  while (offset < buffer.length) {
    const index = buffer.indexOf(from, offset);
    if (index === -1) break;
    to.copy(buffer, index);
    count += 1;
    offset = index + to.length;
  }
  return count;
}

function main() {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`fingertipd binary not found at ${binaryPath}`);
  }

  const data = fs.readFileSync(binaryPath);
  let changed = false;

  const callOffset = data.indexOf(canaryCheckCallNeedle);
  if (callOffset !== -1) {
    const patchOffset = callOffset + canaryCheckCallNeedle.length - 8;
    canaryCheckCallPatch.copy(data, patchOffset);
    changed = true;
    console.log(`Disabled obsolete HNS canary check call at 0x${patchOffset.toString(16)}`);
  } else if (data.indexOf(disabledCanaryCheckNeedle) !== -1) {
    console.log('Obsolete HNS canary check call is already disabled');
  } else {
    throw new Error('could not locate expected obsolete HNS canary check call');
  }

  const replaced = replaceAll(
    data,
    Buffer.from(obsoleteCanary),
    Buffer.from(inertCanary)
  );
  if (replaced > 0) {
    changed = true;
    console.log(`Replaced ${replaced} obsolete HNS canary string occurrence(s)`);
  }

  if (changed) {
    const mode = fs.statSync(binaryPath).mode;
    fs.writeFileSync(binaryPath, data, { mode });
    fs.chmodSync(binaryPath, mode | 0o755);
  }

  console.log(`Patched ${binaryPath}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
