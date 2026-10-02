"""Hermetic validator fixtures; importing the guard never reads proc or starts CDP."""
import copy,importlib.util,unittest,sys,types,json,tempfile,os
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('prove-installed-sandbox.py'))
guard=importlib.util.module_from_spec(spec)
with patch.dict(sys.modules,{'websockets':types.ModuleType('websockets')}):spec.loader.exec_module(guard)

class RendererProofTests(unittest.TestCase):
 def setUp(self):
  self.main={'seccomp_filters':0,'namespaces':{'user':'user:[1]','pid':'pid:[1]'}}
  self.host={'user':'user:[1]','pid':'pid:[1]'}
  self.record={'uids':[1001]*4,'cap_eff':0,'no_new_privs':1,'seccomp':2,'seccomp_filters':1,'namespaces':{'user':'user:[2]','pid':'pid:[2]'},'named_packaged_profile_attached':True,'uid_map':[[1001,1001,1]]}
 def test_complete_owned_renderer_proof(self):self.assertTrue(guard.valid_renderer(self.record,self.main,self.host,1001))
 def test_root_or_different_user_refused(self):
  for ids in [[0]*4,[1001,0,1001,1001],[1002]*4]:
   candidate=copy.deepcopy(self.record);candidate['uids']=ids;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_capability_and_nnp_refused(self):
  for key,value in [('cap_eff',1),('no_new_privs',0)]:
   candidate=copy.deepcopy(self.record);candidate[key]=value;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_inherited_seccomp_not_browser_proof(self):
  candidate=copy.deepcopy(self.record);candidate['seccomp_filters']=0;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_missing_or_disabled_seccomp_refused(self):
  for mode in [0,1]:
   candidate=copy.deepcopy(self.record);candidate['seccomp']=mode;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_host_or_main_namespace_refused(self):
  for kind in ['user','pid']:
   candidate=copy.deepcopy(self.record);candidate['namespaces'][kind]=self.host[kind];self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_unattached_profile_refused(self):
  candidate=copy.deepcopy(self.record);candidate['named_packaged_profile_attached']=False;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_diagnostics_identify_rejected_guard_without_weakening_it(self):
  checks=guard.renderer_checks(self.record,self.main,self.host,1001);self.assertTrue(all(checks.values()))
  for field,value,code in [('cap_eff',1,'capabilities_zero'),('no_new_privs',0,'no_new_privs_enabled'),('seccomp_filters',0,'extra_seccomp_filter')]:
   candidate=copy.deepcopy(self.record);candidate[field]=value;checks=guard.renderer_checks(candidate,self.main,self.host,1001)
   self.assertFalse(checks[code]);self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))
 def test_empty_or_forged_uid_map_refused(self):
  for mapping in [[],[[1001,1001,0]],[[True,1001,1]],[[1001,1001,-1]]]:
   candidate=copy.deepcopy(self.record);candidate['uid_map']=mapping;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))

class RendererDiscoveryTests(unittest.TestCase):
 def setUp(self):self.rows=[{'type':'browser','id':10733},{'type':'renderer','id':10922},{'type':'renderer','id':10911},{'type':'GPU','id':10753}]
 def test_browser_inventory_uses_OS_pids_without_cmdline_tokens(self):
  self.rows[1]['cpuTime']=4.5;self.rows[1]['ignored']='not published'
  self.assertEqual(guard.select_renderer_pids(self.rows,10733),{'browser_pid':10733,'renderer_pids':[10911,10922]})
 def test_unrelated_browser_refused(self):
  with self.assertRaises(AssertionError):guard.select_renderer_pids(self.rows,99)
 def test_missing_renderers_or_browser_refused(self):
  for rows in [[],[self.rows[0]],self.rows[1:]]:
   with self.assertRaises(AssertionError):guard.select_renderer_pids(rows,10733)
 def test_duplicate_id_or_browser_refused(self):
  for row in [self.rows[1],{'type':'browser','id':100}]:
   with self.assertRaises(AssertionError):guard.select_renderer_pids(self.rows+[row],10733)
 def test_forged_or_malformed_inventory_refused(self):
  for value in [True,0,-1,'10922',10922.5,None]:
   rows=copy.deepcopy(self.rows);rows[1]['id']=value
   with self.assertRaises(AssertionError):guard.select_renderer_pids(rows,10733)
 def test_foreign_child_or_missing_cgroup_refused(self):
  expected='0::/system.slice/freedom-package-1-test.service'
  self.assertTrue(guard.same_cgroup(expected+'\n',expected))
  for actual in ['',expected+'/child',expected+'-other',expected+'\n'+expected]:self.assertFalse(guard.same_cgroup(actual,expected))

class FailureReceiptTests(unittest.TestCase):
 def test_context_failure_survives_final_receipt_with_prior_OS_observations(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);harness=root/'harness';harness.mkdir()
   (harness/'browser-launch.json').write_text(json.dumps({'pid':100,'start_ticks':'1','host_uid':1001}))
   (harness/'timing.json').write_text(json.dumps({'host_userns':'user:[1]','host_pidns':'pid:[1]'}))
   (root/'proc/self').mkdir(parents=True);(root/'proc/101').mkdir()
   (root/'proc/self/cgroup').write_text('0::/system.slice/fixture.service\n')
   (root/'proc/101/stat').write_text('101 (fixture) '+' '.join(['0']*19+['2']))
   main={'pid':100,'start_ticks':'1','uids':[1001]*4,'cap_eff':0,'named_packaged_profile_attached':True,
         'seccomp_filters':0,'namespaces':{'user':'user:[1]','pid':'pid:[1]'}}
   renderer={**main,'pid':101,'start_ticks':'2','no_new_privs':1,'seccomp':2,'seccomp_filters':1,
             'namespaces':{'user':'user:[2]','pid':'pid:[2]'},'uid_map':[[1001,1001,1]]}
   def process(pid,snapshot=None,expected_cgroup=None):
    if snapshot is not None:snapshot.update({'fixture_process':pid})
    return main if pid==100 else renderer
   async def inventory(_pid):return {'browser_pid':100,'renderer_pids':[101]}
   async def context(_pid,_renderers,receipt,persist):
    receipt.update({'passed':False,'operation':'page_node_globals','targets':[{'target_id':'GUEST','frame_id':'FRAME'}]})
    persist()
    raise guard.context_module['ProofFailure']('page_node_globals','evaluation_exception')
   def mapped(value):return harness/'guard.py' if str(value)==guard.__file__ else root/str(value).lstrip('/')
   runtime={'version':'42.10.0','installed_executable_sha256':'a'*64,'provenance_sha256':'b'*64,'passed':False}
   with patch.object(guard,'Path',mapped),patch.object(guard,'process_record',process),patch.object(guard,'browser_process_inventory',inventory),patch.dict(guard.context_module,{'context_proof':context}),patch.dict(guard.provenance_module,{'runtime_receipt':lambda *_:copy.deepcopy(runtime),'file_digest':lambda *_:'a'*64}),patch.dict(os.environ,{'FREEDOM_SOURCE_SHA':'a'*40,'FREEDOM_SYSTEMD_UNIT':'fixture.service'}),patch.object(sys,'argv',['guard.py','pre-security']):
    with self.assertRaises(guard.context_module['ProofFailure']):guard.main()
   receipt=json.loads((harness/'renderer-sandbox-pre-security-proof.json').read_text())
   self.assertFalse(receipt['passed'])
   self.assertEqual(receipt['stage'],'Electron_context')
   self.assertEqual(receipt['error'],{'class':'evaluation_exception','assertion_id':'page_node_globals'})
   self.assertTrue(receipt['renderer_candidates'][0]['accepted'])
   self.assertEqual(receipt['electron_context']['targets'][0]['frame_id'],'FRAME')

 def test_unknown_assertion_text_cannot_enter_public_receipt(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory)
   with patch.object(guard,'Path',lambda *_:root/'guard.py'),patch.dict(guard.provenance_module,{'runtime_receipt':lambda *_:(_ for _ in ()).throw(AssertionError('PRIVATE'))}),patch.dict(os.environ,{'FREEDOM_SOURCE_SHA':'a'*40}),patch.object(sys,'argv',['guard.py','final']):
    with self.assertRaises(AssertionError):guard.main()
   receipt=json.loads((root/'renderer-sandbox-final-proof.json').read_text())
   self.assertEqual(receipt['error']['assertion_id'],'unclassified_assertion')
   self.assertNotIn('PRIVATE',json.dumps(receipt))

if __name__=='__main__':unittest.main()
