"""Hermetic CDP exchanges; no browser, socket, process or private fixture access."""
import asyncio
import copy
import io
import json
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest.mock import patch

socket_module = types.ModuleType('websockets')
with patch.dict(sys.modules, {'websockets': socket_module}):
    probe = runpy.run_path(str(Path(__file__).with_name('electron-context.py')))
Failure = probe['ProofFailure']


class Socket:
    def __init__(self, fault=None):
        self.fault = fault
        self.pending = []
        self.requests = []
        self.targets = [{'targetId': 'UI', 'type': 'page', 'url': probe['UI_URL']},
                        {'targetId': 'GUEST', 'type': 'webview', 'url': 'https://PRIVATE.invalid/'}]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def send(self, raw):
        request = json.loads(raw)
        self.requests.append(request)
        method = request['method']
        session = request.get('sessionId')
        params = request['params']
        response = {'id': request['id']}
        if session:
            response['sessionId'] = session
        if self.fault == 'protocol' and method == 'Runtime.enable':
            response['error'] = {'code': -32601, 'message': 'PRIVATE secret'}
            self.pending.append(response)
            return
        result = {}
        if method == 'SystemInfo.getProcessInfo':
            result = {'processInfo': [{'id': 100, 'type': 'browser'}, {'id': 101, 'type': 'renderer'}, {'id': 102, 'type': 'renderer'}]}
        elif method == 'Target.getTargets':
            result = {'targetInfos': copy.deepcopy(self.targets)}
            if self.fault == 'target_drift' and sum(r['method'] == method for r in self.requests) > 1:
                result['targetInfos'][1]['targetId'] = 'OTHER'
        elif method == 'Target.attachToTarget':
            result = {'sessionId': params['targetId']}
        elif method == 'Runtime.enable':
            for context in self.contexts(session):
                self.pending.append({'sessionId': session, 'method': 'Runtime.executionContextCreated', 'params': {'context': context}})
        elif method == 'Page.getFrameTree':
            target = next(t for t in self.targets if t['targetId'] == session)
            result = {'frameTree': {'frame': {'id': session + '-frame', 'loaderId': session + '-loader', 'url': target['url']}}}
            if self.fault == 'navigation' and sum(r['method'] == method and r.get('sessionId') == session for r in self.requests) > 1:
                result['frameTree']['frame']['loaderId'] = 'new-document'
            if self.fault in ('destroyed', 'cleared', 'recreated') and sum(r['method'] == method and r.get('sessionId') == session for r in self.requests) > 1:
                event = 'Runtime.executionContextsCleared' if self.fault == 'cleared' else 'Runtime.executionContextDestroyed'
                self.pending.append({'sessionId': session, 'method': event, 'params': {'executionContextId': 2}})
                if self.fault == 'recreated':
                    context = self.contexts(session)[1];context['uniqueId'] = 'replacement-isolated'
                    self.pending.append({'sessionId': session, 'method': 'Runtime.executionContextCreated', 'params': {'context': context}})
        elif method == 'Runtime.evaluate':
            expression = params['expression']
            if self.fault == 'exception' and expression == probe['NODE_OBSERVATION']:
                result = {'exceptionDetails': {'text': 'PRIVATE', 'exception': {'className': 'ReferenceError', 'description': 'PRIVATE stack'}}}
            else:
                if expression == probe['NODE_OBSERVATION']:
                    value = {'processAbsent': self.fault != 'node_global', 'requireAbsent': True}
                elif expression == probe['VERSION_OBSERVATION']:
                    value = {'electronToken': 'PRIVATE' if self.fault == 'ua' else '42.10.0'}
                elif expression == probe['WEBVIEWS']:
                    value = [{'id': 7, 'url': self.targets[1]['url']}]
                    if self.fault == 'wrong_guest':
                        value[0]['url'] = 'https://unrelated.invalid/'
                else:
                    value = True
                result = {'result': {'value': value}}
        else:
            raise AssertionError('unexpected mocked method ' + method)
        response['result'] = result
        self.pending.append(response)

    def contexts(self, session):
        contexts = [
            {'id': 1, 'uniqueId': session + '-main', 'name': '', 'auxData': {'frameId': session + '-frame', 'isDefault': True}},
            {'id': 2, 'uniqueId': session + '-isolated', 'name': 'Electron Isolated Context', 'auxData': {'frameId': session + '-frame', 'isDefault': False}},
            {'id': 3, 'uniqueId': session + '-child', 'name': 'Electron Isolated Context', 'auxData': {'frameId': 'legitimate-child-frame', 'isDefault': False}},
        ]
        if self.fault == 'wrong_frame':
            contexts[1]['auxData']['frameId'] = 'unrelated-frame'
        if self.fault == 'missing_isolated':
            contexts.pop(1)
        if self.fault == 'duplicate_isolated':
            other = copy.deepcopy(contexts[1]);other.update(id=4, uniqueId='duplicate')
            contexts.append(other)
        if self.fault == 'same_identity':
            contexts[1]['uniqueId'] = contexts[0]['uniqueId']
        return contexts

    async def recv(self):
        if self.fault == 'timeout':
            raise asyncio.TimeoutError()
        return json.dumps(self.pending.pop(0))


class ContextProtocolTests(unittest.TestCase):
    def exercise(self, fault=None):
        self.socket = Socket(fault)
        self.receipt = {}
        self.snapshots = []
        def persist():
            self.snapshots.append(copy.deepcopy(self.receipt))
        endpoint = io.BytesIO(json.dumps({'webSocketDebuggerUrl': 'ws://127.0.0.1:9244/devtools/browser/test'}).encode())
        with patch.object(socket_module, 'connect', lambda *_a, **_k: self.socket, create=True), patch('urllib.request.urlopen', return_value=endpoint):
            asyncio.run(probe['context_proof'](100, [101, 102], self.receipt, persist))

    def test_ui_and_actual_guest_with_extra_frame_context(self):
        self.exercise()
        self.assertTrue(self.receipt['passed'])
        self.assertEqual([t['role'] for t in self.receipt['targets']], ['ui', 'webview'])
        self.assertEqual(self.receipt['targets'][1]['web_contents_id'], 7)
        for target in self.receipt['targets']:
            self.assertEqual(target['context_counts']['all'], 3)
            self.assertEqual(target['context_counts']['electron_isolated'], 1)
        evaluations = [r for r in self.socket.requests if r['method'] == 'Runtime.evaluate']
        self.assertTrue(all('uniqueContextId' in r['params'] for r in evaluations))
        self.assertNotIn('PRIVATE', json.dumps(self.receipt))
        self.assertFalse(any(r['method'] == 'Page.createIsolatedWorld' for r in self.socket.requests))

    def test_wrong_missing_and_duplicate_isolated_contexts_refused(self):
        for fault in ('wrong_frame', 'missing_isolated', 'duplicate_isolated'):
            with self.subTest(fault=fault), self.assertRaises(Failure) as caught:
                self.exercise(fault)
            self.assertEqual(caught.exception.code, 'frame_electron_context_exact')
            self.assertIn('context_counts', self.receipt['targets'][0])

    def test_page_node_global_is_refused(self):
        with self.assertRaises(Failure) as caught:
            self.exercise('node_global')
        self.assertEqual(caught.exception.code, 'page_node_globals_absent')
        self.assertFalse(self.receipt['targets'][0]['page_node_globals']['processAbsent'])

    def test_protocol_error_keeps_numeric_code_without_raw_text(self):
        with self.assertRaises(Failure) as caught:
            self.exercise('protocol')
        self.assertEqual(caught.exception.kind, 'protocol_error')
        self.assertEqual(self.receipt['protocol_error_code'], -32601)
        self.assertNotIn('PRIVATE', json.dumps(self.receipt))

    def test_evaluation_exception_is_distinct_and_sanitized(self):
        with self.assertRaises(Failure) as caught:
            self.exercise('exception')
        self.assertEqual(caught.exception.kind, 'evaluation_exception')
        self.assertEqual(caught.exception.code, 'page_node_globals')
        self.assertEqual(self.receipt['targets'][0]['evaluation_exception'], {'class': 'ReferenceError'})
        self.assertNotIn('PRIVATE', json.dumps(self.receipt))

    def test_navigation_and_target_drift_refused(self):
        for fault, code in [('navigation', 'document_identity_stable'), ('target_drift', 'target_inventory_stable')]:
            with self.subTest(fault=fault), self.assertRaises(Failure) as caught:
                self.exercise(fault)
            self.assertEqual(caught.exception.code, code)

    def test_unrelated_target_cannot_replace_actual_webview(self):
        with self.assertRaises(Failure) as caught:
            self.exercise('wrong_guest')
        self.assertEqual(caught.exception.code, 'webview_target_binding_complete')

    def test_user_agent_is_non_authoritative_and_bounded(self):
        self.exercise('ua')
        self.assertTrue(self.receipt['passed'])
        self.assertEqual(self.receipt['targets'][0]['user_agent'], {'authoritative': False, 'electron_token': None})
        self.assertNotIn('PRIVATE', json.dumps(self.receipt))

    def test_diagnostic_is_persisted_before_each_protocol_operation(self):
        self.exercise('ua')
        operations = [s.get('operation') for s in self.snapshots]
        self.assertIn('page_node_globals', operations)
        self.assertIn('isolated_world_liveness', operations)
        self.assertIn('document_recheck', operations)

    def test_missing_webview_duplicate_target_and_ui_substring_refused(self):
        rows = Socket().targets
        for candidate in [rows[:1], rows + [rows[1]], [{**rows[0], 'url': 'https://example.invalid/src/renderer/index.html'}, rows[1]]]:
            with self.assertRaises(Failure):
                probe['select_targets'](candidate)

    def test_duplicate_guest_urls_are_ambiguous(self):
        with self.assertRaises(Failure) as caught:
            probe['bind_webviews']([{'id': 1, 'url': 'same'}, {'id': 2, 'url': 'same'}], [])
        self.assertEqual(caught.exception.code, 'webview_target_binding_unambiguous')

    def test_unknown_exception_class_is_not_published(self):
        observation = {}
        with self.assertRaises(Failure):
            probe['evaluation_value']({'exceptionDetails': {'exception': {'className': 'PRIVATE'}}}, observation, 'fixed_evaluation')
        self.assertEqual(observation['evaluation_exception'], {'class': 'other'})

    def test_destroyed_cleared_or_recreated_context_refused(self):
        for fault, code in [('destroyed', 'frame_electron_context_exact'),
                            ('cleared', 'frame_default_context_exact'), ('recreated', 'context_identity_stable')]:
            with self.subTest(fault=fault), self.assertRaises(Failure) as caught:
                self.exercise(fault)
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(self.receipt['session_id'], 'UI')
            target = self.receipt['targets'][0]
            self.assertEqual(target['selected_contexts']['electron_isolated']['uniqueId'], 'UI-isolated')
            self.assertIn('context_counts', target['context_recheck'])

    def test_same_unique_context_identity_cannot_prove_distinct_worlds(self):
        with self.assertRaises(Failure) as caught:
            self.exercise('same_identity')
        self.assertEqual(caught.exception.code, 'frame_worlds_distinct')

    def test_timeout_has_fixed_operation_and_distinct_class(self):
        with self.assertRaises(Failure) as caught:
            self.exercise('timeout')
        self.assertEqual((caught.exception.kind, caught.exception.code), ('timeout', 'browser_process_binding'))
        self.assertEqual(self.snapshots[-1]['operation'], 'browser_process_binding')

    def test_malformed_exception_and_absent_value_fail_without_raw_text(self):
        for result, kind in [({'exceptionDetails': {'exception': 'PRIVATE'}}, 'evaluation_exception'),
                             ({'result': {'description': 'PRIVATE'}}, 'assertion')]:
            observation = {}
            with self.assertRaises(Failure) as caught:
                probe['evaluation_value'](result, observation, 'fixed_evaluation')
            self.assertEqual(caught.exception.kind, kind)
            self.assertNotIn('PRIVATE', json.dumps(observation))


if __name__ == '__main__':
    unittest.main()
