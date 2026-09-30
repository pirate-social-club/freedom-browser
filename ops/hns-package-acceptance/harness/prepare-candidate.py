import json,subprocess,hashlib,time,os,datetime
from pathlib import Path
import dns.message,dns.dnssec,dns.rdatatype,dns.name,dns.flags
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
p=Path(__file__).parent
assert (p/'candidate-integrity.json').exists()
assert hashlib.sha256((p/'package/resources/hns-bin/fingertipd').read_bytes()).hexdigest()==json.loads((p/'candidate-integrity.json').read_text())['helper_sha256']
print('Copying fresh public signed fixture answers',flush=True)
hosts=['PLACEHOLDER_DNSSEC','PLACEHOLDER_DANE','PLACEHOLDER_FINAL']
queries=[]
for h in hosts:
 for name,kind in [(h,'A'),(h,'AAAA'),('_tcp.'+h,'A'),('_443._tcp.'+h,'A'),('_443._tcp.'+h,'TLSA')]:
  q=dns.message.make_query(name,kind,want_dnssec=True);queries.append({'name':q.question[0].name.to_text(),'type':kind,'query_hex':q.to_wire().hex()})
import dns.query
fresh=[]
for item in queries:
 q=dns.message.from_wire(bytes.fromhex(item['query_hex']))
 try:
  r=dns.query.udp(q,'81.15.150.167',timeout=3)
  if r.flags & dns.flags.TC:r=dns.query.tcp(q,'81.15.150.167',timeout=3)
 except Exception:r=dns.query.tcp(q,'94.103.168.209',timeout=3)
 assert r.question==q.question,'fixture query response mismatch'
 fresh.append({**item,'response_hex':r.to_wire().hex()})
(p/'new-host-responses.json').write_text(json.dumps(fresh,indent=2)+'\n')
corpus=json.loads((p/'public-fixture-base.json').read_text())+fresh
(p/'public-signed-responses.json').write_text(json.dumps(corpus,indent=2)+'\n')
zone=dns.name.from_text('8s28.');keymsg=next(dns.message.from_wire(bytes.fromhex(r['response_hex'])) for r in corpus if r['name']=='8s28.' and r['type']=='DNSKEY');keys=next(rr for rr in keymsg.answer if rr.rdtype==dns.rdatatype.DNSKEY)
assert any(dns.dnssec.make_ds(zone,key,'SHA256').digest.hex()=='bb4e2a41217b047aef43e5a69ec5973aa0caefe9b3f01fb2e8967d6e2d6c25e6' for key in keys)
checked=[];expiry=[]
for item in corpus:
 m=dns.message.from_wire(bytes.fromhex(item['response_hex']))
 for section in [m.answer,m.authority,m.additional]:
  for rr in section:
   if rr.rdtype in [dns.rdatatype.RRSIG,dns.rdatatype.OPT]:continue
   sig=next((s for s in section if s.rdtype==dns.rdatatype.RRSIG and s.name==rr.name and s.covers==rr.rdtype),None)
   if sig is None:continue
   dns.dnssec.validate(rr,sig,{zone:keys},now=time.time());expiry.extend(s.expiration for s in sig);checked.append({'name':rr.name.to_text(),'type':dns.rdatatype.to_text(rr.rdtype)})
negative=next(dns.message.from_wire(bytes.fromhex(r['response_hex'])) for r in fresh if r['name']==hosts[0]+'.' and r['type']=='A');rr=next(r for r in negative.answer if r.rdtype==dns.rdatatype.A);sig=next(r for r in negative.answer if r.rdtype==dns.rdatatype.RRSIG and r.covers==dns.rdatatype.A);s=next(iter(sig));sig.clear();sig.add(s.replace(signature=bytes([s.signature[0]^1])+s.signature[1:]));rejected=False
try:dns.dnssec.validate(rr,sig,{zone:keys},now=time.time())
except dns.dnssec.ValidationFailure:rejected=True
assert rejected
(p/'signature-validity-recheck.json').write_text(json.dumps({'checked_epoch':time.time(),'all_copied_signatures_valid':True,'earliest_expiry_epoch':min(expiry),'checked_rrsets':checked,'corrupt_signature_rejected_independently':True},indent=2)+'\n')
private=p/'private-test-material';private.mkdir(mode=0o700);key=ec.generate_private_key(ec.SECP256R1());name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,hosts[1])]);now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName(hosts[1])]),critical=False).sign(key,hashes.SHA256())
f=private/'wrong-key.pem';f.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));f.chmod(0o600);(p/'wrong-certificate.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
pin=hashlib.sha256(key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest();tlsa=next(dns.message.from_wire(bytes.fromhex(r['response_hex'])) for r in fresh if r['name']=='_443._tcp.'+hosts[1]+'.' and r['type']=='TLSA');records=[s for rr in tlsa.answer if rr.rdtype==dns.rdatatype.TLSA for s in rr];assert records and all(s.cert.hex()!=pin for s in records)
(p/'wrong-pin-proof.json').write_text(json.dumps({'hostname':hosts[1],'wrong_spki_sha256':pin,'signed_tlsa':[str(s) for s in records],'correct_hostname_SAN':True,'mismatch':True},indent=2)+'\n')
(p/'fixture-mode').write_text('valid\n');print('Candidate and authenticated fixtures ready',flush=True)
