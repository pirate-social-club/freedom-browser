"""Reject false positive live-browser results without starting a browser."""
import runpy
import subprocess
import unittest
from pathlib import Path

module = runpy.run_path(str(Path(__file__).with_name("drive-public-a18n.py")))
accepted = module["accepted"]
select_ui = module["select_ui"]
UI_URL = module["UI_URL"]


def observation(host, status=200):
    return {"resolver_ready": True, "views": [{"destination": host, "content": {
        "status": status, "community_id_present": host == "app.a18n",
        "community_visible": host == "app.a18n", "member_profile_present": host == "journeytest.a18n", "claimed_label_visible": host == "journeytest.a18n"}}]}


class LiveJourneyTests(unittest.TestCase):
    def test_only_unique_exact_installed_ui_is_selected(self):
        row = {"type": "page", "url": UI_URL, "webSocketDebuggerUrl": "ws://127.0.0.1:9244/devtools/page/test"}
        self.assertEqual(select_ui([row]), row)
        for targets in [[], [row, row], [{**row, "url": "https://other.invalid/src/renderer/index.html"}], [{**row, "type": "webview"}]]:
            with self.assertRaises(module["ObservationFailure"]):
                select_ui(targets)

    def test_changing_url_is_read_once_and_never_leaked(self):
        async def check(expression):
            program = """const vm=require('node:vm'),assert=require('node:assert/strict');let reads=0;const view={getURL(){reads++;return reads===1?'https://app.a18n/':'https://unlisted.invalid/second';},async executeJavaScript(){return {status:200};}};const context={window:{serviceRegistry:{async getRegistry(){return {hns:{localResolverReady:true}};}}},document:{querySelectorAll(){return [view];}}};Promise.resolve(vm.runInNewContext(process.argv[1],context)).then(result=>{assert.equal(reads,1);assert.equal(result.views[0].destination,'app.a18n');assert.ok(!JSON.stringify(result).includes('unlisted'));}).catch(()=>process.exit(1));"""
            subprocess.run(["node", "-e", program, expression], check=True, capture_output=True)
            return {"resolver_ready": True, "views": []}
        globals_ = module["snapshot"].__globals__
        previous = globals_["evaluate"]
        try:
            globals_["evaluate"] = check
            module["snapshot"]()
        finally:
            globals_["evaluate"] = previous

    def test_three_real_host_verdicts(self):
        for host, status in [("app.a18n", 200), ("journeytest.a18n", 200), ("unclaimedtest.a18n", 421)]:
            self.assertTrue(accepted(observation(host, status), host, status))

    def test_wrong_status_and_address_are_refused(self):
        for host in ["app.a18n", "journeytest.a18n", "unclaimedtest.a18n"]:
            status = 421 if host.startswith("unclaimed") else 200
            self.assertFalse(accepted(observation(host, 503), host, status))
            value = observation(host, status)
            value["views"][0]["destination"] = None
            self.assertFalse(accepted(value, host, status))

    def test_missing_rendered_content_is_refused(self):
        for host, predicate in [("app.a18n", "community_id_present"), ("app.a18n", "community_visible"), ("journeytest.a18n", "claimed_label_visible"), ("journeytest.a18n", "member_profile_present")]:
            value = observation(host)
            value["views"][0]["content"][predicate] = False
            self.assertFalse(accepted(value, host, 200))

    def test_claimed_content_on_unclaimed_host_is_refused(self):
        for predicate in ["community_id_present", "claimed_label_visible"]:
            value = observation("unclaimedtest.a18n", 421)
            value["views"][0]["content"][predicate] = True
            self.assertFalse(accepted(value, "unclaimedtest.a18n", 421))

    def test_unready_missing_or_duplicate_view_is_refused(self):
        value = observation("app.a18n")
        for changed in [{**value, "resolver_ready": False}, {**value, "views": []}, {**value, "views": value["views"] * 2}, None, {}]:
            self.assertFalse(accepted(changed, "app.a18n", 200))


if __name__ == "__main__":
    unittest.main()
