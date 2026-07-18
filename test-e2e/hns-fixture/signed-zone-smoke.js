const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');
const StubResolver = require('bns/lib/resolver/stub');
const dnssec = require('bns/lib/dnssec');
const tlsa = require('bns/lib/tlsa');
const wire = require('bns/lib/wire');
const { APP_NAME, createSignedZone } = require('./signed-zone');

function createCertificate(directory, name) {
  const keyPath = path.join(directory, `${name}.key.pem`);
  const certPath = path.join(directory, `${name}.cert.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '2', '-subj', `/CN=${APP_NAME.slice(0, -1)}`,
    '-addext', `subjectAltName=DNS:${APP_NAME.slice(0, -1)}`,
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return new X509Certificate(fs.readFileSync(certPath)).raw;
}

async function queryTlsa(server, certificate) {
  const resolver = new StubResolver({ edns: true, dnssec: true });
  const address = server.address();
  resolver.setServers([`${address.address}:${address.port}`]);
  await resolver.open();
  try {
    const response = await resolver.lookup(`_443._tcp.${APP_NAME}`, wire.types.TLSA);
    assert.strictEqual(dnssec.verifyMessage(response, new Map([
      [response.answer.find((record) => record.type === wire.types.RRSIG).data.keyTag,
        server.zone.get('pirate.', wire.types.DNSKEY)[0]],
    ])), true);
    const record = response.answer.find((answer) => answer.type === wire.types.TLSA);
    assert(record, 'authoritative response did not contain TLSA');
    return tlsa.verify(record, certificate);
  } finally {
    await resolver.close();
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dnssec-fixture-'));
  try {
    const originCertificate = createCertificate(directory, 'origin');
    const wrongCertificate = createCertificate(directory, 'wrong');
    const { server, ds, onChainRecords } = createSignedZone(originCertificate);
    await server.open(0, '127.0.0.1');
    try {
      assert.strictEqual(await queryTlsa(server, originCertificate), true);
      assert.strictEqual(await queryTlsa(server, wrongCertificate), false);
      assert.strictEqual(onChainRecords.some((record) => record.type === 'DS'), true);
      assert.strictEqual(ds.data.digest.length, 32);
      console.log('signed DNSSEC zone accepts matching TLSA and rejects mismatch');
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
