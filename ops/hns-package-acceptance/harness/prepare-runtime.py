import hashlib,json,shutil,subprocess,time,os,sys,re
from pathlib import Path
p=Path(__file__).parent
# Public preparation diagnostics contain only fixed phases/categories and numeric exit codes.
preparation_phase='source_pins'
def preparation_progress(status='running',category=None,returncode=None,builder_markers=None):
 record={'phase':preparation_phase,'status':status}
 if category is not None:record['category']=category
 if returncode is not None:record['returncode']=returncode
 if builder_markers is not None:record['builder_markers']=builder_markers
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
 if b'app-builder' in tail and b'spawn' in tail:markers.append('app_builder_spawn_marker')
 return markers or ['unclassified']
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
script="const fs=require('fs'),crypto=require('crypto'),asar=require('@electron/asar');const inputs=JSON.parse(fs.readFileSync(process.argv[1]));for(const [name,expected] of Object.entries(inputs)){const got=crypto.createHash('sha256').update(asar.extractFile(process.argv[2],name)).digest('hex');if(got!==expected)throw Error('packaged file mismatch '+name)}if(JSON.parse(asar.extractFile(process.argv[2],'node_modules/axios/package.json')).version!=='1.20.0')throw Error('Axios version');"
run(['node','-e',script,str(p/'source-files.json'),str(p/'package/resources/app.asar')],cwd=freedom)
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
(p/'candidate-integrity.json').write_text(json.dumps({'Freedom_source':app_sha,'tested_helper_build_source':artifact_source,'tested_helper_build_compiler':'Go 1.26.2','helper_sha256':assets['fingertipd'],'hnsd_sha256':assets['hnsd'],'package_build_command':command,'packaged_source_files_compared':len(checks),'packaged_Axios_version':'1.20.0','packaged_Axios_files_compared':len(axios_files),'native_ABI_check_passed':True,'native_sqlite_SELECT42':True,'helper_rebuilt':False,'Electron_version':'42.10.0','Electron_executable_sha256':hashlib.sha256((p/'package/freedom').read_bytes()).hexdigest()},indent=2)+'\n')
preparation_phase='fixtures';preparation_progress()
checkpoint=p/'warm-checkpoint-main.dat';metadata=json.loads((p/'checkpoint-integrity.json').read_text());assert hashlib.sha256(checkpoint.read_bytes()).hexdigest()==metadata['sha256']
assert checkpoint.read_bytes()==(freedom/'assets/hns/checkpoint_main.dat').read_bytes(),'seed differs from shipped checkpoint'
dest=p/'profile-candidate/hns-data/hnsd';dest.mkdir(parents=True,mode=0o700);shutil.copy2(checkpoint,dest/'checkpoint_main.dat')
settings=p/'profile-settings-fixture.json';assert json.loads(settings.read_text())=={'autoUpdate':False};shutil.copy2(settings,p/'profile-candidate/settings.json');(p/'profile-candidate/settings.json').chmod(0o600)
(p/'profile-seed.json').write_text(json.dumps({'fresh_browser_profile':True,'public_hnsd_checkpoint_sha256':metadata['sha256'],'only_settings_override':{'autoUpdate':False},'settings_sha256':hashlib.sha256(settings.read_bytes()).hexdigest()},indent=2)+'\n')
run([sys.executable,str(p/'prepare-candidate.py')]);run([sys.executable,str(p/'validate-prepared.py')]);pin()
preparation_phase='done';preparation_progress('passed')
