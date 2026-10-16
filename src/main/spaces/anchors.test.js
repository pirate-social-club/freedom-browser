const crypto = require('crypto');
const { loadVeritas } = require('./veritas');
const {
  ANCHOR_RELAYS,
  MIN_HEADER_WORK_BITS,
  anchorSigPayload,
  establishTrust,
  verifyNewestHeader,
  verifyRelayAnchors,
} = require('./anchors');
const capture = require('../../../test/fixtures/spaces/relay-anchors-2026-10-15.json');

// Real answers from the four relays at 2026-10-15T21:35Z (all signed root
// 50e07f… at 971604), and the set two of them signed at 971568 earlier that day.
const lib = loadVeritas();
const CAPTURED_AT = Date.parse(capture.capturedAt);
const CURRENT = {
  relays: capture.relays,
  body: JSON.stringify(capture.anchors),
  header: capture.newestBlockHeader.hex,
};
const PREVIOUS = {
  relays: capture.previousSet.relays,
  body: JSON.stringify(capture.previousSet.anchors),
  header: capture.previousSet.newestBlockHeader.hex,
};
const relay = (name) => ANCHOR_RELAYS.find((candidate) => candidate.name === name);
const answer = (headers, body) => ({ headers: new Headers(headers), bytes: Buffer.from(body) });

/** A fetch that answers each relay's /anchors from `plan[name]` and Blockstream from the matching set. */
function fakeNetwork(plan) {
  return jest.fn(async (url) => {
    for (const { name, url: base } of ANCHOR_RELAYS) {
      if (url !== `${base}/anchors`) continue;
      const entry = plan[name] ?? 'down';
      if (entry === 'down') throw new TypeError('net::ERR_CONNECTION_REFUSED');
      const set = entry.set || CURRENT;
      return new Response(entry.body ?? set.body, {
        status: 200,
        headers: { ...set.relays[name], ...entry.headers },
      });
    }
    for (const set of [CURRENT, PREVIOUS]) {
      const newest = JSON.parse(set.body).entries[0].block.hash;
      if (url === `https://blockstream.info/api/block/${newest}/header`)
        return new Response(set.header);
    }
    throw new Error(`unexpected request ${url}`);
  });
}

const allCurrent = () => ({ cosmos: {}, atlas: {}, orion: {}, pulsar: {} });
const trustAt = (plan, at = CAPTURED_AT) =>
  establishTrust({ fetch: fakeNetwork(plan), lib, now: () => at });

describe('Spaces anchor trust', () => {
  test('accepts the set all four relays signed, after checking its newest header', async () => {
    const fetch = fakeNetwork(allCurrent());
    const trust = await establishTrust({ fetch, lib, now: () => CAPTURED_AT });

    expect(trust.root).toBe('50e07f73ea36981487d93d3139a108f8740087702b0448dced5f5573eb76b774');
    expect(trust.height).toBe(971604);
    expect(trust.entries).toHaveLength(60);
    expect(trust.relays.map((r) => r.name)).toEqual(['cosmos', 'atlas', 'orion', 'pulsar']);
    expect(new Date(trust.blockTime * 1000).toISOString()).toBe('2026-10-15T17:24:03.000Z');
    expect(fetch).toHaveBeenCalledWith(
      'https://blockstream.info/api/block/000000000000000000017a909079c2e86049fd829dac64c1ddfe24c455645a09/header',
      expect.anything()
    );
    for (const [, init] of fetch.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' })
      );
    }
  });

  test('each captured signature verifies under its own relay key only', () => {
    expect(() =>
      verifyRelayAnchors(relay('cosmos'), answer(CURRENT.relays.cosmos, CURRENT.body), lib)
    ).not.toThrow();
    expect(() =>
      verifyRelayAnchors(relay('cosmos'), answer(CURRENT.relays.atlas, CURRENT.body), lib)
    ).toThrow('anchor signature does not verify');
  });

  test('the signature covers the height', () => {
    const headers = { ...CURRENT.relays.cosmos, 'x-anchor-height': '971605' };
    expect(() => verifyRelayAnchors(relay('cosmos'), answer(headers, CURRENT.body), lib)).toThrow(
      'anchor signature does not verify'
    );
  });

  test('refuses a served set that differs from the signed root', () => {
    const entries = JSON.parse(CURRENT.body).entries;
    const truncated = JSON.stringify({ entries: entries.slice(0, -1) });
    expect(() =>
      verifyRelayAnchors(relay('cosmos'), answer(CURRENT.relays.cosmos, truncated), lib)
    ).toThrow('anchor set does not match the signed root');
    const reordered = JSON.stringify({ entries: [...entries].reverse() });
    expect(() =>
      verifyRelayAnchors(relay('cosmos'), answer(CURRENT.relays.cosmos, reordered), lib)
    ).toThrow('anchor set is not newest-first');
  });

  test('refuses an unsigned head', () => {
    const { 'x-anchor-sig': _omitted, ...unsigned } = CURRENT.relays.cosmos;
    expect(() => verifyRelayAnchors(relay('cosmos'), answer(unsigned, CURRENT.body), lib)).toThrow(
      'unsigned or malformed anchor head'
    );
  });

  test('two agreeing relays are enough when the others are down or lying', async () => {
    const forged = { headers: { 'x-anchor-sig': CURRENT.relays.cosmos['x-anchor-sig'] } };
    const trust = await trustAt({ cosmos: 'down', atlas: forged, orion: {}, pulsar: {} });
    expect(trust.relays.map((r) => r.name)).toEqual(['orion', 'pulsar']);
  });

  test('one relay is not enough', async () => {
    await expect(trustAt({ orion: {} })).rejects.toMatchObject({
      code: 'ANCHORS_UNAVAILABLE',
      message: expect.stringMatching(
        /^1 of 4 relays agree on an anchor set, 2 needed \(cosmos: net::ERR_CONNECTION_REFUSED; /
      ),
    });
  });

  test('the set more relays signed wins, a tie goes to the newer set', async () => {
    const older = await trustAt({ cosmos: { set: PREVIOUS }, atlas: { set: PREVIOUS }, orion: {} });
    expect(older.height).toBe(971568);
    expect(older.root).toBe('a9fc2adb1e3ecb132e7ce58c564a076cf3918fadc253bb01816c74298d492b69');

    const tie = await trustAt({
      cosmos: { set: PREVIOUS },
      atlas: { set: PREVIOUS },
      orion: {},
      pulsar: {},
    });
    expect(tie.height).toBe(971604);
  });

  test('refuses a set whose newest anchor was mined more than 12 hours ago', async () => {
    const blockTime = Date.parse('2026-10-15T17:24:03Z');
    await expect(trustAt(allCurrent(), blockTime + 12 * 3600 * 1000)).resolves.toMatchObject({
      height: 971604,
    });
    await expect(trustAt(allCurrent(), blockTime + 12 * 3600 * 1000 + 1000)).rejects.toThrow(
      'newest anchor is stale'
    );
    await expect(trustAt(allCurrent(), blockTime - 2 * 3600 * 1000 - 1000)).rejects.toThrow(
      'newest anchor is ahead of this clock'
    );
  });

  test('refuses a header for another block', async () => {
    const plan = allCurrent();
    const fetch = fakeNetwork(plan);
    const swapped = jest.fn((url, init) =>
      url.startsWith('https://blockstream.info/')
        ? Promise.resolve(new Response(PREVIOUS.header))
        : fetch(url, init)
    );
    await expect(establishTrust({ fetch: swapped, lib, now: () => CAPTURED_AT })).rejects.toThrow(
      'newest anchor header does not hash to the anchor block'
    );
  });

  test('refuses an unreachable header source', async () => {
    const fetch = fakeNetwork(allCurrent());
    const offline = jest.fn((url, init) =>
      url.startsWith('https://blockstream.info/')
        ? Promise.reject(new TypeError('net::ERR_TIMED_OUT'))
        : fetch(url, init)
    );
    await expect(
      establishTrust({ fetch: offline, lib, now: () => CAPTURED_AT })
    ).rejects.toMatchObject({
      code: 'ANCHORS_UNAVAILABLE',
      message: 'newest anchor header unavailable: net::ERR_TIMED_OUT',
    });
  });
});

describe('newest anchor header proof of work', () => {
  // A header built here, with the anchor's block hash set to whatever it hashes
  // to, so only the work checks can refuse it.
  function headerWithBits(bits, time) {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(0x20000000, 0);
    header.writeUInt32LE(time, 68);
    header.writeUInt32LE(bits, 72);
    const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
    const hash = Buffer.from(sha256(sha256(header)))
      .reverse()
      .toString('hex');
    return { hex: header.toString('hex'), anchor: { block: { hash } } };
  }
  const now = 1792085043;

  test('accepts the real header against its own target', () => {
    const anchor = JSON.parse(CURRENT.body).entries[0];
    expect(verifyNewestHeader(anchor, CURRENT.header, now)).toBe(now);
  });

  test(`refuses a chain with less than ${MIN_HEADER_WORK_BITS} bits of work, however valid its own target`, () => {
    const { hex, anchor } = headerWithBits(0x207fffff, now);
    expect(() => verifyNewestHeader(anchor, hex, now)).toThrow(
      'newest anchor header has too little work'
    );
  });

  test('refuses a header that misses its stated target', () => {
    const { hex, anchor } = headerWithBits(0x17021ef0, now);
    expect(() => verifyNewestHeader(anchor, hex, now)).toThrow(
      'newest anchor header does not meet its target'
    );
  });

  test('refuses a negative target', () => {
    const { hex, anchor } = headerWithBits(0x17800001, now);
    expect(() => verifyNewestHeader(anchor, hex, now)).toThrow(
      'newest anchor header has an invalid target'
    );
  });

  test('the signed payload is the relay scheme', () => {
    const payload = anchorSigPayload('ab'.repeat(32), 971604);
    expect(payload.subarray(0, 23).toString()).toBe('certrelay-anchor-sig-v1');
    expect(payload.subarray(23, 55).toString('hex')).toBe('ab'.repeat(32));
    expect(payload.readUInt32BE(55)).toBe(971604);
  });
});
