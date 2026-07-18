# Hermetic HNS fixture

This package pins `hsd` 4.0.1 for an in-memory regtest peer. It is deliberately
isolated from Freedom Browser's production dependency graph.

Install scripts are disabled because hsd's optional `bdb` native LevelDB addon
does not build on the browser's Node 24 toolchain and the fixture never uses a
disk database. After `npm ci`, run `npm run prepare:hsd`; the preparation script
verifies the exact `bdb` version and pure-JS backend hash before applying bdb's
own browser backend mapping. Run all fixture processes with `NODE_BACKEND=js`.

The fixture will own four local components:

1. an hsd 4.0.1 in-memory regtest full node and wallet;
2. the independently fetched, compile-time-regtest `hnsd` binary;
3. a loopback DNSSEC authoritative server delegated by on-chain NS/DS records;
4. a loopback HTTPS origin whose certificate is bound by the zone's TLSA record.

No fixture dependency or binary is included by Electron Builder.

`signed-zone.js` constructs the delegated `pirate.` zone entirely with bns. A
single ECDSA P-256 DNSSEC key signs the DNSKEY, SOA, NS, A, and TLSA RRsets; its
SHA-256 DS plus NS/GLUE4 records are returned in hsd resource JSON form. The
TLSA binding is DANE-EE, SPKI, SHA-256. `npm run test:dnssec` proves both the
matching-certificate path and the required mismatched-certificate rejection.

`npm run test:delegation` completes the DNS half of the trust chain: it runs
the scripted regtest auction, commits NS + DS + GLUE4 on chain, synchronizes
the compile-time-regtest hnsd, and resolves the signed A and TLSA records
through hnsd's recursive endpoint. Because DNS referrals cannot encode a
custom port, this test must bind loopback port 53. CI runs only this isolated
fixture DNS process in a container granted only `NET_BIND_SERVICE`; Freedom
and fingertipd remain unprivileged and never bind port 53.
