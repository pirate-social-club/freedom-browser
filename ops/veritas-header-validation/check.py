"""Compile and test the defensive component offline on a disposable runner."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import tomllib
import urllib.request

REPO = Path(__file__).resolve().parents[2]
OWNED = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    'feasibility', REPO / 'ops/veritas-linux-feasibility/build.py')
FEASIBILITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FEASIBILITY)


def fetch(url, path, maximum, digest):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise RuntimeError('download_size_limit')
    path.write_bytes(data)
    if FEASIBILITY.sha256(path) != digest:
        raise RuntimeError('download_digest_mismatch')


def validate_lock(original, generated):
    permitted = {(p['name'], p['version'], p.get('source'), p.get('checksum'))
                 for p in tomllib.loads(original.read_text())['package']}
    packages = tomllib.loads(generated.read_text())['package']
    own = [p for p in packages if p['name'] == 'freedom-header-conformance']
    if len(own) != 1 or own[0]['version'] != '0.1.0' or 'source' in own[0]:
        raise RuntimeError('owned_package_identity')
    dependencies = []
    for package in packages:
        if package in own:
            continue
        identity = (package['name'], package['version'], package.get('source'), package.get('checksum'))
        if (identity not in permitted or not package.get('checksum')
                or package.get('source') != 'registry+https://github.com/rust-lang/crates.io-index'):
            raise RuntimeError('dependency_identity_changed:' + package['name'])
        dependencies.append(dict(zip(('name', 'version', 'source', 'checksum'), identity)))
    if not any(p['name'] == 'bitcoin' and p['version'] == '0.32.8' for p in dependencies):
        raise RuntimeError('bitcoin_pin_missing')
    return dependencies


def main():
    pins = json.loads((REPO / 'ops/veritas-linux-feasibility/pins.json').read_text())
    evidence = Path(os.environ['RUNNER_TEMP']) / 'veritas-header-validation/evidence'
    evidence.mkdir(parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix='header-conformance-', dir='/var/tmp'))
    inspection = Path(tempfile.mkdtemp(prefix='header-inspection-', dir='/var/tmp'))
    root.chmod(0o755)
    inspection.chmod(0o755)
    units = []
    start = time.monotonic()
    receipt = {'passed': False, 'stage': 'prepare', 'commands': [], 'cleanup': [], 'pins': pins,
               'scope': 'Defensive MAINNET component and offline conformance only',
               'yuki_acceptance_invoked': False, 'application_services_started': False,
               'candidate_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
               'run_id': os.environ.get('GITHUB_RUN_ID'), 'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT')}

    def save():
        (evidence / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(stage, args, *, cwd=None, env=None, timeout=600):
        receipt['stage'] = stage
        save()
        before = time.monotonic()
        with (evidence / (stage + '.log')).open('wb') as log:
            result = subprocess.run(args, cwd=cwd, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=timeout)
        receipt['commands'].append({'stage': stage, 'exit_code': result.returncode,
                                    'elapsed_seconds': time.monotonic() - before})
        save()
        if result.returncode:
            raise RuntimeError(stage + '_failed')

    def cleanup(service):
        observation = FEASIBILITY.stop_service(service, evidence)
        receipt['cleanup'].append(observation)
        save()
        return observation['proved']

    try:
        files = [p for p in OWNED.rglob('*') if p.is_file()]
        files.extend([REPO / '.github/workflows/veritas-header-validation.yml',
                      REPO / 'ops/veritas-linux-feasibility/build.py',
                      REPO / 'ops/veritas-linux-feasibility/pins.json'])
        receipt['source_files'] = {str(p.relative_to(REPO)): FEASIBILITY.sha256(p) for p in sorted(files)}
        run('operating-system', ['cat', '/etc/os-release'], timeout=10)
        archive = root / 'source.tar.gz'
        fetch(pins['source_url'], archive, pins['source_max_bytes'], pins['source_sha256'])
        upstream = root / 'upstream'
        upstream.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(upstream, filter='data')
        children = list(upstream.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise RuntimeError('upstream_layout')
        upstream = children[0]
        original_lock = upstream / 'Cargo.lock'
        if FEASIBILITY.sha256(original_lock) != pins['cargo_lock_sha256']:
            raise RuntimeError('original_lock_mismatch')
        shutil.copyfile(original_lock, evidence / 'upstream-Cargo.lock')
        fetch(pins['rust_manifest_url'], evidence / 'rust-channel.toml', 2_000_000,
              pins['rust_manifest_sha256'])
        crate = root / 'component'
        crate.mkdir()
        shutil.copyfile(OWNED / 'Cargo.toml', crate / 'Cargo.toml')
        for directory in ('src', 'fixtures'):
            shutil.copytree(OWNED / directory, crate / directory)
        env = os.environ.copy()
        env.update(CARGO_HOME=str(root / 'cargo'), RUSTUP_HOME=str(root / 'rustup'))
        run('toolchain', ['rustup', 'toolchain', 'install', pins['toolchain'], '--profile', 'minimal'], env=env)
        tool_bin = root / 'rustup/toolchains' / (pins['toolchain'] + '-' + pins['target']) / 'bin'
        cargo = tool_bin / 'cargo'
        env['PATH'] = str(tool_bin) + ':/usr/local/bin:/usr/bin:/bin'
        run('rustc', [str(tool_bin / 'rustc'), '-Vv'], env=env)
        run('cargo', [str(cargo), '-Vv'], env=env)
        receipt['compiler_hashes'] = {name: FEASIBILITY.sha256(tool_bin / name) for name in ('cargo', 'rustc')}
        run('fetch', [str(cargo), 'fetch', '--locked', '--target', pins['target']], cwd=upstream, env=env)
        run('identity', ['sudo', 'useradd', '--system', '--user-group', '--no-create-home',
                         '--home-dir', str(root), '--shell', '/usr/sbin/nologin', 'header-conformance'])
        run('ownership', ['sudo', 'chown', '-R', 'header-conformance:header-conformance', str(root)])

        def contained(stage, args, seconds, freeze_inputs=False):
            service = 'header-conformance-' + str(time.time_ns()) + '-' + stage
            units.append(service)
            readonly = [inspection]
            if freeze_inputs:
                readonly.extend(crate / p for p in ('Cargo.toml', 'Cargo.lock', 'src', 'fixtures'))
            command = ['sudo', 'systemd-run', '--unit=' + service, '--no-block',
                       '--uid=header-conformance', '--gid=header-conformance',
                       '--working-directory=' + str(crate), '-p', 'Type=exec', '-p', 'Slice=system.slice',
                       '-p', 'StandardOutput=append:' + str(evidence / (stage + '.log')),
                       '-p', 'StandardError=inherit', '-p', 'PrivateNetwork=yes',
                       '-p', 'PrivateDevices=yes', '-p', 'PrivateTmp=yes',
                       '-p', 'BindPaths=' + str(root),
                       '-p', 'BindReadOnlyPaths=' + ' '.join(str(p) for p in readonly),
                       '-p', 'ProtectHome=yes', '-p', 'ProtectSystem=strict',
                       '-p', 'ReadWritePaths=' + str(root), '-p', 'ProtectProc=invisible',
                       '-p', 'RestrictAddressFamilies=AF_UNIX', '-p', 'CapabilityBoundingSet=',
                       '-p', 'NoNewPrivileges=yes', '-p', 'RestrictSUIDSGID=yes',
                       '-p', 'KillMode=control-group', '-p', 'CPUQuota=200%',
                       '-p', 'MemoryMax=4294967296', '-p', 'MemorySwapMax=0',
                       '-p', 'RuntimeMaxSec=' + str(seconds), '-p', 'TimeoutStopSec=10',
                       '-p', 'RemainAfterExit=yes', 'env', '-i', 'PATH=' + env['PATH'],
                       'CARGO_HOME=' + env['CARGO_HOME'], 'CARGO_BUILD_JOBS=2',
                       'CARGO_INCREMENTAL=0', *args]
            try:
                run(stage + '-launch', command, timeout=20)
                receipt['stage'] = stage
                save()
                before = time.monotonic()
                observed = FEASIBILITY.wait_for_service(service, evidence, seconds + 30)
                receipt['commands'].append({'stage': stage, 'completion': observed,
                                            'elapsed_seconds': time.monotonic() - before})
            finally:
                clean = cleanup(service)
            if not clean:
                raise RuntimeError(stage + '_cleanup_unproved')

        contained('lock', [str(cargo), 'generate-lockfile', '--offline'], 60)
        lock = crate / 'Cargo.lock'
        receipt['dependencies'] = validate_lock(original_lock, lock)
        receipt['component_lock_sha256'] = FEASIBILITY.sha256(lock)
        shutil.copyfile(lock, evidence / 'component-Cargo.lock')
        contained('compile', [str(cargo), 'test', '--frozen', '--no-run', '--message-format=json'], 600, True)
        artifacts = []
        for line in (evidence / 'compile.log').read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if (row.get('reason') == 'compiler-artifact' and row.get('profile', {}).get('test')
                    and row.get('target', {}).get('name') == 'freedom_header_conformance'
                    and row.get('executable')):
                artifacts.append(Path(row['executable']).resolve())
        if len(artifacts) != 1 or not artifacts[0].is_relative_to(crate / 'target/debug/deps'):
            raise RuntimeError('test_executable_identity')
        built = artifacts[0]
        binary = inspection / 'header-conformance-tests'
        shutil.copyfile(built, binary)
        binary.chmod(0o755)
        receipt['test_executable_sha256'] = FEASIBILITY.sha256(binary)
        if FEASIBILITY.sha256(built) != receipt['test_executable_sha256']:
            raise RuntimeError('test_copy_mismatch')
        contained('tests', [str(binary), '--test-threads=1', '--nocapture'], 60, True)
        if FEASIBILITY.sha256(binary) != receipt['test_executable_sha256']:
            raise RuntimeError('test_executable_changed')
        if FEASIBILITY.sha256(lock) != receipt['component_lock_sha256']:
            raise RuntimeError('component_lock_changed')
        if FEASIBILITY.sha256(original_lock) != pins['cargo_lock_sha256']:
            raise RuntimeError('original_lock_changed')
        for relative, digest in receipt['source_files'].items():
            if FEASIBILITY.sha256(REPO / relative) != digest:
                raise RuntimeError('candidate_source_changed')
        inputs = [crate / 'Cargo.toml']
        for directory in ('src', 'fixtures'):
            inputs.extend(p for p in (crate / directory).rglob('*') if p.is_file())
        for path in inputs:
            if FEASIBILITY.sha256(path) != FEASIBILITY.sha256(OWNED / path.relative_to(crate)):
                raise RuntimeError('compiled_source_changed')
        shutil.copyfile(binary, evidence / binary.name)
        receipt['passed'] = True
        receipt['stage'] = 'complete'
    except Exception as error:
        receipt['error_type'] = type(error).__name__
        receipt['error'] = str(error)
    finally:
        for service in units:
            if not any(row['unit'] == service and row['proved'] for row in receipt['cleanup']):
                cleanup(service)
        receipt['cleanup_proved'] = all(row['proved'] for row in receipt['cleanup'])
        receipt['passed'] = receipt['passed'] and receipt['cleanup_proved']
        receipt['elapsed_seconds'] = time.monotonic() - start
        save()
        (evidence / 'manifest.json').write_text(json.dumps(
            {p.name: FEASIBILITY.sha256(p) for p in sorted(evidence.iterdir()) if p.is_file()}, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
