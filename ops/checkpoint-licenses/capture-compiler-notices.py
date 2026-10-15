"""Retain official compiler license texts without building or executing helpers."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--archive-directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: retain official Go source metadata and compiler notices')
        return
    metadata_url = 'https://go.dev/dl/?mode=json&include=all'
    metadata = json.loads(urllib.request.urlopen(metadata_url, timeout=60).read())
    release = next(item for item in metadata if item['version'] == args.version)
    entry = next(item for item in release['files'] if item['kind'] == 'source')
    assert entry['filename'] == args.version + '.src.tar.gz'
    args.archive_directory.mkdir(parents=True, exist_ok=True)
    args.output_directory.mkdir(parents=True, exist_ok=True)
    archive = args.archive_directory / entry['filename']
    url = 'https://go.dev/dl/' + entry['filename']
    if not archive.exists():
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
            while chunk := response.read(1048576):
                output.write(chunk)
                assert output.tell() <= entry['size'], 'compiler_source_oversize'
    assert archive.stat().st_size == entry['size']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == entry['sha256'], 'compiler_source_hash'
    records, notices = [], []
    with tarfile.open(archive) as source:
        for member in source:
            if not member.isfile():
                continue
            basename = Path(member.name).name.upper()
            if not basename.startswith(('LICENSE', 'COPYING', 'COPYRIGHT', 'NOTICE', 'PATENTS')) or basename.endswith(('.GO', '.JS', '.RS')):
                continue
            content = source.extractfile(member).read()
            records.append({'source_path': member.name, 'sha256': hashlib.sha256(content).hexdigest()})
            notices.append('\n\n===== ' + member.name + ' =====\n\n' + content.decode())
    assert {'go/LICENSE', 'go/PATENTS'} <= {record['source_path'] for record in records}
    (args.output_directory / 'GO-COMPILER-NOTICES.txt').write_text('Original compiler-source notices; inclusion is conservative.\n' + ''.join(notices))
    (args.output_directory / 'go-compiler-source-record.json').write_text(json.dumps({
        'compiler': args.version, 'metadata_url': metadata_url, 'source_url': url,
        'source_sha256': entry['sha256'], 'source_size': entry['size'], 'notices': records,
        'executed_target': False}, indent=2) + '\n')
    print('Retained', args.version, 'and', len(records), 'notice files', flush=True)


if __name__ == '__main__':
    main()
