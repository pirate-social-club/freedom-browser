"""Bind the locked npm package, downloaded archive and installed runtime bytes."""
import hashlib
import json
import re
import zipfile
from pathlib import Path

VERSION = '42.10.0'
ARCHIVE = 'electron-v42.10.0-linux-x64.zip'


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(chunk)
    return result.hexdigest()


def file_digest(path):
    with Path(path).open('rb') as stream:
        return digest(stream)


def npm_identity(repo):
    lock = repo / 'package-lock.json'
    package = json.loads(lock.read_text())['packages']['node_modules/electron']
    assert package['version'] == VERSION, 'electron_lock_version'
    assert package['resolved'] == 'https://registry.npmjs.org/electron/-/electron-42.10.0.tgz', 'electron_npm_origin'
    assert re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', package['integrity']), 'electron_npm_integrity'
    return {'version': VERSION, 'resolved': package['resolved'], 'integrity': package['integrity'],
            'lockfile_sha256': file_digest(lock)}


def distribution_proof(repo, cache, source):
    package = npm_identity(repo)
    directory = repo / 'node_modules/electron'
    assert json.loads((directory / 'package.json').read_text())['version'] == VERSION, 'electron_installed_npm_version'
    version_file = directory / 'dist/version'
    assert version_file.read_text().strip().lstrip('v') == VERSION, 'electron_distribution_version'
    expected = json.loads((directory / 'checksums.json').read_text())[ARCHIVE]
    assert re.fullmatch('[0-9a-f]{64}', expected), 'electron_archive_digest_format'
    archives = list(cache.rglob(ARCHIVE))
    assert len(archives) == 1 and archives[0].is_file(), 'electron_archive_identity'
    archive_digest = file_digest(archives[0])
    assert archive_digest == expected, 'electron_archive_digest'
    with zipfile.ZipFile(archives[0]) as archive:
        assert archive.namelist().count('version') == 1 and archive.namelist().count('electron') == 1, 'electron_archive_members'
        assert archive.getinfo('version').file_size <= 32, 'electron_archive_version_size'
        assert archive.read('version').decode().strip().lstrip('v') == VERSION, 'electron_archive_version'
        with archive.open('electron') as executable:
            executable_digest = digest(executable)
    assert executable_digest == file_digest(directory / 'dist/electron'), 'electron_distribution_executable'
    return {'passed': True, 'source': source, 'version': VERSION, 'npm': package,
            'npm_ci_integrity_checked': True, 'archive': ARCHIVE,
            'archive_sha256': archive_digest, 'archive_matches_npm_checksums': True,
            'checksums_file_sha256': file_digest(directory / 'checksums.json'),
            'distribution_version_file_sha256': file_digest(version_file),
            'archive_version_matches': True, 'archive_executable_matches_distribution': True,
            'distribution_executable_sha256': executable_digest}


def installed_proof(repo, cold_root, installed, package, source):
    cold = json.loads((cold_root / 'cold-setup.json').read_text())['electron_version_provenance']
    assert cold['passed'] is True and cold['source'] == source, 'electron_cold_source'
    assert cold['npm'] == npm_identity(repo) and cold['version'] == VERSION, 'electron_cold_lock'
    directory = repo / 'node_modules/electron'
    assert file_digest(directory / 'checksums.json') == cold['checksums_file_sha256'], 'electron_checksums_changed'
    assert file_digest(directory / 'dist/version') == cold['distribution_version_file_sha256'], 'electron_version_file_changed'
    hashes = {'distribution_executable_sha256': file_digest(directory / 'dist/electron'),
              'package_executable_sha256': file_digest(package),
              'installed_executable_sha256': file_digest(installed)}
    assert set(hashes.values()) == {cold['distribution_executable_sha256']}, 'electron_installed_byte_chain'
    return {**cold, **hashes, 'installed_package_distribution_match': True}


def validated_runtime_digest(proof, source):
    assert proof['passed'] is True and proof['source'] == source and proof['version'] == VERSION, 'electron_runtime_provenance'
    for key in ['npm_ci_integrity_checked', 'archive_matches_npm_checksums', 'archive_version_matches',
                'archive_executable_matches_distribution', 'installed_package_distribution_match']:
        assert proof[key] is True, 'electron_runtime_chain_link'
    assert proof['npm']['version'] == VERSION and proof['archive'] == ARCHIVE, 'electron_runtime_version'
    hashes = [proof[key] for key in ['distribution_executable_sha256', 'package_executable_sha256', 'installed_executable_sha256']]
    assert len(set(hashes)) == 1 and re.fullmatch('[0-9a-f]{64}', hashes[0]), 'electron_runtime_digest'
    return hashes[0]


def runtime_receipt(proof_path, candidate_path, source):
    raw = proof_path.read_bytes()
    proof_digest = hashlib.sha256(raw).hexdigest()
    candidate = json.loads(candidate_path.read_text())
    assert candidate['Freedom_source'] == source and candidate['Electron_version_proof_sha256'] == proof_digest, 'electron_candidate_proof_binding'
    executable_digest = validated_runtime_digest(json.loads(raw), source)
    assert candidate['Electron_executable_sha256'] == executable_digest, 'electron_candidate_executable_binding'
    return {'version': VERSION, 'installed_executable_sha256': executable_digest,
            'provenance_sha256': proof_digest, 'passed': False}
