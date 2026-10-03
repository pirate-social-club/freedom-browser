"""Exercise manifest, dependency-resolution and advisory refusal boundaries."""
import copy
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest import mock

C = runpy.run_path(str(Path(__file__).with_name("lock-contract.py")))
CLEANUP = runpy.run_path(str(Path(__file__).with_name("verify-refresh-cleanup.py")))
REFRESH = runpy.run_path(str(Path(__file__).with_name("refresh-jest-lock.py")))


def inputs():
    manifest = {"version": "0.7.15", "dependencies": {"runtime": "1"},
                "devDependencies": {"jest": "^30.2.0", "babel-jest": "^30.2.0", "builder": "1"}}
    packages = {"": copy.deepcopy(manifest), "node_modules/runtime": {"version": "1"},
                "node_modules/builder": {"version": "1", "dev": True, "dependencies": {"shared": "1"}},
                "node_modules/shared": {"version": "1", "dev": True},
                "node_modules/micromatch": {"version": "4.0.8", "dev": True, "dependencies": {"braces": "3"}},
                "node_modules/braces": {"version": "3.0.3", "dev": True}}
    for name in ("jest", "babel-jest"):
        packages["node_modules/" + name] = {"version": "30.2.0", "dev": True, "dependencies": {"micromatch": "4"}}
    original = {"name": "freedom-browser", "version": "0.7.15", "requires": True, "lockfileVersion": 3, "packages": packages}
    new_manifest = C["candidate_manifest"](manifest)
    new = copy.deepcopy(original)
    new["packages"][""] = copy.deepcopy(new_manifest)
    for name in ("jest", "babel-jest"):
        new["packages"]["node_modules/" + name] = {"version": "30.3.0", "dev": True,
            "resolved": "https://registry.npmjs.org/" + name + "/-/" + name + "-30.3.0.tgz", "integrity": "sha512-fixture"}
    del new["packages"]["node_modules/braces"]
    del new["packages"]["node_modules/micromatch"]
    return manifest, original, new_manifest, new


class ContractTests(unittest.TestCase):
    def test_shared_dependency_entries_are_preserved(self):
        values = inputs()
        values[3]["packages"]["node_modules/shared"]["version"] = "2"
        repaired, restored, isolated = C["restore_protected_entries"](values[0], values[1], values[3])
        self.assertEqual(restored, {"node_modules/shared": values[1]["packages"]["node_modules/shared"]})
        self.assertTrue(C["validate_lock"](*values[:3], repaired))
        self.assertEqual(isolated, {})

    def test_preserved_entry_must_satisfy_incoming_ranges(self):
        for range_value, passes in (("^1.0.0", True), ("^2.0.0", False)):
            with tempfile.TemporaryDirectory(prefix="freedom-protected-range-") as directory:
                root = Path(directory)
                restored = {"node_modules/shared": {"version": "1.0.0"}}
                packages = {**restored, "node_modules/jest": {"dependencies": {"shared": range_value}}}
                (root / "restored.json").write_text(json.dumps(restored))
                (root / "lock.json").write_text(json.dumps({"packages": packages}))
                result = subprocess.run(["node", "-e", REFRESH["PROTECTED_RANGE_SCRIPT"],
                                         str(root / "restored.json"), str(root / "lock.json"), str(root / "ranges.json")],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, passes)
                observation = json.loads((root / "ranges.json").read_text())
                self.assertEqual(observation["passed"], passes)
                self.assertEqual(observation["checked_edges"], 1)

    def test_jest_syntax_helpers_have_their_own_new_copies(self):
        values = inputs()
        helper = "node_modules/@babel/helper-plugin-utils"
        parents = ("node_modules/@babel/plugin-syntax-jsx", "node_modules/@babel/plugin-syntax-typescript")
        old = {"version": "7.28.6", "dev": True}
        new = {"version": "7.29.7", "dev": True}
        values[1]["packages"][helper] = old
        values[1]["packages"]["node_modules/builder"]["dependencies"]["@babel/helper-plugin-utils"] = "^7.28.0"
        values[3]["packages"]["node_modules/builder"] = copy.deepcopy(values[1]["packages"]["node_modules/builder"])
        values[3]["packages"][helper] = new
        for parent in parents:
            values[3]["packages"][parent] = {"version": "7.29.7", "dev": True,
                                             "dependencies": {"@babel/helper-plugin-utils": "^7.29.7"}}
        values[3]["packages"]["node_modules/jest"]["dependencies"] = {
            "@babel/plugin-syntax-jsx": "^7.29.7", "@babel/plugin-syntax-typescript": "^7.29.7"}
        repaired, restored, isolated = C["restore_protected_entries"](values[0], values[1], values[3])
        self.assertEqual(repaired["packages"][helper], old)
        self.assertEqual(isolated, {parent + "/" + helper: new for parent in parents})
        self.assertEqual(restored, {helper: old})
        self.assertTrue(C["validate_lock"](*values[:3], repaired))

    def test_distinct_empty_npm_configuration(self):
        with tempfile.TemporaryDirectory(prefix="freedom-refresh-config-") as directory:
            with mock.patch.dict(os.environ, {}, clear=True):
                REFRESH["isolate_npm_configuration"](Path(directory))
                user = Path(os.environ["NPM_CONFIG_USERCONFIG"])
                global_config = Path(os.environ["NPM_CONFIG_GLOBALCONFIG"])
                self.assertNotEqual(user, global_config)
                self.assertEqual(user.read_bytes(), b"")
                self.assertEqual(global_config.read_bytes(), b"")

    def test_matching_scoped_update(self):
        self.assertTrue(C["validate_lock"](*inputs()))

    def test_production_and_manifest_drift(self):
        for location in ("manifest", "production"):
            values = inputs()
            if location == "manifest":
                values[2]["version"] = "0.8.6"
            else:
                values[3]["packages"]["node_modules/runtime"]["version"] = "2"
            with self.assertRaises(ValueError):
                C["validate_lock"](*values)

    def test_unrelated_dev_graph_and_shadowing(self):
        for shadow in (False, True):
            values = inputs()
            if shadow:
                values[3]["packages"]["node_modules/builder/node_modules/shared"] = {"version": "2", "dev": True}
            else:
                values[3]["packages"]["node_modules/builder"]["version"] = "2"
            with self.assertRaisesRegex(ValueError, "unrelated_dependency_graph_changed"):
                C["validate_lock"](*values)

    def test_nested_affected_copy_and_edge(self):
        for edge in (False, True):
            values = inputs()
            if edge:
                values[3]["packages"]["node_modules/jest"]["dependencies"] = {"braces": "3"}
            else:
                values[3]["packages"]["node_modules/jest/node_modules/braces"] = {"version": "3.0.3", "dev": True}
            with self.assertRaises(ValueError):
                C["validate_lock"](*values)

    def test_version_and_origin_mismatch(self):
        for field in ("version", "resolved", "integrity"):
            values = inputs()
            values[3]["packages"]["node_modules/jest"][field] = "wrong"
            with self.assertRaises(ValueError):
                C["validate_lock"](*values)

    def test_affected_aliases_are_refused(self):
        for edge in (False, True):
            values = inputs()
            if edge:
                values[3]["packages"]["node_modules/jest"]["dependencies"] = {"alias": "npm:braces@3.0.3"}
            else:
                values[3]["packages"]["node_modules/jest/node_modules/alias"] = {"name": "braces", "version": "3.0.3", "dev": True}
            with self.assertRaises(ValueError):
                C["validate_lock"](*values)

    def test_remaining_full_audit_is_recorded_as_failure(self):
        value = {"vulnerabilities": {"cache": {"via": [{"url": C["REMAINING_ADVISORY"]}]}}}
        observation = C["audit_observation"](value, 1)
        self.assertFalse(observation["full_audit_passed"])
        self.assertFalse(observation["audit_gate_changed"])

    def test_audit_protocol_and_new_advisory_refused(self):
        for value, code in [({"error": {}}, 1), ({"vulnerabilities": {}}, 2),
                            ({"vulnerabilities": {"other": {"via": [{"url": "unknown"}]}}}, 1)]:
            with self.assertRaises(ValueError):
                C["audit_observation"](value, code)

    def test_audit_reference_chains_require_known_advisory(self):
        value = {"vulnerabilities": {"root": {"via": [{"url": C["REMAINING_ADVISORY"]}]},
                                     "dependent": {"via": ["root"]}}}
        self.assertEqual(C["audit_observation"](value, 1)["advisories"], [C["REMAINING_ADVISORY"]])
        for findings in ({"other": {"via": ["unknown"]}}, {"other": {"via": []}},
                         {"a": {"via": ["b"]}, "b": {"via": ["a"]}}):
            with self.assertRaises(ValueError):
                C["audit_observation"]({"vulnerabilities": findings}, 1)

    def test_rooted_audit_cycles_are_reported_as_failures(self):
        value = {"vulnerabilities": {"root": {"via": [{"url": C["REMAINING_ADVISORY"]}]},
                                     "builder": {"via": ["platform", "root"]},
                                     "platform": {"via": ["builder"]}}}
        self.assertFalse(C["audit_observation"](value, 1)["full_audit_passed"])
        value["vulnerabilities"]["platform"]["via"].append({"url": "unknown"})
        with self.assertRaisesRegex(ValueError, "new_or_retained_advisory"):
            C["audit_observation"](value, 1)

    def test_cleanup_query_failure_retains_receipt(self):
        for error in (subprocess.TimeoutExpired("systemctl", 5), subprocess.CalledProcessError(1, "systemctl")):
            with tempfile.TemporaryDirectory(prefix="freedom-refresh-cleanup-") as directory:
                with mock.patch("subprocess.run", side_effect=error):
                    receipt = CLEANUP["verify_cleanup"]("freedom-jest-refresh-1-1.service", directory, 0)
                self.assertFalse(receipt["passed"])
                self.assertEqual(json.loads((Path(directory) / "public/cleanup.json").read_text()), receipt)

    def test_cleanup_failed_stop_never_passes(self):
        query = subprocess.CompletedProcess("systemctl", 0,
            stdout="ActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nControlGroup=\n")
        with tempfile.TemporaryDirectory(prefix="freedom-refresh-cleanup-") as directory:
            with mock.patch("subprocess.run", return_value=query):
                self.assertFalse(CLEANUP["verify_cleanup"]("freedom-jest-refresh-1-1.service", directory, 124)["passed"])


if __name__ == "__main__":
    unittest.main()
