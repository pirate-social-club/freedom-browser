"""Exercise the actual lifecycle controller with bounded user-systemd fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch


def main():
    evidence = Path(sys.argv[1]).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('feasibility_build', Path(__file__).with_name('build.py'))
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    manager = ('systemctl', '--user')
    parent = (Path('/sys/fs/cgroup/user.slice') / ('user-' + str(os.getuid()) + '.slice')
              / ('user@' + str(os.getuid()) + '.service') / 'app.slice')
    results = []
    cases = [
        ('success', ['/usr/bin/true'], None),
        ('nonzero', ['/usr/bin/false'], 'service_execution_failed'),
        ('deadline', ['/usr/bin/sleep', '10'], 'service_execution_failed'),
        ('descendant', ['/bin/sh', '-c', 'sleep 30 & exit 0'], None),
    ]
    for name, command, expected_error in cases:
        service = 'freedom-veritas-fixture-' + name + '-' + str(time.time_ns())
        row = {'case': name, 'expected_error': expected_error, 'error': None}
        args = ['systemd-run', '--user', '--no-block', '--unit=' + service,
                '-p', 'Type=exec', '-p', 'Slice=app.slice', '-p', 'RemainAfterExit=yes',
                '-p', 'CPUQuota=10%', '-p', 'AllowedCPUs=0', '-p', 'Nice=19',
                '-p', 'MemoryMax=32M', '-p', 'MemorySwapMax=0', '-p', 'KillMode=control-group',
                '-p', 'RuntimeMaxSec=1', '-p', 'TimeoutStopSec=1',
                '-p', 'StandardOutput=append:' + str(evidence / (name + '.log')),
                '-p', 'StandardError=inherit', *command]
        try:
            launched = subprocess.run(args, capture_output=True, text=True, timeout=10)
            (evidence / (name + '-launch.log')).write_text(launched.stdout + launched.stderr)
            launched.check_returncode()
            row['completion'] = build.wait_for_service(service, evidence, 5, manager)
        except Exception as error:
            row['error'] = str(error)
        finally:
            row['cleanup'] = build.stop_service(service, evidence, manager, parent)
        row['passed'] = row['error'] == expected_error and row['cleanup']['proved']
        if name == 'descendant':
            row['passed'] = row['passed'] and bool(row['cleanup'].get('observed_cgroup'))
        results.append(row)
        (evidence / 'results.json').write_text(json.dumps(results, indent=2) + '\n')

    # Queued or incomplete execution metadata must never be accepted as success.
    fake = subprocess.CompletedProcess([], 0, stdout=(
        'LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\n'
        'ExecMainCode=1\nExecMainStatus=0\nResult=success\nExecMainStartTimestampMonotonic=0\n'), stderr='')
    with patch.object(build.subprocess, 'run', return_value=fake):
        try:
            build.wait_for_service('unstarted', evidence, 1, manager)
            passed = False
        except RuntimeError as error:
            passed = str(error) == 'service_completion_failed'
    results.append({'case': 'unstarted', 'passed': passed})
    (evidence / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))
    return 0 if all(row['passed'] for row in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
