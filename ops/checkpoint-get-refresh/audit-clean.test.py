"""Malformed or contradictory reports cannot declare this repair audit-clean."""
import copy
from pathlib import Path
import runpy
import unittest

check = runpy.run_path(str(Path(__file__).with_name("refresh.py")))["require_clean_audit"]


class CleanAuditTest(unittest.TestCase):
    def report(self):
        return {"auditReportVersion": 2, "vulnerabilities": {},
                "metadata": {"vulnerabilities": {key: 0 for key in
                 ("info", "low", "moderate", "high", "critical", "total")}}}

    def test_clean_report(self):
        check(self.report(), 0)

    def test_wrong_finding_shape(self):
        for wrong in (None, [], "", {"package": {"severity": "high"}}):
            with self.subTest(wrong=wrong):
                report = self.report()
                report["vulnerabilities"] = wrong
                with self.assertRaises(AssertionError):
                    check(report, 0)

    def test_count_contradictions(self):
        for wrong in (1, True, "0", None):
            with self.subTest(wrong=wrong):
                report = self.report()
                report["metadata"]["vulnerabilities"]["high"] = wrong
                with self.assertRaises(AssertionError):
                    check(report, 0)

    def test_protocol_failure(self):
        reports = [None, [], {**self.report(), "error": {"code": "E503"}},
                   {**self.report(), "auditReportVersion": 1}]
        for report in reports:
            with self.subTest(report=report), self.assertRaises(AssertionError):
                check(copy.deepcopy(report), 0)
        with self.assertRaises(AssertionError):
            check(self.report(), 1)


if __name__ == "__main__":
    unittest.main()
