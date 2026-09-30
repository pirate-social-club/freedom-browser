import os,subprocess,time,json,signal,threading,shutil,sys
from pathlib import Path
source=Path(__file__).parent;start=float(os.environ['FREEDOM_START_MONOTONIC']);epoch=float(os.environ['FREEDOM_START_EPOCH']);deadline=epoch+600
p=Path(os.environ['FREEDOM_PRIVATE_ROOT'])/'work'
p.mkdir(parents=True,mode=0o700);os.chmod(p,0o700)
for f in source.iterdir():
 if f.is_file():shutil.copy2(f,p/f.name)
token=os.environ['FREEDOM_RUN_TOKEN'];assert __import__('re').fullmatch('[a-z0-9-]{1,40}',token)
for f in p.glob('*.py'):
 s=f.read_text()
 for role in ['DNSSEC','DANE','FINAL']:s=s.replace('PLACEHOLDER_'+role,'freedom-'+role.lower()+'-'+token+'.8s28')
 f.write_text(s)
(p/'agent-browser-empty-config.json').write_text('{}\n')
prior={'start_epoch':epoch,'deadline_epoch':deadline}
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
expected='0::/system.slice/'+os.environ['FREEDOM_SYSTEMD_UNIT']
assert next(s for s in Path('/proc/self/cgroup').read_text().splitlines() if s.startswith('0::'))==expected,'wrong dedicated system cgroup'
hostns=Path('/proc/self/ns/net').readlink().as_posix()
(p/'timing.json').write_text(json.dumps({'start_epoch':prior['start_epoch'],'resume_epoch':time.time(),'deadline_epoch':deadline,'host_netns':hostns,'host_mountns':Path('/proc/self/ns/mnt').readlink().as_posix(),'affinity':list(os.sched_getaffinity(0))},indent=2))
cgroup=Path('/sys/fs/cgroup')/expected.split('::',1)[1].lstrip('/')
preflight={name:(cgroup/name).read_text().strip() for name in ['cpu.max','memory.max','memory.swap.max']}
cpuset_owner=next(parent for parent in [cgroup,*cgroup.parents] if (parent/'cpuset.cpus.effective').exists())
preflight['inherited_cpuset_owner']=str(cpuset_owner)
preflight['inherited_cpuset_effective']=(cpuset_owner/'cpuset.cpus.effective').read_text().strip()
preflight['process_affinity']=sorted(os.sched_getaffinity(0))
preflight['configured_allowed_cpus']=subprocess.check_output(['systemctl','show',os.environ['FREEDOM_SYSTEMD_UNIT'],'-p','AllowedCPUs','--value'],text=True).strip()
assert preflight['configured_allowed_cpus']=='0','unit CPU0 configuration missing'
assert preflight['inherited_cpuset_effective'] and set(os.sched_getaffinity(0))=={0},'CPU0 affinity not enforced'
(p/'resource-preflight.json').write_text(json.dumps(preflight,indent=2)+'\n')
quota,period=preflight['cpu.max'].split()
assert quota!='max' and int(quota)<=int(period),'CPU quota exceeds one CPU'
assert preflight['memory.max']!='max' and int(preflight['memory.max'])<=2147483648,'memory cap exceeds 2 GiB'
assert preflight['memory.swap.max']=='0','swap not disabled'
assert set(os.sched_getaffinity(0))=={0},'CPU 0 affinity not enforced'
assert os.getpriority(os.PRIO_PROCESS,0)==19,'idle priority not enforced'
owned={};stop=threading.Event();errors=[]
def processes():
 procs={}
 for entry in Path('/proc').iterdir():
  if entry.name.isdigit():
   try:
    f=(entry/'stat').read_text().rsplit(')',1)[1].split();procs[int(entry.name)]=(int(f[1]),f[19],f[0])
   except (OSError,ValueError):pass
 return procs
def monitor():
 while not stop.is_set():
  procs=processes()
  for _ in range(10):
   for pid,(parent,born,state) in procs.items():
    if parent==os.getpid() or parent in owned:owned[pid]=born
  for pid,born in list(owned.items()):
   if pid not in procs or procs[pid][1]!=born:continue
   try:actual=next(s for s in (Path('/proc')/str(pid)/'cgroup').read_text().splitlines() if s.startswith('0::'))
   except OSError:continue
   if actual!=expected:errors.append('cgroup migration '+str(pid));stop.set()
   try:
    if set(os.sched_getaffinity(pid))!={0}:errors.append('CPU affinity broadened '+str(pid));stop.set()
   except ProcessLookupError:pass
  if time.monotonic()>start+585:errors.append('deadline reached');stop.set()
  time.sleep(.1)
thread=threading.Thread(target=monitor,daemon=True);thread.start()
try:
 prep_log=(p/'preparation.log').open('wb');prep=subprocess.Popen(['python3',str(p/'prepare-runtime.py')],stdout=prep_log,stderr=subprocess.STDOUT)
 while prep.poll() is None and not stop.is_set():time.sleep(.1)
 assert prep.poll()==0,'candidate preparation failed or deadline reached'
 log=(p/'namespace-controller.log').open('wb');ns=subprocess.Popen(['unshare','--user','--map-root-user','--net','--mount','python3',str(p/'namespace-controller.py')],stdout=log,stderr=subprocess.STDOUT)
 while not (p/'namespace-pid').exists() and ns.poll() is None and not stop.is_set():time.sleep(.1)
 assert ns.poll() is None,'namespace startup failed'
 pid=int((p/'namespace-pid').read_text());r,w=os.pipe()
 slog=(p/'slirp.log').open('wb');slirp=subprocess.Popen(['slirp4netns','--configure','--disable-host-loopback','--ready-fd='+str(w),'--userns-path=/proc/'+str(pid)+'/ns/user',str(pid),'tap0'],pass_fds=[w],stdout=slog,stderr=subprocess.STDOUT);os.close(w)
 import select
 assert select.select([r],[],[],10)[0],'slirp readiness timeout';assert os.read(r,1), 'slirp failed';os.close(r);(p/'network.ready').write_text('ready')
 while ns.poll() is None and not stop.is_set():time.sleep(.1)
 assert ns.poll()==0,'namespace driver failed or deadline reached'
 assert json.loads((p/'acceptance-summary.json').read_text())['passed'],'acceptance summary did not pass'
except BaseException as e:errors.append(str(e));(p/'supervisor-failure.txt').write_text(str(e))
finally:
 (p/'stop.request').write_text('stop');time.sleep(2)
 procs=processes()
 for sig in [signal.SIGTERM,signal.SIGKILL]:
  for pid,born in list(owned.items()):
   if pid in procs and procs[pid][1]==born:
    try:os.kill(pid,sig)
    except ProcessLookupError:pass
  time.sleep(1);procs=processes()
 stop.set();thread.join(timeout=1)
 alive=[pid for pid,born in owned.items() if pid in procs and procs[pid][1]==born and procs[pid][2]!='Z']
 (p/'containment.json').write_text(json.dumps({'expected_cgroup':expected,'tracked_pids':sorted(owned),'remaining_pids':alive,'all_tracked_stopped':not alive,'errors':errors,'elapsed_seconds':time.monotonic()-start},indent=2))

# Resource files are sampled before the transient unit is collected.
cgroup=Path('/sys/fs/cgroup')/expected.split('::',1)[1].lstrip('/')
resource={}
for name in ['cpu.max','cpuset.cpus.effective','memory.max','memory.swap.max','memory.peak','memory.swap.peak','memory.events']:
 try:resource[name]=(cgroup/name).read_text().strip()
 except OSError:
  resource[name]=None;errors.append('required resource receipt missing '+name)
try:
 assert all(value is not None and value!='' for value in resource.values()),'missing final resource values'
 quota,period=resource['cpu.max'].split()
 assert quota!='max' and int(quota)>0 and int(period)>0 and int(quota)<=int(period),'invalid CPU cap'
 assert resource['memory.max']!='max' and 0<int(resource['memory.max'])<=2147483648,'invalid memory cap'
 assert resource['memory.swap.max']=='0' and int(resource['memory.swap.peak'])==0,'swap used or enabled'
 assert int(resource['memory.peak'])>=0,'memory peak unavailable'
 events=dict(line.split() for line in resource['memory.events'].splitlines())
 assert int(events['oom'])==0 and int(events['oom_kill'])==0,'OOM recorded'
except (AssertionError,ValueError,TypeError,KeyError,AttributeError) as error:errors.append('final resource proof failed '+str(error))
(p/'resources.json').write_text(json.dumps(resource,indent=2)+'\n')
# Persist resource-proof failures in the containment result as well as the exit status.
containment=json.loads((p/'containment.json').read_text());containment['errors']=errors;(p/'containment.json').write_text(json.dumps(containment,indent=2)+'\n')
if errors or alive or time.monotonic()-start>600 or not (p/'acceptance-summary.json').exists():sys.exit(1)
