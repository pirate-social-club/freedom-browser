// Transport framing only. DNSSEC authentication remains in owned hnsd/libunbound.
const MAX_DNS_MESSAGE = 65535;
const DNS_TYPE_OPT = 41;
const DNS_TYPE_DS = 43;
const DNS_TYPE_RRSIG = 46;

function readName(message, start) {
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
    labels.push(message.toString('latin1', offset, offset + length).replace(/[A-Z]/g, (c) => c.toLowerCase()));
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

module.exports = { MAX_DNS_MESSAGE, parseMessage, parseQuery, isLocalQuestion, validateResponse, questionResponse, udpResponse };
