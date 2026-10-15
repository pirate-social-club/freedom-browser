const { query, record, response, signature } = require('../../test/helpers/hns-dns-fixtures');
const { parseQuery, parseMessage, isLocalQuestion, validateResponse, udpResponse } = require('./hns-dns-wire');

test.each([
  ['', 48, 1, true], ['pirate', 43, 1, true], ['child.pirate', 43, 1, false],
  ['pirate', 48, 1, false], ['app.pirate', 1, 1, false], ['chain.hnsd', 16, 4, true], ['height.tip.chain.hnsd', 16, 1, true],
])('keeps root authority on the owned endpoint: %s/%s/%s', (host, type, klass, local) => {
  expect(isLocalQuestion(parseQuery(query(host, type, klass)))).toBe(local);
});

test('preserves query DO/CD and clears the remote AD assertion', () => {
  const request = query('app.pirate', 1, 1, true);
  const parsed = parseQuery(request);
  expect(parsed.flags & 0x10).toBe(0x10);
  expect(request.readUInt32BE(parsed.records[0].data - 6) & 0x8000).toBe(0x8000);
  const reply = response(request, [[record('app.pirate')], [], [record('', 41, Buffer.alloc(0), 4096)]]);
  const sanitized = validateResponse(reply, parsed, true);
  expect(sanitized.readUInt16BE(2) & 0x20).toBe(0);
  expect(reply.readUInt16BE(2) & 0x20).toBe(0x20);
});

describe.each([0, 1, 2])('remote section %s cannot assert local root authority', (section) => {
  test.each([
    ['', 48, Buffer.alloc(68)], ['', 6, Buffer.alloc(20)],
    ['pirate', 43, Buffer.alloc(36)], ['app.pirate', 46, signature('')],
    ['chain.hnsd', 16, Buffer.from([1, 65]), 4],
  ])('rejects owner %s, type %s', (owner, type, data, klass = 1) => {
    const request = query(); const sections = [[], [], []];
    sections[section].push(record(owner, type, data, klass));
    expect(() => validateResponse(response(request, sections), parseQuery(request), true)).toThrow();
  });
});

test('allows a delegated child DS and non-root signer', () => {
  const request = query('child.pirate', 43);
  expect(() => validateResponse(response(request, [[record('child.pirate', 43, Buffer.alloc(36)),
    record('child.pirate', 46, signature('pirate'))], [], []]), parseQuery(request), true)).not.toThrow();
});

test('allows aggregate local metadata answer owners while checking the original question', () => {
  const request = query('chain.hnsd', 16, 4);
  const reply = response(request, [[record('height.tip.chain.hnsd', 16, Buffer.from([1, 49]), 4)], [], []]);
  expect(() => validateResponse(reply, parseQuery(request))).not.toThrow();
});

test.each(['id', 'question', 'response', 'opcode', 'truncated'])('rejects mismatched remote %s', (kind) => {
  const request = query(); const reply = response(request);
  if (kind === 'id') reply.writeUInt16BE(999, 0);
  if (kind === 'question') reply[13] = 98;
  if (kind === 'response') reply[2] &= 0x7f;
  if (kind === 'opcode') reply[2] |= 0x08;
  if (kind === 'truncated') reply[2] |= 0x02;
  expect(() => validateResponse(reply, parseQuery(request), true)).toThrow();
});

test('rejects compression cycles, undersized/trailing packets and count overflows', () => {
  const cycle = query(); cycle[12] = 0xc0; cycle[13] = 12;
  const count = response(query()); count.writeUInt16BE(65535, 6);
  for (const message of [cycle, count, Buffer.alloc(11), Buffer.concat([query(), Buffer.from([0])])]) {
    expect(() => parseMessage(message)).toThrow();
  }
});

test('oversized UDP reply becomes a question-only TC refusal without AD', () => {
  const request = query(); const reply = response(request, [[record('app.pirate', 16, Buffer.alloc(5000))], [], []]);
  const truncated = udpResponse(reply, request, parseQuery(request));
  const parsed = parseMessage(truncated);
  expect(parsed.flags & 0x220).toBe(0x200);
  expect(parsed.records).toHaveLength(0);
  expect(parsed.question).toEqual(parseQuery(request).question);
});
