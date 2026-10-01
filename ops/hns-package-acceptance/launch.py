import os,sys,json,time,hashlib,subprocess,secrets,shutil,re
from pathlib import Path
base=Path(__file__).parent;start=time.monotonic();epoch=time.time();deadline=start+600
repo=Path(os.environ['FREEDOM_REPOSITORY']).resolve();sha=os.environ['FREEDOM_SOURCE_SHA'];assert re.fullmatch('[0-9a-f]{40}',sha)
assert os.geteuid()==0,'system service launcher requires hosted sudo'
manifest=json.loads((base/'manifest.json').read_text())
for name,digest in manifest.items():assert hashlib.sha256((base/name).read_bytes()).hexdigest()==digest,'harness input changed '+name
assert subprocess.check_output(['git','-c','safe.directory='+str(repo),'-C',str(repo),'rev-parse','HEAD'],text=True,timeout=5).strip()==sha
assert not subprocess.check_output(['git','-c','safe.directory='+str(repo),'-C',str(repo),'diff','--name-only'],text=True,timeout=5).strip()
assert not subprocess.check_output(['git','-c','safe.directory='+str(repo),'-C',str(repo),'diff','--cached','--name-only'],text=True,timeout=5).strip()
assert {0}<=os.sched_getaffinity(0),'CPU0 not available'
token=str(int(epoch))+'-'+secrets.token_hex(4);unit='freedom-package-'+token+'.service';cg=Path('/sys/fs/cgroup/system.slice')/unit
root=Path(os.environ['FREEDOM_HOSTED_PRIVATE']).resolve();assert root.is_dir() and not (root/'work').exists(),'private root not fresh'
os.chown(root,0,0);root.chmod(0o700);result=Path(os.environ['FREEDOM_HOSTED_PUBLIC']).resolve();result.mkdir(parents=True,exist_ok=True)
venv=Path(os.environ['FREEDOM_PYTHON_PREFIX']).resolve();tools=Path(os.environ['FREEDOM_BROWSER_PREFIX']).resolve()
# Safe scalar environment file; no GITHUB_TOKEN, repository secret, HOME override or inherited desktop bus.
env={'FREEDOM_HARNESS_BASE':str(base),'FREEDOM_REPOSITORY':str(repo),'FREEDOM_SOURCE_SHA':sha,'FREEDOM_SYSTEMD_UNIT':unit,'FREEDOM_PRIVATE_ROOT':str(root),'FREEDOM_START_EPOCH':str(epoch),'FREEDOM_START_MONOTONIC':str(start),'FREEDOM_RUN_TOKEN':token,'PATH':str(venv/'bin')+':'+str(tools/'node_modules/.bin')+':'+os.environ['PATH'],'TMPDIR':str(root/'tmp'),'PYTHONUNBUFFERED':'1','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'safe.directory','GIT_CONFIG_VALUE_0':str(repo),'AGENT_BROWSER_IDLE_TIMEOUT_MS':'30000'}
(root/'tmp').mkdir(mode=0o700)
assert all('\n' not in v and '\r' not in v and '\x00' not in v for v in env.values())
def quote(v):return '"'+v.replace('\\','\\\\').replace('"','\\"')+'"'
ef=root/'service.env';ef.write_text(''.join(k+'='+quote(v)+'\n' for k,v in env.items()));ef.chmod(0o600)
errors=[];run_result=None;status={};stop_result=None
try:
 with (root/'systemd-launch.log').open('wb') as log:
  run_result=subprocess.run(['systemd-run','--unit='+unit,'--wait','--pipe','--collect','--property=Slice=system.slice','--property=CPUQuota=100%','--property=AllowedCPUs=0','--property=CPUAffinity=0','--property=MemoryMax=2147483648','--property=MemorySwapMax=0','--property=Nice=19','--property=RuntimeMaxSec=585','--property=TimeoutStopSec=5','--property=KillMode=control-group','--property=EnvironmentFile='+str(ef),str(venv/'bin/python3'),str(base/'harness/supervise.py')],stdout=log,stderr=subprocess.STDOUT,timeout=max(1,deadline-time.monotonic()-9))
except BaseException as e:errors.append('launch '+type(e).__name__)
finally:
 try:stop_result=subprocess.run(['systemctl','stop',unit],capture_output=True,text=True,timeout=max(.1,min(5,deadline-time.monotonic()-3)))
 except BaseException as e:errors.append('stop '+type(e).__name__)
 if stop_result is not None and stop_result.returncode not in [0,5]:errors.append('stop exit '+str(stop_result.returncode))
 try:
  shown=subprocess.run(['systemctl','show',unit,'-p','LoadState','-p','ActiveState','-p','SubState','-p','MainPID','-p','ControlPID','-p','ControlGroup','-p','Result','-p','ExecMainStatus'],capture_output=True,text=True,timeout=max(.1,min(2,deadline-time.monotonic()-1)))
  status=dict(line.split('=',1) for line in shown.stdout.splitlines() if '=' in line)
 except BaseException as e:errors.append('status '+type(e).__name__)
 def receipt_load(name):
  try:
   value=json.loads((root/'work'/name).read_text());assert isinstance(value,dict),'receipt is not an object'
   return value
  except BaseException as error:
   errors.append('required receipt '+name+' '+type(error).__name__);return None
 containment=receipt_load('containment.json')
 acceptance=receipt_load('acceptance-summary.json')
 resources=receipt_load('resources.json')
 resource_proved=False
 try:
  required={'cpu.max','cpuset.cpus.effective','memory.max','memory.swap.max','memory.peak','memory.swap.peak','memory.events'}
  assert resources and required<=set(resources) and all(isinstance(resources[name],str) and resources[name] for name in required),'missing final resource values'
  quota,period=resources['cpu.max'].split()
  assert quota!='max' and 0<int(quota)<=int(period),'invalid final CPU cap'
  assert resources['memory.max']!='max' and 0<int(resources['memory.max'])<=2147483648,'invalid final memory cap'
  assert resources['memory.swap.max']=='0' and int(resources['memory.swap.peak'])==0,'swap enabled or used'
  assert int(resources['memory.peak'])>=0,'missing memory peak'
  events=dict(line.split() for line in resources['memory.events'].splitlines())
  assert int(events['oom'])==0 and int(events['oom_kill'])==0,'OOM recorded'
  assert containment and containment['expected_cgroup']=='0::/system.slice/'+unit,'wrong receipt cgroup'
  resource_proved=True
 except (AssertionError,ValueError,TypeError,KeyError,AttributeError) as error:errors.append('final resource acceptance '+str(error))
 loaded_success=status.get('LoadState')=='loaded' and status.get('Result')=='success' and status.get('ExecMainStatus')=='0'
 reaped=status.get('LoadState')=='not-found' and run_result is not None and run_result.returncode==0
 cleanup=not cg.exists() and status.get('MainPID')=='0' and status.get('ControlPID')=='0' and not status.get('ControlGroup') and status.get('ActiveState')=='inactive' and status.get('SubState')=='dead' and bool(containment and containment.get('all_tracked_stopped') is True and containment.get('remaining_pids')==[])
 passed=not errors and bool(run_result and run_result.returncode==0 and acceptance and acceptance.get('passed') is True and containment and containment.get('errors')==[]) and cleanup and resource_proved and (loaded_success or reaped) and time.monotonic()<=deadline
 receipt={'passed':passed,'source':sha,'unit':unit,'expected_cgroup':str(cg),'actual_cgroup_absent':not cg.exists(),'service_wait_returncode':None if run_result is None else run_result.returncode,'post_completion_stop_returncode':None if stop_result is None else stop_result.returncode,'status':status,'cleanup_proved':cleanup,'final_resource_proof_passed':resource_proved,'elapsed_seconds':time.monotonic()-start,'errors':errors,'hosted_runner_egress':'GitHub hosted Ubuntu; not local Mullvad/VPN acceptance','full_app_restart_tested':False}
 # Public fixture proofs only. No binaries, certificates, private keys, profiles, raw logs or environment file.
 names=['sandbox-eligibility-diagnostic.json','initial-observer-diagnostic.json','browser-lifecycle-diagnostic.json','preparation-progress.json','acceptance-summary.json','candidate-integrity.json','package-manifest.json','source-files.json','profile-seed.json','signature-validity-recheck.json','wrong-pin-proof.json','new-host-responses.json','public-signed-responses.json','fixture-queries.jsonl','wrong-tls-events.jsonl','dnssec-attribution.json','dane-attribution.json','welcome-summary.json','fresh-first-tab.json','fresh-registry-transition.json','warm-renderer-observations.json','warm-renderer-first-tab.json','manual-navigation-home.json','resource-preflight.json','resources.json','containment.json','timing.json','synced-state.json','browser-launch.json']
 work=root/'work'
 removed=False
 try:
  if work.exists():
   for f in work.iterdir():
    if f.is_file() and (f.name in names or re.fullmatch(r'(valid-first|bad-dnssec|wrong-dane|valid-final-community|valid-final-fresh)-(navigation|connections|wire|authenticated-route|failed)\.json',f.name)):
     try:shutil.copy2(f,result/f.name)
     except BaseException as error:errors.append('public receipt copy '+f.name+' '+type(error).__name__)
 except BaseException as error:errors.append('public receipt enumeration '+type(error).__name__)
 finally:
  # Receipt errors never skip safe private-state removal after the service cgroup is gone.
  if not cg.exists():
   try:
    subprocess.run(['rm','-rf','--',str(root)],check=True,timeout=max(.1,min(5,deadline-time.monotonic()-.5)));removed=not root.exists()
   except BaseException as e:errors.append('private-state cleanup '+type(e).__name__)
 receipt['private_state_removed']=removed;receipt['elapsed_seconds']=time.monotonic()-start
 receipt['passed']=passed and removed and not errors and time.monotonic()<=deadline
 passed=receipt['passed']
 (result/'outcome.json').write_text(json.dumps(receipt,indent=2)+'\n')
 (result/'manifest.json').write_text(json.dumps({f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in result.iterdir() if f.is_file() and f.name!='manifest.json'},indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
sys.exit(0 if passed else 1)
