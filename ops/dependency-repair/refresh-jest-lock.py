"""Generate and validate the exact Jest update on a disposable hosted runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import time

BASE_MANIFEST = "03f1fc938d26812151a5053320486b9db771bb74925452176bc4414d4e6944b4"
BASE_LOCK = "aa207af2fd95c6fbccfcbabdcb8cc19c41f27e0aa3d672e941fc3ee3b5103044"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps({"mutation": False, "jest": "30.3.0", "hosted_only": True}))
        return
    assert os.environ.get("FREEDOM_DISPOSABLE_HOSTED") == "1", "hosted_only"
    assert os.geteuid() > 0, "ordinary_runner_user_required"
    repo = Path.cwd()
    output = Path(os.environ["FREEDOM_REFRESH_OUTPUT"]).resolve()
    assert not output.exists() and not output.is_relative_to(repo), "fresh_external_output"
    output.mkdir(mode=0o700)
    private = output / "private"
    private.mkdir(mode=0o700)
    public = output / "public"
    public.mkdir(mode=0o700)
    started = time.monotonic()
    deadline = started + 680
    receipt = {"passed": False, "stage": "baseline", "audit_gate_changed": False}

    def persist():
        (public / "refresh-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def run(command, name):
        receipt["stage"] = name
        persist()
        remaining = deadline-time.monotonic()
        assert remaining > 0, "refresh_deadline"
        with (private / (name + ".log")).open("wb") as log:
            return subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                  timeout=remaining, check=True)

    try:
        unit = os.environ["FREEDOM_REFRESH_UNIT"]
        cgroup = Path("/sys/fs/cgroup/system.slice") / unit
        assert Path("/proc/self/cgroup").read_text().strip() == "0::/system.slice/" + unit
        assert os.sched_getaffinity(0) == {0} and os.getpriority(os.PRIO_PROCESS, 0) == 19
        assert digest(repo / "package.json") == BASE_MANIFEST, "baseline_manifest"
        assert digest(repo / "package-lock.json") == BASE_LOCK, "baseline_lock"
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        assert sha == os.environ["FREEDOM_REFRESH_SOURCE"]
        assert not subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()
        manifest = json.loads((repo / "package.json").read_text())
        lock = json.loads((repo / "package-lock.json").read_text())
        contract = runpy.run_path(str(Path(__file__).with_name("lock-contract.py")))
        receipt.update({"source": sha, "Node": subprocess.check_output(["node", "--version"], text=True).strip(),
                        "npm": subprocess.check_output(["npm", "--version"], text=True).strip(),
                        "registry": "https://registry.npmjs.org", "baseline_manifest_sha256": BASE_MANIFEST,
                        "baseline_lock_sha256": BASE_LOCK})
        assert receipt["Node"] == "v24.14.0", "node_version"
        run(["npm", "install", "--save-dev", "--save-exact", "--package-lock-only", "--ignore-scripts",
             "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org",
             "jest@30.3.0", "babel-jest@30.3.0"], "lock_refresh")
        receipt["stage"] = "lock_contract"
        new_manifest = json.loads((repo / "package.json").read_text())
        new_lock = json.loads((repo / "package-lock.json").read_text())
        for name in ("package.json", "package-lock.json"):
            (public / name).write_bytes((repo / name).read_bytes())
        receipt.update({"candidate_manifest_sha256": digest(public / "package.json"),
                        "candidate_lock_sha256": digest(public / "package-lock.json")})
        raw_changes = [{"path": path, "before": lock["packages"].get(path), "after": new_lock["packages"].get(path)}
                       for path in sorted(set(lock["packages"]) | set(new_lock["packages"]))
                       if lock["packages"].get(path) != new_lock["packages"].get(path)]
        (public / "graph-changes.json").write_text(json.dumps(raw_changes, indent=2) + "\n")
        persist()
        changes = contract["validate_lock"](manifest, lock, new_manifest, new_lock)
        run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
             "--registry=https://registry.npmjs.org"], "clean_install")
        receipt["stage"] = "full_audit"
        persist()
        audit = subprocess.run(["npm", "audit", "--json", "--audit-level=high",
                                "--registry=https://registry.npmjs.org"], capture_output=True, text=True,
                               timeout=max(1, deadline-time.monotonic()))
        audit_json = json.loads(audit.stdout)
        (public / "full-audit.json").write_text(json.dumps(audit_json, indent=2) + "\n")
        receipt["audit"] = contract["audit_observation"](audit_json, audit.returncode)
        run(["npm", "run", "lint"], "lint")
        results_path = private / "jest-results.json"
        run(["npm", "run", "test:unit", "--", "--runInBand", "--json",
             "--outputFile=" + str(results_path)], "full_jest")
        results = json.loads(results_path.read_text())
        assert results["success"] is True and results["numFailedTests"] == 0 and results["numFailedTestSuites"] == 0
        assert results["numTotalTests"] == 990 and results["numTotalTestSuites"] == 72, "test_discovery_changed"
        receipt["tests"] = {key: results[key] for key in ("numTotalTests", "numPassedTests", "numPendingTests",
                                                       "numTotalTestSuites", "numPassedTestSuites", "numPendingTestSuites")}
        assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, timeout=5).strip() == sha, "source_changed"
        for name in ("package.json", "package-lock.json"):
            expected = receipt["candidate_manifest_sha256" if name == "package.json" else "candidate_lock_sha256"]
            assert digest(repo / name) == expected, "candidate_changed_after_validation"
        assert set(subprocess.check_output(["git", "diff", "--name-only"], text=True).splitlines()) == {"package.json", "package-lock.json"}
        assert not subprocess.check_output(["git", "diff", "--cached", "--name-only"], text=True).strip()
        assert time.monotonic() < deadline, "refresh_deadline"
        for name in ("package.json", "package-lock.json"):
            (public / name).write_bytes((repo / name).read_bytes())
        receipt.update({"candidate_manifest_sha256": digest(public / "package.json"),
                        "candidate_lock_sha256": digest(public / "package-lock.json"),
                        "production_graph_unchanged": True, "braces_and_micromatch_removed": True,
                        "changed_graph_entries": len(changes), "lint_passed": True, "stage": "complete", "passed": True})
    except BaseException as error:
        receipt["error_category"] = "timeout" if isinstance(error, subprocess.TimeoutExpired) else "command_failed" if isinstance(error, subprocess.CalledProcessError) else "contract_failed"
        if isinstance(error, (AssertionError, ValueError)):
            known = {"baseline_manifest", "baseline_lock", "node_version", "test_discovery_changed",
                     "unrelated_manifest_change", "production_graph_changed", "affected_test_package_retained",
                     "affected_test_edge_retained", "new_or_retained_advisory", "refresh_deadline",
                     "unrelated_dependency_graph_changed", "unrelated_lock_entry_changed", "missing_root_package",
                     "root_lock_changed", "lock_schema", "lock_metadata_changed", "missing_jest_root",
                     "jest_version", "jest_origin", "audit_protocol_failed", "audit_schema",
                     "audit_finding_schema", "audit_advisory_schema", "audit_verdict_inconsistent",
                     "audit_reference_missing", "audit_reference_cycle", "audit_reference_without_advisory",
                     "source_changed", "candidate_changed_after_validation"}
            receipt["assertion_id"] = str(error) if str(error) in known else "other_contract"
        raise
    finally:
        receipt["elapsed_seconds"] = time.monotonic()-started
        try:
            resources = {name: (cgroup / name).read_text().strip() for name in
                         ("cpu.max", "memory.max", "memory.swap.max", "memory.peak", "memory.swap.peak", "memory.events")}
            quota, period = resources["cpu.max"].split()
            assert quota != "max" and 0 < int(quota) <= int(period)
            assert resources["memory.max"] == "3221225472" and resources["memory.swap.max"] == "0"
            events = dict(line.split() for line in resources["memory.events"].splitlines())
            assert int(events["oom"]) == int(events["oom_kill"]) == int(resources["memory.swap.peak"]) == 0
            receipt["resources"] = resources
        except BaseException:
            receipt["passed"] = False
            receipt["resource_proof_failed"] = True
        persist()
    assert receipt["passed"], "refresh_validation_failed"


if __name__ == "__main__":
    main()
