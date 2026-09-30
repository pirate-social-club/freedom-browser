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
owned={};browser=None;log=None
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
 log=(p/'warm-browser.log').open('wb')
 browser=subprocess.Popen(['unshare','--user','--map-user=1000','--map-group=1000',str(p/'package/freedom'),'--disable-setuid-sandbox','--remote-debugging-port=9244','--user-data-dir='+str(p/'profile-candidate')],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 (p/'browser-launch.json').write_text(json.dumps({'pid':browser.pid,'epoch':time.time(),'network_namespace':Path('/proc/self/ns/net').readlink().as_posix()}))
 driver=subprocess.Popen(['python3',str(p/'drive-acceptance.py')],env=env,stdout=log,stderr=subprocess.STDOUT)
 while time.time()<end and driver.poll() is None:
  scan();time.sleep(.1)
 if driver.poll() is None:driver.terminate();driver.wait(timeout=3)
 if driver.returncode:raise RuntimeError('acceptance driver exit '+str(driver.returncode))
except BaseException as e:
 (p/'namespace-failure.txt').write_text(str(e));raise
finally:
 kill_browser()
 if 'display' in locals():servers.append(display)
 for proc in servers:proc.terminate()
 for proc in servers:
  try:proc.wait(timeout=2)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
