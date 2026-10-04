import json,time,hashlib
from pathlib import Path
p=Path(__file__).parent
assert json.loads((p/'signature-validity-recheck.json').read_text())['earliest_expiry_epoch']>time.time()+600,'fixture expiry margin absent'
r=json.loads((p/'candidate-integrity.json').read_text())
import os
assert r['Freedom_source']==os.environ['FREEDOM_SOURCE_SHA']
assert r['packaged_Axios_version']=='1.20.0'
assert r['tested_helper_build_source']=='21f044ebc830eed87e6851ed7216f9590f6f3df3'
assert not r['fingertipd_rebuilt'] and r['hnsd_rebuilt'] and r['native_ABI_check_passed']
for name,key in [('fingertipd','helper_sha256'),('hnsd','hnsd_sha256')]:assert hashlib.sha256((p/'package/resources/hns-bin'/name).read_bytes()).hexdigest()==r[key]
manifest=json.loads((p/'package-manifest.json').read_text())
assert set(f['path'] for f in manifest)==set(str(f.relative_to(p/'package')) for f in (p/'package').rglob('*') if f.is_file())
for f in manifest:assert hashlib.sha256((p/'package'/f['path']).read_bytes()).hexdigest()==f['sha256'],f['path']
print('Fresh exact integrated package and unexpired signed fixtures verified',flush=True)
