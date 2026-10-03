import {
  cidV0ToV1Base32,
  cidV1B58btcToBase32,
  cidV1BytesToBase32,
  ipnsMhToCidV1Base36,
} from './cid-utils.js';
const shared = require('../../shared/cid-utils');

describe('cidV0ToV1Base32', () => {
  // Expected values cross-checked against multiformats CID.parse(v0).toV1().toString().
  test('converts canonical CIDv0 examples to CIDv1 base32', () => {
    expect(cidV0ToV1Base32('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(
      'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
    );
    expect(cidV0ToV1Base32('Qmbnp5ufs7kauPzwnu5boMjbXM97TvmuiNd5F7F2ex8ThC')).toBe(
      'bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm'
    );
    expect(cidV0ToV1Base32('QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o')).toBe(
      'bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby'
    );
  });

  test('returns null for non-CIDv0 input', () => {
    expect(cidV0ToV1Base32(null)).toBeNull();
    expect(cidV0ToV1Base32(undefined)).toBeNull();
    expect(cidV0ToV1Base32('')).toBeNull();
    expect(cidV0ToV1Base32('bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm')).toBeNull();
    expect(cidV0ToV1Base32('Qmshort')).toBeNull();
    expect(cidV0ToV1Base32('QmContainsInvalidChar!abcdefghijklmnopqrstuvwxyz0123')).toBeNull();
  });

  test('returns null for already-lowercased CIDv0 (cannot be recovered)', () => {
    // The user typing `qm...` lowercase has destroyed the base58btc bytes;
    // no way to round-trip. We pass through unchanged so the caller can
    // emit an upstream error rather than silently producing a wrong CID.
    expect(cidV0ToV1Base32('qmywapjzv5czsna625s3xf2nemtygpphdwez79ojwnpbdg')).toBeNull();
  });
});

describe('cidV1B58btcToBase32', () => {
  // Reference values cross-checked against multiformats:
  //   CID.parse('z...', base58btc).toString(base32)
  test('converts canonical CIDv1 base58btc CIDs to base32 (lowercase, prefix b)', () => {
    // raw codec (0x55) — single-byte
    expect(cidV1B58btcToBase32('zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA')).toBe(
      'bafkreidon73zkcrwdb5iafqtijxildoonbwnpv7dyd6ef3qdgads2jc4su'
    );
    // dag-pb codec (0x70) — single-byte
    expect(cidV1B58btcToBase32('zdj7Wm8AnNCTyaUbqz1afY6jSGdNi2DKwowmcwMFvbz3vL2Ce')).toBe(
      'bafybeihjgbfpb6h5y66ampe35j6wrvogbykwbpfqnyittz42v46btbt2r4'
    );
    // libp2p-key codec (0x72) — single-byte; IPNS keys can also use the z form
    expect(cidV1B58btcToBase32('z5AanNVJCxnFtEfSEgTFFAm3Ju15ppwZfW3wTJTuoBL6FvHj7kmuKn7')).toBe(
      'bafzaajaiaejcad4ww6rlktrbqfhuhkjx72e6ryft3oo5cxhssz4yrpxsaqiie2aa'
    );
  });

  test('handles CIDs with multi-byte varint codec / multihash code', () => {
    // dag-json codec 0x0129 — codec varint is 2 bytes (0xa9 0x02). A
    // single-byte assumption would false-reject this layout (and dag-json
    // is widely used in practice). Reference value cross-checked against
    // multiformats: CID.createV1(0x0129, sha256.digest('hello world')).
    expect(cidV1B58btcToBase32('z4EBG9jCb6wv7WCTz9NvmkQ5czYGEUZQgWFijgDTUqbD7aftapg')).toBe(
      'baguqeeraxfgspomtju7arjjokll5u7nl7lcij37dpjjyb3uqrd32zyxpzxuq'
    );
    // blake2b-256 multihash code 0xb220 — mh-code varint is 3 bytes
    // (0xa0 0xe4 0x02). Reference value: CID.createV1(0x55, blake2b256.digest('hello world')).
    expect(cidV1B58btcToBase32('zCT5htkeAKK1CMxFpvErEwHxFfzgzsMmWZaxxiFzpY8FSzJviw6Q')).toBe(
      'bafk2bzacec4u2j5zsngt4cfffzjnpwt5vp5mjbhp4n5fhahoscepplhc57g6s'
    );
  });

  test('returns null for already-lowercased z... (cannot be recovered)', () => {
    // Lowercased base58btc decodes into different bytes — sometimes
    // valid-looking CID structure by chance. The detector lives at the
    // input-shape layer rather than the decoded-bytes layer so the
    // rejection is deterministic.
    expect(cidV1B58btcToBase32('zb2rhe5p4gxftawva4exq5hjwser2owdys9skaqrrvqpn93ba')).toBeNull();
    expect(cidV1B58btcToBase32('zdj7wm8annctyaubqz1afy6jsgdni2dkwowmcwmfvbz3vl2ce')).toBeNull();
  });

  test('returns null for non-z input (CIDv0, base32 CIDv1, garbage)', () => {
    expect(cidV1B58btcToBase32(null)).toBeNull();
    expect(cidV1B58btcToBase32(undefined)).toBeNull();
    expect(cidV1B58btcToBase32('')).toBeNull();
    // CIDv0 (Qm... prefix) — handled by cidV0ToV1Base32 instead.
    expect(cidV1B58btcToBase32('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBeNull();
    // CIDv1 base32 — already lowercase-canonical.
    expect(cidV1B58btcToBase32('bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm')).toBeNull();
    // Too short to be a real CID.
    expect(cidV1B58btcToBase32('zHello')).toBeNull();
    // Uppercase Z prefix — base58btc multibase prefix is lowercase z;
    // uppercase Z denotes z-base-32 (rarely used, not handled here).
    expect(cidV1B58btcToBase32('ZB2RHE5P4GXFTAWVA4EXQ5HJWSER2OWDYS9SKAQRRVQPN93BA')).toBeNull();
  });
});

describe('cidV1BytesToBase32', () => {
  test('converts CIDv1 raw bytes to base32', () => {
    const bytes = new Uint8Array([
      0x01, 0x55, 0x12, 0x20, 0x17, 0x80, 0x09, 0xfb, 0x92, 0x61, 0x20, 0xf2, 0x94,
      0xc6, 0x0e, 0xbc, 0x3a, 0xe5, 0x4d, 0xe9, 0xdc, 0xca, 0xac, 0xe2, 0x2d, 0xb7,
      0x85, 0x44, 0x5f, 0x6f, 0x54, 0xa8, 0x07, 0xb3, 0x22, 0xfd,
    ]);

    expect(cidV1BytesToBase32(bytes)).toBe(
      'bafkreiaxqae7xetbedzjjrqoxq5oktpj3tfkzyrnw6cuix3pksuapmzc7u'
    );
  });

  test('returns null for malformed CID bytes', () => {
    expect(cidV1BytesToBase32(null)).toBeNull();
    expect(cidV1BytesToBase32(new Uint8Array())).toBeNull();
    expect(cidV1BytesToBase32(new Uint8Array([0x00, 0x55, 0x12, 0x20]))).toBeNull();
    expect(cidV1BytesToBase32(new Uint8Array([0x01, 0x55, 0x12, 0x20, 0xff]))).toBeNull();
  });
});

describe('ipnsMhToCidV1Base36', () => {
  // Expected values cross-checked against multiformats:
  //   CID.createV1(0x72, Multihash(base58btc.decode('z' + peerId))).toString(base36)
  test('converts Ed25519 identity-multihash peer IDs to base36 CIDv1 libp2p-key', () => {
    expect(ipnsMhToCidV1Base36('12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX')).toBe(
      'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4'
    );
    expect(ipnsMhToCidV1Base36('12D3KooWRBy97UB4aJeyegkr4DvfjShtp5g83Gd1zQ77gNeYvbnc')).toBe(
      'k51qzi5uqu5dlvj2baxnohg4sf7y8vid1gtqsm1k7bkvrjsnzjz1tiexq761bp'
    );
  });

  test('converts sha2-256 peer IDs (RSA-style "Qm..." names) to base36 CIDv1 libp2p-key', () => {
    expect(ipnsMhToCidV1Base36('QmNYWqRg2uVWKpwpQ4Q4tu4xrE8kTVNG4aiEvX2wzLgPbh')).toBe(
      'k2k4r8jhqpcrorgyes4mlic3t752f7oigcsb9tmxnly54cu2f6ijjzks'
    );
  });

  test('returns null for malformed input', () => {
    expect(ipnsMhToCidV1Base36(null)).toBeNull();
    expect(ipnsMhToCidV1Base36(undefined)).toBeNull();
    expect(ipnsMhToCidV1Base36('')).toBeNull();
    expect(ipnsMhToCidV1Base36('12')).toBeNull();
    expect(ipnsMhToCidV1Base36('12D3!invalid')).toBeNull();
    // Non-base58 chars (contains '0' and 'O' and 'I' and 'l').
    expect(ipnsMhToCidV1Base36('0OIl')).toBeNull();
  });

  test('returns null for DNSLink and ENS names (caller passes through)', () => {
    // '.' isn't in the base58 alphabet — these intentionally fall through
    // so DNSLink / ENS hosts are forwarded to the gateway as-is.
    expect(ipnsMhToCidV1Base36('docs.ipfs.tech')).toBeNull();
    expect(ipnsMhToCidV1Base36('vitalik.eth')).toBeNull();
  });
});

// Parity check: the renderer ESM mirror and shared CommonJS source must
// produce identical output for every input — drift between the two would
// cause main and renderer to canonicalise differently and the standard-
// scheme URL pipeline to fall apart in subtle ways. Mirrors the
// origin-utils parity test (src/renderer/lib/origin-utils.test.js).
//
// If this fails, update BOTH files together.
describe('renderer ↔ shared parity', () => {
  const CID_INPUTS = [
    null,
    undefined,
    '',
    'Qmshort',
    'QmContainsInvalidChar!abcdefghijklmnopqrstuvwxyz0123',
    'qmywapjzv5czsna625s3xf2nemtygpphdwez79ojwnpbdg',
    'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    'Qmbnp5ufs7kauPzwnu5boMjbXM97TvmuiNd5F7F2ex8ThC',
    'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o',
    'bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm',
    'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34',
  ];

  const IPNS_INPUTS = [
    null,
    undefined,
    '',
    '12',
    '12D3!invalid',
    '0OIl',
    '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX',
    '12D3KooWRBy97UB4aJeyegkr4DvfjShtp5g83Gd1zQ77gNeYvbnc',
    'QmNYWqRg2uVWKpwpQ4Q4tu4xrE8kTVNG4aiEvX2wzLgPbh',
    'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4',
    'docs.ipfs.tech',
    'vitalik.eth',
  ];

  const CIDV1_B58_INPUTS = [
    null,
    undefined,
    '',
    'zHello',
    'zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA',
    'zb2rhe5p4gxftawva4exq5hjwser2owdys9skaqrrvqpn93ba',
    'zdj7Wm8AnNCTyaUbqz1afY6jSGdNi2DKwowmcwMFvbz3vL2Ce',
    'z5AanNVJCxnFtEfSEgTFFAm3Ju15ppwZfW3wTJTuoBL6FvHj7kmuKn7',
    // Multi-byte varint codec / multihash code — see the multi-byte
    // varint test above for codec (0x0129 dag-json) and mh-code (0xb220
    // blake2b-256) layouts.
    'z4EBG9jCb6wv7WCTz9NvmkQ5czYGEUZQgWFijgDTUqbD7aftapg',
    'zCT5htkeAKK1CMxFpvErEwHxFfzgzsMmWZaxxiFzpY8FSzJviw6Q',
    'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    'bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm',
    'ZB2RHE5P4GXFTAWVA4EXQ5HJWSER2OWDYS9SKAQRRVQPN93BA',
  ];

  test('cidV0ToV1Base32 matches shared for every input', () => {
    for (const input of CID_INPUTS) {
      expect(cidV0ToV1Base32(input)).toBe(shared.cidV0ToV1Base32(input));
    }
  });

  test('ipnsMhToCidV1Base36 matches shared for every input', () => {
    for (const input of IPNS_INPUTS) {
      expect(ipnsMhToCidV1Base36(input)).toBe(shared.ipnsMhToCidV1Base36(input));
    }
  });

  test('cidV1B58btcToBase32 matches shared for every input', () => {
    for (const input of CIDV1_B58_INPUTS) {
      expect(cidV1B58btcToBase32(input)).toBe(shared.cidV1B58btcToBase32(input));
    }
  });

  test('cidV1BytesToBase32 matches shared for every input', () => {
    const inputs = [
      null,
      new Uint8Array(),
      new Uint8Array([0x00, 0x55, 0x12, 0x20]),
      new Uint8Array([0x01, 0x55, 0x12, 0x20, 0xff]),
      new Uint8Array([
        0x01, 0x55, 0x12, 0x20, 0x17, 0x80, 0x09, 0xfb, 0x92, 0x61, 0x20, 0xf2, 0x94,
        0xc6, 0x0e, 0xbc, 0x3a, 0xe5, 0x4d, 0xe9, 0xdc, 0xca, 0xac, 0xe2, 0x2d, 0xb7,
        0x85, 0x44, 0x5f, 0x6f, 0x54, 0xa8, 0x07, 0xb3, 0x22, 0xfd,
      ]),
    ];

    for (const input of inputs) {
      expect(cidV1BytesToBase32(input)).toBe(shared.cidV1BytesToBase32(input));
    }
  });
});
