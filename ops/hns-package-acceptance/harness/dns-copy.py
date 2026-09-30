import json,socket,struct,threading,time,sys
from pathlib import Path
import dns.message,dns.rdatatype,dns.rcode
p=Path(__file__).parent
corpus={(q['name'],dns.rdatatype.from_text(q['type'])):bytes.fromhex(q['response_hex']) for q in json.loads((p/'public-signed-responses.json').read_text())}
def reply(wire):
 q=dns.message.from_wire(wire);question=q.question[0];key=(question.name.to_text(),question.rdtype);mode=(p/'fixture-mode').read_text().strip()
 if key not in corpus:
  r=dns.message.make_response(q);r.set_rcode(dns.rcode.SERVFAIL)
 else:
  r=dns.message.from_wire(corpus[key]);r.id=q.id;r.question=q.question
  if mode=='bad-dnssec' and key==('PLACEHOLDER_DNSSEC.',dns.rdatatype.A):
   for rr in r.answer:
    if rr.rdtype==dns.rdatatype.RRSIG and rr.covers==dns.rdatatype.A:
     sig=next(iter(rr));bad=bytes([sig.signature[0]^1])+sig.signature[1:];rr.clear();rr.add(sig.replace(signature=bad))
 with (p/'fixture-queries.jsonl').open('a') as f:f.write(json.dumps({'time':time.time(),'question':key,'mode':mode,'known':key in corpus,'signature_mutated':mode=='bad-dnssec' and key==('PLACEHOLDER_DNSSEC.',dns.rdatatype.A),'response_sha256':__import__('hashlib').sha256(r.to_wire()).hexdigest()})+'\n')
 return r.to_wire()
def udp():
 sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sock.bind(('127.0.0.1',1053))
 while True:
  wire,addr=sock.recvfrom(65535)
  try:sock.sendto(reply(wire),addr)
  except Exception as e:
   with (p/'fixture-errors.log').open('a') as f:f.write(str(e)+'\n')
def readn(sock,n):
 out=b''
 while len(out)<n:
  b=sock.recv(n-len(out))
  if not b:raise EOFError()
  out+=b
 return out
def connection(sock):
 with sock:
  sock.settimeout(3)
  try:
   while True:
    wire=readn(sock,struct.unpack('!H',readn(sock,2))[0]);out=reply(wire);sock.sendall(struct.pack('!H',len(out))+out)
  except (EOFError,TimeoutError,OSError):pass
def tcp():
 sock=socket.socket();sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);sock.bind(('127.0.0.1',1053));sock.listen(16)
 while True:
  client,_=sock.accept();threading.Thread(target=connection,args=(client,),daemon=True).start()
threading.Thread(target=tcp,daemon=True).start();udp()
