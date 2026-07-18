const { FullNode } = require('hsd');

const NETWORK = 'regtest';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 10000;

class HsdRegtestPeer {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    this.host = host;
    this.port = port;
    this.node = new FullNode({
      memory: true,
      network: NETWORK,
      listen: true,
      host,
      port,
      brontidePort: port + 1,
      httpPort: port + 2,
      walletHttpPort: port + 3,
      noDns: true,
      plugins: [require('hsd/lib/wallet/plugin')],
    });
    this.wallet = null;
  }

  async open() {
    await this.node.open();
    await this.node.connect();
    this.wallet = this.node.plugins.walletdb;
    return this;
  }

  async close() {
    await this.node.close();
    this.wallet = null;
  }

  async mine(blocks) {
    const address = await this.wallet.rpc.getNewAddress(['default']);
    await this.node.rpc.generateToAddress([blocks, address]);
    return this.node.chain.height;
  }

  async registerNames(names) {
    for (const name of Object.keys(names)) await this.wallet.rpc.sendOpen([name]);
    await this.mine(6);
    for (const name of Object.keys(names)) await this.wallet.rpc.sendBid([name, 1, 1]);
    await this.mine(6);
    await this.wallet.rpc.sendReveal([]);
    await this.mine(10);
    for (const [name, records] of Object.entries(names)) {
      await this.wallet.rpc.sendUpdate([name, { records }]);
    }
    await this.mine(12);
    return this.node.chain.height;
  }
}

async function main() {
  const peer = await new HsdRegtestPeer({
    host: process.env.HNS_FIXTURE_HOST || DEFAULT_HOST,
    port: Number(process.env.HNS_FIXTURE_PORT || DEFAULT_PORT),
  }).open();
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    network: NETWORK,
    peerAddr: `${peer.host}:${peer.port}`,
    height: peer.node.chain.height,
  })}\n`);

  const stop = async () => {
    await peer.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { HsdRegtestPeer };
