"""Hermetic validator fixtures; importing the guard never reads proc or starts CDP."""
import copy,importlib.util,unittest,sys,types
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

if __name__=='__main__':unittest.main()
