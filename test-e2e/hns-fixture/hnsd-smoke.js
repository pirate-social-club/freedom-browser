const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const StubResolver = require('bns/lib/resolver/stub');
const wire = require('bns/lib/wire');
const { HsdRegtestPeer } = require('./fixture-server');

const HNSD_PATH = path.join(__dirname, '..', '.hns-fixture-bin', 'hnsd-regtest');
const ROOT_ADDR = '127.0.0.1:25349';
const RECURSIVE_ADDR = '127.0.0.1:25350';

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function waitForHeight(resolver, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const question = wire.Question.fromJSON({
    name: 'height.tip.chain.hnsd.',
    class: 'HS',
    type: 'TXT',
  });
  while (Date.now() < deadline) {
    try {
      const response = await resolver.resolve(question);
      const height = Number(response.answer?.[0]?.data?.txt?.[0]);
      if (height === expected) return height;
    } catch { /* hnsd is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`hnsd did not reach fixture height ${expected}`);
}

async function main() {
  assert.strictEqual(fs.existsSync(HNSD_PATH), true, 'run hns:test-fixture:download first');
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hnsd-regtest-'));
  const peer = await new HsdRegtestPeer().open();
  const resolver = new StubResolver();
  resolver.setServers([ROOT_ADDR]);
  await resolver.open();
  let hnsd;
  try {
    const expected = await peer.mine(100);
    hnsd = spawn(HNSD_PATH, [
      '-s', `${peer.host}:${peer.port}`,
      '-n', ROOT_ADDR,
      '-r', RECURSIVE_ADDR,
      '-x', prefix,
      '-t',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    hnsd.stderr.on('data', (data) => { stderr += String(data); });
    hnsd.once('exit', (code) => {
      if (code && !process.exitCode) console.error(stderr.trim());
    });
    const height = await waitForHeight(resolver, expected);
    console.log(`hnsd regtest fixture synced at height ${height}`);
  } finally {
    if (hnsd && hnsd.exitCode == null) {
      hnsd.kill('SIGINT');
      await waitForExit(hnsd);
    }
    await resolver.close();
    await peer.close();
    fs.rmSync(prefix, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
