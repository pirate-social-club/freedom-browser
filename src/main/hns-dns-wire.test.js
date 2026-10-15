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

describe('wildcard proof completion', () => {
  const {
    DNS_TYPE_PROOF_PROBE, needsWildcardProof, buildWildcardProofQuery, appendWildcardProof,
  } = require('./hns-dns-wire');
  // Real dns.pirate.sc exchanges for a member host under the *.8s28 wildcard:
  // the positive answers carry no NSEC, the absent-type answers do.
  const wire = require('../../test/helpers/hns-wildcard-wire.json').exchanges;
  // Reads a possibly compressed name at an offset, as the module does.
  const readNameOf = (message, offset) => {
    const labels = [];
    let end;
    for (let at = offset; ;) {
      const length = message[at];
      if ((length & 0xc0) === 0xc0) { end ??= at + 2; at = ((length & 63) << 8) | message[at + 1]; continue; }
      if (!length) return { labels, end: end ?? at + 1 };
      labels.push(message.toString('latin1', at + 1, at + 1 + length).toLowerCase());
      at += length + 1;
    }
  };
  const bytes = (key, part = 'response') => Buffer.from(wire[key][part], 'hex');
  const proofRecords = (message) => parseMessage(message).records
    .filter((rr) => rr.section === 1 && (rr.type === 47 || (rr.type === 46 && message.readUInt16BE(rr.data) === 47)));

  test.each([['answer_a', 1], ['answer_tlsa', 52]])('a wildcard-expanded %s without NSEC needs the proof', (key) => {
    expect(needsWildcardProof(bytes(key))).toBe(true);
  });

  test('an explicit record, or an answer that already carries NSEC, does not', () => {
    expect(needsWildcardProof(bytes('answer_plain'))).toBe(false);
    const completed = appendWildcardProof(bytes('answer_a'), parseMessage(bytes('answer_a')), bytes('proof_a'));
    expect(needsWildcardProof(completed)).toBe(false);
  });

  test('a refusal or a denial never needs one', () => {
    const refused = Buffer.from(bytes('answer_a'));
    refused.writeUInt16BE((refused.readUInt16BE(2) & ~15) | 2, 2);
    expect(needsWildcardProof(refused)).toBe(false);
    expect(needsWildcardProof(bytes('proof_a'))).toBe(false);
  });

  test('the proof query asks for an absent type with DNSSEC records, keeping RD and CD', () => {
    const original = parseQuery(bytes('answer_tlsa', 'query'));
    const probe = buildWildcardProofQuery(original, 0xbeef);
    const parsed = parseQuery(probe);
    expect(parsed.id).toBe(0xbeef);
    expect(parsed.flags).toBe(original.flags & 0x0110);
    expect(parsed.question).toEqual({ labels: ['_443', '_tcp', 'membertest', '8s28'], type: DNS_TYPE_PROOF_PROBE, klass: 1 });
    expect(probe.readUInt32BE(probe.length - 6)).toBe(0x8000); // OPT DO bit
  });

  test.each([['answer_a', 'proof_a'], ['answer_tlsa', 'proof_tlsa']])('%s gains exactly the NSEC records and their signatures from %s', (answerKey, proofKey) => {
    const answer = bytes(answerKey);
    const before = parseMessage(answer);
    const combined = appendWildcardProof(answer, before, bytes(proofKey));
    const after = parseMessage(combined);
    const added = proofRecords(bytes(proofKey));
    expect(added.length).toBeGreaterThanOrEqual(4);
    // Same answer and additional records, byte for byte; SOA and its RRSIG are not copied.
    const sectionBytes = (message, parsed, section) => parsed.records.filter((rr) => rr.section === section)
      .map((rr) => message.subarray(rr.data - 10, rr.end).toString('hex'));
    expect(sectionBytes(combined, after, 0)).toEqual(sectionBytes(answer, before, 0));
    expect(sectionBytes(combined, after, 2)).toEqual(sectionBytes(answer, before, 2));
    expect(after.records.filter((rr) => rr.section === 1).map((rr) => [rr.labels.join('.'), rr.type]))
      .toEqual(added.map((rr) => [rr.labels.join('.'), rr.type]));
    expect(combined.readUInt16BE(8)).toBe(added.length);
    expect(after.question).toEqual(before.question);
    expect(after.id).toBe(before.id);
    // Same names and same bytes once both sides' names are read out in full:
    // the NSEC next name and the RRSIG signer, and everything around them.
    const decoded = (message, rr) => {
      const name = rr.type === 47 ? readNameOf(message, rr.data) : rr.type === 46 ? readNameOf(message, rr.data + 18) : null;
      const head = rr.type === 46 ? message.subarray(rr.data, rr.data + 18).toString('hex') : '';
      return { type: rr.type, ttl: message.readUInt32BE(rr.data - 6), head, name: name?.labels.join('.'),
        tail: name ? message.subarray(name.end, rr.end).toString('hex') : message.subarray(rr.data, rr.end).toString('hex') };
    };
    expect(after.records.filter((rr) => rr.section === 1).map((rr) => decoded(combined, rr)))
      .toEqual(added.map((rr) => decoded(bytes(proofKey), rr)));
    // Nothing moved carries a compression pointer.
    for (const rr of after.records.filter((r) => r.section === 1 && r.type === 47)) expect(combined[rr.data] & 0xc0).toBe(0);
  });

  test('a denial with no NSEC adds nothing', () => {
    const answer = bytes('answer_a');
    const denial = Buffer.from(bytes('proof_a'));
    const parsed = parseMessage(denial);
    for (const rr of parsed.records.filter((r) => r.type === 47)) denial.writeUInt16BE(13, rr.data - 10); // retype NSEC as HINFO
    expect(appendWildcardProof(answer, parseMessage(answer), denial)).toBe(answer);
  });

  test('the real resolver compresses NSEC next names, and they are written out in full', () => {
    const denial = bytes('proof_a');
    const compressed = parseMessage(denial).records.filter((rr) => rr.type === 47 && denial.subarray(rr.data, rr.end).includes(0xc0));
    expect(compressed.length).toBeGreaterThan(0);
    const combined = appendWildcardProof(bytes('answer_a'), parseMessage(bytes('answer_a')), denial);
    const nsec = parseMessage(combined).records.filter((rr) => rr.section === 1 && rr.type === 47);
    expect(nsec.map((rr) => readNameOf(combined, rr.data).labels.join('.')).sort()).toEqual(['_pirate.8s28', 'ns1.8s28']);
  });

  test('an NSEC next name keeps its letter case when written out in full', () => {
    const denial = Buffer.from(bytes('proof_a'));
    const nsec = parseMessage(denial).records.find((rr) => rr.type === 47 && denial[rr.data] !== 0 && (denial[rr.data] & 0xc0) === 0);
    denial[nsec.data + 2] = denial[nsec.data + 2] & ~0x20; // uppercase one letter of the uncompressed label
    const combined = appendWildcardProof(bytes('answer_a'), parseMessage(bytes('answer_a')), denial);
    const moved = parseMessage(combined).records.find((rr) => rr.section === 1 && rr.type === 47 && rr.labels.join('.') === nsec.labels.join('.'));
    expect(combined.toString('latin1', moved.data + 1, moved.data + 1 + combined[moved.data]))
      .toBe(denial.toString('latin1', nsec.data + 1, nsec.data + 1 + denial[nsec.data]));
  });

  test('an NSEC whose next name runs outside its record refuses the combination', () => {
    const denial = Buffer.from(bytes('proof_a'));
    const nsec = parseMessage(denial).records.find((rr) => rr.type === 47);
    denial.writeUInt16BE(1, nsec.data - 2); // RDLENGTH 1 cuts the next name short
    expect(() => appendWildcardProof(bytes('answer_a'), parseMessage(bytes('answer_a')), denial)).toThrow();
  });
});
