import hashlib,json,shutil,subprocess,time,os,sys,re
from pathlib import Path
p=Path(__file__).parent
# Public preparation diagnostics contain only fixed phases/categories and numeric exit codes.
preparation_phase='source_pins';namespace_access=None;asar_failure=None;asar_top=None
def preparation_progress(status='running',category=None,returncode=None,builder_markers=None):
 record={'phase':preparation_phase,'status':status}
 if category is not None:record['category']=category
 if returncode is not None:record['returncode']=returncode
 if builder_markers is not None:record['builder_markers']=builder_markers
 if namespace_access is not None:record['namespace_access']=namespace_access
 if asar_failure is not None:record['asar_failure_code']=asar_failure
 if asar_top is not None:record['asar_top_diagnostic']=asar_top
 (p/'preparation-progress.json').write_text(json.dumps(record,indent=2)+'\n')
def offline_builder_markers():
 # Inspect at most16KiB of private output and emit only fixed codes, never matched bytes.
 try:
  with (p/'offline-build.log').open('rb') as private_log:
   private_log.seek(0,os.SEEK_END);size=private_log.tell()
   private_log.seek(max(0,size-16384));tail=private_log.read(16384)
 except OSError:return ['log_unavailable']
 markers=[]
 patterns=[
  ('module_missing_marker',[b'MODULE_NOT_FOUND']),
  ('esm_loader_marker',[b'ERR_REQUIRE_ESM']),
  ('configuration_marker',[b'Invalid configuration object.',b'InvalidConfigurationError']),
  ('electron_dist_missing_marker',[b'The specified electronDist does not exist:']),
  ('permission_marker',[b'EACCES',b'EPERM']),
  ('file_missing_marker',[b'ENOENT']),
  ('native_load_marker',[b'ERR_DLOPEN_FAILED']),
  ('network_error_marker',[b'ENOTFOUND',b'ENETUNREACH',b'ECONNREFUSED']),
 ]
 for code,needles in patterns:
  if any(needle in tail for needle in needles):markers.append(code)
 missing=re.search(br"Cannot find module ['\"]([^'\"]+)['\"]",tail)
 if missing:
  target=missing.group(1)
  known={b'./out/cli/cli':'builder_out_cli_missing_marker',
   b'app-builder-lib':'known_builder_import_missing_marker',
   b'app-builder-lib/out/toolsets/windows':'known_builder_import_missing_marker',
   b'app-builder-lib/out/util/electronGet':'known_builder_import_missing_marker',
   b'builder-util':'known_builder_import_missing_marker',
   b'builder-util/out/filename':'known_builder_import_missing_marker',
   b'simple-update-notifier':'known_builder_import_missing_marker',
   b'yargs':'known_builder_import_missing_marker',b'chalk':'known_builder_import_missing_marker',
   b'fs-extra':'known_builder_import_missing_marker'}
  if target.endswith(b'/node_modules/electron-builder/cli.js'):markers.append('builder_cli_entry_missing_marker')
  elif target in known:markers.append(known[target])
 if b'app-builder' in tail and b'spawn' in tail:markers.append('app_builder_spawn_marker')
 return markers or ['unclassified']
def namespace_access_response(returncode,output):
 keys={'cli_entry_readable','out_cli_readable','repo_traversable'}
 unknown={key:False for key in keys};unknown['probe_valid']=False
 if returncode or len(output)>256:return unknown
 try:record=json.loads(output)
 except (ValueError,UnicodeDecodeError):return unknown
 if not isinstance(record,dict) or set(record)!=keys or not all(type(value) is bool for value in record.values()):return unknown
 return {**record,'probe_valid':True}
def asar_top_response(output):
 if len(output)>512:return None
 try:record=json.loads(output)
 except (ValueError,UnicodeDecodeError):return None
 fields={'top_source_count','top_destination_root','axios_120_count','axios_other_version_present'}
 if not isinstance(record,dict) or set(record)!=fields|{'passed','code'} or record['passed'] is not False or record['code']!='mapping_top_axios_changed':return None
 if record['top_source_count'] not in ('zero','one','many') or record['axios_120_count'] not in ('zero','one','many') or type(record['top_destination_root']) is not bool or type(record['axios_other_version_present']) is not bool:return None
 return {field:record[field] for field in sorted(fields)}
def asar_failure_response(output):
 if asar_top_response(output) is not None:return 'mapping_top_axios_changed'
 allowed={'mapping_ambiguous', 'extractor_axios_nested_code_missing_entry', 'extractor_axios_metadata_missing_entry', 'extractor_app_metadata_read_error', 'extractor_axios_metadata_read_error', 'mapping_owner_missing', 'collector_empty', 'extractor_axios_code_missing_entry', 'extractor_axios_nested_code_read_error', 'extractor_axios_nested_metadata_missing_entry', 'extractor_app_code_read_error', 'collector_changed', 'extractor_app_code_missing_entry', 'mapping_top_axios_changed', 'extractor_app_metadata_missing_entry', 'mapping_version_changed', 'mapping_invalid_destination', 'extractor_axios_nested_metadata_read_error', 'extractor_axios_code_read_error'} | {'raw_source_changed', 'transformer_changed', 'axios_version_changed', 'app_metadata_proof_missing', 'success_proof_missing', 'app_metadata_mismatch', 'packaged_code_mismatch', 'builder_version_changed', 'unexpected_metadata_config', 'axios_metadata_mismatch','axios_nested_metadata_mismatch', 'unknown', 'app_code_mismatch', 'runtime_field_changed', 'axios_metadata_proof_missing', 'runtime_field_presence_changed', 'extractor_failure', 'axios_code_mismatch', 'invalid_source_digest', 'invalid_source_path'}
 if len(output)>256:return 'unknown'
 try:record=json.loads(output)
 except (ValueError,UnicodeDecodeError):return 'unknown'
 if not isinstance(record,dict) or set(record)!={'passed','code'} or record['passed'] is not False or not isinstance(record['code'],str) or record['code'] not in allowed:return 'unknown'
 return record['code']
def asar_receipt_failure(output,subtype):
 known=asar_failure_response(output)
 if known!='unknown':return known
 allowed={'success_receipt_missing','success_receipt_read_error','success_receipt_invalid_json','success_receipt_invalid_shape'}
 return subtype if subtype in allowed else 'unknown'
class NamespacePermissionDenied(Exception):pass
def preparation_exception(_kind,error,_traceback):
 category='internal_error';returncode=None
 if isinstance(error,NamespacePermissionDenied):category='namespace_permission_denied'
 elif isinstance(error,AssertionError):category='assertion'
 elif isinstance(error,subprocess.TimeoutExpired):category='timeout'
 elif isinstance(error,subprocess.CalledProcessError):category='child_failed';returncode=error.returncode
 markers=offline_builder_markers() if preparation_phase=='offline_build' and category=='child_failed' else None
 preparation_progress('failed',category,returncode,markers)
sys.excepthook=preparation_exception
preparation_progress()
freedom=Path(os.environ['FREEDOM_REPOSITORY']);app_sha=os.environ['FREEDOM_SOURCE_SHA'];assert re.fullmatch('[0-9a-f]{40}',app_sha)
artifact_source='21f044ebc830eed87e6851ed7216f9590f6f3df3'
deadline=json.loads((p/'timing.json').read_text())['deadline_epoch']-30

def run(args,**kw):
 remaining=deadline-time.time();assert remaining>0,'preparation deadline reached'
 return subprocess.run(args,check=kw.pop('check',True),timeout=remaining,**kw)
def git(*args):return subprocess.check_output(['git','-C',str(freedom),*args],text=True,timeout=10).strip()
def pin():
 assert git('rev-parse','HEAD')==app_sha,'source moved'
 assert not git('diff','--name-only') and not git('diff','--cached','--name-only'),'tracked source dirty'
pin()
for name,digest in json.loads((Path(os.environ['FREEDOM_HARNESS_BASE'])/'runtime-source-pins.json').read_text()).items():assert hashlib.sha256((freedom/name).read_bytes()).hexdigest()==digest,'reviewed runtime input changed '+name
assets={'fingertipd':'065e4f0d5c118213f09319998c94633033cae7f96dc6d714083208468225f766','hnsd':'881ba4728f3e36a2015185f8cfa478d718260eaf7f406404af386b0ed4d863af'}
for name,digest in assets.items():assert hashlib.sha256((freedom/'hns-bin/linux-x64'/name).read_bytes()).hexdigest()==digest
assert json.loads((freedom/'node_modules/electron/package.json').read_text())['version']=='42.10.0'
assert json.loads((freedom/'node_modules/axios/package.json').read_text())['version']=='1.20.0'
assert (freedom/'node_modules/better-sqlite3/build/Release/better_sqlite3.node').is_file(),'native ABI artifact missing'
preparation_phase='namespace_probe';preparation_progress()
probe=run(['/usr/bin/unshare','--user','--map-root-user','--net','/usr/bin/true'],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
if probe.returncode:
 if probe.stderr.strip()==b'unshare: unshare failed: Operation not permitted':raise NamespacePermissionDenied()
 raise subprocess.CalledProcessError(probe.returncode,'namespace_probe')
# Absolute inline Python runs even when repository/private ancestors are inaccessible.
access_script="import os,sys,json;root=sys.argv[1];record={'cli_entry_readable':False,'out_cli_readable':False,'repo_traversable':os.access(root,os.X_OK)}\nfor key,suffix in [('cli_entry_readable','node_modules/electron-builder/cli.js'),('out_cli_readable','node_modules/electron-builder/out/cli/cli.js')]:\n try:\n  with open(os.path.join(root,suffix),'rb') as f:f.read(1)\n  record[key]=True\n except OSError:pass\nprint(json.dumps(record))"
access_probe=run(['/usr/bin/unshare','--user','--map-root-user','--net','/usr/bin/python3','-c',access_script,str(freedom)],check=False,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
namespace_access=namespace_access_response(access_probe.returncode,access_probe.stdout)
preparation_phase='offline_build';preparation_progress()
command=['unshare','--user','--map-root-user','--net','node','node_modules/electron-builder/cli.js','--linux','--x64','--dir','--publish','never','-c.electronDist='+str(freedom/'node_modules/electron/dist'),'-c.npmRebuild=false','-c.nodeGypRebuild=false','-c.directories.output='+str(p/'build')]
with (p/'offline-build.log').open('wb') as build_log:
 run(command,cwd=freedom,env={**os.environ,'ELECTRON_SKIP_BINARY_DOWNLOAD':'1','npm_config_offline':'true','CSC_IDENTITY_AUTO_DISCOVERY':'false'},stdout=build_log,stderr=subprocess.STDOUT)
preparation_phase='source_resources_native';preparation_progress()
base=p/'build/linux-unpacked';assert (base/'freedom').is_file();shutil.copytree(base,p/'package',symlinks=True)
assert (p/'package/freedom').read_bytes()==(freedom/'node_modules/electron/dist/electron').read_bytes(),'Electron executable mismatch'
for name,digest in assets.items():assert hashlib.sha256((p/'package/resources/hns-bin'/name).read_bytes()).hexdigest()==digest,'packaged helper differs'
checks={name:hashlib.sha256((freedom/name).read_bytes()).hexdigest() for name in git('ls-files','src').splitlines() if (freedom/name).is_file() and not name.endswith('.test.js')}
checks['package.json']=hashlib.sha256((freedom/'package.json').read_bytes()).hexdigest()
axios_files=[f for f in (freedom/'node_modules/axios').rglob('*') if f.is_file() and (f.suffix in ['.js','.cjs','.mjs'] or f.name=='package.json')]
for f in axios_files:checks[str(f.relative_to(freedom))]=hashlib.sha256(f.read_bytes()).hexdigest()
(p/'source-files.json').write_text(json.dumps(checks,indent=2))
preparation_phase='asar_integrity';preparation_progress()
asar_check=run(['/usr/bin/unshare','--user','--map-root-user','--net','node',str(p/'verify-asar.js'),str(freedom),str(p/'source-files.json'),str(p/'package/resources/app.asar'),str(p/'asar-integrity.json')],cwd=freedom,check=False,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
if asar_check.returncode:
 asar_top=asar_top_response(asar_check.stdout)
 asar_failure=asar_failure_response(asar_check.stdout)
 raise subprocess.CalledProcessError(asar_check.returncode,'asar_integrity')
try:
 asar_text=(p/'asar-integrity.json').read_text()
except FileNotFoundError:
 asar_failure=asar_receipt_failure(asar_check.stdout,'success_receipt_missing');raise AssertionError('ASAR success proof missing')
except (OSError,UnicodeError):
 asar_failure=asar_receipt_failure(asar_check.stdout,'success_receipt_read_error');raise AssertionError('ASAR success proof missing')
try:
 asar_success=json.loads(asar_text)
except ValueError:
 asar_failure=asar_receipt_failure(asar_check.stdout,'success_receipt_invalid_json');raise AssertionError('ASAR success proof missing')
if not isinstance(asar_success,dict) or asar_success.get('passed') is not True:
 asar_failure=asar_receipt_failure(asar_check.stdout,'success_receipt_invalid_shape');raise AssertionError('ASAR success proof missing')
preparation_phase='source_resources_native';preparation_progress()
# Every configured extraResources file present at cold setup must be byte-identical.
for directory,out in [('assets','assets'),('hns-bin/linux-x64','hns-bin'),('bee-bin/linux-x64','bee-bin'),('ipfs-bin/linux-x64','ipfs-bin'),('radicle-bin/linux-x64','radicle-bin'),('dvpn-bin/linux-x64','dvpn-bin'),('scripts/jacktrip','jacktrip-scripts')]:
 src=freedom/directory;assert src.is_dir(),'release resources absent '+directory
 for f in src.rglob('*'):
  if f.is_file():assert f.read_bytes()==(p/'package/resources'/out/f.relative_to(src)).read_bytes(),'resource differs '+str(f.relative_to(freedom))
for name,out in [('config/bee.yaml','bee.yaml'),('config/default-bookmarks.json','default-bookmarks.json')]:assert (freedom/name).read_bytes()==(p/'package/resources'/out).read_bytes()
addon=Path('node_modules/better-sqlite3/build/Release/better_sqlite3.node');assert (freedom/addon).read_bytes()==(p/'package/resources/app.asar.unpacked'/addon).read_bytes()
manifest=[{'path':str(f.relative_to(p/'package')),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted((p/'package').rglob('*')) if f.is_file()]
(p/'package-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
native="const path=require('path');const app=process.argv[1];const DB=require(path.join(app,'node_modules/better-sqlite3'));const db=new DB(':memory:');if(db.prepare('SELECT 42 AS value').get().value!==42)throw Error('sqlite ABI');db.close();const axios=require(path.join(app,'node_modules/axios'));if(axios.VERSION!=='1.20.0'||typeof axios.request!=='function')throw Error('runtime Axios');"
run(['unshare','--user','--map-root-user','--net',str(p/'package/freedom'),'-e',native,str(p/'package/resources/app.asar')],cwd=p/'package',env={**os.environ,'ELECTRON_RUN_AS_NODE':'1'})
(p/'candidate-integrity.json').write_text(json.dumps({'Freedom_source':app_sha,'asar_integrity':json.loads((p/'asar-integrity.json').read_text()),'tested_helper_build_source':artifact_source,'tested_helper_build_compiler':'Go 1.26.2','helper_sha256':assets['fingertipd'],'hnsd_sha256':assets['hnsd'],'package_build_command':command,'packaged_source_files_compared':len(checks),'packaged_Axios_version':'1.20.0','packaged_Axios_files_compared':len(axios_files),'native_ABI_check_passed':True,'native_sqlite_SELECT42':True,'helper_rebuilt':False,'Electron_version':'42.10.0','Electron_executable_sha256':hashlib.sha256((p/'package/freedom').read_bytes()).hexdigest()},indent=2)+'\n')
preparation_phase='fixtures';preparation_progress()
checkpoint=p/'warm-checkpoint-main.dat';metadata=json.loads((p/'checkpoint-integrity.json').read_text());assert hashlib.sha256(checkpoint.read_bytes()).hexdigest()==metadata['sha256']
assert checkpoint.read_bytes()==(freedom/'assets/hns/checkpoint_main.dat').read_bytes(),'seed differs from shipped checkpoint'
dest=p/'profile-candidate/hns-data/hnsd';dest.mkdir(parents=True,mode=0o700);shutil.copy2(checkpoint,dest/'checkpoint_main.dat')
settings=p/'profile-settings-fixture.json';assert json.loads(settings.read_text())=={'autoUpdate':False};shutil.copy2(settings,p/'profile-candidate/settings.json');(p/'profile-candidate/settings.json').chmod(0o600)
(p/'profile-seed.json').write_text(json.dumps({'fresh_browser_profile':True,'public_hnsd_checkpoint_sha256':metadata['sha256'],'only_settings_override':{'autoUpdate':False},'settings_sha256':hashlib.sha256(settings.read_bytes()).hexdigest()},indent=2)+'\n')
run([sys.executable,str(p/'prepare-candidate.py')]);run([sys.executable,str(p/'validate-prepared.py')]);pin()
preparation_phase='done';preparation_progress('passed')
