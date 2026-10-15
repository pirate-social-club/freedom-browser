"""Capture source and notice bytes from a helper's embedded Go module hashes."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.request
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build-info', type=Path, required=True)
    parser.add_argument('--archive-directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: retain checksum-bound Go module sources and notices; no target execution')
        return
    args.archive_directory.mkdir(parents=True, exist_ok=True)
    args.output_directory.mkdir(parents=True, exist_ok=True)
    observed = args.build_info.read_bytes()
    compiler = re.search(r': (go\d+\.\d+\.\d+)\n', observed.decode()).group(1)
    deadline = time.monotonic() + 1700
    records = []
    notices = []

    def escape(value):
        return re.sub('[A-Z]', lambda match: '!' + match[0].lower(), value)

    def obtain(url, destination):
        if destination.exists():
            return destination.read_bytes()
        assert time.monotonic() < deadline, 'capture_deadline'
        data = urllib.request.urlopen(url, timeout=min(60, deadline - time.monotonic())).read()
        assert len(data) <= 128 * 1024 * 1024, 'source_archive_too_large'
        destination.write_bytes(data)
        return data

    for line in observed.decode().splitlines():
        if not line.startswith('\tdep\t') and not (line.startswith('\tmod\t') and '\th1:' in line):
            continue
        fields = line.split('\t')
        assert len(fields) == 5 and fields[4].startswith('h1:'), 'module_hash_missing'
        _, _, module, version, expected = fields
        url = 'https://proxy.golang.org/' + escape(module) + '/@v/' + escape(version) + '.zip'
        destination = args.archive_directory / (hashlib.sha256(url.encode()).hexdigest() + '.zip')
        data = obtain(url, destination)
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = sorted(archive.namelist())
        aggregate = hashlib.sha256()
        module_notices = []
        for name in names:
            assert not archive.getinfo(name).is_dir(), 'unexpected_go_zip_directory'
            content = archive.read(name)
            digest = hashlib.sha256(content).hexdigest()
            aggregate.update((digest + '  ' + name + '\n').encode())
            basename = Path(name).name.upper()
            if basename.startswith(('LICENSE', 'COPYING', 'COPYRIGHT', 'NOTICE', 'PATENTS')) and not basename.endswith(('.GO', '.JS', '.RS')):
                module_notices.append({'source_path': name, 'sha256': digest})
                notices.append('\n\n===== ' + name + ' =====\n\n' + content.decode('utf-8', errors='strict'))
        actual = 'h1:' + base64.b64encode(aggregate.digest()).decode()
        assert actual == expected, 'module_source_hash_changed: ' + module
        records.append({'module': module, 'version': version, 'h1': actual, 'source_url': url,
                        'archive_sha256': hashlib.sha256(data).hexdigest(), 'notices': module_notices})
        if len(records) % 25 == 0:
            print('Verified', len(records), 'module archives', flush=True)
    assert records, 'no_module_observations'
    missing = [record['module'] for record in records if not record['notices']]
    inventory = {'compiler': compiler, 'build_info_sha256': hashlib.sha256(observed).hexdigest(),
                 'modules': records, 'modules_without_notice_files': missing,
                 'executed_target': False, 'installed_packages': False}
    (args.output_directory / 'go-module-source-record.json').write_text(json.dumps(inventory, indent=2) + '\n')
    (args.output_directory / 'GO-MODULE-NOTICES.txt').write_text('Original notices from checksum-bound module archives. Inclusion is conservative; an archive can include code outside the final executable.\n' + ''.join(notices))
    print('Captured', len(records), 'modules;', len(missing), 'need separate notice review', flush=True)


if __name__ == '__main__':
    main()
