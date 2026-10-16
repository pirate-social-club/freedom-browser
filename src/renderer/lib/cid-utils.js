/**
 * CID and IPNS-key canonicalisation utilities (ESM, renderer).
 *
 * ESM mirror of `src/shared/cid-utils.js`. The shared file is CommonJS and
 * cannot be imported directly by the renderer (script type="module"
 * context with no Node require). Both implementations MUST stay in sync;
 * drift is guarded against by the parity assertion in
 * `src/renderer/lib/cid-utils.test.js`. Same pattern as
 * `src/renderer/lib/origin-utils.js` ↔ `src/shared/origin-utils.js`.
 *
 * See the shared file for the full rationale; in short: standard-scheme
 * URL parsing in Chromium lowercases the host, which destroys base58btc
 * encodings (CIDv0, base58 IPNS peer IDs). Canonicalising to CIDv1 base32
 * / libp2p-key base36 sidesteps the issue.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map();
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_MAP.set(BASE58_ALPHABET[i], i);

// RFC 4648 base32, lowercase, no padding (used by CIDv1 'b' multibase prefix).
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const base58Decode = (str) => {
  if (!str) return null;
  let num = 0n;
  for (let i = 0; i < str.length; i++) {
    const val = BASE58_MAP.get(str[i]);
    if (val === undefined) return null;
    num = num * 58n + BigInt(val);
  }
  let leadingOnes = 0;
  while (leadingOnes < str.length && str[leadingOnes] === '1') leadingOnes++;

  const bytes = [];
  let n = num;
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }

  const result = new Uint8Array(bytes.length + leadingOnes);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingOnes + i] = bytes[i];
  }
  return result;
};

const base32Encode = (bytes) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = ((value & 0xff) << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
};

/**
 * Convert a CIDv0 ("Qm..." base58btc of a sha2-256 dag-pb multihash)
 * to the CIDv1 base32 form ("bafybei..."), which is lowercase and
 * therefore safe for the standard-scheme URL parser. Returns null on any
 * malformed input (including an already-lowercased "qm..." since that no
 * longer round-trips through base58btc).
 */
export const cidV0ToV1Base32 = (cidV0) => {
  if (typeof cidV0 !== 'string') return null;
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cidV0)) return null;
  const mh = base58Decode(cidV0);
  if (!mh || mh.length !== 34) return null;
  // Validate multihash header: 0x12 = sha2-256, 0x20 = 32-byte digest length.
  if (mh[0] !== 0x12 || mh[1] !== 0x20) return null;
  const v1 = new Uint8Array(mh.length + 2);
  v1[0] = 0x01; // CIDv1 version (varint, <128 so one byte)
  v1[1] = 0x70; // dag-pb codec (varint, <128 so one byte)
  v1.set(mh, 2);
  return 'b' + base32Encode(v1);
};

// Base36 encode for multibase 'k' — lowercase, no padding, leading zero
// bytes preserved as '0' chars (matches the multiformats basex convention).
const base36Encode = (bytes) => {
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) {
    num = (num << 8n) | BigInt(bytes[i]);
  }
  const body = num === 0n ? '' : num.toString(36);
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  return '0'.repeat(leadingZeros) + body;
};

/**
 * Convert a base58btc IPNS multihash (peer-ID shape: "12D3Koo..." for
 * Ed25519, "16Uiu2H..." for secp256k1, "Qm..." for sha2-256) to the
 * CIDv1 libp2p-key base36 form ("k51qzi..." / "k2k4..."), which is
 * lowercase and therefore safe for the standard-scheme URL parser.
 * Accepts any well-formed multihash — not just sha2-256 — because Ed25519
 * peer IDs use the identity multihash (0x00). Returns null on malformed
 * input, which includes DNSLink names like "docs.ipfs.tech" (the '.'
 * isn't in the base58 alphabet) and ENS names like "vitalik.eth" — both
 * intentionally fall through unchanged.
 */
export const ipnsMhToCidV1Base36 = (mhBase58) => {
  if (typeof mhBase58 !== 'string') return null;
  const mh = base58Decode(mhBase58);
  // Multihash = 1-byte code + 1-byte digest length + digest. We only accept
  // single-byte-varint code/length (<128); fine for every code a libp2p peer
  // ID can use (identity 0x00, sha2-256 0x12) and any realistic digest size.
  if (!mh || mh.length < 3) return null;
  const code = mh[0];
  const digestLen = mh[1];
  if (code >= 0x80 || digestLen >= 0x80) return null;
  if (mh.length !== 2 + digestLen) return null;
  const v1 = new Uint8Array(mh.length + 2);
  v1[0] = 0x01; // CIDv1 version
  v1[1] = 0x72; // libp2p-key codec
  v1.set(mh, 2);
  return 'k' + base36Encode(v1);
};

/**
 * Convert a CIDv1 base58btc CID ("z..." multibase prefix) to the equivalent
 * CIDv1 base32 form ("b..." prefix), which is lowercase and therefore safe
 * for the standard-scheme URL parser. See the shared file for the full
 * rationale; in short, base58btc is case-sensitive and Chromium lowercases
 * standard-scheme hosts, so `z...` CIDv1s need to be re-encoded before
 * the URL hits Chromium's parser. Returns null for non-string input,
 * already-lowercased `z...` bytes, or anything that doesn't decode as a
 * valid CIDv1 structure.
 */
// LEB128 unsigned varint reader — see the shared file for the rationale
// (multi-byte codec / multihash-code varints in the wild — `dag-json`,
// `blake2b-256`, etc.).
const readUvarint = (bytes, offset) => {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, length: pos - offset };
    shift += 7;
    if (shift >= 35) return null;
  }
  return null;
};

export const cidV1B58btcToBase32 = (cid) => {
  if (typeof cid !== 'string') return null;
  if (!/^z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(cid)) return null;
  // Reject all-lowercase input — see the shared file for the rationale
  // (lowercased base58 can decode into valid-looking-but-wrong CID bytes,
  // so detect at the input-shape layer where it's deterministic).
  if (!/[A-HJ-NP-Z]/.test(cid)) return null;
  const bytes = base58Decode(cid.slice(1));
  if (!bytes || bytes.length < 4) return null;
  // CIDv1 = version varint (always 0x01) + codec varint + multihash
  // (code varint + length varint + digest bytes). Codec, mh-code, and
  // length can each be multi-byte varints; single-byte assumptions
  // false-reject e.g. dag-json (codec 0x0129) and blake2b-256 (mh-code
  // 0xb220).
  if (bytes[0] !== 0x01) return null;
  const codec = readUvarint(bytes, 1);
  if (!codec) return null;
  const mhCode = readUvarint(bytes, 1 + codec.length);
  if (!mhCode) return null;
  const mhLen = readUvarint(bytes, 1 + codec.length + mhCode.length);
  if (!mhLen) return null;
  const expectedTotal = 1 + codec.length + mhCode.length + mhLen.length + mhLen.value;
  if (bytes.length !== expectedTotal) return null;
  return 'b' + base32Encode(bytes);
};

export const cidV1BytesToBase32 = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  if (bytes[0] !== 0x01) return null;
  const codec = readUvarint(bytes, 1);
  if (!codec) return null;
  const mhCode = readUvarint(bytes, 1 + codec.length);
  if (!mhCode) return null;
  const mhLen = readUvarint(bytes, 1 + codec.length + mhCode.length);
  if (!mhLen) return null;
  const expectedTotal = 1 + codec.length + mhCode.length + mhLen.length + mhLen.value;
  if (bytes.length !== expectedTotal) return null;
  return 'b' + base32Encode(bytes);
};
