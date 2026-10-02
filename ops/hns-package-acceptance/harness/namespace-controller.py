import os,json,subprocess,time,signal,pwd
from pathlib import Path
p=Path(__file__).parent;end=json.loads((p/'timing.json').read_text())['deadline_epoch']-30
assert Path('/proc/self/ns/net').readlink().as_posix()!=json.loads((p/'timing.json').read_text())['host_netns']
assert Path('/proc/self/ns/mnt').readlink().as_posix()!=json.loads((p/'timing.json').read_text())['host_mountns']
subprocess.run(['mount','--make-rprivate','/'],check=True)
(p/'namespace-tmp').mkdir(mode=0o1777)
os.chmod(p/'namespace-tmp',0o1777)
subprocess.run(['mount','--bind',str(p/'namespace-tmp'),'/tmp'],check=True)
assert Path('/tmp').stat().st_ino==(p/'namespace-tmp').stat().st_ino,'private display temporary directory not mounted'
subprocess.run(['ip','link','set','lo','up'],check=True)
(p/'namespace-pid').write_text(str(os.getpid()))
while not (p/'network.ready').exists() and time.time()<end:time.sleep(.1)
assert (p/'network.ready').exists(),'slirp never ready'
subprocess.run(['nft','-f',str(p/'namespace-dns.nft')],check=True)
servers=[subprocess.Popen(['python3',str(p/n)]) for n in ['dns-copy.py','wrong-tls.py','os-dns.py']]
def browser_socket_preflight(directory):
 assert directory.is_absolute() and directory==p/'ab','socket directory outside private work'
 size=len(os.fsencode(str(directory/'freedom-hosted-package-acceptance.sock')))
 assert size<=103,'automation socket path exceeds pinned CLI limit'
 return {'socket_path_bytes':size,'pinned_cli_limit_bytes':103,'private_directory':True}
env={**os.environ,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+str(p/'no-session-bus'),'DISPLAY':':77','AGENT_BROWSER_IDLE_TIMEOUT_MS':'30000','AGENT_BROWSER_CONFIG':str(p/'agent-browser-empty-config.json'),'AGENT_BROWSER_SOCKET_DIR':str(p/'ab'),'XDG_CONFIG_HOME':str(p/'xdg-config'),'XDG_CACHE_HOME':str(p/'xdg-cache'),'XDG_DATA_HOME':str(p/'xdg-data')}
(p/'ab').mkdir(mode=0o700)
(p/'automation-socket-preflight.json').write_text(json.dumps(browser_socket_preflight(p/'ab'),indent=2)+'\n')
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
 uid=int(os.environ['FREEDOM_BROWSER_UID']);gid=int(os.environ['FREEDOM_BROWSER_GID']);assert uid>0 and gid>0
 assert Path('/proc/self/ns/user').readlink().as_posix()==json.loads((p/'timing.json').read_text())['host_userns'],'runtime outer user namespace forbidden'
 # Only browser-owned state is writable/readable to the ordinary host user.
 for directory in ['profile-candidate','browser-config','browser-cache','browser-data','browser-tmp']:
  target=p/directory;target.mkdir(mode=0o700,exist_ok=True)
  for path in [target,*target.rglob('*')]:
   if path.is_symlink():raise AssertionError('browser state symlink refused')
   os.chown(path,uid,gid)
   path.chmod(0o700 if path.is_dir() else 0o600)
 browser_env={**env,'HOME':pwd.getpwuid(uid).pw_dir,'USER':pwd.getpwuid(uid).pw_name,'LOGNAME':pwd.getpwuid(uid).pw_name,'XDG_CONFIG_HOME':str(p/'browser-config'),'XDG_CACHE_HOME':str(p/'browser-cache'),'XDG_DATA_HOME':str(p/'browser-data'),'TMPDIR':str(p/'browser-tmp')}
 assert (p/'private-test-material').stat().st_uid==0 and (p/'private-test-material').stat().st_mode&0o777==0o700
 log=(p/'warm-browser.log').open('wb')
 browser=subprocess.Popen(['setpriv','--reuid='+str(uid),'--regid='+str(gid),'--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','/opt/Freedom/freedom','--remote-debugging-port=9244','--user-data-dir='+str(p/'profile-candidate')],env=browser_env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 (p/'browser-launch.json').write_text(json.dumps({'pid':browser.pid,'start_ticks':(Path('/proc')/str(browser.pid)/'stat').read_text().rsplit(')',1)[1].split()[19],'epoch':time.time(),'network_namespace':Path('/proc/self/ns/net').readlink().as_posix(),'host_uid':uid,'host_gid':gid,'executable':'/opt/Freedom/freedom'}))
 browser_diagnostic('browser_launched')
 driver=subprocess.Popen(['python3',str(p/'drive-acceptance.py')],env=env,stdout=log,stderr=subprocess.STDOUT)
 next_diagnostic=0
 while time.time()<end and driver.poll() is None:
  if time.time()>=next_diagnostic:browser_diagnostic('driver_running');next_diagnostic=time.time()+1
  scan();time.sleep(.1)
 if driver.poll() is None:driver.terminate();driver.wait(timeout=3)
 browser_diagnostic('driver_finished')
 assert Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text().strip()=='1'
 assert 'freedom (unconfined)' in Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
 assert (Path('/proc')/str(browser.pid)/'attr/current').read_text().strip()=='freedom (unconfined)'
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
