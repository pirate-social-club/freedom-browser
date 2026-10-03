"""Live address-bar acceptance; no fixture DNS or wallet operations."""
import asyncio
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

COMMUNITY = "community_6d62b944-55ee-438d-99f5-f49b4b33def5"
TARGETS = (("app.a18n", 200), ("journeytest.a18n", 200), ("unclaimedtest.a18n", 421))
SESSION = "freedom-hosted-package-acceptance"
UI_URL = "file:///opt/Freedom/resources/app.asar/src/renderer/index.html"


class ObservationFailure(Exception):
    pass


def select_ui(targets):
    if not isinstance(targets, list):
        raise ObservationFailure("target_schema")
    selected = [row for row in targets if isinstance(row, dict) and row.get("type") == "page" and row.get("url") == UI_URL]
    if len(selected) != 1:
        raise ObservationFailure("target_identity")
    return selected[0]


def accepted(snapshot, host, status):
    if not isinstance(snapshot, dict) or snapshot.get("resolver_ready") is not True:
        return False
    views = snapshot.get("views")
    if not isinstance(views, list) or len(views) != 1:
        return False
    view = views[0]
    if not isinstance(view, dict) or view.get("destination") != host:
        return False
    content = view.get("content", {})
    if not isinstance(content, dict) or content.get("status") != status:
        return False
    if host == "app.a18n":
        return content.get("community_id_present") is True and content.get("community_visible") is True
    if host == "journeytest.a18n":
        return content.get("claimed_label_visible") is True and content.get("member_profile_present") is True
    return status == 421 and content.get("community_id_present") is False and content.get("claimed_label_visible") is False


async def evaluate(expression):
    import websockets
    with urllib.request.urlopen("http://127.0.0.1:9244/json/list", timeout=2) as response:
        targets = json.load(response)
    target = select_ui(targets)
    async with websockets.connect(target["webSocketDebuggerUrl"], open_timeout=3) as connection:
        await connection.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
            "expression": expression, "awaitPromise": True, "returnByValue": True}}))
        while True:
            result = json.loads(await asyncio.wait_for(connection.recv(), timeout=8))
            if result.get("id") == 1:
                if "error" in result:
                    raise ObservationFailure("protocol_refused")
                if "exceptionDetails" in result.get("result", {}):
                    raise ObservationFailure("evaluation_failed")
                return result["result"]["result"].get("value")


def snapshot():
    # Only public identity predicates are retained; no page text or profile data.
    content = "({status:performance.getEntriesByType('navigation')[0]?.responseStatus,community_id_present:document.documentElement.outerHTML.includes(" + json.dumps(COMMUNITY) + "),community_visible:document.body.innerText.includes('HNS a18n staging'),member_profile_present:document.querySelector('main[data-persona-profile-state=success]')!==null,claimed_label_visible:Array.from(document.querySelectorAll('main[data-persona-profile-state=success] ul[aria-label=Names] li')).some(e=>e.innerText.trim()==='journeytest.a18n'&&e.getClientRects().length>0)})"
    destinations = json.dumps(["https://" + host + "/" for host, _ in TARGETS])
    expression = "(async()=>({resolver_ready:(await window.serviceRegistry.getRegistry()).hns.localResolverReady===true,views:await Promise.all(Array.from(document.querySelectorAll('webview')).map(async v=>({destination:" + destinations + ".includes(v.getURL())?new URL(v.getURL()).hostname:null,content:await v.executeJavaScript(" + json.dumps(content) + ")})))}))()"
    return asyncio.run(evaluate(expression))


def main():
    directory = Path(__file__).parent
    deadline = json.loads((directory / "timing.json").read_text())["deadline_epoch"] - 30
    network = json.loads((directory / "public-network.json").read_text())
    assert network["fixture_dns_interception"] is False and network["fixture_servers_started"] is False and network["empty_network_ruleset"] is True
    observations = []
    receipt = {"passed": False, "journey": "a18n", "public_resolver": True, "observations": observations, "observation_error_counts": {}}

    def persist():
        (directory / "public-a18n-navigation.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def note_error(error):
        known = {"target_schema", "target_identity", "protocol_refused", "evaluation_failed"}
        code = str(error) if isinstance(error, ObservationFailure) and str(error) in known else "timeout" if isinstance(error, (TimeoutError, asyncio.TimeoutError)) else "observation_unavailable"
        counts = receipt["observation_error_counts"]
        counts[code] = counts.get(code, 0) + 1
        persist()

    try:
        ready_until = min(time.time() + 150, deadline)
        while time.time() < ready_until:
            try:
                if snapshot().get("resolver_ready") is True:
                    break
            except Exception as error:
                note_error(error)
            time.sleep(1)
        else:
            raise RuntimeError("public resolver readiness timed out")
        subprocess.run([sys.executable, str(directory / "prove-installed-sandbox.py"), "pre-security"], check=True, timeout=min(15, max(1, deadline-time.time())))
        for host, status in TARGETS:
            started = time.time()
            subprocess.run(["agent-browser", "--session", SESSION, "--cdp", "9244", "fill", 'input[placeholder="Enter hash, ID or URL"]', "https://" + host + "/"], check=True, timeout=min(15, max(1, deadline-time.time())))
            subprocess.run([sys.executable, str(directory / "native-enter.py")], check=True, timeout=min(5, max(1, deadline-time.time())))
            until = min(time.time() + 55, deadline)
            last = None
            while time.time() < until:
                try:
                    last = snapshot()
                    if accepted(last, host, status):
                        break
                except Exception as error:
                    note_error(error)
                time.sleep(0.5)
            else:
                observations.append({"host": host, "passed": False, "last": last})
                raise RuntimeError("live page acceptance failed: " + host)
            observations.append({"host": host, "passed": True, "started_epoch": started, "completed_epoch": time.time(), "snapshot": last})
            persist()
        subprocess.run([sys.executable, str(directory / "prove-installed-sandbox.py"), "final"], check=True, timeout=min(15, max(1, deadline-time.time())))
        proofs = [json.loads((directory / ("renderer-sandbox-" + phase + "-proof.json")).read_text())["passed"] is True for phase in ["pre-security", "final"]]
        assert all(proofs) and time.time() < deadline
        receipt["passed"] = True
        summary = {"passed": True, "journey": "a18n", "real_public_hosts_rendered": True, "host_statuses": dict(TARGETS), "installed_deb_tested": True, "combined_renderer_os_and_electron_sandbox_proved": True, "fixture_dns_interception": False, "full_app_restart_tested": False, "source": json.loads((directory / "candidate-integrity.json").read_text())["Freedom_source"]}
        (directory / "acceptance-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    finally:
        persist()
        try:
            subprocess.run(["agent-browser", "--session", SESSION, "close"], timeout=5, capture_output=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
