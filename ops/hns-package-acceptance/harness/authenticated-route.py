import json,sys
from pathlib import Path
import dns.message,dns.rdatatype
p=Path(__file__).parent;label,host=sys.argv[1:];corpus=json.loads((p/'public-signed-responses.json').read_text());wire=json.loads((p/(label+'-wire.json')).read_text());checks=[];errors=[]
for name,kind in [(host,'A'),(host,'AAAA'),('_443._tcp.'+host,'TLSA')]:
 expected_row=next((r for r in corpus if r['name']==name+'.' and r['type']==kind),None)
 actual_row=next((r for r in wire['results'] if r['question']==[name,kind]),None)
 if expected_row is None or actual_row is None or 'response_hex' not in actual_row:
  errors.append('missing signed fixture or actual wire '+kind);continue
 expected=dns.message.from_wire(bytes.fromhex(expected_row['response_hex']));actual=dns.message.from_wire(bytes.fromhex(actual_row['response_hex']));rtype=dns.rdatatype.from_text(kind)
 def values(message):return sorted(record.to_text() for group in message.answer if group.rdtype==rtype and str(group.name)==name+'.' for record in group)
 expected_data,actual_data=values(expected),values(actual)
 passed=actual_row.get('AD') is True and actual_row.get('CD') is False and actual_row.get('rcode')=='NOERROR' and expected_data==actual_data
 if kind in ['A','TLSA'] and not expected_data:passed=False
 if kind=='TLSA' and not all(r.startswith('3 1 1 ') for r in expected_data):passed=False
 checks.append({'name':name,'type':kind,'expected_signature_validated_fixture_RDATA':expected_data,'actual_hnsd_RDATA':actual_data,'authenticated':actual_row.get('AD'),'rcode':actual_row.get('rcode'),'TTL_ignored_for_data_equality':True,'authenticated_empty_family':passed and kind=='AAAA' and not actual_data,'passed':passed})
 if not passed:errors.append('actual authenticated '+kind+' differs from validated fixture')
result={'host':host,'all_three_families_and_pin_proven':len(checks)==3 and not errors,'checks':checks,'errors':errors}
(p/(label+'-authenticated-route.json')).write_text(json.dumps(result,indent=2)+'\n')
if not result['all_three_families_and_pin_proven']:raise SystemExit(1)
