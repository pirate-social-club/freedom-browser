import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('retain_package', Path(__file__).with_name('retain-package.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetainedPackageTests(unittest.TestCase):
    def test_only_verified_installed_bytes_are_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work, output = root / 'work', root / 'public'
            (work / 'build').mkdir(parents=True)
            output.mkdir()
            package = work / 'build/test.deb'
            package.write_bytes(b'accepted evaluation package')
            (work / 'private-key').write_text('private fixture')
            receipt = {'installation_proved': True, 'package': 'freedom-browser', 'version': '0.7.15', 'deb_sha256': module.digest(package)}
            (work / 'installed-deb.json').write_text(json.dumps(receipt))
            (work / 'candidate-integrity.json').write_text(json.dumps({'Freedom_source': 'source', 'installed_deb_payload_matched': True}))
            with self.assertRaisesRegex(AssertionError, 'retained_deb_source'):
                module.retain(work, output, 'other-source')
            package.write_bytes(b'changed bytes')
            with self.assertRaisesRegex(AssertionError, 'retained_deb_bytes'):
                module.retain(work, output, 'source')
            package.write_bytes(b'accepted evaluation package')
            def interrupted_copy(_source, target):
                Path(target).write_bytes(b'partial copy')
                raise OSError('copy fixture')
            with patch.object(module.shutil, 'copyfile', side_effect=interrupted_copy):
                with self.assertRaises(OSError):
                    module.retain(work, output, 'source')
            self.assertEqual(list(output.iterdir()), [])
            with patch.object(module.shutil, 'copyfile', side_effect=lambda _source, target: Path(target).write_bytes(b'wrong copy')):
                with self.assertRaisesRegex(AssertionError, 'retained_deb_copy'):
                    module.retain(work, output, 'source')
            self.assertEqual(list(output.iterdir()), [])
            retained = module.retain(work, output, 'source')
            self.assertEqual([path.name for path in output.iterdir()], [retained['file']])
            self.assertEqual(module.digest(output / retained['file']), receipt['deb_sha256'])
            self.assertFalse(retained['public_release'])


if __name__ == '__main__':
    unittest.main()
