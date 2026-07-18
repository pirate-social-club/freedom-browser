const AuthServer = require('bns/lib/server/auth');
const constants = require('bns/lib/constants');
const dnssec = require('bns/lib/dnssec');
const tlsa = require('bns/lib/tlsa');
const wire = require('bns/lib/wire');

const ORIGIN = 'pirate.';
const APP_NAME = `app.${ORIGIN}`;
const NS_NAME = `ns1.${ORIGIN}`;

function createSignedZone(tlsaCertificate) {
  const algorithm = constants.algs.ECDSAP256SHA256;
  const privateKey = dnssec.createPrivate(algorithm);
  const dnskey = dnssec.makeKey(
    ORIGIN,
    algorithm,
    privateKey,
    constants.keyFlags.ZONE | constants.keyFlags.SEP,
  );
  const records = wire.fromZone(`
$ORIGIN ${ORIGIN}
$TTL 60
@ IN SOA ${NS_NAME} hostmaster.${ORIGIN} 1 60 60 60 60
@ IN NS ${NS_NAME}
${NS_NAME} IN A 127.0.0.1
${APP_NAME} IN A 127.0.0.1
`, ORIGIN);
  records.push(dnskey);
  records.push(tlsa.create(tlsaCertificate, APP_NAME, 'tcp', 443, {
    ttl: 60,
    usage: 3,
    selector: 1,
    matchingType: 1,
  }));

  const sets = new Map();
  for (const record of records) {
    const id = `${record.name}|${record.type}`;
    if (!sets.has(id)) sets.set(id, []);
    sets.get(id).push(record);
  }
  for (const rrset of sets.values()) records.push(dnssec.sign(dnskey, privateKey, rrset));

  const server = new AuthServer({ tcp: true, edns: true, dnssec: true });
  server.setOrigin(ORIGIN);
  for (const record of records) server.zone.insert(record);

  const ds = dnssec.createDS(dnskey, constants.hashes.SHA256);
  return {
    server,
    dnskey,
    ds,
    onChainRecords: [
      { type: 'NS', ns: NS_NAME },
      { type: 'DS', ...ds.data.getJSON() },
      { type: 'GLUE4', ns: NS_NAME, address: '127.0.0.1' },
    ],
  };
}

module.exports = { APP_NAME, NS_NAME, ORIGIN, createSignedZone };
