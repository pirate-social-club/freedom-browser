"""Observe the pinned hnsd's ELF and system-library contract on the runner."""
import hashlib
import os
from pathlib import Path
import re
import subprocess

HNSD_SHA = 'ed2e2f8f22b60fa3e17a8a74445174540d6b4f1903d5849c9e27baee120182d2'


def validate_elf(program, dynamic, versions):
    assert '/lib64/ld-linux-x86-64.so.2' in program, 'hnsd_interpreter_changed'
    assert set(re.findall(r'Shared library: \[([^]]+)\]', dynamic)) == {'libunbound.so.8', 'libc.so.6'}, 'hnsd_soname_changed'
    assert 'RPATH' not in dynamic and 'RUNPATH' not in dynamic, 'hnsd_private_library_search'
    symbols = {tuple(map(int, name.split('.'))) for name in re.findall(r'GLIBC_(\d+\.\d+)', versions)}
    assert symbols and max(symbols) == (2, 36), 'hnsd_glibc_requirement_changed'


def observe(binary, run, namespace=False):
    binary = Path(binary)
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == HNSD_SHA, 'hnsd_bytes_changed'
    environment = {**os.environ, 'LC_ALL': 'C', 'LD_BIND_NOW': '1'}

    def output(args):
        return run(args, env=environment, stdout=subprocess.PIPE).stdout.decode()

    program = output(['readelf', '-l', str(binary)])
    dynamic = output(['readelf', '-d', str(binary)])
    versions = output(['readelf', '--version-info', str(binary)])
    validate_elf(program, dynamic, versions)
    loaded = output(['ldd', str(binary)])
    assert 'not found' not in loaded, 'hnsd_runtime_library_missing'
    libraries = {}
    for soname in ['libunbound.so.8', 'libc.so.6']:
        match = re.search(r'^\s*' + re.escape(soname) + r'\s+=>\s+(/\S+)', loaded, re.M)
        assert match, 'hnsd_system_library_unresolved'
        path = Path(match[1]).resolve()
        assert path.is_relative_to('/usr/lib') or path.is_relative_to('/lib'), 'hnsd_non_system_library'
        libraries[soname] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    prefix = ['unshare', '--user', '--map-root-user', '--net'] if namespace else []
    version = output(prefix + [str(binary), '--version']).strip()
    assert version == '2.0.0 (main)', 'hnsd_runtime_version_changed'
    packages = output(['dpkg-query', '-W', '-f=${Package} ${Version}\n', 'libunbound8', 'libc6']).splitlines()
    return {'passed': True, 'binary_sha256': HNSD_SHA, 'needed': ['libunbound.so.8', 'libc.so.6'],
            'required_glibc_symbol_max': '2.36', 'private_search_paths_absent': True,
            'system_libraries': libraries, 'packages': packages, 'version': version,
            'version_probe_in_network_namespace': namespace}
