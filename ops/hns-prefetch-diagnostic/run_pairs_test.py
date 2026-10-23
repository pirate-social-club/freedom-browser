import importlib.util
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hns_pairs", Path(__file__).with_name("run-pairs.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PairEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        module.write_json(self.root / "resources.json", {"resources": module.RESOURCES, "affinity": [0], "nice": 19})
        module.write_json(self.root / "jest.json", {"success": True, "numFailedTests": 0,
                                                   "numPendingTests": 0, "numTotalTests": 10})
        for mode in ("protected", "control"):
            directory = self.root / "probes" / f"{mode}-fixture"
            directory.mkdir(parents=True)
            result = {"versions": {"electron": "44.9.3"}, "networkLog": {
                "stopped": True, "captureMode": "default", "maxFileSize": module.NET_LOG_MAX_BYTES}}
            result["rendererHintObservation"] = {"enabled": True, "overflow": False, "contentsIds": [1, 2, 3],
                "messages": ([{"contentsId": 2, "ms": 1, "name": f"{kind}-default-r2.{root}"}
                              for kind in ("header", "html") for root in ("hnsprobe", "pirate", "unlistedprobe")]
                             if mode == "control" else [])}
            stdout = ("PROBE-RESULT " + json.dumps(result) + "\n").encode()
            module.write_json(directory / "net-log.json", {"constants": {"logEventTypes": {"fixture": 1}},
                                                          "events": [{"type": 1}]})
            (directory / "stdout.log").write_bytes(stdout)
            (directory / "stderr.log").write_bytes(b"")
            module.write_json(directory / "process.json", {"closed": True, "exitCode": 0, "signal": None,
                "timedOut": False, "spawnError": None, "parseError": None, "resultFound": True,
                "stdoutBytes": len(stdout), "stderrBytes": 0, "networkLogging": True})

    def tearDown(self):
        self.temporary.cleanup()

    def test_complete_evidence_passes(self):
        self.assertEqual(module.assess_pair(self.root, 0), [])

    def test_renderer_observation_refuses_absent_overflow_and_wrong_shapes(self):
        for value in [None, [], {}, {"enabled": True, "overflow": True, "contentsIds": [1, 2, 3], "messages": []},
                      {"enabled": True, "overflow": False, "contentsIds": [1, 1, 2], "messages": []},
                      {"enabled": True, "overflow": False, "contentsIds": [1, 2, 3], "messages": [None]}]:
            with self.subTest(value=value):
                self.assertFalse(module.valid_renderer_observation(value, "control"))

    def test_renderer_observation_requires_later_control_triggers_and_protected_silence(self):
        value = {"enabled": True, "overflow": False, "contentsIds": [1, 2, 3], "messages": []}
        self.assertTrue(module.valid_renderer_observation(value, "protected"))
        self.assertFalse(module.valid_renderer_observation(value, "control"))
        value["messages"] = [{"contentsId": 2, "ms": 1, "name": "html-default.pirate"}]
        self.assertFalse(module.valid_renderer_observation(value, "protected"))

    def test_green_jest_does_not_hide_missing_renderer_capture(self):
        directory = self.root / "probes/control-fixture"
        result = json.loads((directory / "stdout.log").read_text().removeprefix("PROBE-RESULT "))
        del result["rendererHintObservation"]
        stdout = ("PROBE-RESULT " + json.dumps(result) + "\n").encode()
        (directory / "stdout.log").write_bytes(stdout)
        record = json.loads((directory / "process.json").read_text())
        record["stdoutBytes"] = len(stdout)
        module.write_json(directory / "process.json", record)
        self.assertIn("control_renderer_observation_invalid", module.assess_pair(self.root, 0))

    def test_green_jest_does_not_hide_nonzero_probe_exit(self):
        path = self.root / "probes/control-fixture/process.json"
        value = json.loads(path.read_text())
        value["exitCode"] = 1
        module.write_json(path, value)
        self.assertIn("control_process_failed", module.assess_pair(self.root, 0))

    def test_green_jest_does_not_hide_timeout_or_missing_output(self):
        path = self.root / "probes/control-fixture/process.json"
        value = json.loads(path.read_text())
        value.update({"timedOut": True, "closed": False, "stdoutBytes": 10000})
        module.write_json(path, value)
        failures = module.assess_pair(self.root, 0)
        self.assertIn("control_process_failed", failures)
        self.assertIn("control_output_incomplete", failures)

    def test_missing_control_fails(self):
        (self.root / "probes/control-fixture/process.json").unlink()
        self.assertIn("control_process_count", module.assess_pair(self.root, 0))

    def test_missing_or_truncated_network_log_cannot_pass(self):
        path = self.root / "probes/control-fixture/net-log.json"
        path.unlink()
        self.assertIn("control_evidence_invalid", module.assess_pair(self.root, 0))
        path.write_text('{"events":[')
        self.assertIn("control_evidence_invalid", module.assess_pair(self.root, 0))

    def test_network_log_at_size_limit_is_not_complete_evidence(self):
        path = self.root / "probes/control-fixture/net-log.json"
        with path.open("wb") as output:
            output.truncate(module.NET_LOG_MAX_BYTES)
        self.assertIn("control_net_log_limit_reached", module.assess_pair(self.root, 0))

    def test_wrong_network_log_shape_is_recorded_without_aborting_sample_collection(self):
        path = self.root / "probes/control-fixture/net-log.json"
        for value in ([], None, {"constants": [1], "events": [1]}, {"constants": {"a": 1}, "events": "bad"}):
            with self.subTest(value=value):
                module.write_json(path, value)
                self.assertIn("control_net_log_empty", module.assess_pair(self.root, 0))

    def test_empty_network_log_and_disabled_logging_fail(self):
        directory = self.root / "probes/control-fixture"
        module.write_json(directory / "net-log.json", {"constants": {}, "events": []})
        record = json.loads((directory / "process.json").read_text())
        record["networkLogging"] = False
        module.write_json(directory / "process.json", record)
        failures = module.assess_pair(self.root, 0)
        self.assertIn("control_net_log_empty", failures)
        self.assertIn("control_network_logging_missing", failures)

    def test_unflushed_network_log_fails_despite_valid_json(self):
        directory = self.root / "probes/control-fixture"
        stdout = (directory / "stdout.log").read_bytes().replace(b'"stopped": true', b'"stopped":false')
        (directory / "stdout.log").write_bytes(stdout)
        record = json.loads((directory / "process.json").read_text())
        record["stdoutBytes"] = len(stdout)
        module.write_json(directory / "process.json", record)
        self.assertIn("control_net_log_not_flushed", module.assess_pair(self.root, 0))

    def test_skipped_or_failed_assertions_fail(self):
        module.write_json(self.root / "jest.json", {"success": True, "numFailedTests": 0,
                                                   "numPendingTests": 1, "numTotalTests": 10})
        self.assertIn("assertions_failed_or_skipped", module.assess_pair(self.root, 0))

    def test_wrong_runtime_and_missing_limits_fail(self):
        path = self.root / "probes/protected-fixture/stdout.log"
        path.write_text(path.read_text().replace("44.9.3", "44.9.4"))
        (self.root / "resources.json").unlink()
        failures = module.assess_pair(self.root, 0)
        self.assertIn("protected_runtime_or_result_mismatch", failures)
        self.assertIn("runtime_limits_missing", failures)


class SampleSchedulingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.verifier = self.root / "verifier.py"
        self.verifier.write_text("fixture verifier; never executed")
        self.digest = hashlib.sha256(self.verifier.read_bytes()).hexdigest()
        self.launches = []
        self.cleanups = []
        self.unit_codes = [0] * 6
        self.cleanup_fails = False

    def tearDown(self):
        self.temporary.cleanup()

    def fake_run(self, command, **_kwargs):
        if command[:2] == ["sudo", "systemd-run"]:
            self.launches.append(command[command.index("--output") + 1])
            code = self.unit_codes[len(self.launches) - 1]
            if isinstance(code, Exception):
                raise code
            return subprocess.CompletedProcess(command, code)
        if command[:2] == ["python3", str(self.verifier)]:
            self.cleanups.append(command[3])
            if self.cleanup_fails:
                raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, stdout=b"fixture journal", stderr=b"")

    def collect(self, setup_ok=True, deadline=None):
        with patch.object(module.subprocess, "run", side_effect=self.fake_run), \
             patch.object(module.subprocess, "check_output", return_value="inactive\n"), \
             patch.object(module, "assess_pair", side_effect=lambda _path, code: [] if code == 0 else ["jest_or_unit_failed"]), \
             contextlib.redirect_stdout(io.StringIO()):
            code = module.collect_pairs(self.root, self.verifier, self.digest,
                "freedom-upstream-validation-1-1.service",
                deadline if deadline is not None else time.monotonic() + 1320, setup_ok)
        return code, json.loads((self.root / "summary.json").read_text())

    def test_failure_is_retained_and_next_samples_are_not_retries(self):
        self.unit_codes[0] = 1
        code, summary = self.collect()
        self.assertEqual(code, 1)
        self.assertEqual([Path(path).name for path in self.launches], [f"pair-{i}" for i in range(1, 7)])
        self.assertEqual(len(self.cleanups), 6)
        self.assertEqual([pair["status"] for pair in summary["pairs"]], ["failed"] + ["passed"] * 5)
        self.assertEqual(summary["retries"], 0)

    def test_cleanup_failure_prevents_next_browser_and_records_all_six_outcomes(self):
        self.cleanup_fails = True
        code, summary = self.collect()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.launches), 1)
        self.assertEqual(len(summary["pairs"]), 6)
        self.assertIn("cleanup_failed", summary["pairs"][0]["failures"])
        self.assertTrue(all(pair["reason"] == "cleanup_failed" for pair in summary["pairs"][1:]))

    def test_client_timeout_still_cleans_up_and_is_not_erased(self):
        self.unit_codes[0] = subprocess.TimeoutExpired("fixture command", 195)
        code, summary = self.collect()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.cleanups), 6)
        self.assertIn("unit_client_timeout", summary["pairs"][0]["failures"])
        self.assertFalse(summary["passed"])

    def test_insufficient_setup_budget_never_launches_a_browser(self):
        code, summary = self.collect(setup_ok=False)
        self.assertEqual((code, self.launches, self.cleanups), (1, [], []))
        self.assertEqual(len(summary["pairs"]), 6)
        self.assertTrue(all(pair["reason"] == "setup_budget_exhausted" for pair in summary["pairs"]))

    def test_expired_experiment_never_launches_a_browser(self):
        code, summary = self.collect(deadline=time.monotonic() - 1)
        self.assertEqual((code, self.launches), (1, []))
        self.assertTrue(all(pair["reason"] == "budget_exhausted" for pair in summary["pairs"]))

    def test_six_clean_samples_do_not_claim_a_cause_or_repair(self):
        code, summary = self.collect()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.launches), 6)
        self.assertTrue(summary["passed"])
        self.assertFalse(summary["causeEstablished"])
        self.assertFalse(summary["repairEstablished"])


if __name__ == "__main__":
    unittest.main()
