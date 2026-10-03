"""Admission for credential-free public QA; never merge or release clearance."""
import json

KNOWN_ADVISORIES = {
    'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm': 'braces',
    'https://github.com/advisories/GHSA-ch52-4w7c-c8xp': 'http-cache-semantics',
}
KNOWN_VERSIONS = {'braces': '3.0.3', 'http-cache-semantics': '4.2.0'}
KNOWN_SOURCES = {'braces': 1240992, 'http-cache-semantics': 1240991}
SEVERITIES = ('info', 'low', 'moderate', 'high', 'critical')


def locked_identity(node, packages):
    package = packages[node]
    return package.get('name', node.rsplit('node_modules/', 1)[-1])


def resolved_dependency(node, dependency, packages):
    ancestor = node
    while True:
        candidate = ancestor + '/node_modules/' + dependency if ancestor else 'node_modules/' + dependency
        if ancestor.rsplit('/', 1)[-1] != 'node_modules' and candidate in packages:
            return candidate
        if not ancestor:
            return None
        ancestor = ancestor.rsplit('/', 1)[0] if '/' in ancestor else ''


def direct_locked_link(node, target_name, target_nodes, packages):
    package = packages[node]
    dependencies = set().union(*(package.get(key, {}) for key in ('dependencies', 'optionalDependencies', 'peerDependencies')))
    for dependency in dependencies:
        target = resolved_dependency(node, dependency, packages)
        if target in target_nodes and locked_identity(target, packages) == target_name:
            return True
    return False


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
    actual_counts = {severity: 0 for severity in SEVERITIES}
    for finding in report['vulnerabilities'].values():
        assert isinstance(finding, dict) and finding.get('severity') in SEVERITIES, 'missing finding severity'
        actual_counts[finding['severity']] += 1
    assert all(counts[key] == actual_counts[key] for key in SEVERITIES), 'inconsistent severity counts'
    assert (returncode == 0) == (counts['high'] + counts['critical'] == 0)
    return report


def admit_public_diagnostic(full_output, full_code, runtime_output, runtime_code, lock):
    full = audit_document(full_output, full_code)
    runtime = audit_document(runtime_output, runtime_code)
    assert runtime_code == 0 and not runtime['vulnerabilities'], 'runtime audit must be clean'
    findings = full['vulnerabilities']
    packages = lock['packages']
    advisories = set()
    for name, finding in findings.items():
        assert isinstance(finding, dict) and finding.get('name') == name
        assert isinstance(finding.get('nodes'), list) and finding['nodes']
        assert len(finding['nodes']) == len(set(finding['nodes'])), 'duplicate finding paths'
        for node in finding['nodes']:
            assert isinstance(node, str) and node.startswith('node_modules/')
            assert packages.get(node, {}).get('dev') is True, 'finding outside pinned dev paths'
            assert locked_identity(node, packages) == name, 'finding does not match locked package'
            if name in KNOWN_VERSIONS:
                assert packages[node].get('version') == KNOWN_VERSIONS[name], 'changed advisory package version'
        assert isinstance(finding.get('via'), list) and finding['via']
        for via in finding['via']:
            if isinstance(via, str):
                assert via in findings, 'unknown transitive finding'
                assert all(direct_locked_link(node, via, findings[via]['nodes'], packages)
                           for node in finding['nodes']), 'invented transitive finding'
            else:
                assert isinstance(via, dict)
                url = via.get('url')
                assert KNOWN_ADVISORIES.get(url) == name, 'new advisory or changed root'
                assert via.get('name') == name and via.get('dependency') == name, 'changed advisory identity'
                assert via.get('severity') == finding['severity'] == 'high', 'changed advisory severity'
                assert type(via.get('source')) is int and via['source'] == KNOWN_SOURCES[name], 'changed advisory source identity'
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
