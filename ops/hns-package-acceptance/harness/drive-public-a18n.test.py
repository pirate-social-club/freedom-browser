"""Reject false positive live-browser results without starting a browser."""
import runpy
import unittest
from pathlib import Path

accepted = runpy.run_path(str(Path(__file__).with_name("drive-public-a18n.py")))["accepted"]


def observation(host, status=200):
    return {"resolver_ready": True, "views": [{"url": "https://" + host + "/", "content": {
        "status": status, "community_id_present": host == "app.a18n",
        "community_visible": host == "app.a18n", "claimed_label_visible": host == "journeytest.a18n"}}]}


class LiveJourneyTests(unittest.TestCase):
    def test_three_real_host_verdicts(self):
        for host, status in [("app.a18n", 200), ("journeytest.a18n", 200), ("unclaimedtest.a18n", 421)]:
            self.assertTrue(accepted(observation(host, status), host, status))

    def test_wrong_status_and_address_are_refused(self):
        for host in ["app.a18n", "journeytest.a18n", "unclaimedtest.a18n"]:
            status = 421 if host.startswith("unclaimed") else 200
            self.assertFalse(accepted(observation(host, 503), host, status))
            value = observation(host, status)
            value["views"][0]["url"] = "https://other.invalid/"
            self.assertFalse(accepted(value, host, status))

    def test_missing_rendered_content_is_refused(self):
        for host, predicate in [("app.a18n", "community_id_present"), ("app.a18n", "community_visible"), ("journeytest.a18n", "claimed_label_visible")]:
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
