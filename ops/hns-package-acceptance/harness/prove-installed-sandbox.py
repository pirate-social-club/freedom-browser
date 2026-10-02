"""Read-only combined OS/isolated-context proof for the actual installed application."""
import asyncio,json,os,sys,time,urllib.request,runpy
from pathlib import Path
from urllib.parse import urlsplit
import websockets

context_module=runpy.run_path(str(Path(__file__).with_name('electron-context.py')))
provenance_module=runpy.run_path(str(Path(__file__).with_name('electron-provenance.py')))


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
 snapshot['read_stage']='executable_inode'
 loaded=root.joinpath('exe').stat();installed=Path('/opt/Freedom/freedom').stat()
 snapshot['installed_inode_matches']=(loaded.st_dev,loaded.st_ino)==(installed.st_dev,installed.st_ino)
 assert snapshot['installed_inode_matches'],'runtime_executable_inode'
 snapshot['read_stage']='identity_recheck';snapshot['identity_stable']=root.joinpath('stat').read_text().rsplit(')',1)[1].split()[19]==born
 assert snapshot['identity_stable'],'PID changed during proof'
 snapshot['read_stage']='done'
 return record



ASSERTION_IDS = {'PID changed during proof': 'pid_changed_during_proof',
 'browser process inventory deadline': 'browser_process_inventory_deadline',
 'browser process inventory refused': 'browser_process_inventory_refused',
 'different browser inventory': 'different_browser_inventory',
 'duplicate process inventory': 'duplicate_process_inventory',
 'electron_archive_digest': 'electron_archive_digest',
 'electron_archive_digest_format': 'electron_archive_digest_format',
 'electron_archive_identity': 'electron_archive_identity',
 'electron_archive_members': 'electron_archive_members',
 'electron_archive_version': 'electron_archive_version',
 'electron_archive_version_size': 'electron_archive_version_size',
 'electron_candidate_executable_binding': 'electron_candidate_executable_binding',
 'electron_candidate_proof_binding': 'electron_candidate_proof_binding',
 'electron_checksums_changed': 'electron_checksums_changed',
 'electron_cold_lock': 'electron_cold_lock',
 'electron_cold_source': 'electron_cold_source',
 'electron_distribution_executable': 'electron_distribution_executable',
 'electron_distribution_version': 'electron_distribution_version',
 'electron_installed_byte_chain': 'electron_installed_byte_chain',
 'electron_installed_npm_version': 'electron_installed_npm_version',
 'electron_lock_version': 'electron_lock_version',
 'electron_npm_integrity': 'electron_npm_integrity',
 'electron_npm_origin': 'electron_npm_origin',
 'electron_runtime_chain_link': 'electron_runtime_chain_link',
 'electron_runtime_digest': 'electron_runtime_digest',
 'electron_runtime_provenance': 'electron_runtime_provenance',
 'electron_runtime_version': 'electron_runtime_version',
 'electron_version_file_changed': 'electron_version_file_changed',
 'fixed proof phase required': 'fixed_proof_phase_required',
 'installed_runtime_digest': 'installed_runtime_digest',
 'installed_runtime_digest_changed': 'installed_runtime_digest_changed',
 'invalid process identity': 'invalid_process_identity',
 'invalid process inventory': 'invalid_process_inventory',
 'main PID reused': 'main_pid_reused',
 'main identity changed': 'main_identity_changed',
 'main must use actual host user/PID namespaces': 'main_must_use_actual_host_user_pid_namespaces',
 'main_uid_capability_profile': 'main_uid_capability_profile',
 'namespace_restriction_changed': 'namespace_restriction_changed',
 'no owned renderer proof': 'no_owned_renderer_proof',
 'no renderer inventory': 'no_renderer_inventory',
 'packaged_profile_missing': 'packaged_profile_missing',
 'process outside owned service': 'process_outside_owned_service',
 'proof outside owned service': 'proof_outside_owned_service',
 'renderer OS sandbox proof refused': 'renderer_os_sandbox_proof_refused',
 'renderer identity changed': 'renderer_identity_changed',
 'renderer identity changed after proof': 'renderer_identity_changed_after_proof',
 'renderer inventory changed during proof': 'renderer_inventory_changed_during_proof',
 'runtime_executable_inode': 'runtime_executable_inode',
 'unexpected browser endpoint': 'unexpected_browser_endpoint',
 'unexpected executable': 'unexpected_executable'}


def main():
 assert len(sys.argv)==2 and sys.argv[1] in ['pre-security','final'],'fixed proof phase required'
 phase=sys.argv[1]
 p=Path(__file__).parent;receipt={'passed':False,'scope':'combined_owned_renderer_OS_and_Electron_context','stage':'runtime_version','phase':phase}
 def persist():
  (p/('renderer-sandbox-'+phase+'-proof.json')).write_text(json.dumps(receipt,indent=2)+'\n')
 try:
  receipt['runtime_version']=provenance_module['runtime_receipt'](p/'electron-version-proof.json',p/'candidate-integrity.json',os.environ['FREEDOM_SOURCE_SHA'])
  expected_digest=receipt['runtime_version']['installed_executable_sha256']
  assert provenance_module['file_digest']('/opt/Freedom/freedom')==expected_digest,'installed_runtime_digest'
  receipt['runtime_version']['passed']=True;receipt['stage']='process_identity';persist()
  launch=json.loads((p/'browser-launch.json').read_text());timing=json.loads((p/'timing.json').read_text());uid=launch['host_uid']
  expected_cgroup='0::/system.slice/'+os.environ['FREEDOM_SYSTEMD_UNIT']
  assert same_cgroup(Path('/proc/self/cgroup').read_text(),expected_cgroup),'proof outside owned service'
  receipt['main_observation']={}
  main_record=process_record(launch['pid'],receipt['main_observation'],expected_cgroup);assert main_record['start_ticks']==launch['start_ticks'],'main PID reused'
  assert uid>0 and main_record['uids']==[uid]*4 and main_record['cap_eff']==0 and main_record['named_packaged_profile_attached'],'main_uid_capability_profile'
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
  receipt['electron_context']={}
  asyncio.run(context_module['context_proof'](launch['pid'],inventory['renderer_pids'],receipt['electron_context'],persist))
  electron=receipt['electron_context']
  receipt['stage']='profile_recheck'
  assert Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text().strip()=='1','namespace_restriction_changed'
  assert 'freedom (unconfined)' in Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines(),'packaged_profile_missing'
  receipt['stage']='runtime_version_recheck'
  assert provenance_module['file_digest']('/opt/Freedom/freedom')==expected_digest,'installed_runtime_digest_changed'
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
  if isinstance(error,context_module['ProofFailure']):
   receipt['error']={'class':error.kind,'assertion_id':error.code}
  elif isinstance(error,AssertionError):
   # Only fixed source-authored messages are eligible, never exception text from CDP.
   receipt['error']['assertion_id']=ASSERTION_IDS.get(str(error),'unclassified_assertion')
  if isinstance(error,OSError):receipt['error']['errno']=error.errno
  raise
 finally:persist()


if __name__=='__main__':main()
