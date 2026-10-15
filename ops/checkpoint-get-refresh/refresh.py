"""Generate the exact Get 5 override on a disposable hosted runner."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

BASE_LOCK = "c7e48d41401eee66868051c04f13fccefd40d196aad338c34f325a75de7ea3d2"
BASE_MANIFEST = "057a9676ac847cf1309787d57da12325c2ada604596c298e4b230502d7b64ba2"


def production_records(lock):
    return {name: record for name, record in lock["packages"].items()
            if name and not record.get("dev", False)}


def require_clean_audit(audit, returncode):
    assert returncode == 0 and isinstance(audit, dict), "audit_command_failed"
    assert audit.get("auditReportVersion") == 2 and not audit.get("error")
    assert isinstance(audit.get("vulnerabilities"), dict) and audit["vulnerabilities"] == {}, "audit_not_clean"
    counts = audit["metadata"]["vulnerabilities"]
    assert all(type(counts.get(key)) is int and counts[key] == 0
               for key in ("info", "low", "moderate", "high", "critical", "total")), "audit_counts_not_zero"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    if not parser.parse_args().apply:
        print("Plan: generate and audit the scoped Get 5 lock on a hosted runner")
        return
    assert os.environ.get("FREEDOM_DISPOSABLE_HOSTED") == "1" and os.geteuid() > 0
    repo = Path.cwd()
    output = Path(os.environ["FREEDOM_REFRESH_OUTPUT"]).resolve()
    assert not output.exists() and not output.is_relative_to(repo)
    output.mkdir(mode=0o700)
    private = output / "private"
    public = output / "public"
    private.mkdir(mode=0o700)
    public.mkdir(mode=0o700)
    receipt = {"passed": False, "stage": "baseline", "audit_gate_changed": False}
    deadline = time.monotonic() + 680

    def persist():
        (public / "refresh-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def run(command, name, check=True):
        receipt["stage"] = name
        persist()
        remaining = deadline - time.monotonic()
        assert remaining > 0
        with (private / (name + ".log")).open("wb") as log, \
                (private / (name + ".stderr")).open("wb") as errors:
            return subprocess.run(command, cwd=repo, timeout=remaining, check=check,
                                  stdout=log, stderr=errors)

    try:
        unit = os.environ["FREEDOM_REFRESH_UNIT"]
        assert Path("/proc/self/cgroup").read_text().strip() == "0::/system.slice/" + unit
        assert os.sched_getaffinity(0) == {0} and os.getpriority(os.PRIO_PROCESS, 0) == 19
        assert hashlib.sha256((repo / "package-lock.json").read_bytes()).hexdigest() == BASE_LOCK
        assert hashlib.sha256((repo / "package.json").read_bytes()).hexdigest() == BASE_MANIFEST
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        assert sha == os.environ["FREEDOM_REFRESH_SOURCE"]
        assert not subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()
        assert subprocess.check_output(["node", "--version"], text=True).strip() == "v24.14.0"
        for kind in ("user", "global"):
            config = private / (kind + ".npmrc")
            config.write_text("")
            os.environ["NPM_CONFIG_" + kind.upper() + "CONFIG"] = str(config)
        os.environ["npm_config_cache"] = str(private / "npm-cache")
        old_manifest = json.loads((repo / "package.json").read_text())
        old_lock = json.loads((repo / "package-lock.json").read_text())
        manifest = copy.deepcopy(old_manifest)
        manifest["overrides"]["app-builder-lib@26.15.3"] = {"@electron/get": "5.1.0"}
        (repo / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
        staged_lock = copy.deepcopy(old_lock)
        stale_get = "node_modules/app-builder-lib/node_modules/@electron/get"
        stale_records = {name for name in staged_lock["packages"]
                         if name == stale_get or name.startswith(stale_get + "/node_modules/")}
        assert stale_records == {stale_get, stale_get + "/node_modules/fs-extra",
                                 stale_get + "/node_modules/semver"}, "stale_get_subtree_changed"
        assert all(staged_lock["packages"][name].get("dev") is True for name in stale_records)
        for name in stale_records:
            del staged_lock["packages"][name]
        receipt["regenerated_dev_records"] = sorted(stale_records)
        (repo / "package-lock.json").write_text(json.dumps(staged_lock, indent=2) + "\n")
        run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
             "--registry=https://registry.npmjs.org"], "generate")
        generated_bytes = (repo / "package-lock.json").read_bytes()
        new_lock = json.loads(generated_bytes)
        (public / "npm-generated-lock.json").write_bytes(generated_bytes)
        receipt["generated_lock_sha256"] = hashlib.sha256(generated_bytes).hexdigest()
        for name in ("generate.log", "generate.stderr"):
            (public / name).write_bytes((private / name).read_bytes())
        assert json.loads((repo / "package.json").read_text()) == manifest
        assert production_records(new_lock) == production_records(old_lock), "production_graph_changed"
        assert new_lock["packages"]["node_modules/app-builder-lib"]["version"] == "26.15.3"
        assert new_lock["packages"]["node_modules/@electron/get"]["version"] == "5.1.0"
        forbidden = {"got", "cacheable-request", "http-cache-semantics"}
        receipt["remaining_legacy_packages"] = [name for name in new_lock["packages"]
                                               if name.rsplit("node_modules/", 1)[-1] in forbidden]
        assert not receipt["remaining_legacy_packages"], "legacy_downloaders_remain"
        run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "cold_install")
        run(["node", "-e", "const p=require.resolve('@electron/get',{paths:[require.resolve('app-builder-lib')]});const meta=JSON.parse(require('fs').readFileSync(require('path').join(require('path').dirname(p),'..','package.json')));if(meta.name!=='@electron/get'||meta.version!=='5.1.0')throw Error('Get5 installed version');const get=require(p);if(typeof get.downloadArtifact!=='function'||!get.ElectronDownloadCacheMode)throw Error('Get5 exports');console.log(JSON.stringify({path:p,version:meta.version}))"], "get_import")
        (public / "get-import.json").write_bytes((private / "get_import.log").read_bytes())
        result = run(["npm", "audit", "--json", "--audit-level=high"], "audit", check=False)
        audit = json.loads((private / "audit.log").read_text())
        (public / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
        receipt["audit_returncode"] = result.returncode
        require_clean_audit(audit, result.returncode)
        for name in ("package.json", "package-lock.json"):
            (public / name).write_bytes((repo / name).read_bytes())
        receipt.update(passed=True, source=sha, stage="complete", production_records=len(production_records(new_lock)),
                       manifest_sha256=hashlib.sha256((repo / "package.json").read_bytes()).hexdigest(),
                       lock_sha256=hashlib.sha256((repo / "package-lock.json").read_bytes()).hexdigest())
    except BaseException as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        audit_path = private / "audit.log"
        if audit_path.exists():
            try:
                report = json.loads(audit_path.read_text())
                if isinstance(report, dict) and report.get("auditReportVersion") == 2 and "vulnerabilities" in report:
                    (public / "audit.json").write_text(json.dumps(report, indent=2) + "\n")
            except (ValueError, OSError):
                receipt["audit_output_valid_json"] = False
        persist()


if __name__ == "__main__":
    main()
