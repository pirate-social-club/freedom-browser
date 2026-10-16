function name(value) {
  const labels = value.replace(/\.$/, '').split('.').filter(Boolean);
  return Buffer.concat([...labels.flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]), Buffer.from([0])]);
}

function query(host = 'app.pirate', type = 1, klass = 1, edns = false) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1234, 0); header.writeUInt16BE(0x0110, 2); header.writeUInt16BE(1, 4);
  if (edns) header.writeUInt16BE(1, 10);
  const tail = Buffer.alloc(4); tail.writeUInt16BE(type, 0); tail.writeUInt16BE(klass, 2);
  return Buffer.concat([header, name(host), tail, ...(edns ? [record('', 41, Buffer.alloc(0), 4096, 0x8000)] : [])]);
}

function record(owner, type = 1, data = Buffer.from([1, 2, 3, 4]), klass = 1, ttl = 60) {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0); header.writeUInt16BE(klass, 2);
  header.writeUInt32BE(ttl, 4); header.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), header, data]);
}

function response(request, sections = [[record('app.pirate')], [], []], flags = 0x81b0) {
  let end = 12;
  while (request[end]) end += request[end] + 1;
  end += 5;
  const header = Buffer.from(request.subarray(0, end));
  header.writeUInt16BE(flags, 2);
  sections.forEach((section, index) => header.writeUInt16BE(section.length, 6 + index * 2));
  return Buffer.concat([header, ...sections.flat()]);
}

function signature(signer = 'pirate') {
  return Buffer.concat([Buffer.alloc(18), name(signer), Buffer.alloc(64)]);
}

module.exports = { name, query, record, response, signature };
