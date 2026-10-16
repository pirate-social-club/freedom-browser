const crypto = require('crypto');
const { fetchBytes } = require('./transport');

/**
 * Trusted Spaces anchors.
 *
 * An anchor is a snapshot of the Spaces and nums tree roots at a Bitcoin
 * block. libveritas accepts a proof only at an anchor it was handed, so the
 * anchor set decides what verifies. Freedom has no anchor source of its own
 * yet, so it takes the set from the upstream certrelay relays below, pinned
 * with the keys @spacesprotocol/fabric-core 0.2.11 ships (dist/seeds.js), and
 * trusts it only when:
 *  - at least ANCHOR_QUORUM relays answer /anchors with the same signed trust
 *    root and height, each signature a BIP-340 signature by that relay's
 *    pinned key over "certrelay-anchor-sig-v1" ‖ root ‖ height (big-endian
 *    u32), the relays' own scheme;
 *  - the root recomputed from the served set equals the signed one, the set is
 *    newest-first, and its newest anchor is at the signed height;
 *  - the newest anchor's Bitcoin header, fetched separately, double-SHA-256
 *    hashes to the anchor's block hash, meets its own proof-of-work target and
 *    a floor of MIN_HEADER_WORK_BITS no throwaway chain reaches, and was mined
 *    no more than MAX_ANCHOR_AGE_SECONDS ago (relays snapshot every 36 blocks).
 *
 * The relays learn nothing about what is browsed from this request.
 */
const ANCHOR_RELAYS = Object.freeze([
  {
    name: 'cosmos',
    url: 'https://relay-cosmos.spacesprotocol.org',
    pubkey: 'b4e6def56fe1c7fedc3168b100254e184fbbd1175628e5ba92e36644a107ac70',
  },
  {
    name: 'atlas',
    url: 'https://relay-atlas.spacesprotocol.org',
    pubkey: '33621830b05efe450f1dbbfb064ed94db50a033ae83b982643d1957f95c94ce7',
  },
  {
    name: 'orion',
    url: 'https://relay-orion.spacesprotocol.org',
    pubkey: '7126eaafb140c43ec50b22a37d44aeb451f87a03c9994994f3c0ebebd5b0ff0b',
  },
  {
    name: 'pulsar',
    url: 'https://relay-pulsar.spacesprotocol.org',
    pubkey: 'f3c827ea7bf9d2e621b629c4420d25a0633f671953deff67926d38fe49679730',
  },
]);
const ANCHOR_QUORUM = 2;
const ANCHOR_SIG_TAG = Buffer.from('certrelay-anchor-sig-v1');
const BLOCK_HEADER_URL = 'https://blockstream.info/api/block/';
const MAX_ANCHOR_AGE_SECONDS = 12 * 60 * 60;
const MAX_ANCHOR_LEAD_SECONDS = 2 * 60 * 60;
const MIN_HEADER_WORK_BITS = 72;
const MAX_ANCHORS_BYTES = 512 * 1024;
const MAX_HEADER_BYTES = 1024;

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

const anchorError = (message) => Object.assign(new Error(message), { code: 'ANCHORS_UNAVAILABLE' });

function anchorSigPayload(root, height) {
  const payload = Buffer.alloc(ANCHOR_SIG_TAG.length + 36);
  ANCHOR_SIG_TAG.copy(payload, 0);
  Buffer.from(root, 'hex').copy(payload, ANCHOR_SIG_TAG.length);
  payload.writeUInt32BE(height, ANCHOR_SIG_TAG.length + 32);
  return payload;
}

/** Check one relay's /anchors answer; returns `{ relay, root, height, entries }` or throws. */
function verifyRelayAnchors(relay, { headers, bytes }, lib) {
  const root = String(headers.get('x-anchor-root') || '').toLowerCase();
  const sig = String(headers.get('x-anchor-sig') || '').toLowerCase();
  const heightText = String(headers.get('x-anchor-height') || '');
  if (!HEX32.test(root) || !HEX64.test(sig) || !/^\d{1,10}$/.test(heightText)) {
    throw new Error('unsigned or malformed anchor head');
  }
  const height = Number(heightText);
  if (height > 0xffffffff) throw new Error('anchor height out of range');
  try {
    lib.verifySpacesMessage(
      anchorSigPayload(root, height),
      Buffer.from(sig, 'hex'),
      Buffer.from(relay.pubkey, 'hex')
    );
  } catch {
    throw new Error('anchor signature does not verify');
  }

  let entries;
  try {
    entries = JSON.parse(bytes.toString('utf8')).entries;
  } catch {
    throw new Error('anchor set is not JSON');
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('empty anchor set');
  for (let i = 0; i < entries.length; i++) {
    const block = entries[i]?.block;
    if (!Number.isSafeInteger(block?.height) || !HEX32.test(String(block?.hash))) {
      throw new Error('malformed anchor');
    }
    if (i > 0 && block.height >= entries[i - 1].block.height) {
      throw new Error('anchor set is not newest-first');
    }
  }
  if (entries[0].block.height !== height)
    throw new Error('newest anchor is not at the signed height');

  const anchors = new lib.Anchors(JSON.stringify(entries));
  let computed;
  try {
    computed = Buffer.from(anchors.computeTrustSet().id).toString('hex');
  } finally {
    anchors.free();
  }
  if (computed !== root) throw new Error('anchor set does not match the signed root');
  return { relay, root, height, entries };
}

/** Check the newest anchor's Bitcoin header; returns its block time in seconds or throws. */
function verifyNewestHeader(anchor, headerHex, nowSeconds) {
  const text = String(headerHex).trim().toLowerCase();
  if (!/^[0-9a-f]{160}$/.test(text)) throw anchorError('newest anchor header is malformed');
  const header = Buffer.from(text, 'hex');
  const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
  const hash = Buffer.from(sha256(sha256(header)))
    .reverse()
    .toString('hex');
  if (hash !== anchor.block.hash)
    throw anchorError('newest anchor header does not hash to the anchor block');

  const bits = header.readUInt32LE(72);
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000 || mantissa === 0n)
    throw anchorError('newest anchor header has an invalid target');
  const target =
    exponent >= 3 ? mantissa << BigInt(8 * (exponent - 3)) : mantissa >> BigInt(8 * (3 - exponent));
  if (target >= 1n << BigInt(256 - MIN_HEADER_WORK_BITS))
    throw anchorError('newest anchor header has too little work');
  if (BigInt(`0x${hash}`) > target)
    throw anchorError('newest anchor header does not meet its target');

  const time = header.readUInt32LE(68);
  if (nowSeconds - time > MAX_ANCHOR_AGE_SECONDS) throw anchorError('newest anchor is stale');
  if (time - nowSeconds > MAX_ANCHOR_LEAD_SECONDS)
    throw anchorError('newest anchor is ahead of this clock');
  return time;
}

/**
 * Fetch the anchor set from every pinned relay and the newest anchor's header,
 * and return `{ root, height, entries, relays, blockTime }` for the root the
 * most relays signed (ties to the higher height), or throw `ANCHORS_UNAVAILABLE`.
 * `relays` are the agreeing relays, which demonstrably serve this set.
 */
async function establishTrust({
  fetch,
  lib,
  now = Date.now,
  relays = ANCHOR_RELAYS,
  quorum = ANCHOR_QUORUM,
}) {
  const answers = await Promise.all(
    relays.map(async (relay) => {
      try {
        return verifyRelayAnchors(
          relay,
          await fetchBytes(fetch, `${relay.url}/anchors`, { limit: MAX_ANCHORS_BYTES }),
          lib
        );
      } catch (err) {
        return { relay, error: `${relay.name}: ${err.message}` };
      }
    })
  );

  const votes = new Map();
  for (const answer of answers) {
    if (answer.error) continue;
    const key = `${answer.root}:${answer.height}`;
    votes.set(key, [...(votes.get(key) || []), answer]);
  }
  let winner = [];
  for (const agreeing of votes.values()) {
    if (
      agreeing.length > winner.length ||
      (agreeing.length === winner.length && agreeing[0].height > winner[0].height)
    ) {
      winner = agreeing;
    }
  }
  if (winner.length < quorum) {
    const reasons = answers.filter((answer) => answer.error).map((answer) => answer.error);
    throw anchorError(
      `${winner.length} of ${relays.length} relays agree on an anchor set, ${quorum} needed` +
        (reasons.length ? ` (${reasons.join('; ')})` : '')
    );
  }

  const [{ root, height, entries }] = winner;
  const newest = entries[0];
  let header;
  try {
    header = await fetchBytes(fetch, `${BLOCK_HEADER_URL}${newest.block.hash}/header`, {
      limit: MAX_HEADER_BYTES,
    });
  } catch (err) {
    throw anchorError(`newest anchor header unavailable: ${err.message}`);
  }
  const blockTime = verifyNewestHeader(
    newest,
    header.bytes.toString('utf8'),
    Math.floor(now() / 1000)
  );
  return { root, height, entries, relays: winner.map((answer) => answer.relay), blockTime };
}

module.exports = {
  ANCHOR_RELAYS,
  ANCHOR_QUORUM,
  MAX_ANCHOR_AGE_SECONDS,
  MIN_HEADER_WORK_BITS,
  anchorSigPayload,
  establishTrust,
  verifyNewestHeader,
  verifyRelayAnchors,
};
