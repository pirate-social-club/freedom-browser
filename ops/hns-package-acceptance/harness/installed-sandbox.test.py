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
 def test_empty_or_forged_uid_map_refused(self):
  for mapping in [[],[[1001,1001,0]],[[True,1001,1]],[[1001,1001,-1]]]:
   candidate=copy.deepcopy(self.record);candidate['uid_map']=mapping;self.assertFalse(guard.valid_renderer(candidate,self.main,self.host,1001))

if __name__=='__main__':unittest.main()
