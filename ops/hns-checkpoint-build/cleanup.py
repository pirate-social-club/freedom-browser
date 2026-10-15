#!/usr/bin/env python3
"""Bounded cleanup of the exact labeled container belonging to this run."""
import json
import os
from pathlib import Path
import re
import subprocess


def cleanup(run, output):
    if not re.fullmatch(r"[0-9]+-[0-9]+", run):
        raise ValueError("invalid run identity")
    name = f"hns-checkpoint-{run}"
    receipt = {"container": name, "removed": False, "absent": False}
    output.mkdir(parents=True, exist_ok=True)

    def command(*arguments):
        return subprocess.check_output(
            ["docker", *arguments], text=True, timeout=25, stderr=subprocess.PIPE
        )

    def present():
        return bool(command("container", "ls", "-aq", "--filter", f"name=^/{name}$").strip())

    try:
        if present():
            raw = command("container", "inspect", name)
            observation = json.loads(raw)
            assert len(observation) == 1, "container identity ambiguous"
            record = observation[0]
            assert record["Name"] == f"/{name}", "container name mismatch"
            assert record["Config"]["Labels"].get("freedom.checkpoint.run") == run, "container custody mismatch"
            (output / "container.json").write_text(raw)
            command("container", "rm", "-f", record["Id"])
            receipt["removed"] = True
        receipt["absent"] = not present()
        assert receipt["absent"], "container survived cleanup"
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        (output / "cleanup.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    cleanup(
        f'{os.environ["GITHUB_RUN_ID"]}-{os.environ["GITHUB_RUN_ATTEMPT"]}',
        Path(os.environ["RUNNER_TEMP"]) / "hns-checkpoint-output",
    )
