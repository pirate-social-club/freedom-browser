"""Admission for credential-free public QA; never merge or release clearance."""
import json

KNOWN_ADVISORIES = {
    'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm': 'braces',
    'https://github.com/advisories/GHSA-ch52-4w7c-c8xp': 'http-cache-semantics',
}


def audit_document(output, returncode):
    report = json.loads(output)
    assert returncode in (0, 1), 'audit command failed'
    assert isinstance(report, dict) and report.get('auditReportVersion') == 2
    assert 'error' not in report and isinstance(report.get('vulnerabilities'), dict)
    counts = report['metadata']['vulnerabilities']
    assert all(type(counts.get(key)) is int and counts[key] >= 0
               for key in ('info', 'low', 'moderate', 'high', 'critical', 'total'))
    assert counts['total'] == sum(counts[key] for key in ('info', 'low', 'moderate', 'high', 'critical'))
    assert counts['total'] == len(report['vulnerabilities']), 'inconsistent audit counts'
    assert (returncode == 0) == (counts['high'] + counts['critical'] == 0)
    return report


def admit_public_diagnostic(full_output, full_code, runtime_output, runtime_code, lock):
    full = audit_document(full_output, full_code)
    runtime = audit_document(runtime_output, runtime_code)
    assert runtime_code == 0 and not runtime['vulnerabilities'], 'runtime audit must be clean'
    findings = full['vulnerabilities']
    advisories = set()
    for name, finding in findings.items():
        assert isinstance(finding, dict) and finding.get('name') == name
        assert isinstance(finding.get('nodes'), list) and finding['nodes']
        for node in finding['nodes']:
            assert isinstance(node, str) and node.startswith('node_modules/')
            assert lock['packages'].get(node, {}).get('dev') is True, 'finding outside pinned dev paths'
        assert isinstance(finding.get('via'), list) and finding['via']
        for via in finding['via']:
            if isinstance(via, str):
                assert via in findings, 'unknown transitive finding'
            else:
                assert isinstance(via, dict)
                url = via.get('url')
                assert KNOWN_ADVISORIES.get(url) == name, 'new advisory or changed root'
                advisories.add(url)
    if findings:
        assert advisories == set(KNOWN_ADVISORIES), 'unrecognized audit roots'
        # Every transitive finding must reach an admitted advisory, including cycles.
        def known_root(name, seen):
            if name in seen:
                return False
            return any(isinstance(via, dict) or known_root(via, seen | {name})
                       for via in findings[name]['via'])
        assert all(known_root(name, set()) for name in findings), 'unresolved audit graph'
    return {'scope': 'credential_free_public_diagnostic', 'full_audit_passed': full_code == 0,
            'full_audit_counts': full['metadata']['vulnerabilities'],
            'runtime_audit_passed': True, 'known_advisories': sorted(advisories),
            'merge_or_release_acceptance': False}
