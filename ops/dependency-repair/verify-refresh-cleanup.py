"""Retain unit disappearance after hosted lock generation, before artifact upload."""
import json
from pathlib import Path
import re
import subprocess
import sys

def verify_cleanup(unit, output, stop_returncode):
    assert re.fullmatch(r"freedom-jest-refresh-[0-9]+-[0-9]+\.service", unit)
    receipt = {"passed": False, "unit": unit, "stop_returncode": stop_returncode, "state": {}}
    cgroup = Path("/sys/fs/cgroup/system.slice") / unit
    try:
        query = subprocess.run(["systemctl", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState",
                                "-p", "MainPID", "-p", "ControlPID", "-p", "ControlGroup"],
                               capture_output=True, text=True, check=True, timeout=5)
        state = dict(line.split("=", 1) for line in query.stdout.splitlines() if "=" in line)
        receipt["state"] = state
        receipt["passed"] = stop_returncode in (0, 5) and state.get("ActiveState") == "inactive" \
            and state.get("SubState") == "dead" and state.get("MainPID") == "0" \
            and state.get("ControlPID") == "0" and not state.get("ControlGroup") and not cgroup.exists()
    except BaseException as error:
        receipt["error_category"] = "query_timeout" if isinstance(error, subprocess.TimeoutExpired) else "query_failed"
    finally:
        receipt["expected_cgroup_absent"] = not cgroup.exists()
        public = Path(output) / "public"
        public.mkdir(parents=True, exist_ok=True)
        (public / "cleanup.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    unit, output, stop_code = sys.argv[1:]
    assert verify_cleanup(unit, output, int(stop_code))["passed"], "hosted_unit_cleanup_failed"
