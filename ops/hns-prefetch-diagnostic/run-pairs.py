#!/usr/bin/env python3
"""Six serial hosted samples, retaining failures without retries or assertion changes."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PAIRS = 6
EXPERIMENT_SECONDS = 22 * 60
PAIR_SECONDS = 195
SPEC = "src/main/__tests__/integration/hns-namespace-discovery.test.js"
RESOURCES = {"cpu.max": "100000 100000", "memory.max": "3221225472", "memory.swap.max": "0"}
NET_LOG_MAX_BYTES = 8 * 1024 * 1024


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def assess_pair(directory, exit_code):
    failures = []
    if exit_code != 0:
        failures.append("jest_or_unit_failed")
    try:
        resources = json.loads((directory / "resources.json").read_text())
        if resources != {"resources": RESOURCES, "affinity": [0], "nice": 19}:
            failures.append("runtime_limits_mismatch")
    except (OSError, ValueError):
        failures.append("runtime_limits_missing")
    try:
        result = json.loads((directory / "jest.json").read_text())
        if (result.get("success") is not True or result.get("numFailedTests") != 0
                or result.get("numPendingTests") != 0 or result.get("numTotalTests", 0) < 1):
            failures.append("assertions_failed_or_skipped")
    except (OSError, ValueError):
        failures.append("jest_result_missing_or_invalid")
    for mode in ("protected", "control"):
        records = list((directory / "probes").glob(f"{mode}-*/process.json"))
        if len(records) != 1:
            failures.append(f"{mode}_process_count")
            continue
        try:
            record = json.loads(records[0].read_text())
            if (record.get("closed") is not True or record.get("exitCode") != 0
                    or record.get("signal") is not None or record.get("timedOut") is not False
                    or record.get("spawnError") is not None or record.get("parseError") is not None
                    or record.get("resultFound") is not True):
                failures.append(f"{mode}_process_failed")
            stdout = records[0].with_name("stdout.log").read_bytes()
            stderr = records[0].with_name("stderr.log").read_bytes()
            if len(stdout) != record.get("stdoutBytes") or len(stderr) != record.get("stderrBytes"):
                failures.append(f"{mode}_output_incomplete")
            results = [line.removeprefix("PROBE-RESULT ") for line in stdout.decode().splitlines()
                       if line.startswith("PROBE-RESULT ")]
            if len(results) != 1 or json.loads(results[0]).get("versions", {}).get("electron") != "44.9.3":
                failures.append(f"{mode}_runtime_or_result_mismatch")
            if record.get("networkLogging") is not True:
                failures.append(f"{mode}_network_logging_missing")
            network_log = records[0].with_name("net-log.json")
            if network_log.stat().st_size >= NET_LOG_MAX_BYTES:
                failures.append(f"{mode}_net_log_limit_reached")
            else:
                capture = json.loads(network_log.read_text())
                if not capture.get("constants") or not capture.get("events"):
                    failures.append(f"{mode}_net_log_empty")
            if len(results) == 1 and json.loads(results[0]).get("networkLog") != {
                    "stopped": True, "captureMode": "default", "maxFileSize": NET_LOG_MAX_BYTES}:
                failures.append(f"{mode}_net_log_not_flushed")
        except (OSError, ValueError, UnicodeError):
            failures.append(f"{mode}_evidence_invalid")
    return failures


def run_pair(directory):
    """Executed inside the bounded unit before Jest and its Electron children."""
    group = next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines()
                 if line.startswith("0::"))
    cgroup = Path("/sys/fs/cgroup") / group.lstrip("/")
    resources = {name: (cgroup / name).read_text().strip()
                 for name in ("cpu.max", "memory.max", "memory.swap.max")}
    assert resources == RESOURCES
    assert os.sched_getaffinity(0) == {0} and os.getpriority(os.PRIO_PROCESS, 0) == 19
    node = shutil.which("node")
    assert node and subprocess.check_output([node, "--version"], text=True).strip() == "v24.14.0"
    write_json(directory / "resources.json", {"resources": resources, "affinity": [0], "nice": 19})
    result = subprocess.run([node, str(ROOT / "node_modules/jest/bin/jest.js"), "--runInBand",
                             "--runTestsByPath", SPEC, "--json", "--outputFile", str(directory / "jest.json")],
                            env={**os.environ, "FREEDOM_ELECTRON_NET_TEST": "1",
                                 "FREEDOM_HNS_NETWORK_DIAGNOSTIC": "1",
                                 "FREEDOM_HNS_PROBE_EVIDENCE_DIR": str(directory / "probes")})
    write_json(directory / "resource-outcome.json", {name: (cgroup / name).read_text().strip()
               for name in ("cpu.stat", "memory.events", "memory.peak", "memory.swap.peak")})
    return result.returncode


def run_samples(output, verifier):
    assert os.getuid() != 0 and output.is_absolute()
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    assert re.fullmatch(r"[0-9]+", run_id) and re.fullmatch(r"[0-9]+", attempt)
    unit = f"freedom-upstream-validation-{run_id}-{attempt}.service"
    assert verifier == Path("/run") / f"{unit}.verifier.py"
    assert verifier.stat().st_uid == 0 and verifier.stat().st_mode & 0o022 == 0
    verifier_digest = hashlib.sha256(verifier.read_bytes()).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + EXPERIMENT_SECONDS
    setup_seconds = time.time() - int(os.environ["FREEDOM_HNS_JOB_STARTED_AT"])
    setup_budget_ok = 0 <= setup_seconds <= 35 * 60 - EXPERIMENT_SECONDS - 120
    write_json(output / "plan.json", {
        "pairs": PAIRS, "experimentSeconds": EXPERIMENT_SECONDS, "perPairSeconds": PAIR_SECONDS,
        "node": "24.14.0", "electron": "44.9.3", "platform": "ubuntu-24.04",
        "runnerImage": {name: os.environ.get(name) for name in ("ImageOS", "ImageVersion")},
        "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "lockSha256": hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest(),
        "verifierSha256": verifier_digest, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "setupSeconds": setup_seconds, "fullExperimentBudgetAvailable": setup_budget_ok,
        "retries": 0, "cleanSamplesWithoutRecurrenceDoNotResolveFlake": True,
        "networkObservation": {"captureMode": "default", "maxFileSizePerProbe": NET_LOG_MAX_BYTES,
                               "nativeVmodule": "simple_network_hints_handler_impl=2"},
    })
    return collect_pairs(output, verifier, verifier_digest, unit, deadline, setup_budget_ok)


def collect_pairs(output, verifier, verifier_digest, unit, deadline, setup_budget_ok):
    results = []
    cleanup_failed = False
    for index in range(1, PAIRS + 1):
        directory = output / f"pair-{index}"
        directory.mkdir()
        remaining = int(deadline - time.monotonic())
        if not setup_budget_ok or cleanup_failed or remaining <= 60:
            reason = "setup_budget_exhausted" if not setup_budget_ok else "cleanup_failed" if cleanup_failed else "budget_exhausted"
            result = {"pair": index, "status": "not-run", "reason": reason}
            results.append(result)
            write_json(directory / "outcome.json", result)
            continue
        # Reserve the client grace and every bounded cleanup call, plus time
        # to write the outcome, inside the overall experiment deadline.
        bound = min(PAIR_SECONDS, remaining - 60)
        command = ["sudo", "systemd-run", f"--unit={unit}", "--wait", "--pipe", "--collect",
                   f"--uid={os.getuid()}", f"--gid={os.getgid()}", f"--working-directory={ROOT}",
                   "--property=CPUQuota=100%", "--property=CPUQuotaPeriodSec=100ms",
                   "--property=AllowedCPUs=0", "--property=CPUAffinity=0", "--property=Nice=19",
                   "--property=MemoryMax=3221225472", "--property=MemorySwapMax=0",
                   f"--property=RuntimeMaxSec={bound}", "--property=TimeoutStopSec=5",
                   "--property=KillMode=control-group", f"--setenv=PATH={os.environ['PATH']}",
                   "--setenv=CI=1", "--setenv=GITHUB_ACTIONS=true", "python3", str(Path(__file__).resolve()),
                   "--output", str(directory), "--run-pair"]
        started = time.monotonic()
        started_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        code = None
        failures = []
        with (directory / "unit.log").open("xb") as log:
            try:
                code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=bound + 10).returncode
            except subprocess.TimeoutExpired:
                failures.append("unit_client_timeout")
            except (OSError, subprocess.SubprocessError):
                failures.append("unit_launch_failed")
            finally:
                # A failed sample never leaves a previous browser beside the next sample.
                try:
                    stop = subprocess.run(["sudo", "systemctl", "stop", unit], capture_output=True, timeout=10)
                    state = subprocess.check_output(["systemctl", "show", unit, "-p", "ActiveState", "--value"], text=True, timeout=5).strip()
                    if stop.returncode == 0 and state == "failed":
                        subprocess.run(["sudo", "systemctl", "reset-failed", unit], check=True, timeout=5)
                    assert hashlib.sha256(verifier.read_bytes()).hexdigest() == verifier_digest
                    subprocess.run(["python3", str(verifier), unit, str(directory), str(stop.returncode)],
                                   check=True, stdout=log, stderr=subprocess.STDOUT, timeout=10)
                except (OSError, AssertionError, subprocess.SubprocessError):
                    cleanup_failed = True
                    failures.append("cleanup_failed")
                try:
                    journal = subprocess.run(["sudo", "journalctl", "-u", unit, "--since", started_at,
                                              "--no-pager", "-o", "short-iso"], capture_output=True, timeout=5)
                    (directory / "journal.log").write_bytes(journal.stdout + journal.stderr)
                    if journal.returncode != 0:
                        failures.append("journal_failed")
                except (OSError, subprocess.SubprocessError):
                    failures.append("journal_failed")
        failures.extend(assess_pair(directory, code))
        result = {"pair": index, "status": "failed" if failures else "passed", "exitCode": code,
                  "elapsedSeconds": time.monotonic() - started, "failures": failures}
        results.append(result)
        write_json(directory / "outcome.json", result)
        print(json.dumps(result), flush=True)
    passed = all(result["status"] == "passed" for result in results)
    write_json(output / "summary.json", {"passed": passed, "pairs": results, "retries": 0,
                                        "causeEstablished": False, "repairEstablished": False})
    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verifier", type=Path)
    parser.add_argument("--run-pair", action="store_true")
    args = parser.parse_args()
    assert os.environ.get("GITHUB_ACTIONS") == "true", "Hosted diagnostic only; do not launch a local browser"
    if args.run_pair:
        return run_pair(args.output)
    else:
        assert args.verifier is not None
        return run_samples(args.output, args.verifier)


if __name__ == "__main__":
    sys.exit(main())
