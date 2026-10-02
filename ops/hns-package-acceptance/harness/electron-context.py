"""Observe existing UI/webview worlds through a browser-bound CDP connection.

No preload, application byte, preference, world or page global is modified.
Receipts contain fixed categories and identifiers, never URLs or exception text.
"""
import asyncio
import hashlib
import json
import re
import time
import urllib.request
from collections import Counter
from urllib.parse import urlsplit
import websockets

UI_URL = 'file:///opt/Freedom/resources/app.asar/src/renderer/index.html'
NODE_OBSERVATION = "({processAbsent:typeof process==='undefined',requireAbsent:typeof require==='undefined'})"
VERSION_OBSERVATION = r"(()=>{const m=/\bElectron\/(\d+\.\d+\.\d+)\b/.exec(navigator.userAgent);return {electronToken:m?m[1]:null}})()"
WEBVIEWS = "Array.from(document.querySelectorAll('webview'),v=>({id:v.getWebContentsId(),url:v.getURL()}))"


class ProofFailure(Exception):
    def __init__(self, code, kind='assertion'):
        super().__init__(code)
        self.code = code
        self.kind = kind


def require(value, code):
    if not value:
        raise ProofFailure(code)


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value) is not None


def url_digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def select_targets(rows):
    require(isinstance(rows, list) and 0 < len(rows) <= 256, 'target_inventory_schema')
    targets = []
    for row in rows:
        require(isinstance(row, dict) and identifier(row.get('targetId')), 'target_identity_schema')
        require(isinstance(row.get('type'), str) and isinstance(row.get('url'), str), 'target_description_schema')
        if row['type'] in ('page', 'webview'):
            targets.append({key: row[key] for key in ('targetId', 'type', 'url')})
    require(len({row['targetId'] for row in rows}) == len(rows), 'target_identity_unique')
    ui = [row for row in targets if row['type'] == 'page' and row['url'] == UI_URL]
    require(len(ui) == 1, 'ui_target_exact')
    guests = [row for row in targets if row['targetId'] != ui[0]['targetId']]
    require(bool(guests), 'webview_targets_present')
    return ui[0], sorted(guests, key=lambda row: row['targetId'])


def bind_webviews(views, guests):
    require(isinstance(views, list) and 0 < len(views) <= 128, 'webview_inventory_schema')
    require(all(isinstance(v, dict) and type(v.get('id')) is int and v['id'] > 0
                and isinstance(v.get('url'), str) for v in views), 'webview_identity_schema')
    require(len({v['id'] for v in views}) == len(views), 'webview_identity_unique')
    # Duplicate URLs cannot establish an unambiguous target-to-element binding.
    require(len({v['url'] for v in views}) == len(views), 'webview_target_binding_unambiguous')
    require(Counter(v['url'] for v in views) == Counter(g['url'] for g in guests), 'webview_target_binding_complete')
    return {g['targetId']: next(v['id'] for v in views if v['url'] == g['url']) for g in guests}


def select_contexts(contexts, frame_id, observation):
    require(identifier(frame_id), 'frame_identity_schema')
    matched = [c for c in contexts.values() if c.get('auxData', {}).get('frameId') == frame_id]
    main = [c for c in matched if c.get('auxData', {}).get('isDefault') is True]
    isolated = [c for c in matched if c.get('name') == 'Electron Isolated Context'
                and c.get('auxData', {}).get('isDefault') is False]
    observation['context_counts'] = {'all': len(contexts), 'frame': len(matched),
                                     'default': len(main), 'electron_isolated': len(isolated)}
    observation['frame_contexts'] = [
        {'id': c.get('id'), 'unique_id': c.get('uniqueId') if identifier(c.get('uniqueId')) else None,
         'default': c.get('auxData', {}).get('isDefault') is True,
         'electron_isolated': c.get('name') == 'Electron Isolated Context'} for c in matched]
    require(len(main) == 1, 'frame_default_context_exact')
    require(len(isolated) == 1, 'frame_electron_context_exact')
    for context in (main[0], isolated[0]):
        require(type(context.get('id')) is int and context['id'] > 0
                and identifier(context.get('uniqueId')), 'context_identity_schema')
    require(main[0]['id'] != isolated[0]['id'] and main[0]['uniqueId'] != isolated[0]['uniqueId'], 'frame_worlds_distinct')
    selected = {role: {'id': c['id'], 'uniqueId': c['uniqueId']}
                for role, c in [('default', main[0]), ('electron_isolated', isolated[0])]}
    observation['selected_contexts'] = selected
    return selected


def evaluation_value(result, observation, code):
    require(isinstance(result, dict), code + '_schema')
    if 'exceptionDetails' in result:
        details = result['exceptionDetails']
        exception = details.get('exception', {}) if isinstance(details, dict) else {}
        name = exception.get('className') if isinstance(exception, dict) else None
        observation['evaluation_exception'] = {'class': name if name in
            ('ReferenceError', 'TypeError', 'SyntaxError', 'RangeError', 'EvalError', 'Error') else 'other'}
        raise ProofFailure(code, 'evaluation_exception')
    remote = result.get('result')
    require(isinstance(remote, dict) and 'value' in remote, code + '_value_missing')
    return remote['value']


class Cdp:
    def __init__(self, socket, receipt, persist):
        self.socket = socket
        self.receipt = receipt
        self.persist = persist
        self.next_id = 0
        self.contexts = {}

    async def rpc(self, method, params, code, session=None):
        self.receipt['operation'] = code
        self.receipt['session_id'] = session
        self.persist()
        self.next_id += 1
        wanted = self.next_id
        request = {'id': wanted, 'method': method, 'params': params}
        if session is not None:
            request['sessionId'] = session
        await self.socket.send(json.dumps(request))
        end = time.monotonic() + 3
        while True:
            try:
                message = json.loads(await asyncio.wait_for(self.socket.recv(), max(.01, end - time.monotonic())))
            except asyncio.TimeoutError:
                raise ProofFailure(code, 'timeout') from None
            require(isinstance(message, dict), 'protocol_message_schema')
            sid = message.get('sessionId')
            if sid in self.contexts:
                contexts = self.contexts[sid]
                event = message.get('method')
                data = message.get('params', {})
                require(isinstance(data, dict), 'context_event_parameters')
                if event == 'Runtime.executionContextCreated':
                    context = data.get('context')
                    require(isinstance(context, dict) and type(context.get('id')) is int
                            and isinstance(context.get('auxData', {}), dict), 'context_event_schema')
                    contexts[context['id']] = context
                elif event == 'Runtime.executionContextDestroyed':
                    contexts.pop(data.get('executionContextId'), None)
                elif event == 'Runtime.executionContextsCleared':
                    contexts.clear()
            if message.get('id') == wanted and sid == session:
                if 'error' in message:
                    error = message['error']
                    self.receipt['protocol_error_code'] = error.get('code') if isinstance(error, dict) and type(error.get('code')) is int else None
                    raise ProofFailure(code, 'protocol_error')
                require(isinstance(message.get('result'), dict), code + '_response_schema')
                return message['result']
            require(time.monotonic() < end, code + '_deadline')

    async def evaluate(self, session, context, expression, observation, code):
        result = await self.rpc('Runtime.evaluate', {'uniqueContextId': context['uniqueId'],
            'expression': expression, 'returnByValue': True, 'timeout': 2000}, code, session)
        value = evaluation_value(result, observation, code)
        self.persist()
        return value


async def inspect_target(cdp, target, role):
    observation = {'role': role, 'target_id': target['targetId'], 'target_type': target['type'],
                   'url_sha256': url_digest(target['url']), 'passed': False}
    cdp.receipt['targets'].append(observation)
    response = await cdp.rpc('Target.attachToTarget', {'targetId': target['targetId'], 'flatten': True}, 'target_attach')
    session = response.get('sessionId')
    require(identifier(session), 'target_session_identity')
    cdp.contexts[session] = {}
    await cdp.rpc('Runtime.enable', {}, 'context_inventory_enable', session)
    frame = (await cdp.rpc('Page.getFrameTree', {}, 'frame_inventory', session))['frameTree']['frame']
    frame_id = frame.get('id')
    observation['frame_id'] = frame_id if identifier(frame_id) else None
    observation['frame_url_matches_target'] = frame.get('url') == target['url']
    require(observation['frame_url_matches_target'], 'frame_target_url_binding')
    require(identifier(frame.get('loaderId')), 'document_loader_identity')
    observation['loader_id'] = frame['loaderId']
    selected = select_contexts(cdp.contexts[session], frame_id, observation)
    cdp.persist()
    page = await cdp.evaluate(session, selected['default'], NODE_OBSERVATION, observation, 'page_node_globals')
    observation['page_node_globals'] = {key: page.get(key) if isinstance(page, dict) and type(page.get(key)) is bool else None
                                       for key in ('processAbsent', 'requireAbsent')}
    require(observation['page_node_globals'] == {'processAbsent': True, 'requireAbsent': True}, 'page_node_globals_absent')
    # Evaluating in an existing context proves it is alive without creating a world.
    alive = await cdp.evaluate(session, selected['electron_isolated'], 'window === globalThis', observation, 'isolated_world_liveness')
    observation['isolated_world_alive'] = alive is True
    require(alive is True, 'isolated_world_liveness')
    token = await cdp.evaluate(session, selected['default'], VERSION_OBSERVATION, observation, 'user_agent_observation')
    token = token.get('electronToken') if isinstance(token, dict) else None
    observation['user_agent'] = {'authoritative': False, 'electron_token': token if isinstance(token, str)
                                and re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,3}', token) else None}
    cdp.persist()
    return session, frame, selected, observation


async def context_proof(browser_pid, expected_renderers, receipt, persist):
    receipt.update({'passed': False, 'targets': [], 'scope': 'UI_and_actual_webview_main_frames'})
    receipt['operation'] = 'browser_endpoint'
    persist()
    with urllib.request.urlopen('http://127.0.0.1:9244/json/version', timeout=2) as response:
        version = json.load(response)
    endpoint = version['webSocketDebuggerUrl']
    url = urlsplit(endpoint)
    require(url.scheme == 'ws' and url.hostname == '127.0.0.1' and url.port == 9244
            and url.path.startswith('/devtools/browser/') and not url.username and not url.password
            and not url.query and not url.fragment, 'browser_endpoint_identity')
    async with websockets.connect(endpoint, open_timeout=3) as socket:
        cdp = Cdp(socket, receipt, persist)
        rows = (await cdp.rpc('SystemInfo.getProcessInfo', {}, 'browser_process_binding'))['processInfo']
        require([r['id'] for r in rows if r['type'] == 'browser'] == [browser_pid], 'browser_pid_binding')
        require(sorted(r['id'] for r in rows if r['type'] == 'renderer') == expected_renderers, 'renderer_inventory_binding')
        targets = (await cdp.rpc('Target.getTargets', {}, 'target_inventory'))['targetInfos']
        ui, guests = select_targets(targets)
        inspected = [await inspect_target(cdp, ui, 'ui')]
        ui_session, _, ui_contexts, ui_observation = inspected[0]
        views = await cdp.evaluate(ui_session, ui_contexts['default'], WEBVIEWS, ui_observation, 'actual_webview_inventory')
        bindings = bind_webviews(views, guests)
        for target in guests:
            item = await inspect_target(cdp, target, 'webview')
            item[3]['web_contents_id'] = bindings[target['targetId']]
            inspected.append(item)
        # Recheck documents, contexts and actual guest membership on the same connection.
        for session, frame, selected, observation in inspected:
            current = (await cdp.rpc('Page.getFrameTree', {}, 'document_recheck', session))['frameTree']['frame']
            require(all(current.get(k) == frame.get(k) for k in ('id', 'loaderId', 'url')), 'document_identity_stable')
            observation['context_recheck'] = {}
            require(select_contexts(cdp.contexts[session], frame['id'], observation['context_recheck']) == selected, 'context_identity_stable')
            observation['passed'] = True
            cdp.persist()
        final_views = await cdp.evaluate(ui_session, ui_contexts['default'], WEBVIEWS, ui_observation, 'actual_webview_recheck')
        require(sorted(final_views, key=lambda v: v['id']) == sorted(views, key=lambda v: v['id']), 'webview_inventory_stable')
        final_targets = (await cdp.rpc('Target.getTargets', {}, 'target_inventory_recheck'))['targetInfos']
        require(select_targets(final_targets) == (ui, guests), 'target_inventory_stable')
        receipt.update({'passed': True, 'operation': 'done', 'target_count': len(inspected),
                        'actual_webviews_bound': True, 'documents_and_contexts_stable': True})
        persist()
