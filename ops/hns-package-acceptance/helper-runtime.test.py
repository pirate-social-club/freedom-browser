import runpy
from pathlib import Path
import unittest

validate = runpy.run_path(str(Path(__file__).with_name('helper-runtime.py')))['validate_elf']


class ElfContract(unittest.TestCase):
    def test_expected_contract(self):
        validate('/lib64/ld-linux-x86-64.so.2',
                 'Shared library: [libunbound.so.8]\nShared library: [libc.so.6]', 'GLIBC_2.2 GLIBC_2.36')

    def test_rejects_unexpected_soname_and_search_paths(self):
        for extra in ['\nShared library: [libssl.so.3]', '\nRPATH', '\nRUNPATH']:
            with self.subTest(extra=extra), self.assertRaises(AssertionError):
                validate('/lib64/ld-linux-x86-64.so.2',
                         'Shared library: [libunbound.so.8]\nShared library: [libc.so.6]' + extra, 'GLIBC_2.36')

    def test_rejects_changed_interpreter_or_glibc_requirement(self):
        for program, versions in [('static', 'GLIBC_2.36'), ('/lib64/ld-linux-x86-64.so.2', 'GLIBC_2.38')]:
            with self.subTest(program=program, versions=versions), self.assertRaises(AssertionError):
                validate(program, 'Shared library: [libunbound.so.8]\nShared library: [libc.so.6]', versions)


if __name__ == '__main__':
    unittest.main()
