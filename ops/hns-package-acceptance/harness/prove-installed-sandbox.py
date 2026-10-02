"""Read-only combined OS/isolated-context proof for the actual installed application."""
import asyncio,json,os,sys,time,urllib.request
from pathlib import Path
from urllib.parse import urlsplit
import websockets


def valid_renderer(record,main,host,uid):
 return (record['uids']==[uid]*4 and record['cap_eff']==0 and record['no_new_privs']==1
  and record['seccomp']==2 and record['seccomp_filters']>main['seccomp_filters']
  and all(record['namespaces'][kind]!=main['namespaces'][kind]
          and record['namespaces'][kind]!=host[kind] for kind in ['user','pid'])
  and record['named_packaged_profile_attached'] is True and bool(record['uid_map'])
  and all(len(row)==3 and all(type(v) is int and v>=0 for v in row) and row[2]>0 for row in record['uid_map']))


def renderer_checks(record,main,host,uid):
 return {'host_uid_matches':record['uids']==[uid]*4,'capabilities_zero':record['cap_eff']==0,
  'no_new_privs_enabled':record['no_new_privs']==1,'seccomp_filter_mode':record['seccomp']==2,
  'extra_seccomp_filter':record['seccomp_filters']>main['seccomp_filters'],
  'separate_user_namespace':record['namespaces']['user']!=main['namespaces']['user'] and record['namespaces']['user']!=host['user'],
  'separate_pid_namespace':record['namespaces']['pid']!=main['namespaces']['pid'] and record['namespaces']['pid']!=host['pid'],
  'named_profile_attached':record['named_packaged_profile_attached'] is True,
  'uid_map_present':bool(record['uid_map']),
  'uid_map_well_formed':all(len(row)==3 and all(type(v) is int and v>=0 for v in row) and row[2]>0 for row in record['uid_map'])}


def select_renderer_pids(rows,browser_pid):
 assert type(browser_pid) is int and browser_pid>0 and type(rows) is list and 0<len(rows)<=256,'invalid process inventory'
 assert all(type(row) is dict and type(row.get('id')) is int and row['id']>0 and type(row.get('type')) is str for row in rows),'invalid process identity'
 ids=[row['id'] for row in rows];assert len(set(ids))==len(ids),'duplicate process inventory'
 assert [row['id'] for row in rows if row['type']=='browser']==[browser_pid],'different browser inventory'
 renderers=sorted(row['id'] for row in rows if row['type']=='renderer')
 assert renderers and browser_pid not in renderers,'no renderer inventory'
 return {'browser_pid':browser_pid,'renderer_pids':renderers}


def same_cgroup(text,expected):
 return [line for line in text.splitlines() if line.startswith('0::')]==[expected]


async def browser_process_inventory(browser_pid):
 with urllib.request.urlopen('http://127.0.0.1:9244/json/version',timeout=2) as response:version=json.load(response)
 endpoint=version['webSocketDebuggerUrl'];url=urlsplit(endpoint)
 assert url.scheme=='ws' and url.hostname=='127.0.0.1' and url.port==9244 and url.path.startswith('/devtools/browser/') and not url.username and not url.password and not url.query and not url.fragment,'unexpected browser endpoint'
 async with websockets.connect(endpoint,open_timeout=3) as ws:
  await ws.send(json.dumps({'id':1,'method':'SystemInfo.getProcessInfo'}));end=time.monotonic()+3
  while True:
   value=json.loads(await asyncio.wait_for(ws.recv(),timeout=max(.01,end-time.monotonic())))
   if value.get('id')==1:
    assert 'error' not in value,'browser process inventory refused'
    return select_renderer_pids(value['result']['processInfo'],browser_pid)
   assert time.monotonic()<end,'browser process inventory deadline'


def process_record(pid,snapshot=None,expected_cgroup=None):
 if snapshot is None:snapshot={}
 root=Path('/proc')/str(pid);snapshot.update({'pid':pid,'read_stage':'stat'})
 born=root.joinpath('stat').read_text().rsplit(')',1)[1].split()[19];snapshot['start_ticks']=born
 snapshot['read_stage']='status'
 fields=dict(line.split(':',1) for line in root.joinpath('status').read_text().splitlines() if ':' in line)
 record={'pid':pid,'start_ticks':born,'uids':list(map(int,fields['Uid'].split())),
  'cap_eff':int(fields['CapEff'].strip(),16),'no_new_privs':int(fields['NoNewPrivs']),
  'seccomp':int(fields['Seccomp']),'seccomp_filters':int(fields['Seccomp_filters'])}
 snapshot.update(record);record['namespaces']={}
 for kind in ['user','pid']:
  snapshot['read_stage']='namespace_'+kind;record['namespaces'][kind]=root.joinpath('ns',kind).readlink().as_posix()
 snapshot['namespaces']=record['namespaces'];snapshot['read_stage']='profile'
 record['named_packaged_profile_attached']=root.joinpath('attr/current').read_text().strip()=='freedom (unconfined)'
 snapshot.update(record);snapshot['read_stage']='uid_map'
 record['uid_map']=[list(map(int,line.split())) for line in root.joinpath('uid_map').read_text().splitlines()]
 snapshot.update(record)
 if expected_cgroup is not None:
  snapshot['read_stage']='cgroup';snapshot['owned_cgroup_matches']=same_cgroup(root.joinpath('cgroup').read_text(),expected_cgroup)
  assert snapshot['owned_cgroup_matches'],'process outside owned service'
 snapshot['read_stage']='executable'
 snapshot['executable_matches']=root.joinpath('exe').readlink()==Path('/opt/Freedom/freedom')
 assert snapshot['executable_matches'],'unexpected executable'
 snapshot['read_stage']='identity_recheck';snapshot['identity_stable']=root.joinpath('stat').read_text().rsplit(')',1)[1].split()[19]==born
 assert snapshot['identity_stable'],'PID changed during proof'
 snapshot['read_stage']='done'
 return record


async def context_proof():
 with urllib.request.urlopen('http://127.0.0.1:9244/json/list',timeout=2) as response:targets=json.load(response)
 target=next(target for target in targets if 'src/renderer/index.html' in target.get('url',''))
 async with websockets.connect(target['webSocketDebuggerUrl'],open_timeout=3) as ws:
  await ws.send(json.dumps({'id':1,'method':'Runtime.enable'}));contexts=[];enabled=False;limit=time.monotonic()+4
  isolated=[]
  while time.monotonic()<limit:
   value=json.loads(await asyncio.wait_for(ws.recv(),timeout=max(.01,limit-time.monotonic())))
   if value.get('method')=='Runtime.executionContextCreated':contexts.append(value['params']['context'])
   if value.get('id')==1:
    assert 'error' not in value;enabled=True
   isolated=[c for c in contexts if c.get('name')=='Electron Isolated Context' and c.get('auxData',{}).get('isDefault') is False]
   if enabled and isolated:break
  assert enabled and len(isolated)==1,'exact preload isolated context required'
  await ws.send(json.dumps({'id':2,'method':'Runtime.evaluate','params':{'contextId':isolated[0]['id'],'returnByValue':True,'expression':"({sandboxed:process.sandboxed===true,contextIsolated:process.contextIsolated===true,electron:process.versions.electron})"}}))
  while True:
   value=json.loads(await asyncio.wait_for(ws.recv(),timeout=3))
   if value.get('id')==2:
    assert 'error' not in value and 'exceptionDetails' not in value.get('result',{})
    result=value['result']['result']['value'];break
  assert result=={'sandboxed':True,'contextIsolated':True,'electron':'42.10.0'},'Electron isolated context proof refused'
  await ws.send(json.dumps({'id':3,'method':'Runtime.evaluate','params':{'returnByValue':True,'expression':"({nodeGlobalAbsent:typeof process==='undefined' && typeof require==='undefined'})"}}))
  while True:
   value=json.loads(await asyncio.wait_for(ws.recv(),timeout=3))
   if value.get('id')==3:
    assert 'error' not in value and 'exceptionDetails' not in value.get('result',{})
    assert value['result']['result']['value']=={'nodeGlobalAbsent':True};break
 return {**result,'default_world_node_globals_absent':True}


def main():
 assert len(sys.argv)==2 and sys.argv[1] in ['pre-security','final'],'fixed proof phase required'
 phase=sys.argv[1]
 p=Path(__file__).parent;receipt={'passed':False,'scope':'combined_owned_renderer_OS_and_Electron_context','stage':'process_identity','phase':phase}
 try:
  launch=json.loads((p/'browser-launch.json').read_text());timing=json.loads((p/'timing.json').read_text());uid=launch['host_uid']
  expected_cgroup='0::/system.slice/'+os.environ['FREEDOM_SYSTEMD_UNIT']
  assert same_cgroup(Path('/proc/self/cgroup').read_text(),expected_cgroup),'proof outside owned service'
  receipt['main_observation']={}
  main_record=process_record(launch['pid'],receipt['main_observation'],expected_cgroup);assert main_record['start_ticks']==launch['start_ticks'],'main PID reused'
  assert uid>0 and main_record['uids']==[uid]*4 and main_record['cap_eff']==0 and main_record['named_packaged_profile_attached']
  host={'user':timing['host_userns'],'pid':timing['host_pidns']}
  assert main_record['namespaces']==host,'main must use actual host user/PID namespaces'
  receipt['stage']='renderer_discovery';receipt['discovery_method']='browser_SystemInfo_getProcessInfo'
  inventory=asyncio.run(browser_process_inventory(launch['pid']));receipt['inventory_before']=inventory
  receipt['stage']='renderer_OS_state'
  renderers=[];receipt['renderer_candidates']=[]
  for pid in inventory['renderer_pids']:
   receipt['current_process_id']=pid
   born=Path('/proc').joinpath(str(pid),'stat').read_text().rsplit(')',1)[1].split()[19]
   candidate={'pid':pid,'expected_start_ticks':born,'observation':{}};receipt['renderer_candidates'].append(candidate)
   record=process_record(pid,candidate['observation'],expected_cgroup);candidate['start_ticks_match']=record['start_ticks']==born
   candidate['born_after_browser']=int(record['start_ticks'])>=int(main_record['start_ticks'])
   assert candidate['start_ticks_match'] and candidate['born_after_browser'],'renderer identity changed'
   candidate['checks']=renderer_checks(record,main_record,host,uid);candidate['accepted']=valid_renderer(record,main_record,host,uid)
   assert candidate['accepted'],'renderer OS sandbox proof refused'
   renderers.append(record)
  assert renderers,'no owned renderer proof'
  receipt['stage']='Electron_context'
  electron=asyncio.run(context_proof())
  receipt['stage']='profile_recheck'
  assert Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text().strip()=='1'
  assert 'freedom (unconfined)' in Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
  receipt['stage']='process_inventory_recheck'
  receipt['inventory_after']=asyncio.run(browser_process_inventory(launch['pid']))
  assert receipt['inventory_after']==inventory,'renderer inventory changed during proof'
  assert process_record(launch['pid'],expected_cgroup=expected_cgroup)['start_ticks']==launch['start_ticks'],'main identity changed'
  for record in renderers:
   assert process_record(record['pid'],expected_cgroup=expected_cgroup)['start_ticks']==record['start_ticks'],'renderer identity changed after proof'
  receipt.update({'passed':True,'stage':'done','main':main_record,'renderers':renderers,'electron_context':electron,'restriction':1,'packaged_named_profile_still_loaded':True,'observed_epoch':time.time()})
 except BaseException as error:
  kind='assertion' if isinstance(error,AssertionError) else 'proc_read_error' if isinstance(error,OSError) else 'schema_error' if isinstance(error,(KeyError,ValueError,TypeError,StopIteration)) else 'other_error'
  receipt['error']={'class':kind}
  if isinstance(error,OSError):receipt['error']['errno']=error.errno
  raise
 finally:(p/('renderer-sandbox-'+phase+'-proof.json')).write_text(json.dumps(receipt,indent=2)+'\n')


if __name__=='__main__':main()
