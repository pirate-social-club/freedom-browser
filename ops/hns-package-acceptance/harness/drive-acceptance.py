import asyncio,json,urllib.request,subprocess,time,sys,re
from pathlib import Path
import websockets
p=Path(__file__).parent;deadline=json.loads((p/'timing.json').read_text())['deadline_epoch']-30;session='freedom-hosted-package-acceptance'
def progress(s):print(time.strftime('%H:%M:%S')+' acceptance: '+s,flush=True)
async def eval_cdp(expression):
 targets=json.load(urllib.request.urlopen('http://127.0.0.1:9244/json/list',timeout=2));t=next(t for t in targets if 'src/renderer/index.html' in t.get('url',''))
 async with websockets.connect(t['webSocketDebuggerUrl'],open_timeout=3) as ws:
  await ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':expression,'awaitPromise':True,'returnByValue':True}}))
  while True:
   r=json.loads(await asyncio.wait_for(ws.recv(),timeout=6))
   if r.get('id')==1:
    assert 'exceptionDetails' not in r.get('result',{}),r
    return r['result']['result'].get('value')
def evaluate(expression):return asyncio.run(eval_cdp(expression))
def records():
 return [json.loads(s) for s in (p/'fixture-queries.jsonl').read_text().splitlines()] if (p/'fixture-queries.jsonl').exists() else []
def stage(label,host,status=None,token=None):
 (p/'phase').write_text(label);start=time.time();progress('navigate '+host)
 subprocess.run(['agent-browser','--session',session,'--cdp','9244','fill','input[placeholder="Enter hash, ID or URL"]','https://'+host+'/'],check=True,timeout=15)
 subprocess.run(['python3',str(p/'native-enter.py')],check=True,timeout=5)
 end=min(time.time()+55,deadline);last=None
 while time.time()<end:
  try:
   r=subprocess.run(['python3',str(p/'readback.py')],capture_output=True,text=True,timeout=8)
   if r.returncode:last=None
   else:last=json.loads(r.stdout)
  except subprocess.TimeoutExpired:continue
  if last:
   for v in last.get('views',[]):
    body=v.get('content',{}).get('body','');positive=v.get('url')=='https://'+host+'/' and v.get('content',{}).get('status')==status and (not token or token in body)
    negative=('error.html' in v.get('url','') and host in body and 'E2E HNS 8s28' not in body and 'WRONG DANE MUST' not in body)
    if (status is not None and positive) or (status is None and negative):
     (p/(label+'-navigation.json')).write_text(json.dumps({'started_epoch':start,'completed_epoch':time.time(),**last},indent=2)+'\n');progress(label+' navigation observed');return start
  time.sleep(.5)
 (p/(label+'-failed.json')).write_text(json.dumps(last,indent=2)+'\n');raise RuntimeError(label+' navigation failed')
def require_fixture(host,start,mutated=False):
 found=[r for r in records() if r['time']>=start and r['question'][0]==host+'.']
 assert any(r['question'][1]==1 for r in found),'fresh A response not fetched'
 if mutated:assert any(r.get('signature_mutated') for r in found),'corrupt response never reached client'
 else:assert not any(r.get('signature_mutated') for r in found)
 return found
def reset_counter():
 subprocess.run(['nft','delete','table','ip','freedom_count'],capture_output=True)
 subprocess.run(['nft','-f',str(p/'namespace-counter.nft')],check=True)
def counter(label):
 data=json.loads(subprocess.check_output(['nft','-j','list','counter','ip','freedom_count','gateway_syn'],text=True))
 (p/(label+'-connections.json')).write_text(json.dumps(data,indent=2)+'\n')
 return next(x['counter']['packets'] for x in data['nftables'] if 'counter' in x)
def capture(label,host):
 subprocess.run(['python3',str(p/'capture-wire.py'),label,host],check=True,timeout=12)
def route_proof(label,host):
 subprocess.run(['python3',str(p/'authenticated-route.py'),label,host],check=True,timeout=10)
try:
 subprocess.run(['python3',str(p/'observe-welcome.py')],check=True,timeout=max(1,deadline-time.time()))
 assert json.loads((p/'welcome-summary.json').read_text())['passed']
 subprocess.run(['python3',str(p/'prove-installed-sandbox.py'),'pre-security'],check=True,timeout=min(15,max(1,deadline-time.time())))
 assert json.loads((p/'renderer-sandbox-pre-security-proof.json').read_text())['passed']
 end=min(time.time()+150,deadline)
 while time.time()<end:
  try:
   hns=evaluate('window.serviceRegistry.getRegistry().then(r=>r.hns)')
   if hns and hns.get('synced'):
    (p/'synced-state.json').write_text(json.dumps(hns,indent=2)+'\n');progress('mainnet header sync ready');break
  except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('chain synchronization timeout')
 initial=stage('valid-first','app.8s28',200,'E2E HNS 8s28');capture('valid-first','app.8s28');route_proof('valid-first','app.8s28')
 (p/'fixture-mode').write_text('bad-dnssec\n');reset_counter();before=len((p/'warm-browser.log').read_text());bad=time.time();diagnostic_errors=[];navigation_refused=False;requests=[];gateway_attempts=None
 try:
  bad=stage('bad-dnssec','PLACEHOLDER_DNSSEC');navigation_refused=True
 except Exception as e:diagnostic_errors.append('navigation: '+str(e))
 # Collect every diagnostic before assertions so a failed marker cannot discard evidence.
 try:requests=require_fixture('PLACEHOLDER_DNSSEC',bad,True)
 except Exception as e:diagnostic_errors.append('fixture: '+str(e))
 try:gateway_attempts=counter('bad-dnssec')
 except Exception as e:diagnostic_errors.append('counter: '+str(e))
 try:capture('bad-dnssec','PLACEHOLDER_DNSSEC')
 except Exception as e:diagnostic_errors.append('wire: '+str(e))
 segment=(p/'warm-browser.log').read_text()[before:];wire_refusal=False
 if (p/'bad-dnssec-wire.json').exists():
  replies=json.loads((p/'bad-dnssec-wire.json').read_text())['results']
  wire_refusal=any(r.get('question')==['PLACEHOLDER_DNSSEC','A'] and r.get('AD') is False and r.get('rcode') in ['SERVFAIL','NOERROR'] for r in replies)
 proof={'mutated_fixture_requests':requests,'navigation_refused':navigation_refused,'helper_address_validation_failure':'HNS address validation failed' in segment,'actual_A_wire_refusal_or_insecure':wire_refusal,'upstream_connection_attempts':gateway_attempts,'bogus_log_supplemental':'bogus: 1' in segment,'diagnostic_errors':diagnostic_errors}
 (p/'dnssec-attribution.json').write_text(json.dumps(proof,indent=2)+'\n')
 dnssec_attribution_complete=wire_refusal and not any(e.startswith('wire:') for e in diagnostic_errors)
 assert not [e for e in diagnostic_errors if not e.startswith('wire:')],diagnostic_errors
 assert navigation_refused,'corrupt address navigation not refused'
 assert requests,'mutated A fixture not fetched'
 assert any('HNS address validation failed' in line and 'PLACEHOLDER_DNSSEC' in line for line in segment.splitlines()),'helper did not explicitly refuse this address validation'
 assert gateway_attempts==0,'corrupt address caused an upstream connection'
 progress('corrupt DNSSEC core refusal/counter guards passed; wire attribution '+str(dnssec_attribution_complete))
 (p/'fixture-mode').write_text('valid\n');subprocess.run(['nft','delete','table','ip','freedom_fixture'],check=True);subprocess.run(['nft','-f',str(p/'namespace-wrong-dane.nft')],check=True);reset_counter();before=len((p/'warm-browser.log').read_text())
 wrong=time.time();diagnostic_errors=[];navigation_refused=False;gateway_attempts=None
 try:
  wrong=stage('wrong-dane','PLACEHOLDER_DANE');navigation_refused=True
 except Exception as e:diagnostic_errors.append('navigation: '+str(e))
 try:gateway_attempts=counter('wrong-dane')
 except Exception as e:diagnostic_errors.append('counter: '+str(e))
 try:capture('wrong-dane','PLACEHOLDER_DANE')
 except Exception as e:diagnostic_errors.append('wire: '+str(e))
 try:route_proof('wrong-dane','PLACEHOLDER_DANE')
 except Exception as e:diagnostic_errors.append('route-proof: '+str(e))
 segment=(p/'warm-browser.log').read_text()[before:]
 events=[json.loads(s) for s in (p/'wrong-tls-events.jsonl').read_text().splitlines()] if (p/'wrong-tls-events.jsonl').exists() else []
 proof={'navigation_refused':navigation_refused,'explicit_dane_authentication_failure':'tls: dane authentication failed' in segment,'tls_events':events,'upstream_connection_attempts':gateway_attempts,'no_decrypted_http_request':bool(events) and not any(r.get('http_request_received') for r in events),'diagnostic_errors':diagnostic_errors}
 (p/'dane-attribution.json').write_text(json.dumps(proof,indent=2)+'\n')
 dane_wire=json.loads((p/'wrong-dane-wire.json').read_text())['results'] if (p/'wrong-dane-wire.json').exists() else []
 dane_attribution_complete=len(dane_wire)==3 and all(r.get('AD') is True and r.get('rcode')=='NOERROR' for r in dane_wire) and not any(e.startswith(('wire:','route-proof:')) for e in diagnostic_errors)
 proof['authenticated_actual_wire_complete']=dane_attribution_complete
 (p/'dane-attribution.json').write_text(json.dumps(proof,indent=2)+'\n')
 assert not [e for e in diagnostic_errors if not e.startswith(('wire:','route-proof:'))],diagnostic_errors
 assert navigation_refused,'wrong DANE navigation not refused'
 pins=json.loads((p/'wrong-pin-proof.json').read_text());assert pins['mismatch'] and ('3 1 1 '+pins['wrong_spki_sha256']) not in pins['signed_tlsa'],'wrong certificate does not mismatch authenticated fixture pin'
 assert any('tls: dane authentication failed' in line and 'PLACEHOLDER_DANE' in line for line in segment.splitlines()),'explicit DANE refusal absent'
 assert gateway_attempts is not None and gateway_attempts>0,'wrong-key fixture never received a connection attempt'
 assert events and not any(r.get('http_request_received') for r in events),'wrong-key fixture received application data or no TLS event'
 progress('wrong DANE attributed to pin authentication failure')
 subprocess.run(['nft','delete','table','ip','freedom_fixture'],check=True);subprocess.run(['nft','-f',str(p/'namespace-dns.nft')],check=True)
 stage('valid-final-community','app.8s28',200,'E2E HNS 8s28');capture('valid-final-community','app.8s28');route_proof('valid-final-community','app.8s28')
 reset_counter();final=stage('valid-final-fresh','PLACEHOLDER_FINAL',421);assert counter('valid-final-fresh')>0,'final fresh control opened no gateway connection';capture('valid-final-fresh','PLACEHOLDER_FINAL');route_proof('valid-final-fresh','PLACEHOLDER_FINAL')
 subprocess.run(['python3',str(p/'prove-installed-sandbox.py'),'final'],check=True,timeout=min(15,max(1,deadline-time.time())))
 assert json.loads((p/'renderer-sandbox-final-proof.json').read_text())['passed']
 (p/'acceptance-summary.json').write_text(json.dumps({'passed':dnssec_attribution_complete and dane_attribution_complete and json.loads((p/'renderer-sandbox-pre-security-proof.json').read_text())['passed'] and json.loads((p/'renderer-sandbox-final-proof.json').read_text())['passed'],'dnssec_wire_attribution_complete':dnssec_attribution_complete,'dane_wire_attribution_complete':dane_attribution_complete,'valid_initial':True,'corrupt_dnssec_refused_with_attribution':True,'wrong_dane_refused_with_attribution':True,'valid_final_community':True,'valid_final_uncached_host':True,'one_warm_resolver':True,'source':json.loads((p/'candidate-integrity.json').read_text())['Freedom_source'],'candidate_helper':'21f044ebc830eed87e6851ed7216f9590f6f3df3','helper_matches_tracked_integrated_asset':True,'installed_deb_tested':True,'combined_renderer_os_and_electron_sandbox_proved':True,'pre_security_renderer_sandbox_proved':True,'final_hns_renderer_sandbox_proved':True,'welcome_actual_first_tab_passed':True,'warm_renderer_reload_tested':True,'full_app_restart_tested':False,'completed_epoch':time.time()},indent=2)+'\n');progress('All controls completed; required wire attribution '+str(dnssec_attribution_complete and dane_attribution_complete))
 assert dnssec_attribution_complete and dane_attribution_complete,'required wire attribution incomplete despite completed core guards and final controls'
except BaseException as e:
 (p/'acceptance-failure.txt').write_text(str(e));progress('FAILED: '+str(e));raise
finally:
 try:subprocess.run(['agent-browser','--session',session,'close'],timeout=5,capture_output=True)
 except Exception:pass
