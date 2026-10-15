"""Retain only the installed evaluation deb, bound to its acceptance receipt."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            value.update(chunk)
    return value.hexdigest()


def retain(work, destination, source):
    work, destination = Path(work), Path(destination)
    installed = json.loads((work / 'installed-deb.json').read_text())
    integrity = json.loads((work / 'candidate-integrity.json').read_text())
    assert installed['installation_proved'] is True, 'retained_deb_not_installed'
    assert installed['package'] == 'freedom-browser' and installed['version'] == '0.7.15', 'retained_deb_identity'
    assert integrity['Freedom_source'] == source and integrity['installed_deb_payload_matched'] is True, 'retained_deb_source'
    packages = list((work / 'build').glob('*.deb'))
    assert len(packages) == 1 and not packages[0].is_symlink(), 'retained_deb_count'
    package = packages[0]
    assert digest(package) == installed['deb_sha256'], 'retained_deb_bytes'
    output = destination / 'freedom-browser-0.7.15-linux-amd64-evaluation.deb'
    assert not output.exists() and not output.is_symlink(), 'retained_deb_destination_exists'
    # Verify outside the upload directory, then publish without overwriting any file.
    with tempfile.TemporaryDirectory(prefix='freedom-deb-retention-', dir=destination.parent) as staging:
        staged = Path(staging) / 'verified.deb'
        shutil.copyfile(package, staged)
        assert digest(staged) == installed['deb_sha256'], 'retained_deb_copy'
        os.link(staged, output)
    return {'file': output.name, 'sha256': installed['deb_sha256'], 'source': source,
            'evaluation_only': True, 'public_release': False}
