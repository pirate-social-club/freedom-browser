"""Recover notices for explicit crate grants; no builds or target execution."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile
import tomllib
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive-directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: retain explicit crate grants and matching original notices')
        return
    args.output_directory.mkdir(parents=True, exist_ok=True)
    projects = [json.loads(path.read_text()) for path in Path('assets/third-party-licenses').glob('radicle*/rust-source-record.json')]
    sources = {entry['component']: entry for project in projects for entry in project['sources']}
    missing = sorted({name for project in projects for name in project['sources_without_notice_files']})
    originals, records = [], []

    def fetch(url):
        cache = args.archive_directory / (hashlib.sha256(url.encode()).hexdigest() + '.notice')
        if cache.exists():
            return cache.read_bytes()
        try:
            data = urllib.request.urlopen(url, timeout=20).read(1048577)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
        assert 0 < len(data) <= 1048576, 'notice_size'
        cache.write_bytes(data)
        return data

    def retain(label, origin, content):
        originals.append('\n\n===== ' + label + ': ' + origin + ' =====\n\n' + content.decode())
        return {'source': origin, 'sha256': hashlib.sha256(content).hexdigest()}

    for label in missing:
        entry = sources[label]
        path = args.archive_directory / (hashlib.sha256(entry['source_url'].encode()).hexdigest() + '.tar.gz')
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['archive_sha256'], 'source_archive_changed'
        with tarfile.open(path) as archive:
            members = [member for member in archive if member.isfile()]
            cargo = next(member for member in members if member.name.count('/') == 1 and member.name.endswith('/Cargo.toml'))
            manifest = archive.extractfile(cargo).read()
            package = tomllib.loads(manifest.decode())['package']
            declaration = package['license']
            selected = next(license_id for license_id in ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'Unlicense'] if license_id in re.split(r'\s+|/', declaration))
            notices = [retain(label, cargo.name, manifest)]
            vcs = next((member for member in members if member.name.endswith('/.cargo_vcs_info.json')), None)
            metadata = {}
            if vcs:
                raw = archive.extractfile(vcs).read()
                metadata = json.loads(raw)
                notices.append(retain(label, vcs.name, raw))
            for member in members:
                if member.name.rsplit('/', 1)[-1].upper() in ['README', 'README.MD', 'AUTHORS', 'AUTHORS.MD', 'COPYRIGHT', 'COPYRIGHT.MD']:
                    notices.append(retain(label, member.name, archive.extractfile(member).read()))
                if not member.name.endswith(('.rs', '.c', '.h')):
                    continue
                header = b''.join(archive.extractfile(member).read().splitlines(keepends=True)[:100])
                if b'copyright' in header.lower():
                    notices.append(retain(label, member.name + ' first 100 lines', header))
        canonical = 'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/' + selected + '.txt'
        text = fetch(canonical)
        assert text, 'full_license_text_missing'
        notices.append(retain(label, canonical, text))
        repository = package.get('repository', '')
        match = re.fullmatch(r'https://github.com/([^?#]+?)(?:\.git)?/?', repository)
        commit = metadata.get('git', {}).get('sha1', '')
        if match and re.fullmatch('[0-9a-f]{40}', commit):
            subpath = metadata.get('path_in_vcs', '').strip('/')
            assert '..' not in subpath.split('/'), 'vcs_path'
            for folder in sorted({'', subpath}):
                for name in ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'NOTICE.md', 'UNLICENSE', 'AUTHORS', 'README.md']:
                    url = 'https://raw.githubusercontent.com/' + match[1].removesuffix('.git').rstrip('/') + '/' + commit + '/' + (folder + '/' if folder else '') + name
                    content = fetch(url)
                    if content:
                        notices.append(retain(label, url, content))
        radicle_revisions = {'71a91042d96bb994c4cd4311d85f5cd1a6311b4e',
                             'fd892d006ff0b107533257b1427d3781c5586588',
                             'a0b434c3201d398732bff3c3c7e92978a7427416'}
        if label.startswith('radicle') and commit in radicle_revisions:
            # This mirror supplies original notices, not a producer-source claim.
            url = 'https://raw.githubusercontent.com/radicle-dev/heartwood/' + commit + '/LICENSE-MIT'
            content = fetch(url)
            assert content, 'radicle_original_notice_missing'
            notices.append(retain(label, url, content))
        records.append({'component': label, 'declaration': declaration, 'selected_license': selected,
                        'source_archive_sha256': entry['archive_sha256'], 'vcs': metadata,
                        'source_reconstruction_proved': False, 'notices': notices})
        print('Recovered explicit grant/notices for', label.split('#')[0], flush=True)
    (args.output_directory / 'SUPPLEMENTAL-NOTICES.txt').write_text('Original crate declarations, source attribution and license texts. Selection follows an explicit offered license. Metadata does not claim source reconstruction.\n' + ''.join(originals))
    (args.output_directory / 'supplemental-source-record.json').write_text(json.dumps({'components': records, 'executed_target': False}, indent=2) + '\n')


if __name__ == '__main__':
    main()
