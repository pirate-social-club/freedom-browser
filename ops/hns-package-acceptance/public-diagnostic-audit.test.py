import copy
import ast
import json
import runpy
import subprocess
import unittest
from pathlib import Path

module = runpy.run_path(str(Path(__file__).with_name('public-diagnostic-audit.py')))
admit = module['admit_public_diagnostic']


def report(findings):
    return json.dumps({'auditReportVersion': 2, 'vulnerabilities': findings,
                       'metadata': {'vulnerabilities': {'info': 0, 'low': 0, 'moderate': 0,
                                                       'high': len(findings), 'critical': 0,
                                                       'total': len(findings)}}})


class Admission(unittest.TestCase):
    def setUp(self):
        self.findings = {name: {'name': name, 'severity': 'high', 'nodes': ['node_modules/' + name],
                                'via': [{'url': url, 'name': name, 'dependency': name, 'severity': 'high', 'source': module['KNOWN_SOURCES'][name]}]}
                         for url, name in module['KNOWN_ADVISORIES'].items()}
        self.findings['build-parent'] = {'name': 'build-parent', 'severity': 'high', 'nodes': ['node_modules/build-parent'], 'via': ['braces']}
        self.lock = {'packages': {node: {'dev': True, 'version': module['KNOWN_VERSIONS'].get(name, '1.0.0')}
                                 for name, finding in self.findings.items() for node in finding['nodes']}}
        self.lock['packages']['node_modules/build-parent']['dependencies'] = {'braces': '^3.0.3'}

    def run_admission(self, runtime=None, runtime_code=0):
        return admit(report(self.findings), 1, report(runtime or {}), runtime_code, self.lock)

    def test_known_dev_findings_are_diagnostic_only(self):
        result = self.run_admission()
        self.assertFalse(result['full_audit_passed'])
        self.assertFalse(result['merge_or_release_acceptance'])
        self.assertTrue(result['runtime_audit_passed'])

    def test_new_advisory_refused(self):
        self.findings['braces']['via'][0]['url'] = 'https://github.com/advisories/new'
        with self.assertRaises(AssertionError): self.run_admission()

    def test_swapped_node_or_invented_finding_refused(self):
        self.lock['packages']['node_modules/jest'] = {'dev': True, 'version': '30.2.0'}
        self.findings['braces']['nodes'] = ['node_modules/jest']
        with self.assertRaises(AssertionError): self.run_admission()
        self.findings['braces']['nodes'] = ['node_modules/braces']
        self.findings['invented'] = {'name': 'invented', 'severity': 'high', 'nodes': ['node_modules/jest'], 'via': ['braces']}
        with self.assertRaises(AssertionError): self.run_admission()

    def test_invented_direct_dependency_link_refused(self):
        self.lock['packages']['node_modules/build-parent']['dependencies'] = {}
        with self.assertRaises(AssertionError): self.run_admission()

    def test_swapped_transitive_package_identity_refused(self):
        self.lock['packages']['node_modules/another-parent'] = {'dev': True, 'version': '1.0.0', 'dependencies': {'braces': '*'}}
        self.findings['build-parent']['nodes'] = ['node_modules/another-parent']
        with self.assertRaises(AssertionError): self.run_admission()

    def test_severity_counts_must_match_findings(self):
        document = json.loads(report(self.findings))
        document['metadata']['vulnerabilities']['high'] -= 1
        document['metadata']['vulnerabilities']['moderate'] += 1
        with self.assertRaises(AssertionError): module['audit_document'](json.dumps(document), 1)

    def test_missing_or_changed_severity_and_identity_refused(self):
        original = copy.deepcopy(self.findings)
        for field, value in [('severity', None), ('name', 'jest'), ('dependency', 'jest'), ('source', None), ('source', 1)]:
            self.findings = copy.deepcopy(original)
            self.findings['braces']['via'][0][field] = value
            with self.subTest(field=field):
                with self.assertRaises(AssertionError): self.run_admission()
        for severity in (None, 'moderate'):
            self.findings = copy.deepcopy(original)
            self.findings['braces']['severity'] = severity
            with self.subTest(severity=severity):
                with self.assertRaises(AssertionError): self.run_admission()

    def test_changed_locked_advisory_version_refused(self):
        self.lock['packages']['node_modules/braces']['version'] = 'different'
        with self.assertRaises(AssertionError): self.run_admission()

    def test_unknown_or_production_path_refused(self):
        for replacement in ({}, {'dev': False}):
            with self.subTest(replacement=replacement):
                self.lock['packages']['node_modules/braces'] = replacement
                with self.assertRaises(AssertionError): self.run_admission()

    def test_runtime_finding_refused(self):
        with self.assertRaises(AssertionError): self.run_admission({'braces': self.findings['braces']}, 1)

    def test_command_and_protocol_errors_refused(self):
        for output, code in [('not-json', 1), ('{"error":{}}', 1), (report(self.findings), 2), (report(self.findings), 0)]:
            with self.subTest(code=code, output=output[:16]):
                with self.assertRaises((AssertionError, ValueError, KeyError)):
                    admit(output, code, report({}), 0, self.lock)

    def test_missing_or_cyclic_transitive_root_refused(self):
        original = copy.deepcopy(self.findings)
        for reference in ('missing', 'build-parent'):
            self.findings = copy.deepcopy(original)
            self.findings['build-parent']['via'] = [reference]
            self.lock['packages']['node_modules/build-parent']['dependencies'] = {reference: '*'}
            with self.assertRaises(AssertionError): self.run_admission()

    def test_actual_archive_entries_including_nested_copies(self):
        source = Path(__file__).parent / 'harness/prepare-runtime.py'
        assignments = [node for node in ast.walk(ast.parse(source.read_text()))
                       if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'exclusion_script' for t in node.targets)]
        self.assertEqual(len(assignments), 1)
        expression = ast.literal_eval(assignments[0].value)
        for paths, expected in [(['/src/main.js', '/node_modules/axios/index.js'], True),
                                (['/node_modules/braces/index.js'], False),
                                (['/node_modules/parent/node_modules/http-cache-semantics/index.js'], False),
                                ([], False)]:
            with self.subTest(paths=paths):
                runner = "const vm=require('vm');let proof=null;const entries=JSON.parse(process.argv[1]);const context={process:{argv:['node','archive','receipt']},require:n=>n==='fs'?{writeFileSync:(p,s)=>{proof=JSON.parse(s)}}:{listPackage:()=>entries}};try{vm.runInNewContext(process.argv[2],context);console.log(JSON.stringify(proof));}catch{process.exitCode=1}"
                result = subprocess.run(['node', '-e', runner, json.dumps(paths), expression], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode == 0, expected)
                if expected:
                    proof = json.loads(result.stdout)
                    self.assertTrue(proof['actual_asar_exclusion_passed'])
                    self.assertFalse(proof['merge_or_release_acceptance'])


if __name__ == '__main__':
    unittest.main()
