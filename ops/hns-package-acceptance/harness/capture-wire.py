import json,sys,time,ipaddress
from pathlib import Path
import dns.message,dns.query,dns.flags,dns.rcode
p=Path(__file__).parent;label,host=sys.argv[1:];found=[]
for entry in Path('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:
  if (entry/'comm').read_text().strip()!='fingertipd':continue
  args=(entry/'cmdline').read_bytes().decode().split('\0')
  if str(p/'profile-candidate') not in ' '.join(args):continue
  i=args.index('-recursive-addr');found.append({'pid':int(entry.name),'recursive_addr':args[i+1]})
 except (OSError,ValueError):continue
assert len(found)==1,found
addr,port=found[0]['recursive_addr'].rsplit(':',1);assert ipaddress.ip_address(addr).is_loopback
out=[]
for name,kind in [(host,'A'),(host,'AAAA'),('_443._tcp.'+host,'TLSA')]:
 q=dns.message.make_query(name,kind);q.flags|=dns.flags.AD|dns.flags.RD;q.use_edns(edns=0,ednsflags=0,payload=4096)
 try:
  r=dns.query.udp(q,addr,port=int(port),timeout=3)
  out.append({'time':time.time(),'question':[name,kind],'request_flags':dns.flags.to_text(q.flags),'request_DO':False,'rcode':dns.rcode.to_text(r.rcode()),'AD':bool(r.flags&dns.flags.AD),'CD':bool(r.flags&dns.flags.CD),'answer':[str(rr) for rr in r.answer],'authority':[str(rr) for rr in r.authority],'query_hex':q.to_wire().hex(),'response_hex':r.to_wire().hex()})
 except Exception as e:out.append({'question':[name,kind],'error':str(e)})
(p/(label+'-wire.json')).write_text(json.dumps({'helper':found[0],'after_navigation':True,'results':out},indent=2)+'\n')
assert not any('error' in r for r in out),out
