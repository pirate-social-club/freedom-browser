// Transport framing only. DNSSEC authentication remains in owned hnsd/libunbound.
const MAX_DNS_MESSAGE = 65535;
const DNS_TYPE_OPT = 41;
const DNS_TYPE_DS = 43;
const DNS_TYPE_RRSIG = 46;
const DNS_TYPE_NSEC = 47;
const DNS_TYPE_NSEC3 = 50;
// Private-use type (RFC 6895): no zone publishes it, so asking for it at a
// wildcard-expanded name returns the signed denial that proves the expansion.
const DNS_TYPE_PROOF_PROBE = 65280;

function readName(message, start, { preserveCase = false } = {}) {
  const labels = [];
  const visited = new Set();
  let offset = start;
  let end;
  let size = 1;
  while (true) {
    if (offset >= message.length || visited.has(offset)) throw new Error('Invalid DNS name');
    visited.add(offset);
    if (visited.size > 128) throw new Error('DNS name is too complex');
    const length = message[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= message.length) throw new Error('Truncated DNS pointer');
      const pointer = ((length & 63) << 8) | message[offset + 1];
      if (pointer < 12 || pointer >= offset) throw new Error('Invalid DNS pointer');
      end ??= offset + 2;
      offset = pointer;
      continue;
    }
    if (length & 0xc0) throw new Error('Invalid DNS label');
    offset += 1;
    if (!length) return { labels, end: end ?? offset };
    size += length + 1;
    if (size > 255 || offset + length > message.length) throw new Error('Invalid DNS name size');
    const label = message.toString('latin1', offset, offset + length);
    labels.push(preserveCase ? label : label.replace(/[A-Z]/g, (c) => c.toLowerCase()));
    offset += length;
  }
}

function parseMessage(message) {
  if (!Buffer.isBuffer(message) || message.length < 12 || message.length > MAX_DNS_MESSAGE) {
    throw new Error('Invalid DNS message size');
  }
  if (message.readUInt16BE(4) !== 1) throw new Error('DNS requires one question');
  const name = readName(message, 12);
  let offset = name.end;
  if (offset + 4 > message.length) throw new Error('Truncated DNS question');
  const question = { labels: name.labels, type: message.readUInt16BE(offset), klass: message.readUInt16BE(offset + 2) };
  offset += 4;
  const questionEnd = offset;
  const records = [];
  for (let section = 0; section < 3; section += 1) {
    const count = message.readUInt16BE(6 + section * 2);
    for (let index = 0; index < count; index += 1) {
      const owner = readName(message, offset);
      offset = owner.end;
      if (offset + 10 > message.length) throw new Error('Truncated DNS record');
      const type = message.readUInt16BE(offset);
      const klass = message.readUInt16BE(offset + 2);
      const length = message.readUInt16BE(offset + 8);
      const data = offset + 10;
      const end = data + length;
      if (end > message.length) throw new Error('Truncated DNS record data');
      const record = { labels: owner.labels, type, klass, section, data, end };
      if (type === DNS_TYPE_RRSIG) {
        if (length < 20) throw new Error('Truncated DNS signature');
        const signer = readName(message, data + 18);
        if (signer.end >= end) throw new Error('Invalid DNS signature signer');
        record.signerLabels = signer.labels;
      }
      records.push(record);
      offset = end;
    }
  }
  if (offset !== message.length) throw new Error('Trailing DNS data');
  return { id: message.readUInt16BE(0), flags: message.readUInt16BE(2), question, questionEnd, records };
}

function parseQuery(message) {
  const parsed = parseMessage(message);
  if ((parsed.flags & 0xf800) !== 0 || (parsed.flags & 15) !== 0 ||
      ![1, 4].includes(parsed.question.klass) || parsed.records.some((rr) => rr.section !== 2 || rr.type !== DNS_TYPE_OPT || rr.labels.length) ||
      parsed.records.length > 1) throw new Error('Unsupported DNS query');
  return parsed;
}

function isLocalQuestion({ question }) {
  return question.klass === 4 || question.labels.length === 0 ||
    (question.klass === 1 && question.type === 16 && question.labels.join('.') === 'height.tip.chain.hnsd') ||
    (question.type === DNS_TYPE_DS && question.labels.length === 1);
}

function validateResponse(message, query, remote = false) {
  const parsed = parseMessage(message);
  if (!(parsed.flags & 0x8000) || (parsed.flags & 0x7800) !== (query.flags & 0x7800) ||
      parsed.id !== query.id || JSON.stringify(parsed.question) !== JSON.stringify(query.question)) {
    throw new Error('DNS response does not match query');
  }
  if (remote) {
    if (parsed.flags & 0x0200) throw new Error('Truncated encrypted DNS response');
    let optCount = 0;
    for (const rr of parsed.records) {
      if (rr.type === DNS_TYPE_OPT) {
        if (rr.labels.length || rr.section !== 2 || ++optCount > 1) throw new Error('Invalid DNS OPT');
      } else if (rr.labels.length === 0 || rr.klass !== 1 ||
          (rr.type === DNS_TYPE_DS && rr.labels.length === 1) ||
          (rr.signerLabels && rr.signerLabels.length === 0)) {
        // The synthetic root signing keys are public. Only our own hnsd root
        // may assert root authority, including denial proofs and referrals.
        throw new Error('Encrypted resolver attempted to assert local root authority');
      }
    }
  }
  const result = Buffer.from(message);
  result.writeUInt16BE(parsed.flags & ~0x0020, 2);
  return result;
}

function questionResponse(message, query, flags) {
  const result = Buffer.from(message.subarray(0, query.questionEnd));
  result.writeUInt16BE(0x8000 | (query.flags & 0x0110) | flags, 2);
  result.fill(0, 6, 12);
  return result;
}

function udpResponse(message, request, query) {
  const limit = Math.min(4096, Math.max(512, query.records[0]?.klass || 512));
  return message.length > limit ? questionResponse(request, query, 0x0200) : message;
}

function encodeName(labels) {
  return Buffer.concat([
    ...labels.flatMap((label) => [Buffer.from([label.length]), Buffer.from(label, 'latin1')]),
    Buffer.from([0]),
  ]);
}

// One proof record re-encoded to stand alone in another packet: owner and the
// RDATA names written out in full, everything else byte for byte. RFC 4034
// forbids compressing the NSEC next name and the RRSIG signer, but resolvers
// built on hsd do it anyway; validators canonicalize both to uncompressed
// lowercase where the canonical form requires it, so writing them out in full
// changes nothing they verify. Their letters keep their original case: the
// NSEC next name is not lowercased in canonical form (RFC 6840 section 5.1),
// so its case is part of what the signature covers. A name that runs outside
// its RDATA refuses the record.
function standaloneProofRecord(message, rr) {
  const fixed = message.subarray(rr.data - 10, rr.data - 2); // type, class, TTL
  let rdata;
  if (rr.type === DNS_TYPE_NSEC) {
    const next = readName(message, rr.data, { preserveCase: true });
    if (next.end > rr.end) throw new Error('NSEC next name overruns its record');
    rdata = Buffer.concat([encodeName(next.labels), message.subarray(next.end, rr.end)]);
  } else if (rr.type === DNS_TYPE_RRSIG) {
    const signer = readName(message, rr.data + 18, { preserveCase: true });
    if (signer.end >= rr.end) throw new Error('RRSIG signer overruns its record');
    rdata = Buffer.concat([message.subarray(rr.data, rr.data + 18), encodeName(signer.labels), message.subarray(signer.end, rr.end)]);
  } else {
    rdata = message.subarray(rr.data, rr.end); // NSEC3 carries no names
  }
  const length = Buffer.alloc(2);
  length.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([encodeName(rr.labels), fixed, length, rdata]);
}

/**
 * A positive answer whose signature shows wildcard expansion (RRSIG labels
 * below the owner's label count) and that carries no NSEC or NSEC3 record. A
 * validator must refuse it without the proof that no closer name exists
 * (RFC 4035 section 5.3.4); recursive resolvers can drop that proof.
 */
function needsWildcardProof(message, parsed = parseMessage(message)) {
  if ((parsed.flags & 15) !== 0) return false;
  const question = parsed.question.labels.join('.');
  const expanded = parsed.records.some((rr) => rr.section === 0 && rr.type === DNS_TYPE_RRSIG &&
    rr.labels.join('.') === question && message[rr.data + 3] < rr.labels.length);
  const proven = parsed.records.some((rr) => rr.section === 1 &&
    (rr.type === DNS_TYPE_NSEC || rr.type === DNS_TYPE_NSEC3));
  return expanded && !proven;
}

// The denial query for the same name: an absent type, asking for DNSSEC
// records, with the original query's RD and CD bits and a fresh ID.
function buildWildcardProofQuery(query, id) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(query.flags & 0x0110, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 10);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(DNS_TYPE_PROOF_PROBE, 0);
  question.writeUInt16BE(1, 2);
  const opt = Buffer.alloc(11);
  opt.writeUInt16BE(DNS_TYPE_OPT, 1);
  opt.writeUInt16BE(4096, 3);
  opt.writeUInt32BE(0x00008000, 5);
  return Buffer.concat([header, encodeName(query.question.labels), question, opt]);
}

/**
 * Adds the NSEC/NSEC3 records and their signatures from a denial answer to
 * the authority section of a wildcard-expanded positive answer. Nothing is
 * judged here: hnsd/libunbound still verify every signature and whether the
 * proof covers the name, so a missing, forged, expired or unrelated proof is
 * refused there. Every name in a moved record is written out in full, so no
 * compression pointer refers into the other packet.
 */
function appendWildcardProof(message, parsed, proof, proofParsed = parseMessage(proof)) {
  const denial = (rr) => rr.section === 1 && rr.klass === 1;
  const records = proofParsed.records.filter((rr) => denial(rr) && (rr.type === DNS_TYPE_NSEC || rr.type === DNS_TYPE_NSEC3));
  const owners = new Set(records.map((rr) => `${rr.type}:${rr.labels.join('.')}`));
  // Only the signatures over those denial records, at their owners.
  const signatures = proofParsed.records.filter((rr) => denial(rr) && rr.type === DNS_TYPE_RRSIG &&
    owners.has(`${proof.readUInt16BE(rr.data)}:${rr.labels.join('.')}`));
  const encoded = proofParsed.records.filter((rr) => records.includes(rr) || signatures.includes(rr))
    .map((rr) => standaloneProofRecord(proof, rr));
  if (!encoded.length) return message;
  // Insert after the last authority record. Compression pointers only point
  // backwards, so every record after the insertion point stays valid.
  const authorityEnd = parsed.records.filter((rr) => rr.section <= 1)
    .reduce((end, rr) => Math.max(end, rr.end), parsed.questionEnd);
  const combined = Buffer.concat([message.subarray(0, authorityEnd), ...encoded, message.subarray(authorityEnd)]);
  if (combined.length > MAX_DNS_MESSAGE) return message;
  combined.writeUInt16BE(message.readUInt16BE(8) + encoded.length, 8);
  parseMessage(combined);
  return combined;
}

module.exports = {
  MAX_DNS_MESSAGE, DNS_TYPE_PROOF_PROBE, parseMessage, parseQuery, isLocalQuestion, validateResponse,
  questionResponse, udpResponse, needsWildcardProof, buildWildcardProofQuery, appendWildcardProof,
};
