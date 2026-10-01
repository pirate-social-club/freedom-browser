"""Read-only combined OS/isolated-context proof for the actual installed application."""
import asyncio,json,os,sys,time,urllib.request
from pathlib import Path
import websockets


def valid_renderer(record,main,host,uid):
 return (record['uids']==[uid]*4 and record['cap_eff']==0 and record['no_new_privs']==1
  and record['seccomp']==2 and record['seccomp_filters']>main['seccomp_filters']
  and all(record['namespaces'][kind]!=main['namespaces'][kind]
          and record['namespaces'][kind]!=host[kind] for kind in ['user','pid'])
  and record['named_packaged_profile_attached'] is True and bool(record['uid_map'])
  and all(len(row)==3 and all(type(v) is int and v>=0 for v in row) and row[2]>0 for row in record['uid_map']))


def process_record(pid):
 root=Path('/proc')/str(pid)
 born=root.joinpath('stat').read_text().rsplit(')',1)[1].split()[19]
 fields=dict(line.split(':',1) for line in root.joinpath('status').read_text().splitlines() if ':' in line)
 record={'pid':pid,'start_ticks':born,'uids':list(map(int,fields['Uid'].split())),
  'cap_eff':int(fields['CapEff'].strip(),16),'no_new_privs':int(fields['NoNewPrivs']),
  'seccomp':int(fields['Seccomp']),'seccomp_filters':int(fields['Seccomp_filters']),
  'namespaces':{kind:root.joinpath('ns',kind).readlink().as_posix() for kind in ['user','pid']},
  'named_packaged_profile_attached':root.joinpath('attr/current').read_text().strip()=='freedom (unconfined)',
  'uid_map':[list(map(int,line.split())) for line in root.joinpath('uid_map').read_text().splitlines()]}
 assert root.joinpath('exe').readlink()==Path('/opt/Freedom/freedom'),'unexpected executable'
 assert root.joinpath('stat').read_text().rsplit(')',1)[1].split()[19]==born,'PID changed during proof'
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
  main_record=process_record(launch['pid']);assert main_record['start_ticks']==launch['start_ticks'],'main PID reused'
  assert uid>0 and main_record['uids']==[uid]*4 and main_record['cap_eff']==0 and main_record['named_packaged_profile_attached']
  host={'user':timing['host_userns'],'pid':timing['host_pidns']}
  assert main_record['namespaces']==host,'main must use actual host user/PID namespaces'
  owned={launch['pid']:main_record['start_ticks']};records={}
  for entry in Path('/proc').iterdir():
   if entry.name.isdigit():
    try:
     fields=(entry/'stat').read_text().rsplit(')',1)[1].split();records[int(entry.name)]=(int(fields[1]),fields[19])
    except (OSError,ValueError):pass
  for _ in range(16):
   for pid,(parent,born) in records.items():
    if parent in owned:owned[pid]=born
  receipt['stage']='renderer_OS_state'
  renderers=[]
  for pid,born in owned.items():
   try:
    root=Path('/proc')/str(pid)
    if b'--type=renderer' not in root.joinpath('cmdline').read_bytes().split(b'\x00'):continue
    record=process_record(pid);assert record['start_ticks']==born
    assert valid_renderer(record,main_record,host,uid),'renderer OS sandbox proof refused'
    renderers.append(record)
   except FileNotFoundError:continue
  assert renderers,'no owned renderer proof'
  receipt['stage']='Electron_context'
  electron=asyncio.run(context_proof())
  receipt['stage']='profile_recheck'
  assert Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text().strip()=='1'
  assert 'freedom (unconfined)' in Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
  receipt.update({'passed':True,'stage':'done','main':main_record,'renderers':renderers,'electron_context':electron,'restriction':1,'packaged_named_profile_still_loaded':True,'observed_epoch':time.time()})
 finally:(p/('renderer-sandbox-'+phase+'-proof.json')).write_text(json.dumps(receipt,indent=2)+'\n')


if __name__=='__main__':main()
