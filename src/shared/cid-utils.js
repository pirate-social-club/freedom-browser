/**
 * CID and IPNS-key canonicalisation utilities (CommonJS, main process).
 *
 * `src/renderer/lib/cid-utils.js` is the ESM mirror of this file — the two
 * implementations MUST stay in sync, guarded by the parity assertion in
 * `src/renderer/lib/cid-utils.test.js`. Renderer pages load as
 * `<script type="module">` and can't `require()` from node_modules or
 * import a CommonJS file directly, hence the duplication (same pattern as
 * `src/shared/origin-utils.js` ↔ `src/renderer/lib/origin-utils.js`).
 *
 * Why this exists:
 * `ipfs:` and `ipns:` are registered as privileged standard schemes (see
 * `src/main/index.js`), so Chromium's URL parser treats the host segment
 * as a real hostname and lowercases it. CIDv0 ("Qm..." base58btc) and
 * IPNS peer-ID multihashes (base58btc — "12D3Koo...", "16Uiu2H...",
 * "Qm...") are case-sensitive: lowercasing them changes the underlying
 * bytes and Kubo rejects the request with `400 invalid cid: selected
 * encoding not supported`. Converting on the way in to the lowercase
 * canonical CIDv1 forms — base32 ("bafy...") for IPFS, libp2p-key base36
 * ("k51..." / "k2k4...") for IPNS — sidesteps the entire normalisation
 * problem because both target encodings are case-insensitive lowercase.
 *
 * Used by `src/renderer/lib/url-utils.js` (address-bar input) and
 * `src/main/ipfs/ipfs-protocol.js` (gateway-form path rewriting for
 * sub-resource requests that bypass the renderer).
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
 * Convert a CIDv0 ("Qm..." base58btc of a sha2-256 dag-pb multihash) to
 * the CIDv1 base32 form ("bafybei..."), which is lowercase and therefore
 * safe for the standard-scheme URL parser. Returns null on any malformed
 * input (including an already-lowercased "qm..." since that no longer
 * round-trips through base58btc).
 */
const cidV0ToV1Base32 = (cidV0) => {
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
const ipnsMhToCidV1Base36 = (mhBase58) => {
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
 * for the standard-scheme URL parser.
 *
 * Base58btc encoding is case-sensitive; once Chromium lowercases the host
 * segment of `ipfs://<z-cid>/...` the original bytes are destroyed
 * (lowercased letters decode to different base58 values). This converter
 * runs *before* Chromium parses the URL — case-preserving address-bar
 * input goes through src/renderer/lib/url-utils.js#parseIpfsInput, raw
 * anchor hrefs are intercepted by src/main/webview-preload.js. After
 * conversion the resulting `b...` form decodes case-insensitively (RFC
 * 4648 base32) so subsequent normalisation is a no-op.
 *
 * Returns null on:
 *  - non-string input,
 *  - input not matching the case-sensitive `z...` prefix shape (lowercased
 *    inputs that were once mixed-case are unrecoverable; caller should
 *    surface a 400 rather than re-encode wrong bytes),
 *  - bytes that don't form a valid CIDv1 structure (version 0x01, single-
 *    byte varint codec, plausible multihash header).
 */
// Read an unsigned LEB128 varint at `offset`. Returns `{ value, length }`
// on success or `null` on premature EOF / overlong encoding. We cap at
// 5 bytes (35 bits) which is comfortably above any multicodec / multihash
// code in the registry (largest currently-allocated entries fit in 14
// bits) and well below the 53-bit safe-integer limit.
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

const cidV1B58btcToBase32 = (cid) => {
  if (typeof cid !== 'string') return null;
  // Case-sensitive base58btc body, no `/i` flag.
  if (!/^z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(cid)) return null;
  // Detect-and-reject lowercased input. The decoded-bytes sanity check
  // alone isn't enough — lowercased base58 can decode into garbage that
  // happens to look like a valid CIDv1 structure (just three varint
  // headers, only ~1/256 chance of mismatching when the input is
  // lowercased mid-flight). This input-shape check is deterministic:
  // real `z...` CIDs of 40+ chars contain mixed case (~24 upper + 25
  // lower + 9 digits in the alphabet, so for a 32-byte SHA-256
  // multihash → ~44-char body the probability of zero uppercase letters
  // is ≈ (33/58)^44 ≈ 6×10⁻¹²). All-lowercase input therefore signals
  // that something upstream lowercased the host (most commonly
  // Chromium's standard-scheme URL parser); the original bytes are
  // unrecoverable and the caller should surface a 400 rather than
  // re-encode to the wrong content.
  if (!/[A-HJ-NP-Z]/.test(cid)) return null;
  const bytes = base58Decode(cid.slice(1));
  if (!bytes || bytes.length < 4) return null;
  // CIDv1 layout: version varint (always 0x01) + codec varint +
  // multihash (code varint + digest-length varint + digest bytes).
  // Codec, mh-code, and digest-length CAN be multi-byte varints — eg.
  // dag-json is 0x0129 (varint `0xa9 0x02`), blake2b-256 multihash code
  // is 0xb220 (`0xa0 0xe4 0x02`). Single-byte assumptions here would
  // false-reject those layouts (and they're not vanishingly rare —
  // dag-json and dag-cbor in particular are widely used).
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

const cidV1BytesToBase32 = (bytes) => {
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

module.exports = {
  cidV0ToV1Base32,
  ipnsMhToCidV1Base36,
  cidV1B58btcToBase32,
  cidV1BytesToBase32,
};
