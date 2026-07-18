const assert = require('assert');
const { HsdRegtestPeer } = require('./fixture-server');

async function main() {
  const peer = await new HsdRegtestPeer().open();
  try {
    const height = await peer.mine(2);
    assert.strictEqual(height, 2);
    console.log(`hsd regtest fixture ready at height ${height}`);
  } finally {
    await peer.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
