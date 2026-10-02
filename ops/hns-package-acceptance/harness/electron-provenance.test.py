"""Small synthetic archive fixtures; no Electron binary, download or launch."""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest
import zipfile

proof = runpy.run_path(str(Path(__file__).with_name('electron-provenance.py')))


class ElectronProvenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / 'repo';self.repo.mkdir()
        self.cache = self.root / 'cache';self.cache.mkdir()
        self.cold = self.root / 'cold';self.cold.mkdir()
        self.directory = self.repo / 'node_modules/electron'
        (self.directory / 'dist').mkdir(parents=True)
        self.package = {'version': '42.10.0', 'resolved': 'https://registry.npmjs.org/electron/-/electron-42.10.0.tgz',
                        'integrity': 'sha512-' + 'A' * 86 + '=='}
        self.lock = self.repo / 'package-lock.json'
        self.write_lock()
        (self.directory / 'package.json').write_text(json.dumps({'version': '42.10.0'}))
        (self.directory / 'dist/version').write_text('42.10.0')
        (self.directory / 'dist/electron').write_bytes(b'synthetic executable')
        self.archive = self.cache / proof['ARCHIVE']
        self.write_archive()
        self.installed = self.root / 'installed';self.installed.write_bytes(b'synthetic executable')
        self.packaged = self.root / 'packaged';self.packaged.write_bytes(b'synthetic executable')
        self.source = 'a' * 40

    def write_lock(self):
        self.lock.write_text(json.dumps({'packages': {'node_modules/electron': self.package}}))

    def write_archive(self, version='42.10.0', executable=b'synthetic executable'):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('version', version)
            archive.writestr('electron', executable)
        (self.directory / 'checksums.json').write_text(json.dumps({proof['ARCHIVE']: hashlib.sha256(self.archive.read_bytes()).hexdigest()}))

    def distribution(self):
        return proof['distribution_proof'](self.repo, self.cache, self.source)

    def installed_proof(self):
        cold = self.distribution()
        (self.cold / 'cold-setup.json').write_text(json.dumps({'electron_version_provenance': cold}))
        return proof['installed_proof'](self.repo, self.cold, self.installed, self.packaged, self.source)

    def test_complete_chain_records_lock_archive_version_and_bytes(self):
        result = self.installed_proof()
        expected = hashlib.sha256(b'synthetic executable').hexdigest()
        self.assertEqual(proof['validated_runtime_digest'](result, self.source), expected)
        self.assertEqual(result['npm']['integrity'], self.package['integrity'])
        self.assertTrue(result['archive_matches_npm_checksums'])
        self.assertTrue(result['installed_package_distribution_match'])

    def test_wrong_lock_version_origin_or_integrity_refused(self):
        for key, value in [('version', '42.9.0'), ('resolved', 'https://PRIVATE.invalid/'), ('integrity', '')]:
            with self.subTest(key=key):
                old = self.package[key];self.package[key] = value;self.write_lock()
                with self.assertRaises(AssertionError):self.distribution()
                self.package[key] = old;self.write_lock()

    def test_corrupted_archive_refused(self):
        with self.archive.open('ab') as archive:archive.write(b'changed')
        with self.assertRaisesRegex(AssertionError, '^electron_archive_digest$'):self.distribution()

    def test_archive_version_and_executable_are_checked_independently(self):
        self.write_archive(version='42.9.0')
        with self.assertRaisesRegex(AssertionError, '^electron_archive_version$'):self.distribution()
        self.write_archive(executable=b'wrong executable')
        with self.assertRaisesRegex(AssertionError, '^electron_distribution_executable$'):self.distribution()

    def test_missing_and_multiple_archives_refused(self):
        self.archive.rename(self.cache / 'different-name.zip')
        with self.assertRaisesRegex(AssertionError, '^electron_archive_identity$'):self.distribution()
        (self.cache / 'different-name.zip').rename(self.archive)
        extra = self.cache / 'extra';extra.mkdir();(extra / proof['ARCHIVE']).write_bytes(self.archive.read_bytes())
        with self.assertRaisesRegex(AssertionError, '^electron_archive_identity$'):self.distribution()

    def test_changed_installed_or_packaged_bytes_refused(self):
        for path in [self.installed, self.packaged]:
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(AssertionError, '^electron_installed_byte_chain$'):self.installed_proof()
            path.write_bytes(b'synthetic executable')

    def test_runtime_rejects_wrong_source_and_missing_chain_links(self):
        result = self.installed_proof()
        with self.assertRaisesRegex(AssertionError, '^electron_runtime_provenance$'):
            proof['validated_runtime_digest'](result, 'b' * 40)
        for key in ['npm_ci_integrity_checked', 'archive_matches_npm_checksums', 'archive_version_matches',
                    'archive_executable_matches_distribution', 'installed_package_distribution_match']:
            candidate = copy.deepcopy(result);candidate[key] = False
            with self.assertRaisesRegex(AssertionError, '^electron_runtime_chain_link$'):
                proof['validated_runtime_digest'](candidate, self.source)
        result['installed_executable_sha256'] = 'b' * 64
        with self.assertRaisesRegex(AssertionError, '^electron_runtime_digest$'):
            proof['validated_runtime_digest'](result, self.source)

    def test_cold_proof_cannot_be_reused_after_distribution_change(self):
        self.installed_proof()
        (self.directory / 'dist/version').write_text('42.10.0\n')
        with self.assertRaisesRegex(AssertionError, '^electron_version_file_changed$'):
            proof['installed_proof'](self.repo, self.cold, self.installed, self.packaged, self.source)

    def test_runtime_binds_exact_provenance_and_executable_to_candidate(self):
        result = self.installed_proof()
        receipt = self.root / 'proof.json';receipt.write_text(json.dumps(result))
        candidate = self.root / 'candidate.json'
        data = {'Freedom_source': self.source, 'Electron_version_proof_sha256': hashlib.sha256(receipt.read_bytes()).hexdigest(),
                'Electron_executable_sha256': result['installed_executable_sha256']}
        candidate.write_text(json.dumps(data))
        observed = proof['runtime_receipt'](receipt, candidate, self.source)
        self.assertEqual(observed['version'], '42.10.0')
        self.assertEqual(observed['installed_executable_sha256'], result['installed_executable_sha256'])
        for key in data:
            modified = {**data, key: 'b' * 64};candidate.write_text(json.dumps(modified))
            with self.subTest(key=key), self.assertRaises(AssertionError):
                proof['runtime_receipt'](receipt, candidate, self.source)
        candidate.write_text(json.dumps(data));receipt.write_text(json.dumps(result) + '\n')
        with self.assertRaisesRegex(AssertionError, '^electron_candidate_proof_binding$'):
            proof['runtime_receipt'](receipt, candidate, self.source)


if __name__ == '__main__':
    unittest.main()
