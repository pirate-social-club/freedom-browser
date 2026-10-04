"""Import reviewed helper bytes and notices; never execute either helper."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

HNSD_SHA = 'ed2e2f8f22b60fa3e17a8a74445174540d6b4f1903d5849c9e27baee120182d2'
SOURCE_SHA = 'd5411e7bac5d0d78bffb392c3af2888abba966ae6e12b8d42ce984949be509b1'
FINGERTIP_SHA = '065e4f0d5c118213f09319998c94633033cae7f96dc6d714083208468225f766'
EVIDENCE_PINS = {'receipt.json': '5ec2ce6fd4b40ab43f179394cd3db851214a762837a343db45eeead6d2a02dac',
                 'go-notice-receipt.json': '15734db9ca2afa3f3cb00c582d96c47796f49293a7b0edb96215e78d345b3731',
                 'fingertip-source.tar': '2b0a39abfa0172bc47e522f57d17d7539f1d9f266915473f06e4260e6452abb7'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--fingertip-evidence', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: import reviewed hnsd and HNS helper notices, without execution')
        return
    repo = Path(__file__).resolve().parents[2]
    assert subprocess.check_output(['git', 'branch', '--show-current'], cwd=repo, text=True).strip() == 'release/security-checkpoint-0.7.15'
    target = repo / 'hns-bin/linux-x64'
    binary = (args.artifact / 'hnsd').read_bytes()
    source = (args.artifact / 'hnsd-source.tar').read_bytes()
    assert hashlib.sha256(binary).hexdigest() == HNSD_SHA
    assert hashlib.sha256(source).hexdigest() == SOURCE_SHA
    assert hashlib.sha256((target / 'fingertipd').read_bytes()).hexdigest() == FINGERTIP_SHA
    for name, expected in EVIDENCE_PINS.items():
        assert hashlib.sha256((args.fingertip_evidence / name).read_bytes()).hexdigest() == expected, 'fingertip_evidence_changed'
    apache = (args.artifact / 'licenses/common-licenses/Apache-2.0').read_bytes()
    assert hashlib.sha256(apache).hexdigest() == 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'apache_license_changed'
    notice_root = target / 'licenses'
    notice_root.mkdir(exist_ok=True)
    records = []

    def retain(label, name, content, origin):
        folder = notice_root / label
        folder.mkdir(exist_ok=True)
        path = folder / name
        path.write_bytes(content)
        records.append({'path': str(path.relative_to(target)), 'source_path': origin,
                        'sha256': hashlib.sha256(content).hexdigest()})

    # Full source preserves included libuv ISC/BSD and embedded crypto notices.
    retain('hnsd', 'source.tar', source, 'hnsd-source.tar')
    with tarfile.open(fileobj=io.BytesIO(source)) as archive:
        for name in ['LICENSE', 'uv/LICENSE', 'src/secp256k1/COPYING']:
            content = archive.extractfile(name).read()
            retain('hnsd', name.replace('/', '-'), content, name)
        for name in ['src/blake2b.c', 'src/blake2b.h', 'src/blake2b-impl.h']:
            retain('hnsd', name.replace('/', '-') + '.txt', archive.extractfile(name).read(), name)
    retain('hnsd', 'LICENSE-APACHE-2.0',
           apache,
           'Debian common-licenses/Apache-2.0')
    evidence = args.fingertip_evidence
    fingertip = json.loads((evidence / 'receipt.json').read_text())
    with tarfile.open(evidence / 'fingertip-source.tar') as archive:
        retain('fingertipd', 'LICENSE-MIT', archive.extractfile('LICENSE').read(), 'LICENSE')
    for module in fingertip['modules']:
        for entry in module['notices']:
            content = (evidence / entry['path']).read_bytes()
            assert hashlib.sha256(content).hexdigest() == entry['sha256']
            retain('fingertipd', str(len(records)) + '-' + Path(entry['path']).name,
                   content, entry['source_path'])
    compiler = json.loads((evidence / 'go-notice-receipt.json').read_text())
    for entry in compiler['notices']:
        if entry['source_path'] not in ['go/LICENSE', 'go/PATENTS'] and not entry['source_path'].startswith('go/src/vendor/'):
            continue
        content = (evidence / entry['path']).read_bytes()
        assert hashlib.sha256(content).hexdigest() == entry['sha256']
        retain('fingertipd', 'go-' + Path(entry['path']).name, content, entry['source_path'])
    inventory = {'hnsd': {'binary_sha256': HNSD_SHA, 'source_commit': 'a5c7c287e848f46d3e97f16b698e2027c8dc96c3',
                         'source_archive_sha256': SOURCE_SHA, 'build_run': 37184107654,
                         'blake2b_license_choice': 'Apache-2.0',
                         'system_libraries': ['libunbound.so.8', 'libc.so.6']},
                 'fingertipd': {'binary_sha256': FINGERTIP_SHA, 'source_commit': fingertip['source'],
                               'source_archive_sha256': fingertip['source_archive_sha256'],
                               'source_url': 'https://github.com/pirate-social-club/fingertipd/tree/' + fingertip['source'],
                               'captured_modules': fingertip['modules'], 'Go_source_url': compiler['source_url'],
                               'Go_source_sha256': compiler['source_sha256']},
                 'notices': records, 'executed_helpers': False}
    (notice_root / 'source-record.json').write_text(json.dumps(inventory, indent=2) + '\n')
    (target / 'hnsd').write_bytes(binary)
    (target / 'hnsd').chmod(0o755)
    print('Imported reviewed helper and', len(records), 'notice/source files; no helper executed')


if __name__ == '__main__':
    main()
