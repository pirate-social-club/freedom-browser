#!/usr/bin/env python3
"""Own one loopback fixture and one disposable Electron process inside CI."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import threading
import time

PREFIX = 'RUNTIME_FETCH_PROBE '
LIMIT = 128 * 1024


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def serve(listener, representation, receipt):
    try:
        listener.settimeout(15)
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(15)
            request = b''
            while b'\r\n\r\n' not in request:
                block = connection.recv(4096)
                if not block:
                    raise ValueError('request_incomplete')
                request += block
                if len(request) > 8192:
                    raise ValueError('request_budget')
            receipt['requestReceived'] = True
            body = b'{"ok":true}'
            coding = ''
            if representation == 'gzip':
                body = gzip.compress(body, mtime=0)
                coding = 'Content-Encoding: gzip\r\n'
            if representation == 'hostile':
                body = b''
                coding = 'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\n'
            length = 1 if representation == 'hostile' else len(body)
            header = ('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' + coding +
                      'Content-Length: ' + str(length) + '\r\nConnection: close\r\n\r\n').encode()
            connection.sendall(header + body)
            receipt['responseWritten'] = True
            connection.shutdown(socket.SHUT_WR)
            try:
                while connection.recv(4096):
                    pass
                receipt['peerCompletion'] = 'eof'
            except ConnectionResetError:
                receipt['peerCompletion'] = 'reset'
        receipt['socketComplete'] = True
    except Exception as error:
        receipt['error'] = type(error).__name__
    finally:
        listener.close()


def terminate_owned(process):
    # start_new_session below establishes this exact process group as ours.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def main():
    context, representation = sys.argv[1:]
    assert context in ['main', 'worker'] and representation in ['json', 'gzip', 'hostile']
    assert not any(os.environ.get(key) for key in ['GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
    os.sched_setaffinity(0, {0})
    os.nice(19)
    group = next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    cgroup = Path('/sys/fs/cgroup') / group.lstrip('/')
    resources = {key: (cgroup / key).read_text().strip() for key in ['cpu.max', 'memory.max', 'memory.swap.max', 'pids.max']}
    assert resources == {'cpu.max': '100000 100000', 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '256'}
    interfaces = sorted(path.name for path in Path('/sys/class/net').iterdir())
    assert interfaces == ['lo'], interfaces
    binary = '/opt/Freedom/freedom'
    binary_hash = digest(binary)
    assert binary_hash == os.environ['PROBE_BINARY_SHA256']
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    origin = 'http://127.0.0.1:' + str(listener.getsockname()[1]) + '/'
    server = {'requestReceived': False, 'responseWritten': False, 'socketComplete': False}
    thread = threading.Thread(target=serve, args=(listener, representation, server), daemon=True)
    thread.start()
    # CI instrumentation only. This no-sandbox flag never qualifies an install.
    command = [binary, '--no-sandbox', '--disable-gpu', '--probe-context=' + context, '--probe-origin=' + origin]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    for name in output:
        selector.register(getattr(process, name), selectors.EVENT_READ, name)
    timed_out = overflow = False
    deadline = time.monotonic() + 25
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                terminate_owned(process)
                break
            for key, _ in selector.select(timeout=0.2):
                block = os.read(key.fileobj.fileno(), 16384)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                target = output[key.data]
                if len(target) + len(block) > LIMIT:
                    overflow = True
                    terminate_owned(process)
                    break
                target.extend(block)
            if overflow:
                break
        if process.poll() is None:
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
        terminate_owned(process)
    finally:
        if process.poll() is None:
            terminate_owned(process)
        selector.close()
        process.stdout.close()
        process.stderr.close()
        thread.join(timeout=16)
    text = {name: value.decode('utf-8', errors='replace') for name, value in output.items()}
    events = []
    parse_errors = 0
    for line in text['stdout'].splitlines():
        if line.startswith(PREFIX):
            try:
                event = json.loads(line[len(PREFIX):])
                assert isinstance(event, dict)
                events.append(event)
            except (ValueError, AssertionError):
                parse_errors += 1
    receipt = {'context': context, 'representation': representation, 'binarySha256': binary_hash,
               'ciSandboxDisabled': True, 'resources': resources, 'interfaces': interfaces,
               'processExitCode': process.returncode, 'timedOut': timed_out, 'outputOverflow': overflow,
               'serverThreadGone': not thread.is_alive(), 'server': server, 'events': events,
               'parseErrors': parse_errors, 'stdout': text['stdout'], 'stderr': text['stderr'],
               'memoryEvents': (cgroup / 'memory.events').read_text()}
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
