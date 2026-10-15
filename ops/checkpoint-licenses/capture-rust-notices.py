"""Capture pinned Radicle source and conservative dependency notices without builds."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tomllib
import urllib.request

PROJECTS = {
    'radicle': ('radicle-dev/heartwood', '4641c342c689dd9c549af6c0235256fe225b53a7'),
    'radicle-httpd': ('radicle-dev/radicle-explorer', '427cece9850944d30f0d49ccd016f98dacd77d75'),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', choices=PROJECTS, required=True)
    parser.add_argument('--archive-directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: retain pinned Rust sources and original notices; no build')
        return
    args.archive_directory.mkdir(parents=True, exist_ok=True)
    args.output_directory.mkdir(parents=True, exist_ok=True)
    records, notices, missing = [], [], []

    def obtain(url, expected=None):
        path = args.archive_directory / (hashlib.sha256(url.encode()).hexdigest() + '.tar.gz')
        if not path.exists():
            with urllib.request.urlopen(url, timeout=60) as response, path.open('wb') as output:
                while chunk := response.read(1048576):
                    output.write(chunk)
                    assert output.tell() <= 128 * 1024 * 1024, 'source_archive_oversize'
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        assert expected is None or digest == expected, 'crate_checksum_changed'
        return data, digest

    def capture(label, url, expected=None, httpd=False):
        data, digest = obtain(url, expected)
        entries = []
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive:
                basename = Path(member.name).name.upper()
                if not member.isfile() or not basename.startswith(('LICENSE', 'COPYING', 'COPYRIGHT', 'NOTICE', 'PATENTS')) or basename.endswith(('.RS', '.C', '.H', '.GO', '.JS')):
                    continue
                # Explorer's root GPL license belongs to its UI, not the httpd crate.
                if httpd and '/crates/radicle-httpd/' not in member.name:
                    continue
                content = archive.extractfile(member).read()
                entries.append({'source_path': member.name, 'sha256': hashlib.sha256(content).hexdigest()})
                notices.append('\n\n===== ' + member.name + ' =====\n\n' + content.decode())
        records.append({'component': label, 'source_url': url, 'archive_sha256': digest, 'notices': entries})
        if not entries:
            missing.append(label)
        return data

    repository, revision = PROJECTS[args.project]
    source_url = 'https://codeload.github.com/' + repository + '/tar.gz/' + revision
    source = capture(args.project, source_url, httpd=args.project == 'radicle-httpd')
    with tarfile.open(fileobj=io.BytesIO(source)) as archive:
        locks = [member for member in archive if member.name.count('/') == 1 and member.name.endswith('/Cargo.lock')]
        assert len(locks) == 1, 'project_lock_count'
        lock_bytes = archive.extractfile(locks[0]).read()
    lock = tomllib.loads(lock_bytes.decode())
    seen_git = set()
    for package in lock['package']:
        origin = package.get('source', '')
        label = package['name'] + '@' + package['version']
        if origin.startswith('registry+'):
            assert origin == 'registry+https://github.com/rust-lang/crates.io-index', 'unexpected_crate_registry'
            capture(label, 'https://static.crates.io/crates/' + package['name'] + '/' + package['name'] + '-' + package['version'] + '.crate', package['checksum'])
        elif origin.startswith('git+') and origin not in seen_git:
            seen_git.add(origin)
            match = re.fullmatch(r'git\+https://github.com/([^?#]+)(?:\?[^#]+)?#([0-9a-f]{40})', origin)
            if match:
                capture(origin, 'https://codeload.github.com/' + match[1].removesuffix('.git') + '/tar.gz/' + match[2])
            else:
                remote = 'https://seed.radicle.dev/z2UcCU1LgMshWvXj6hXSDDrwB8q8M/z6MkwPUeUS2fJMfc2HZN1RQTQcTTuhw4HhPySB8JeUg2mVvx'
                locked_revision = '77cf8fb415f1f9026fb8a0bd5ef807eca54f69d4'
                assert origin.startswith('git+' + remote + '?') and origin.endswith('#' + locked_revision), 'unsupported_git_source'
                evidence = args.archive_directory / ('git-' + locked_revision)
                git_environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_') and key not in ['GITHUB_TOKEN', 'GH_TOKEN']}
                git_environment.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'})
                if not evidence.exists():
                    subprocess.run(['git', 'init', '--bare', '--template=', str(evidence)], check=True, timeout=10, stdout=subprocess.DEVNULL, env=git_environment)
                git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-C', str(evidence)]
                subprocess.run(git + ['fetch', remote, locked_revision + ':refs/evidence/locked'], check=True, timeout=240, env=git_environment)
                observed = subprocess.check_output(git + ['rev-parse', 'refs/evidence/locked'], text=True, timeout=10, env=git_environment).strip()
                assert observed == locked_revision, 'locked_git_revision_changed'
                tree = subprocess.check_output(git + ['rev-parse', locked_revision + '^{tree}'], text=True, timeout=10, env=git_environment).strip()
                subprocess.run(git + ['bundle', 'create', str(evidence.parent / (locked_revision + '.bundle')), 'refs/evidence/locked'], check=True, timeout=30, env=git_environment)
                data = subprocess.check_output(git + ['archive', '--format=tar.gz', '--prefix=radicle-job/', locked_revision], timeout=30, env=git_environment)
                cache_url = remote + '#' + locked_revision
                (args.archive_directory / (hashlib.sha256(cache_url.encode()).hexdigest() + '.tar.gz')).write_bytes(data)
                capture(origin, cache_url, hashlib.sha256(data).hexdigest())
                records[-1]['git_tree'] = tree
        elif origin:
            assert origin.startswith('git+'), 'unexpected_source'
        if len(records) % 25 == 0:
            print('Captured', args.project, len(records), 'sources', flush=True)
    (args.output_directory / 'RUST-NOTICES.txt').write_text('Original source-archive notices. The complete lock graph is conservative and includes non-shipped build/test/platform code.\n' + ''.join(notices))
    (args.output_directory / 'rust-source-record.json').write_text(json.dumps({
        'project': args.project, 'source_revision': revision, 'lock_sha256': hashlib.sha256(lock_bytes).hexdigest(),
        'sources': records, 'sources_without_notice_files': missing, 'executed_target': False,
        'reproducible_build_proved': False}, indent=2) + '\n')
    print('Finished', args.project, len(records), 'sources;', len(missing), 'need separate review', flush=True)


if __name__ == '__main__':
    main()
