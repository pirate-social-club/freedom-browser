"""Exercise the accepted audit and security boundaries of the expiring exception."""
import copy
import datetime
import io
import gzip
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

C = runpy.run_path(str(Path(__file__).with_name("audit-scoped-exception.py")))
ROOT = Path(__file__).resolve().parents[2]
# Fixed approval bytes exercise refusal boundaries after the live graph changes.
# These fixtures grant no exception to the current candidate.
MANIFEST = Path(__file__).with_name("approved-audit-manifest-fixture.json").read_bytes()
LOCK = gzip.decompress(Path(__file__).with_name("approved-audit-lock-fixture.json.gz").read_bytes())
POLICY = C["load_policy"]()
AUDIT = json.loads(Path(__file__).with_name("audit-fixture.json").read_bytes())
NOW = datetime.datetime(2026, 10, 3, 12, tzinfo=datetime.timezone.utc)


def evaluate(audit=None, code=1, manifest=MANIFEST, lock=LOCK, policy=None, now=NOW, context=None):
    return C["evaluate"](AUDIT if audit is None else audit, code, manifest, lock,
                         POLICY if policy is None else policy, now,
                         C["CI_CONTEXT"] if context is None else context)


class ExceptionTests(unittest.TestCase):
    def test_current_changed_candidate_cannot_use_historical_approval(self):
        current_manifest = (ROOT / "package.json").read_bytes()
        current_lock = (ROOT / "package-lock.json").read_bytes()
        if current_manifest == MANIFEST and current_lock == LOCK:
            self.assertTrue(evaluate()["exception_applied"])
        else:
            with self.assertRaisesRegex(ValueError, "approved_(lock|manifest)_changed"):
                evaluate(manifest=current_manifest, lock=current_lock)

    def test_fixture_bytes_match_exact_owner_approval(self):
        self.assertEqual(C["digest"](MANIFEST), C["MANIFEST_SHA256"])
        self.assertEqual(C["digest"](LOCK), POLICY["candidate_lock_sha256"])

    def test_accepted_eight_finding_cycle_remains_failed_full_audit(self):
        result = evaluate()
        self.assertTrue(result["gate_passed"])
        self.assertTrue(result["exception_applied"])
        self.assertFalse(result["full_audit_passed"])
        self.assertFalse(result["full_audit_clean"])
        self.assertFalse(result["packaging_release_accepted"])
        self.assertEqual(result["audit_exit_code"], 1)
        self.assertEqual(result["counts"]["high"], 8)

    def test_expiry_is_exact_and_approval_cannot_be_backdated(self):
        expiry = datetime.datetime(2026, 10, 10, tzinfo=datetime.timezone.utc)
        self.assertTrue(evaluate(now=expiry - datetime.timedelta(microseconds=1))["gate_passed"])
        for now in (expiry, expiry + datetime.timedelta(seconds=1), NOW - datetime.timedelta(days=1)):
            with self.assertRaisesRegex(ValueError, "exception_expired_or_clock_before_approval"):
                evaluate(now=now)
        with self.assertRaisesRegex(ValueError, "clock_timezone_missing"):
            evaluate(now=NOW.replace(tzinfo=None))

    def test_release_or_unidentified_context_cannot_use_exception(self):
        for context in ({}, {**C["CI_CONTEXT"], "GITHUB_WORKFLOW": "Release"},
                        {**C["CI_CONTEXT"], "GITHUB_JOB": "package"},
                        {**C["CI_CONTEXT"], "GITHUB_ACTIONS": "false"}):
            with self.assertRaisesRegex(ValueError, "exception_outside_development_ci"):
                evaluate(context=context)

    def test_unapproved_policy_refuses(self):
        for key, value in (("status", "proposed"), ("authority", "operator"), ("applied", False)):
            policy = copy.deepcopy(POLICY)
            policy[key] = value
            with self.assertRaisesRegex(ValueError, "exception_not_approved"):
                evaluate(policy=policy)

    def test_manifest_and_lock_byte_drift_refuse(self):
        for values in ({"manifest": MANIFEST + b" "}, {"lock": LOCK + b" "}):
            with self.assertRaisesRegex(ValueError, "approved_.*_changed"):
                evaluate(**values)

    def test_new_or_removed_finding_refuses(self):
        for remove in (False, True):
            audit = copy.deepcopy(AUDIT)
            if remove:
                del audit["vulnerabilities"]["got"]
            else:
                audit["vulnerabilities"]["unknown"] = {"name": "unknown", "severity": "high"}
            audit["metadata"]["vulnerabilities"]["high"] = len(audit["vulnerabilities"])
            audit["metadata"]["vulnerabilities"]["total"] = len(audit["vulnerabilities"])
            with self.assertRaisesRegex(ValueError, "unapproved_finding_set"):
                evaluate(audit)

    def test_severity_and_directness_drift_refuse(self):
        for key, value in (("isDirect", True), ("severity", "critical")):
            audit = copy.deepcopy(AUDIT)
            audit["vulnerabilities"]["got"][key] = value
            if key == "severity":
                audit["metadata"]["vulnerabilities"].update(high=7, critical=1)
            with self.assertRaisesRegex(ValueError, "finding_identity_changed"):
                evaluate(audit)

    def test_changed_or_duplicate_node_paths_refuse(self):
        for nodes in (["node_modules/other/got"], ["node_modules/got", "node_modules/got"]):
            audit = copy.deepcopy(AUDIT)
            audit["vulnerabilities"]["got"]["nodes"] = nodes
            with self.assertRaisesRegex(ValueError, "finding_paths_changed"):
                evaluate(audit)

    def test_advisory_identity_and_reference_drift_refuse(self):
        for via in (["unknown"], [], [{"url": "https://github.com/advisories/unknown"}]):
            audit = copy.deepcopy(AUDIT)
            audit["vulnerabilities"]["got"]["via"] = via
            with self.assertRaises(ValueError):
                evaluate(audit)
        audit = copy.deepcopy(AUDIT)
        audit["vulnerabilities"]["http-cache-semantics"]["via"][0]["source"] += 1
        with self.assertRaisesRegex(ValueError, "finding_advisory_or_ancestry_changed"):
            evaluate(audit)

    def test_runtime_graph_refusal_is_independent_of_hash_check(self):
        manifest, lock, policy = json.loads(MANIFEST), json.loads(LOCK), copy.deepcopy(POLICY)
        manifest["dependencies"]["got"] = "11.8.6"
        manifest_raw, lock_raw = json.dumps(manifest).encode(), json.dumps(lock).encode()
        policy["candidate_lock_sha256"] = C["digest"](lock_raw)
        with mock.patch.dict(C["evaluate"].__globals__, MANIFEST_SHA256=C["digest"](manifest_raw)):
            with self.assertRaisesRegex(ValueError, "runtime_reaches_affected_path"):
                evaluate(manifest=manifest_raw, lock=lock_raw, policy=policy)

    def test_protocol_counts_and_process_errors_refuse(self):
        for code in (2, 124, True):
            with self.assertRaisesRegex(ValueError, "audit_process_failed"):
                evaluate(code=code)
        for mutation in ({"auditReportVersion": 1}, {"error": {}}, {"metadata": []},
                         {"metadata": {"vulnerabilities": {"high": 8}}}):
            with self.assertRaises(ValueError):
                evaluate({**AUDIT, **mutation})
        audit = copy.deepcopy(AUDIT)
        audit["metadata"]["vulnerabilities"]["low"] = True
        with self.assertRaisesRegex(ValueError, "audit_counts_inconsistent"):
            evaluate(audit)

    def test_exit_code_cannot_contradict_high_severity_findings(self):
        with self.assertRaisesRegex(ValueError, "audit_exit_inconsistent"):
            evaluate(code=0)

    def test_existing_high_threshold_remains_without_exception(self):
        audit = {"auditReportVersion": 2, "vulnerabilities": {},
                 "metadata": {"vulnerabilities": dict.fromkeys((*C["SEVERITIES"], "total"), 0)}}
        result = evaluate(audit, code=0, context={}, now=NOW + datetime.timedelta(days=30))
        self.assertTrue(result["full_audit_clean"])
        self.assertFalse(result["exception_applied"])
        audit["vulnerabilities"]["moderate"] = {"name": "moderate", "severity": "moderate"}
        audit["metadata"]["vulnerabilities"].update(moderate=1, total=1)
        result = evaluate(audit, code=0, context={})
        self.assertTrue(result["gate_passed"])
        self.assertFalse(result["full_audit_clean"])
        self.assertFalse(result["exception_applied"])

    def test_policy_bytes_are_bound_to_owner_approval(self):
        with mock.patch.object(Path, "read_bytes", return_value=b"{}"):
            with self.assertRaisesRegex(ValueError, "approved_policy_changed"):
                C["load_policy"]()

    def test_actual_nonzero_audit_and_raw_output_are_retained(self):
        raw = json.dumps(AUDIT).encode()
        with tempfile.TemporaryDirectory(prefix="freedom-audit-fixture-") as directory:
            output = Path(directory)
            completed = subprocess.CompletedProcess("npm", 1, stdout=raw, stderr=b"fixture")
            with mock.patch("subprocess.run", return_value=completed) as run:
                self.assertEqual(C["record_audit"](ROOT, output), (raw, 1))
            self.assertEqual(run.call_args.args[0], ["npm", "audit", "--audit-level=high", "--json"])
            self.assertEqual((output / "full-audit.json").read_bytes(), raw)
            receipt = json.loads((output / "audit-execution.json").read_text())
            self.assertEqual(receipt["audit_exit_code"], 1)
            self.assertFalse(receipt["full_audit_passed"])

    def test_timeout_is_retained_and_never_passes(self):
        with tempfile.TemporaryDirectory(prefix="freedom-audit-fixture-") as directory:
            output = Path(directory)
            with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("npm", 180)):
                raw, code = C["record_audit"](ROOT, output)
            self.assertEqual((raw, code), (b"", 124))
            self.assertFalse(json.loads((output / "audit-execution.json").read_text())["full_audit_passed"])

    def test_malformed_audit_records_a_refusal_verdict(self):
        with tempfile.TemporaryDirectory(prefix="freedom-audit-fixture-") as directory:
            with mock.patch.object(sys, "argv", ["audit", "--output", directory]), \
                    mock.patch("subprocess.run", return_value=subprocess.CompletedProcess("npm", 1, b"invalid", b"")), \
                    mock.patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}), redirect_stdout(io.StringIO()):
                self.assertEqual(C["main"](), 1)
            result = json.loads((Path(directory) / "exception-verdict.json").read_text())
            self.assertFalse(result["gate_passed"])
            self.assertFalse(result["exception_applied"])
            self.assertEqual((Path(directory) / "full-audit.json").read_bytes(), b"invalid")


if __name__ == "__main__":
    unittest.main()
