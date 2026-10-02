"""Hermetic socket-path and observer diagnostic checks; never invokes the CLI."""
import ast,json,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import Mock
HERE=Path(__file__).parent
class SocketLayoutTests(unittest.TestCase):
 def scope(self,p):
  tree=ast.parse((HERE/'namespace-controller.py').read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='browser_socket_preflight'];scope={'p':p,'os':os};exec(compile(ast.Module(body=nodes,type_ignores=[]),'<socket-fixture>','exec'),scope);return scope
 def test_hosted_short_directory_passes(self):
  p=Path('/var/tmp/freedom-package-36965918474-1/private/work');value=self.scope(p)['browser_socket_preflight'](p/'ab');self.assertEqual(value['socket_path_bytes'],93);self.assertLessEqual(value['socket_path_bytes'],103)
 def test_oversized_layout_refused(self):
  p=Path('/var/tmp/'+('x'*70));scope=self.scope(p)
  with self.assertRaises(AssertionError):scope['browser_socket_preflight'](p/'ab')
 def test_unicode_counts_bytes(self):
  p=Path('/var/tmp/'+('é'*30));scope=self.scope(p)
  with self.assertRaises(AssertionError):scope['browser_socket_preflight'](p/'ab')
 def test_outside_directory_refused(self):
  p=Path('/private/work');scope=self.scope(p)
  with self.assertRaises(AssertionError):scope['browser_socket_preflight'](Path('/tmp/global'))
 def test_manual_failure_is_finite_and_raw_error_is_withheld(self):
  tree=ast.parse((HERE/'observe-welcome.py').read_text());names={'fixed_error','manual_progress','welcome_exception','CdpTargetMissing','CdpProtocolError','CdpEvaluationError'};nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
  with tempfile.TemporaryDirectory() as temp:
   scope={'p':Path(temp),'json':json,'subprocess':subprocess,'manual_stage':'address_fill','manual_index':0,'asyncio':__import__('asyncio')};exec(compile(ast.Module(body=nodes,type_ignores=[]),'<diagnostic-fixture>','exec'),scope)
   scope['welcome_exception'](None,subprocess.CalledProcessError(1,'PRIVATE SECRET'),None);v=json.loads((Path(temp)/'manual-observer-diagnostic.json').read_text());self.assertEqual(v['phase'],'address_fill');self.assertEqual(v['command_returncode'],1);self.assertNotIn('PRIVATE',json.dumps(v))
if __name__=='__main__':unittest.main()
