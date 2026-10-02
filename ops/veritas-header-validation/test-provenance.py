"""Defensive fixtures for the dependency identity gate; no Rust execution."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('conformance', Path(__file__).with_name('check.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'


def package(name, version, checksum=None, source=None):
    lines = ['[[package]]', f'name = "{name}"', f'version = "{version}"']
    if checksum is not None:
        lines.append(f'checksum = "{checksum}"')
    if source is not None:
        lines.append(f'source = "{source}"')
    return '\n'.join(lines) + '\n'


class ProvenanceTests(unittest.TestCase):
    def validate(self, original, dependencies, own=None):
        if own is None:
            own = package('freedom-header-conformance', '0.1.0')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / 'original.lock', root / 'component.lock'
            first.write_text(original)
            second.write_text(own + dependencies)
            return MODULE.validate_lock(first, second)

    def test_accepts_an_exact_registry_subset(self):
        bitcoin = package('bitcoin', '0.32.8', 'a' * 64, REGISTRY)
        result = self.validate(bitcoin + package('unused', '1.0.0', 'b' * 64, REGISTRY), bitcoin)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['version'], '0.32.8')

    def test_refuses_changed_checksum_or_version(self):
        original = package('bitcoin', '0.32.8', 'a' * 64, REGISTRY)
        for changed in [package('bitcoin', '0.32.8', 'b' * 64, REGISTRY),
                        package('bitcoin', '0.32.9', 'a' * 64, REGISTRY)]:
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'dependency_identity_changed'):
                self.validate(original, changed)

    def test_refuses_unpinned_dependency(self):
        bitcoin = package('bitcoin', '0.32.8', 'a' * 64, REGISTRY)
        with self.assertRaisesRegex(RuntimeError, 'dependency_identity_changed'):
            self.validate(bitcoin, bitcoin + package('extra', '1.0.0', 'b' * 64, REGISTRY))

    def test_refuses_git_path_and_missing_integrity(self):
        for source, checksum in [(None, None), ('git+https://example.invalid/crate', 'a' * 64),
                                 (REGISTRY, None)]:
            dependency = package('bitcoin', '0.32.8', checksum, source)
            with self.subTest(source=source), self.assertRaisesRegex(RuntimeError, 'dependency_identity_changed'):
                self.validate(dependency, dependency)

    def test_refuses_missing_bitcoin(self):
        dependency = package('other', '1.0.0', 'a' * 64, REGISTRY)
        with self.assertRaisesRegex(RuntimeError, 'bitcoin_pin_missing'):
            self.validate(dependency, dependency)

    def test_refuses_changed_or_duplicate_owned_identity(self):
        bitcoin = package('bitcoin', '0.32.8', 'a' * 64, REGISTRY)
        for owned in ['', package('freedom-header-conformance', '0.2.0'),
                      package('freedom-header-conformance', '0.1.0', 'a' * 64, REGISTRY),
                      package('freedom-header-conformance', '0.1.0') * 2]:
            with self.subTest(owned=owned), self.assertRaisesRegex(RuntimeError, 'owned_package_identity'):
                self.validate(bitcoin, bitcoin, owned)


if __name__ == '__main__':
    unittest.main()
