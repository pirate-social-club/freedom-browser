"""Retain the full audit and apply only the owner's exact, expiring CI exception."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess

POLICY_SHA256 = "1dccead99bb9bdd754e79e1d459bb8042357c8d9e9a59e2e471abda20db30737"
MANIFEST_SHA256 = "057a9676ac847cf1309787d57da12325c2ada604596c298e4b230502d7b64ba2"
CONTRACT = runpy.run_path(str(Path(__file__).with_name("lock-contract.py")))
SEVERITIES = ("info", "low", "moderate", "high", "critical")
CI_CONTEXT = {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": "CI", "GITHUB_JOB": "dependency-audit"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def require(value, code):
    if not value:
        raise ValueError(code)


def load_policy():
    raw = Path(__file__).with_name("http-audit-exception.json").read_bytes()
    require(digest(raw) == POLICY_SHA256, "approved_policy_changed")
    return json.loads(raw)


def finding_counts(audit):
    require(isinstance(audit, dict) and audit.get("auditReportVersion") == 2
            and "error" not in audit, "audit_protocol_failed")
    findings = audit.get("vulnerabilities")
    require(isinstance(findings, dict), "audit_findings_schema")
    counts = {name: 0 for name in SEVERITIES}
    for name, entry in findings.items():
        require(isinstance(entry, dict) and entry.get("name") == name
                and entry.get("severity") in SEVERITIES, "audit_finding_schema")
        counts[entry["severity"]] += 1
    counts["total"] = len(findings)
    require(isinstance(audit.get("metadata"), dict), "audit_metadata_schema")
    metadata = audit["metadata"].get("vulnerabilities")
    require(isinstance(metadata, dict) and set(metadata) == set(counts)
            and all(type(v) is int for v in metadata.values())
            and metadata == counts, "audit_counts_inconsistent")
    return findings, counts


def canonical_via(value):
    require(isinstance(value, list) and value, "audit_via_schema")
    require(all(isinstance(v, (str, dict)) for v in value), "audit_via_schema")
    return sorted(json.dumps(v, sort_keys=True) for v in value)


def evaluate(audit, returncode, manifest_raw, lock_raw, policy, now, context):
    require(type(returncode) is int and returncode in (0, 1), "audit_process_failed")
    findings, counts = finding_counts(audit)
    threshold_failed = bool(counts["high"] or counts["critical"])
    require((returncode != 0) == threshold_failed, "audit_exit_inconsistent")
    result = {"audit_exit_code": returncode, "full_audit_passed": returncode == 0,
              "full_audit_clean": not findings, "counts": counts,
              "exception_applied": False, "gate_passed": False,
              "packaging_release_accepted": False}
    # Preserve the existing high-severity threshold when an exception is unnecessary.
    if returncode == 0:
        result["gate_passed"] = True
        result["code"] = "full_audit_threshold_passed"
        return result

    require(all(context.get(key) == value for key, value in CI_CONTEXT.items()),
            "exception_outside_development_ci")
    require(policy.get("status") == "approved_by_workspace_owner"
            and policy.get("authority") == "workspace_owner"
            and policy.get("applied") is True, "exception_not_approved")
    require(now.tzinfo is not None, "clock_timezone_missing")
    approved = datetime.datetime.fromisoformat(policy["approved_on"] + "T00:00:00+00:00")
    expires = datetime.datetime.fromisoformat(policy["expires_at"].replace("Z", "+00:00"))
    require(approved <= now < expires, "exception_expired_or_clock_before_approval")
    require(digest(lock_raw) == policy["candidate_lock_sha256"], "approved_lock_changed")
    require(digest(manifest_raw) == MANIFEST_SHA256, "approved_manifest_changed")
    manifest, lock = json.loads(manifest_raw), json.loads(lock_raw)
    allowed = policy["allowed_findings"]
    require(set(findings) == set(allowed), "unapproved_finding_set")
    affected = set()
    for name, expected in allowed.items():
        entry = findings[name]
        require(entry.get("severity") == expected["severity"]
                and type(entry.get("isDirect")) is bool
                and entry["isDirect"] == expected["isDirect"], "finding_identity_changed")
        nodes = entry.get("nodes")
        require(isinstance(nodes, list) and all(isinstance(x, str) for x in nodes)
                and len(nodes) == len(set(nodes))
                and set(nodes) == set(expected["nodes"]), "finding_paths_changed")
        require(canonical_via(entry.get("via")) == canonical_via(expected["via"]),
                "finding_advisory_or_ancestry_changed")
        for path, record in expected["nodes"].items():
            require(lock["packages"].get(path) == record and record.get("dev") is True,
                    "locked_finding_record_changed")
            affected.add(path)
    # The pinned complete lock binds every resolved dependency, optional and peer edge.
    roots = set()
    for kind in ("dependencies", "optionalDependencies", "peerDependencies"):
        roots.update(manifest.get(kind, {}))
    graph = CONTRACT["resolved_graph"](lock, roots)
    require(not affected.intersection(graph), "runtime_reaches_affected_path")
    observation = CONTRACT["audit_observation"](audit, returncode)
    require(observation["advisories"] == [policy["advisory_url"]], "unapproved_advisory")
    result.update({"exception_applied": True, "gate_passed": True,
                   "code": "owner_approved_development_exception",
                   "advisory": policy["advisory"], "expires_at": policy["expires_at"],
                   "policy_sha256": POLICY_SHA256, "lock_sha256": digest(lock_raw)})
    return result


def record_audit(root, output):
    command = ["npm", "audit", "--audit-level=high", "--json"]
    try:
        run = subprocess.run(command, cwd=root, capture_output=True, timeout=180)
        raw, returncode, stderr = run.stdout, run.returncode, run.stderr
    except subprocess.TimeoutExpired as error:
        raw, returncode, stderr = error.stdout or b"", 124, error.stderr or b""
    (output / "full-audit.json").write_bytes(raw)
    receipt = {"command": command, "audit_exit_code": returncode,
               "full_audit_passed": returncode == 0,
               "stdout_sha256": digest(raw), "stderr_sha256": digest(stderr)}
    (output / "audit-execution.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return raw, returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    result = {"gate_passed": False, "exception_applied": False,
              "full_audit_passed": False, "packaging_release_accepted": False}
    try:
        policy = load_policy()
        manifest_raw, lock_raw = (root / "package.json").read_bytes(), (root / "package-lock.json").read_bytes()
        raw, returncode = record_audit(root, output)
        result["audit_exit_code"] = returncode
        result = evaluate(json.loads(raw), returncode, manifest_raw, lock_raw, policy,
                          datetime.datetime.now(datetime.timezone.utc), os.environ)
        require((root / "package.json").read_bytes() == manifest_raw
                and (root / "package-lock.json").read_bytes() == lock_raw, "source_changed_during_audit")
    except (ValueError, OSError, KeyError, TypeError) as error:
        result["gate_passed"] = False
        result["exception_applied"] = False
        result["code"] = str(error) if type(error) is ValueError else "audit_protocol_or_input_error"
    (output / "exception-verdict.json").write_text(json.dumps(result, indent=2) + "\n")
    summary = "Full dependency audit exit: {0}. Full audit passed: {1}. Development CI gate passed: {2}.".format(
        result.get("audit_exit_code", "not completed"), result["full_audit_passed"], result["gate_passed"])
    if result["exception_applied"]:
        summary += "\n\nThe owner-approved GHSA-ch52-4w7c-c8xp exception applies to the exact pinned downloader path until 2026-10-10 at 00:00 UTC. The full audit remains failed. This is no packaging or release acceptance."
    else:
        summary += "\n\nVerdict: " + result["code"] + ". No advisory exception applied."
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as destination:
            destination.write(summary + "\n")
    return 0 if result["gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
