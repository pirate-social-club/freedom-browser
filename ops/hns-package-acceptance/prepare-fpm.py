"""Prepare pinned FPM with Get 5 and system 7z before offline packaging."""
import hashlib
import json
import os
from pathlib import Path
import subprocess


def prepare(repo, root, run):
    module = repo / 'node_modules/app-builder-lib/out/toolsets/linux.js'
    assert json.loads((repo / 'node_modules/app-builder-lib/package.json').read_text())['version'] == '26.15.3'
    assert json.loads((repo / 'node_modules/@electron/get/package.json').read_text())['version'] == '5.1.0'
    name = 'fpm-1.17.0-ruby-3.4.3-linux-amd64.7z'
    digest = '44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f'
    assert digest in module.read_text(), 'locked FPM checksum changed'
    url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/fpm@2.1.4/' + name
    cache = root / 'builder-cache'
    assert not cache.exists(), 'fresh private builder cache required'
    request = {'isGeneric': True, 'version': '2.1.4', 'artifactName': name,
               'checksums': {name: digest}, 'cacheRoot': str(cache / 'archives')}
    script = "const get=require('@electron/get');const options=JSON.parse(process.argv[1]);options.mirrorOptions={resolveAssetURL:async()=>process.argv[2]};get.downloadArtifact(options).then(p=>console.log('FPM_ARCHIVE '+p)).catch(e=>{console.error(e);process.exit(1)})"
    result = run(['node', '-e', script, json.dumps(request), url], stdout=subprocess.PIPE)
    paths = [line[12:] for line in result.stdout.decode().splitlines() if line.startswith('FPM_ARCHIVE ')]
    assert len(paths) == 1
    archive = Path(paths[0]).resolve()
    assert archive.is_relative_to(cache.resolve()) and archive.is_file()
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest, 'FPM archive checksum mismatch'
    directory = cache / 'fpm'
    directory.mkdir(mode=0o755)
    run(['/usr/bin/7z', 'x', str(archive), '-o' + str(directory), '-y'], stdout=subprocess.DEVNULL)
    executable = directory / 'fpm'
    assert executable.is_file() and os.access(executable, os.X_OK), 'prepared FPM absent'

    def file_sha(path):
        result = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1048576), b''):
                result.update(chunk)
        return result.hexdigest()

    files = {str(path.relative_to(directory)): file_sha(path)
             for path in sorted(directory.rglob('*')) if path.is_file()}
    receipt = {'archive': name, 'archive_sha256': digest, 'source_url': url,
               'builder_version': '26.15.3', 'get_version': '5.1.0',
               'toolset_module_sha256': file_sha(module), 'executable': str(executable),
               'directory': str(directory), 'files': files}
    (root / 'fpm-cache.json').write_text(json.dumps(receipt, indent=2) + '\n')
