"""Hermetic AST-extracted tool diagnostics; never imports preparation or runs tools."""
import ast,json,os,re,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import Mock
SOURCE=Path(__file__).with_name('prepare-runtime.py').read_text()
TREE=ast.parse(SOURCE)
NAMES={'classify_tool_markers','private_tool_markers','preparation_exception','NamespacePermissionDenied','FpmVersionMismatch','retain_build_error_tail'}
SELECTED=[node for node in TREE.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in NAMES]
class ToolDiagnosticsTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.scope={'p':Path(self.temp.name),'os':os,'re':re,'subprocess':subprocess,'preparation_progress':Mock()}
  exec(compile(ast.Module(body=SELECTED,type_ignores=[]),'<diagnostic-fixture>','exec'),self.scope)
 def classify(self,raw):return self.scope['classify_tool_markers'](raw)
 def test_secret_and_unknown_never_emitted(self):
  for raw in [b'token=PRIVATE.example/password',b'\xff\x00 PRIVATE']:
   self.assertEqual(self.classify(raw),['unclassified'])
 def test_fixed_library_interpreter_and_compression_codes(self):
  cases=[(b'libcrypt.so.1: cannot open shared object file','libcrypt_missing_marker'),(b'bad interpreter: /PRIVATE/secret','interpreter_missing_marker'),(b'xz: not found','compression_missing_marker')]
  for raw,code in cases:self.assertIn(code,self.classify(raw));self.assertNotIn('PRIVATE',json.dumps(self.classify(raw)))
 def test_fpm_metadata_spawn_allocation_codes(self):
  for raw,code in [(b'fpm spawn ENOENT','fpm_spawn_marker'),(b'FPM failed to find the specified files PRIVATE','fpm_files_missing_marker'),(b'depends must be Array or String PRIVATE','package_metadata_marker'),(b'Unknown argument: PRIVATE','command_option_marker'),(b'Cannot allocate memory','allocation_marker')]:self.assertIn(code,self.classify(raw))
 def test_tail_bound_excludes_old_markers(self):
  self.assertEqual(self.classify(b'ENOMEM'+b'x'*16384),['unclassified'])
  log=self.scope['p']/'offline-build.log';log.write_bytes(b'ENOMEM'+b'x'*16384)
  self.assertEqual(self.scope['private_tool_markers']('offline-build.log'),['unclassified'])
 def test_missing_private_log_fixed(self):self.assertEqual(self.scope['private_tool_markers']('fpm-preflight.log'),['log_unavailable'])
 def test_fpm_failure_hook_uses_own_log(self):
  (self.scope['p']/'fpm-preflight.log').write_bytes(b'libcrypt.so.1: cannot open shared object file PRIVATE')
  self.scope['preparation_phase']='fpm_runtime_preflight'
  self.scope['preparation_exception'](None,subprocess.CalledProcessError(1,'PRIVATE'),None)
  args=self.scope['preparation_progress'].call_args.args
  self.assertEqual(args[:3],('failed','child_failed',1));self.assertIn('libcrypt_missing_marker',args[3]);self.assertNotIn('PRIVATE',json.dumps(args))
 def test_spawn_and_wrong_version_have_fixed_codes(self):
  self.scope['preparation_phase']='fpm_runtime_preflight'
  for error,code in [(FileNotFoundError('PRIVATE'),'fpm_preflight_io_error_marker'),(self.scope['FpmVersionMismatch'](),'fpm_version_mismatch_marker')]:
   self.scope['preparation_exception'](None,error,None)
   self.assertIn(code,self.scope['preparation_progress'].call_args.args[3])
 def test_error_tail_keeps_actual_unknown_error_and_only_last_fifty_lines(self):
  raw=b'\n'.join(('line '+str(i)).encode() for i in range(80))+b'\nUNKNOWN BUILDER FAILURE\n'
  (self.scope['p']/'offline-build.log').write_bytes(raw)
  self.scope['retain_build_error_tail']()
  tail=(self.scope['p']/'offline-build-error.log').read_bytes()
  self.assertEqual(len(tail.splitlines()),50);self.assertTrue(tail.endswith(b'UNKNOWN BUILDER FAILURE\n'))
  self.assertNotIn(b'line 0\n',tail)
 def test_error_tail_bounded_read_discards_partial_first_line(self):
  (self.scope['p']/'offline-build.log').write_bytes(b'x'*100000+b'\nACTUAL ERROR\n')
  self.scope['retain_build_error_tail']()
  self.assertEqual((self.scope['p']/'offline-build-error.log').read_bytes(),b'ACTUAL ERROR\n')
 def test_other_phase_does_not_publish_raw_private_logs(self):
  (self.scope['p']/'fpm-preflight.log').write_bytes(b'PRIVATE FPM LOG')
  self.scope['preparation_phase']='fpm_runtime_preflight'
  self.scope['preparation_exception'](None,subprocess.CalledProcessError(1,'PRIVATE'),None)
  self.assertFalse((self.scope['p']/'offline-build-error.log').exists())
 def test_failed_offline_build_hook_retains_real_error(self):
  (self.scope['p']/'offline-build.log').write_bytes(b'ACTUAL UNKNOWN ERROR\n')
  self.scope['preparation_phase']='offline_build'
  self.scope['preparation_exception'](None,subprocess.CalledProcessError(1,'fixed-command'),None)
  self.assertEqual((self.scope['p']/'offline-build-error.log').read_bytes(),b'ACTUAL UNKNOWN ERROR\n')
 def test_build_preserves_host_ownership_and_keeps_network_isolation(self):
  assignment=next(node for node in TREE.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='command' for t in node.targets))
  scope={'freedom':self.scope['p']/'source','p':self.scope['p']}
  exec(compile(ast.Module(body=[assignment],type_ignores=[]),'<build-command-fixture>','exec'),scope)
  command=scope['command']
  self.assertEqual(command[:5],['unshare','--net','node','node_modules/electron-builder/cli.js','--linux'])
  self.assertNotIn('--user',command);self.assertNotIn('--map-root-user',command)
  self.assertIn('deb',command);self.assertEqual(command[command.index('--publish')+1],'never')
 def test_actual_preflight_exact_namespace_version_and_checked_run(self):
  start=next(i for i,node in enumerate(TREE.body) if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='preparation_phase' for t in node.targets) and isinstance(node.value,ast.Constant) and node.value.value=='fpm_runtime_preflight')
  nodes=TREE.body[start:start+4];calls=[];fpm=self.scope['p']/'cached-fpm'
  def fake_run(command,**kwargs):
   calls.append((command,kwargs));kwargs['stdout'].write(b'1.17.0\n')
  self.scope.update({'fpm':fpm,'freedom':self.scope['p'],'run':fake_run})
  compiled=compile(ast.Module(body=nodes,type_ignores=[]),'<preflight-fixture>','exec');exec(compiled,self.scope)
  self.assertEqual(calls[0][0],['unshare','--user','--map-root-user','--net',str(fpm),'--version']);self.assertNotIn('check',calls[0][1])
  def wrong(command,**kwargs):kwargs['stdout'].write(b'1.18.0 PRIVATE')
  self.scope['run']=wrong
  with self.assertRaises(self.scope['FpmVersionMismatch']):exec(compiled,self.scope)
if __name__=='__main__':unittest.main()
