# Invoked only by the proposed hosted cold-setup step, never on the gaming machine.
import os,sys,json,subprocess,hashlib,time,re,runpy
from pathlib import Path
base=Path(__file__).parent;repo=Path(os.environ['FREEDOM_REPOSITORY']).resolve();root=Path(os.environ['FREEDOM_COLD_ROOT']).resolve();root.mkdir(mode=0o755);root.chmod(0o755)
start=time.monotonic();deadline=start+1150

def run(args,**kw):
 remaining=deadline-time.monotonic();assert remaining>0,'cold-setup deadline reached'
 return subprocess.run(args,check=True,timeout=remaining,cwd=repo,**kw)
for name,digest in json.loads((base/'runtime-source-pins.json').read_text()).items():assert hashlib.sha256((repo/name).read_bytes()).hexdigest()==digest,'reviewed runtime input changed '+name
assert sys.version_info[:2]==(3,12),'pinned wheels require Ubuntu24 Python3.12'
assert subprocess.check_output(['node','--version'],text=True,timeout=5).strip()=='v24.14.0'
lock=json.loads((repo/'package-lock.json').read_text());assert lock['packages']['node_modules/axios']['version']=='1.20.0';assert lock['packages']['node_modules/electron']['version']=='42.10.0'
run(['npm','ci'])
journey=os.environ.get('FREEDOM_ACCEPTANCE_JOURNEY','fixtures');assert journey in ('fixtures','a18n')
audit_proof=None
if journey=='fixtures':
 run(['npm','audit','--audit-level=high'])
else:
 def diagnostic_audit(arguments,filename):
  remaining=deadline-time.monotonic();assert remaining>0
  result=subprocess.run(['npm','audit','--json','--audit-level=high',*arguments],cwd=repo,timeout=remaining,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  (root/filename).write_bytes(result.stdout)
  return result.stdout,result.returncode
 full,full_code=diagnostic_audit([],'audit-full.json')
 runtime,runtime_code=diagnostic_audit(['--omit=dev'],'audit-runtime.json')
 audit_proof=runpy.run_path(str(base/'public-diagnostic-audit.py'))['admit_public_diagnostic'](full,full_code,runtime,runtime_code,lock)
 (root/'public-diagnostic-audit.json').write_text(json.dumps(audit_proof,indent=2)+'\n')
# Electron42 has no npm postinstall downloader. Explicitly prepare its locked binary during cold setup.
electron_dir=repo/'node_modules/electron';electron=electron_dir/'dist/electron';addon=repo/'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
assert json.loads((electron_dir/'package.json').read_text())['version']=='42.10.0'
electron_archive='electron-v42.10.0-linux-x64.zip';electron_checksum=json.loads((electron_dir/'checksums.json').read_text())[electron_archive]
assert re.fullmatch('[0-9a-f]{64}',electron_checksum),'bundled Electron checksum missing'
electron_cache=root/'electron-cache';assert not electron_cache.exists(),'fresh Electron archive cache required'
run(['node',str(electron_dir/'install.js')],env={**os.environ,'electron_config_cache':str(electron_cache),'ELECTRON_INSTALL_PLATFORM':'linux','ELECTRON_INSTALL_ARCH':'x64','electron_use_remote_checksums':'','npm_config_electron_use_remote_checksums':''})
assert electron.is_file() and addon.is_file(),'cold Electron/native ABI artifact missing'
assert (electron_dir/'dist/version').read_text().strip().lstrip('v')=='42.10.0' and (electron_dir/'path.txt').read_text().strip()=='electron','installed Electron version/path mismatch'
version_proof=runpy.run_path(str(base/'harness/electron-provenance.py'))['distribution_proof'](repo,electron_cache,os.environ['FREEDOM_SOURCE_SHA'])
electron_ldd=subprocess.check_output(['ldd',str(electron)],text=True,timeout=5);assert 'not found' not in electron_ldd,'Electron runtime library missing'
native_probe="const DB=require('better-sqlite3');const db=new DB(':memory:');if(db.prepare('SELECT 42 AS value').get().value!==42)throw Error('cold SQLite ABI');db.close();const axios=require('axios');if(axios.VERSION!=='1.20.0'||typeof axios.request!=='function')throw Error('cold Axios version');"
run([str(electron),'-e',native_probe],env={**os.environ,'ELECTRON_RUN_AS_NODE':'1'})
# Prepare only the locked builder FPM distribution in a fresh cold cache.
fpm_module=repo/'node_modules/app-builder-lib/out/toolsets/linux.js'
fpm_module_sha=hashlib.sha256(fpm_module.read_bytes()).hexdigest()
assert json.loads((repo/'node_modules/app-builder-lib/package.json').read_text())['version']=='26.15.3'
fpm_archive='fpm-1.17.0-ruby-3.4.3-linux-amd64.7z';fpm_archive_sha='44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f'
assert fpm_archive_sha in fpm_module.read_text(),'locked FPM checksum changed'
fpm_cache=root/'builder-cache';assert not fpm_cache.exists()
fpm_environment={**os.environ,'ELECTRON_BUILDER_CACHE':str(fpm_cache),'USE_SYSTEM_FPM':'false'}
fpm_environment.pop('CUSTOM_FPM_PATH',None)
fpm_prepare=run(['node','-e',"require('app-builder-lib/out/toolsets/linux').getFpmPath().then(p=>console.log('FPM_PATH '+p)).catch(()=>process.exit(1))"],env=fpm_environment,stdout=subprocess.PIPE)
fpm_lines=[line[9:] for line in fpm_prepare.stdout.decode().splitlines() if line.startswith('FPM_PATH ')]
assert len(fpm_lines)==1
fpm=Path(fpm_lines[0]).resolve();assert fpm.is_file() and fpm.is_relative_to(fpm_cache.resolve())
def file_sha(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk)
 return h.hexdigest()
fpm_files={str(path.relative_to(fpm.parent)):file_sha(path) for path in sorted(fpm.parent.rglob('*')) if path.is_file()}
(root/'fpm-cache.json').write_text(json.dumps({'archive':fpm_archive,'archive_sha256':fpm_archive_sha,'builder_version':'26.15.3','toolset_module_sha256':fpm_module_sha,'executable':str(fpm),'directory':str(fpm.parent),'files':fpm_files},indent=2)+'\n')
run(['npm','run','bee:download','--','--target','linux-x64'])
kubo_proof=None
if journey=='fixtures':
 run(['npm','run','ipfs:download','--','--target','linux-x64'])
else:
 # The original endpoint failed in run37105756502. Use the official release's
 # identical archive for this diagnostic, retaining the original SHA512 pin.
 kubo_mirror=r"""
 const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
 const locked=require('./scripts/binary-artifacts.lock.json').ipfs;
 const artifact=locked.targets['linux-x64'];
 const original='https://dist.ipfs.tech/kubo/v0.43.0/kubo_v0.43.0_linux-amd64.tar.gz';
 const mirror='https://github.com/ipfs/kubo/releases/download/v0.43.0/kubo_v0.43.0_linux-amd64.tar.gz';
 const pin='6af21cd24a307d94326807b3d3827064c74fb7122f83b6940af250e6ae40da250e0ec0e1f3551256b78cd204623ed56c32ce735bbe28bdcc787b36943c52458a';
 (async()=>{
  assert(locked.version==='v0.43.0'&&artifact.url===original&&artifact.sha512===pin&&artifact.archive==='tar.gz');
  const target=path.resolve('ipfs-bin/linux-x64');assert(!fs.existsSync(target),'fresh Kubo destination required');
  fs.mkdirSync(target,{recursive:true});const archive=path.join(target,'kubo_v0.43.0_linux-amd64.tar.gz');
  await require('./scripts/download-verified').downloadVerified(mirror,archive,'sha512',pin);
  require('./scripts/extract-archive').extractArchive(archive,target,artifact.archive);
  const extracted=path.join(target,'kubo/ipfs');assert(fs.lstatSync(extracted).isFile(),'Kubo executable missing');
  const binary=path.join(target,'ipfs');fs.renameSync(extracted,binary);fs.chmodSync(binary,0o755);
  fs.rmSync(archive);fs.rmSync(path.join(target,'kubo'),{recursive:true});
  fs.writeFileSync(process.argv[1],JSON.stringify({original_url:original,original_failed_run:37105756502,original_failure:'Kubo_download_failed_empty_error',official_release_url:mirror,archive_sha512:pin,executable_sha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),original_pin_verified:true,scope:'credential_free_public_diagnostic',merge_or_release_acceptance:false}));
 })().catch(()=>{console.error('Pinned Kubo diagnostic mirror failed');process.exitCode=1});
 """
 run(['node','-e',kubo_mirror,str(root/'kubo-distribution.json')])
 kubo_proof=json.loads((root/'kubo-distribution.json').read_text())
run(['npm','run','radicle:download','--','--target','linux-x64'])
venv=root/'python';run(['/usr/bin/python3','-m','venv',str(venv)])
run([str(venv/'bin/pip'),'install','--require-hashes','--only-binary=:all:','--disable-pip-version-check','-r',str(base/'requirements.txt')])
browser=root/'browser';browser.mkdir();pin=json.loads((base/'agent-browser-pin.json').read_text());(browser/'package.json').write_text(json.dumps({'name':'freedom-hosted-cdp-tools','private':True,'version':'1.0.0','dependencies':{'agent-browser':pin['tarball']}}))
run(['npm','install','--prefix',str(browser),'--ignore-scripts','--no-audit','--no-fund'])
installed=json.loads((browser/'package-lock.json').read_text())['packages']['node_modules/agent-browser'];assert installed['version']==pin['version'] and installed['integrity']==pin['integrity'],'CLI registry integrity mismatch'
binary=browser/'node_modules/agent-browser/bin/agent-browser-linux-x64';assert binary.is_file(),'native CLI missing from pinned npm archive; no unverified GitHub fallback'
assert hashlib.sha256(binary.read_bytes()).hexdigest()==pin['native_sha256'],'CLI native executable differs from previously tested artifact';binary.chmod(0o755)
# No agent-browser install/open command. Attachment is explicit --cdp in the later phase.
run(['sudo','-n','test','!','-e','/root/.agent-browser/config.json'])
assert not (repo/'agent-browser.json').exists(),'unexpected browser automation configuration'
for path in [repo/'node_modules/electron/dist/electron',repo/'node_modules/better-sqlite3/build/Release/better_sqlite3.node',repo/'hns-bin/linux-x64/hnsd',repo/'hns-bin/linux-x64/fingertipd']:assert path.is_file()
for flags in [['-l'],['-d']]:
 output=subprocess.check_output(['readelf',*flags,str(repo/'hns-bin/linux-x64/hnsd')],text=True,timeout=5)
 assert ('INTERP' not in output) if flags==['-l'] else ('There is no dynamic section' in output),'hnsd unexpectedly dynamically linked'
receipt={'electron_version_provenance':version_proof,'source':os.environ['FREEDOM_SOURCE_SHA'],'cold_setup_seconds':time.monotonic()-start,'Node':'24.14.0','Electron':'42.10.0','Axios':'1.20.0','agent_browser':pin,'libunbound_runtime_package_required':False,'Electron_download_archive':electron_archive,'Electron_download_sha256':electron_checksum,'Electron_installer_sha256':hashlib.sha256((electron_dir/'install.js').read_bytes()).hexdigest(),'Electron_executable_sha256':hashlib.sha256(electron.read_bytes()).hexdigest(),'cold_native_sqlite_SELECT42':True,'cold_Axios_version':'1.20.0','native_module_sha256':hashlib.sha256((repo/'node_modules/better-sqlite3/build/Release/better_sqlite3.node').read_bytes()).hexdigest(),'ImageOS':os.environ.get('ImageOS'),'ImageVersion':os.environ.get('ImageVersion'),'apt_packages':subprocess.check_output(['dpkg-query','-W','-f=${Package} ${Version}\n','xvfb','slirp4netns','nftables','python3','python3-venv','util-linux','binutils'],text=True,timeout=5).splitlines()}
if audit_proof is not None:receipt['public_diagnostic_audit']=audit_proof
if kubo_proof is not None:receipt['kubo_distribution']=kubo_proof
(root/'cold-setup.json').write_text(json.dumps(receipt,indent=2)+'\n')
