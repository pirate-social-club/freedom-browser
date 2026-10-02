"""Build the pinned Rust core on a disposable runner; never start its services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def wait_for_service(service, evidence, seconds, manager=('sudo', 'systemctl')):
    deadline = time.monotonic() + seconds
    while True:
        result = subprocess.run([*manager, 'show', service, '-p', 'LoadState',
                                 '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
                                 '-p', 'ExecMainCode', '-p', 'ExecMainStatus', '-p', 'Result',
                                 '-p', 'ExecMainStartTimestampMonotonic'],
                                capture_output=True, text=True, timeout=10)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        (evidence / (service + '-observation.txt')).write_text(result.stdout + result.stderr)
        if result.returncode or fields.get('LoadState') != 'loaded':
            raise RuntimeError('service_observation_failed')
        if fields.get('SubState') == 'exited' and fields.get('MainPID') == '0':
            started = fields.get('ExecMainStartTimestampMonotonic', '')
            if (fields.get('ActiveState') != 'active' or fields.get('Result') != 'success'
                    or fields.get('ExecMainCode') != '1' or fields.get('ExecMainStatus') != '0'
                    or not started.isdigit() or int(started) == 0):
                raise RuntimeError('service_completion_failed')
            return fields
        if fields.get('ActiveState') in ('failed', 'inactive'):
            raise RuntimeError('service_execution_failed')
        if time.monotonic() >= deadline:
            raise TimeoutError('service_observation_timeout')
        time.sleep(0.2)


def stop_service(service, evidence, manager=('sudo', 'systemctl'),
                 cgroup_parent=Path('/sys/fs/cgroup/system.slice')):
    cleanup = {'unit': service, 'proved': False}
    group = cgroup_parent / (service + '.service')
    expected = '/' + str(group.relative_to('/sys/fs/cgroup'))
    cleanup['expected_cgroup'] = expected
    group_identity = False
    for phase, args in (
        ('service', ['show', service, '-p', 'Result', '-p', 'CPUUsageNSec',
                     '-p', 'MemoryPeak', '-p', 'MemorySwapPeak', '-p', 'ExecMainCode',
                     '-p', 'ExecMainStatus', '-p', 'MainPID', '-p', 'ControlGroup',
                     '-p', 'MemoryMax', '-p', 'MemorySwapMax', '-p', 'CPUQuotaPerSecUSec',
                     '-p', 'User', '-p', 'Group', '-p', 'Slice', '-p', 'PrivateNetwork',
                     '-p', 'PrivateDevices', '-p', 'PrivateTmp', '-p', 'ProtectHome',
                     '-p', 'ProtectSystem', '-p', 'ReadWritePaths', '-p', 'BindPaths',
                     '-p', 'BindReadOnlyPaths', '-p', 'ProtectProc', '-p', 'NoNewPrivileges',
                     '-p', 'RestrictAddressFamilies', '-p', 'CapabilityBoundingSet',
                     '-p', 'RestrictSUIDSGID', '-p', 'KillMode', '-p', 'RuntimeMaxUSec']),
        ('stop', ['stop', service]),
        ('cleanup', ['show', service, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID']),
    ):
        try:
            result = subprocess.run([*manager, *args], capture_output=True,
                                    text=True, timeout=20)
            (evidence / (service + '-' + phase + '.txt')).write_text(result.stdout + result.stderr)
            fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
            if phase == 'service':
                observed = fields.get('ControlGroup')
                cleanup['observed_cgroup'] = observed
                # systemd clears ControlGroup after the final process exits.
                group_identity = (result.returncode == 0 and
                                  (observed == expected or (observed == '' and not group.exists())))
            if phase == 'cleanup':
                empty = not group.exists() or all(
                    not path.read_text().strip() for path in group.rglob('cgroup.procs'))
                cleanup['cgroup_empty_or_absent'] = empty
                cleanup['proved'] = (group_identity and result.returncode == 0
                                     and fields.get('MainPID') == '0'
                                     and fields.get('ControlPID') == '0'
                                     and fields.get('ActiveState') in ('inactive', 'failed') and empty)
        except Exception as error:
            cleanup[phase + '_error'] = type(error).__name__ + ': ' + str(error)
    return cleanup


def main():
    pins = json.loads(Path(__file__).with_name('pins.json').read_text())
    root = Path(tempfile.mkdtemp(prefix='veritas-build-', dir='/var/tmp'))
    root.chmod(0o755)
    inspection = Path(tempfile.mkdtemp(prefix='veritas-inspection-', dir='/var/tmp'))
    inspection.chmod(0o755)
    evidence = Path(os.environ['RUNNER_TEMP']) / 'veritas-feasibility/evidence'
    evidence.mkdir(parents=True, exist_ok=False)
    unit = 'veritas-feasibility-' + str(time.time_ns())
    start = time.monotonic()
    receipt = {'passed': False, 'stage': 'prepare', 'pins': pins, 'commands': [],
               'application_services_started': False, 'scope': 'Linux compilation and offline CLI help only',
               'cleanup': []}
    units = []

    def save():
        (evidence / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(stage, args, *, cwd=None, env=None, timeout=300):
        receipt['stage'] = stage
        save()
        before = time.monotonic()
        with (evidence / (stage + '.log')).open('wb') as log:
            result = subprocess.run(args, cwd=cwd, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=timeout, check=False)
        receipt['commands'].append({'stage': stage, 'exit_code': result.returncode,
                                    'elapsed_seconds': time.monotonic() - before})
        save()
        if result.returncode:
            raise RuntimeError(stage + '_failed')

    def stop_and_record(service):
        cleanup = stop_service(service, evidence)
        receipt['cleanup'].append(cleanup)
        return cleanup['proved']

    try:
        receipt['candidate_sha'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=10).strip()
        repo = Path(__file__).resolve().parents[2]
        receipt['harness_files'] = {name: sha256(repo / name) for name in (
            '.github/workflows/veritas-linux-feasibility.yml',
            'ops/veritas-linux-feasibility/build.py',
            'ops/veritas-linux-feasibility/test-systemd-lifecycle.py',
            'ops/veritas-linux-feasibility/pins.json',
            'ops/veritas-linux-feasibility/README.md')}
        receipt['run_id'] = os.environ.get('GITHUB_RUN_ID')
        receipt['run_attempt'] = os.environ.get('GITHUB_RUN_ATTEMPT')
        run('operating-system', ['cat', '/etc/os-release'], timeout=10)
        run('kernel', ['uname', '-a'], timeout=10)
        receipt['stage'] = 'source_download'
        save()
        archive = root / 'source.tar.gz'
        with urllib.request.urlopen(pins['source_url'], timeout=60) as response:
            data = response.read(pins['source_max_bytes'] + 1)
        if len(data) > pins['source_max_bytes']:
            raise RuntimeError('source_size_limit')
        archive.write_bytes(data)
        if sha256(archive) != pins['source_sha256']:
            raise RuntimeError('source_digest_mismatch')
        source = root / 'source'
        source.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(source, filter='data')
        children = list(source.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise RuntimeError('source_layout_mismatch')
        source = children[0]
        if sha256(source / 'Cargo.lock') != pins['cargo_lock_sha256']:
            raise RuntimeError('lock_digest_mismatch')
        shutil.copyfile(source / 'Cargo.lock', evidence / 'Cargo.lock')
        with urllib.request.urlopen(pins['rust_manifest_url'], timeout=60) as response:
            manifest_data = response.read(2000001)
        if hashlib.sha256(manifest_data).hexdigest() != pins['rust_manifest_sha256']:
            raise RuntimeError('rust_manifest_digest_mismatch')
        (evidence / 'rust-channel.toml').write_bytes(manifest_data)
        env = os.environ.copy()
        env.update(CARGO_HOME=str(root / 'cargo'), RUSTUP_HOME=str(root / 'rustup'))
        run('toolchain', ['rustup', 'toolchain', 'install', pins['toolchain'], '--profile', 'minimal'], env=env, timeout=600)
        tool_bin = root / 'rustup/toolchains' / (pins['toolchain'] + '-' + pins['target']) / 'bin'
        cargo = tool_bin / 'cargo'
        env['PATH'] = str(tool_bin) + ':/usr/local/bin:/usr/bin:/bin'
        run('rustc', [str(tool_bin / 'rustc'), '-Vv'], env=env)
        run('cargo', [str(cargo), '-Vv'], env=env)
        receipt['toolchain_executables'] = {name: sha256(tool_bin / name) for name in ('cargo', 'rustc')}
        receipt['toolchain_validation'] = ('Rustup distribution checks and a separately pinned official '
                                           'manifest; archive-to-installed byte equivalence is not tested.')
        run('fetch', [str(cargo), 'fetch', '--locked', '--target', pins['target']], cwd=source, env=env, timeout=600)
        run('identity', ['sudo', 'useradd', '--system', '--user-group', '--no-create-home',
                         '--home-dir', str(root), '--shell', '/usr/sbin/nologin', 'veritas-build'])
        run('ownership', ['sudo', 'chown', '-R', 'veritas-build:veritas-build', str(root)])
        # Separate identity, hidden home directories, no network, and no privilege escalation.
        build_env = ['env', '-i', 'PATH=' + env['PATH'], 'CARGO_HOME=' + env['CARGO_HOME'],
                     'CARGO_BUILD_JOBS=2', 'CARGO_INCREMENTAL=0']
        def contained(stage, args, seconds):
            service = unit + '-' + stage
            units.append(service)
            command = ['sudo', 'systemd-run', '--unit=' + service, '--no-block',
                       '--uid=veritas-build', '--gid=veritas-build', '--working-directory=' + str(source),
                       '-p', 'Type=exec', '-p', 'Slice=system.slice',
                       '-p', 'StandardOutput=append:' + str(evidence / (stage + '.log')),
                       '-p', 'StandardError=inherit',
                       '-p', 'PrivateNetwork=yes', '-p', 'PrivateDevices=yes', '-p', 'PrivateTmp=yes',
                       '-p', 'BindPaths=' + str(root),
                       '-p', 'BindReadOnlyPaths=' + str(inspection),
                       '-p', 'ProtectHome=yes', '-p', 'ProtectSystem=strict',
                       '-p', 'ReadWritePaths=' + str(root), '-p', 'ProtectProc=invisible',
                       '-p', 'RestrictAddressFamilies=AF_UNIX', '-p', 'CapabilityBoundingSet=',
                       '-p', 'NoNewPrivileges=yes', '-p', 'RestrictSUIDSGID=yes',
                       '-p', 'KillMode=control-group', '-p', 'CPUQuota=' + str(pins['cpu_quota_percent']) + '%',
                       '-p', 'MemoryMax=' + str(pins['memory_max_bytes']), '-p', 'MemorySwapMax=0',
                       '-p', 'RuntimeMaxSec=' + str(seconds), '-p', 'TimeoutStopSec=10',
                       '-p', 'RemainAfterExit=yes', *build_env, *args]
            try:
                run(stage + '-launch', command, timeout=20)
                receipt['stage'] = stage
                save()
                before = time.monotonic()
                observed = wait_for_service(service, evidence, seconds + 30)
                receipt['commands'].append({'stage': stage, 'exit_code': 0,
                                            'elapsed_seconds': time.monotonic() - before,
                                            'completion': observed})
            finally:
                clean = stop_and_record(service)
                save()
            if not clean:
                raise RuntimeError(stage + '_cleanup_unproved')

        contained('build', [str(cargo), 'build', '--frozen', '--release', '--bin', 'veritas',
                           '--target', pins['target']], pins['build_timeout_seconds'])
        if sha256(source / 'Cargo.lock') != pins['cargo_lock_sha256']:
            raise RuntimeError('lock_changed')
        built = source / 'target' / pins['target'] / 'release/veritas'
        receipt['executable_sha256'] = sha256(built)
        binary = inspection / 'veritas'
        shutil.copyfile(built, binary)
        binary.chmod(0o755)
        if sha256(binary) != receipt['executable_sha256']:
            raise RuntimeError('inspection_copy_digest_mismatch')
        contained('elf', ['readelf', '-h', '-l', '-d', str(binary)], 15)
        contained('linkage', ['ldd', str(binary)], 15)
        contained('help', [str(binary), '--help'], 15)
        preserved = evidence / 'veritas-linux-x64'
        shutil.copyfile(binary, preserved)
        receipt['preserved_executable_sha256'] = sha256(preserved)
        if receipt['preserved_executable_sha256'] != receipt['executable_sha256']:
            raise RuntimeError('preserved_executable_digest_mismatch')
        receipt['passed'] = True
        receipt['stage'] = 'complete'
    except Exception as error:
        receipt['error_type'] = type(error).__name__
        receipt['error'] = str(error)
    finally:
        for service in units:
            if not any(row['unit'] == service and row['proved'] for row in receipt['cleanup']):
                stop_and_record(service)
        receipt['cleanup_proved'] = all(row['proved'] for row in receipt['cleanup'])
        receipt['passed'] = receipt['passed'] and receipt['cleanup_proved']
        receipt['elapsed_seconds'] = time.monotonic() - start
        save()
        manifest = {path.name: sha256(path) for path in sorted(evidence.iterdir()) if path.is_file()}
        (evidence / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
