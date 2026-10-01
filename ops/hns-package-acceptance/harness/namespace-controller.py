import os,json,subprocess,time,signal
from pathlib import Path
p=Path(__file__).parent;end=json.loads((p/'timing.json').read_text())['deadline_epoch']-30
assert Path('/proc/self/ns/net').readlink().as_posix()!=json.loads((p/'timing.json').read_text())['host_netns']
assert Path('/proc/self/ns/mnt').readlink().as_posix()!=json.loads((p/'timing.json').read_text())['host_mountns']
subprocess.run(['mount','--make-rprivate','/'],check=True)
(p/'namespace-tmp').mkdir(mode=0o700)
subprocess.run(['mount','--bind',str(p/'namespace-tmp'),'/tmp'],check=True)
assert Path('/tmp').stat().st_ino==(p/'namespace-tmp').stat().st_ino,'private display temporary directory not mounted'
subprocess.run(['ip','link','set','lo','up'],check=True)
(p/'namespace-pid').write_text(str(os.getpid()))
while not (p/'network.ready').exists() and time.time()<end:time.sleep(.1)
assert (p/'network.ready').exists(),'slirp never ready'
subprocess.run(['nft','-f',str(p/'namespace-dns.nft')],check=True)
servers=[subprocess.Popen(['python3',str(p/n)]) for n in ['dns-copy.py','wrong-tls.py','os-dns.py']]
env={**os.environ,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+str(p/'no-session-bus'),'DISPLAY':':77','AGENT_BROWSER_IDLE_TIMEOUT_MS':'30000','AGENT_BROWSER_CONFIG':str(p/'agent-browser-empty-config.json'),'AGENT_BROWSER_SOCKET_DIR':str(p/'agent-browser-sockets'),'XDG_CONFIG_HOME':str(p/'xdg-config'),'XDG_CACHE_HOME':str(p/'xdg-cache'),'XDG_DATA_HOME':str(p/'xdg-data')}
(p/'agent-browser-sockets').mkdir(mode=0o700)
owned={};browser=None;log=None;lifecycle={}
def scan():
 procs={}
 for entry in Path('/proc').iterdir():
  if entry.name.isdigit():
   try:
    f=(entry/'stat').read_text().rsplit(')',1)[1].split();procs[int(entry.name)]=(int(f[1]),f[19])
   except (OSError,ValueError):pass
 if browser and browser.pid in procs:owned[browser.pid]=procs[browser.pid][1]
 for _ in range(10):
  for pid,(parent,born) in procs.items():
   if parent in owned:owned[pid]=born
 return procs
def browser_markers():
 try:
  with (p/'warm-browser.log').open('rb') as private_log:
   private_log.seek(0,os.SEEK_END);size=private_log.tell();private_log.seek(max(0,size-16384));tail=private_log.read(16384)
 except OSError:return ['log_unavailable']
 markers=[]
 for code,needles in [('root_refusal_marker',[b'Running as root without --no-sandbox is not supported']),('no_usable_sandbox_marker',[b'No usable sandbox!']),('failed_move_namespace_marker',[b'Failed to move to new namespace:']),('gpu_fatal_marker',[b'GPU process isn',b'FATAL:gpu_data_manager']),('display_marker',[b'Missing X server or $DISPLAY',b'cannot open display']),('module_missing_marker',[b'MODULE_NOT_FOUND',b'ERR_MODULE_NOT_FOUND']),('library_marker',[b'error while loading shared libraries:']),('permission_marker',[b'Permission denied',b'Operation not permitted']),('devtools_listening_marker',[b'DevTools listening on ws://'])]:
  if any(needle in tail for needle in needles):markers.append(code)
 for line in tail.splitlines():
  if b'Failed to move to new namespace:' in line and len(line)<=512:
   for needle,code in [(b'errno = Operation not permitted', 'sandbox_errno_permission_denied'),(b'errno = Permission denied', 'sandbox_errno_access_denied'),(b'errno = Invalid argument', 'sandbox_errno_unsupported'),(b'errno = No space left on device', 'sandbox_errno_namespace_limit'),(b'errno = Too many users', 'sandbox_errno_nesting_limit')]:
    if needle in line:markers.append(code)
 return sorted(set(markers)) or ['unclassified']
def browser_diagnostic(stage):
 assert stage in ['browser_launched','driver_running','driver_finished','before_browser_cleanup','after_browser_cleanup'],'invalid browser diagnostic stage'
 code=browser.poll() if browser is not None else None
 record={'stage':stage,'epoch':time.time(),'browser_started':browser is not None,'browser_alive':browser is not None and code is None,'browser_returncode':code,'driver_returncode':driver.poll() if 'driver' in globals() else None,'private_log_markers':browser_markers()}
 lifecycle[stage]=record
 (p/'browser-lifecycle-diagnostic.json').write_text(json.dumps({'snapshots':lifecycle},indent=2)+'\n')
def eligibility_diagnostic():
 # This executable can have a different AppArmor policy from Electron.
 budget=min(10,end-time.time()-2)
 assert budget>0,'no time for sandbox diagnostic'
 proc=subprocess.Popen(['unshare','--user','--map-user=1000','--map-group=1000','/usr/bin/python3',str(p/'probe-sandbox-eligibility.py')],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 value={'schema':1,'probe_receipt_valid':False,'failure':'unknown'}
 try:
  raw,_=proc.communicate(timeout=budget)
  if proc.returncode==0 and len(raw)<=2048:
   try:
    candidate=json.loads(raw)
    facts=candidate['kernel_facts'];result=candidate['eligibility']
    fact_keys={'unprivileged_userns_clone','apparmor_restrict_unprivileged_userns','max_user_namespaces','apparmor_label_class'}
    categories={'permission_denied','access_denied','unsupported','namespace_limit','nesting_limit','other_errno','none'}
    stages={'identity','clone_user','deny_setgroups','gid_map','uid_map','drop_capabilities','verify_capabilities','second_user','done','timeout','unknown'}
    valid=type(candidate) is dict and set(candidate)=={'schema','kernel_facts','eligibility'} and type(candidate['schema']) is int and candidate['schema']==1 and type(facts) is dict and set(facts)==fact_keys and all(facts[k] is None or (type(facts[k]) is int and 0<=facts[k]<=9999999999) for k in fact_keys-{'apparmor_label_class'}) and facts['apparmor_label_class'] in {'unconfined','confined_or_other','unavailable'} and type(result) is dict and set(result)=={'passed','stage','errno_category'} and type(result['passed']) is bool and result['stage'] in stages and result['errno_category'] in categories and (not result['passed'] or (result['stage']=='done' and result['errno_category']=='none'))
    if valid:value={**candidate,'probe_receipt_valid':True}
   except (ValueError,TypeError,KeyError):pass
 except subprocess.TimeoutExpired:
  value['failure']='timeout'
 finally:
  if proc.poll() is None:
   try:os.killpg(proc.pid,signal.SIGKILL)
   except ProcessLookupError:pass
  proc.wait(timeout=2)
 (p/'sandbox-eligibility-diagnostic.json').write_text(json.dumps(value,indent=2)+'\n')
def kill_browser():
 procs=scan()
 for sig in [signal.SIGTERM,signal.SIGKILL]:
  for pid,born in list(owned.items()):
   if pid in procs and procs[pid][1]==born:
    try:os.kill(pid,sig)
    except ProcessLookupError:pass
  time.sleep(1);procs=scan()
 if browser:
  try:browser.wait(timeout=2)
  except subprocess.TimeoutExpired:pass
 if log:log.close()
 owned.clear()
try:
 assert not Path('/tmp/.X11-unix/X77').exists(),'unexpected existing display socket'
 display=subprocess.Popen(['Xvfb',':77','-screen','0','1280x900x24','-nolisten','tcp','-ac'],stdout=(p/'display.log').open('wb'),stderr=subprocess.STDOUT)
 display_end=min(time.time()+5,end)
 while not Path('/tmp/.X11-unix/X77').exists() and time.time()<display_end and display.poll() is None:time.sleep(.1)
 assert display.poll() is None and Path('/tmp/.X11-unix/X77').exists(),'owned Xvfb not ready'
 time.sleep(.3)
 eligibility_diagnostic()
 log=(p/'warm-browser.log').open('wb')
 browser=subprocess.Popen(['unshare','--user','--map-user=1000','--map-group=1000',str(p/'package/freedom'),'--disable-setuid-sandbox','--remote-debugging-port=9244','--user-data-dir='+str(p/'profile-candidate')],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 (p/'browser-launch.json').write_text(json.dumps({'pid':browser.pid,'epoch':time.time(),'network_namespace':Path('/proc/self/ns/net').readlink().as_posix()}))
 browser_diagnostic('browser_launched')
 driver=subprocess.Popen(['python3',str(p/'drive-acceptance.py')],env=env,stdout=log,stderr=subprocess.STDOUT)
 next_diagnostic=0
 while time.time()<end and driver.poll() is None:
  if time.time()>=next_diagnostic:browser_diagnostic('driver_running');next_diagnostic=time.time()+1
  scan();time.sleep(.1)
 if driver.poll() is None:driver.terminate();driver.wait(timeout=3)
 browser_diagnostic('driver_finished')
 if driver.returncode:raise RuntimeError('acceptance driver exit '+str(driver.returncode))
except BaseException as e:
 (p/'namespace-failure.txt').write_text(str(e));raise
finally:
 # Diagnostic-write failure must never prevent the existing mandatory cleanup.
 try:browser_diagnostic('before_browser_cleanup')
 except Exception:pass
 kill_browser()
 try:browser_diagnostic('after_browser_cleanup')
 except Exception:pass
 if 'display' in locals():servers.append(display)
 for proc in servers:proc.terminate()
 for proc in servers:
  try:proc.wait(timeout=2)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
