"""Diagnostic only: Chromium 148 eligibility sequence, not Electron policy proof."""
import ctypes
import errno
import json
import os
import platform
import signal
import time
from pathlib import Path

NEWUSER = 0x10000000
ERRNOS = {errno.EPERM: 'permission_denied', errno.EACCES: 'access_denied', errno.EINVAL: 'unsupported', errno.ENOSPC: 'namespace_limit', errno.EUSERS: 'nesting_limit'}
STAGES = ('identity', 'clone_user', 'deny_setgroups', 'gid_map', 'uid_map', 'drop_capabilities', 'verify_capabilities', 'second_user', 'done', 'timeout', 'unknown')

def error_category(number):
    return ERRNOS.get(number, 'other_errno')

def kernel_facts():
    result = {}
    for name, path in [('unprivileged_userns_clone', '/proc/sys/kernel/unprivileged_userns_clone'), ('apparmor_restrict_unprivileged_userns', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'), ('max_user_namespaces', '/proc/sys/user/max_user_namespaces')]:
        try:
            raw = Path(path).read_text()[:32].strip()
            result[name] = int(raw) if raw.isdigit() and len(raw) <= 10 else None
        except OSError:
            result[name] = None
    try:
        raw = Path('/proc/self/attr/current').read_bytes()[:256].strip()
        result['apparmor_label_class'] = 'unconfined' if raw == b'unconfined' else 'confined_or_other'
    except OSError:
        result['apparmor_label_class'] = 'unavailable'
    return result

class CapHeader(ctypes.Structure):
    _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
class CapData(ctypes.Structure):
    _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]

def child_sequence(libc, uid, gid, send):
    stage = 'deny_setgroups'
    try:
        if Path('/proc/self/setgroups').exists():
            Path('/proc/self/setgroups').write_text('deny')
        stage = 'gid_map'
        Path('/proc/self/gid_map').write_text('%d %d 1\n' % (gid,gid))
        stage = 'uid_map'
        Path('/proc/self/uid_map').write_text('%d %d 1\n' % (uid,uid))
        stage = 'drop_capabilities'
        header = CapHeader(0x20080522, 0)
        data = (CapData * 2)()
        if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
            raise OSError(ctypes.get_errno(), '')
        stage = 'verify_capabilities'
        if libc.capget(ctypes.byref(header), ctypes.byref(data)) != 0:
            raise OSError(ctypes.get_errno(), '')
        if any(item.effective or item.permitted or item.inheritable for item in data):
            send({'passed': False, 'stage': stage, 'errno_category': 'none'})
            return
        stage = 'second_user'
        if libc.unshare(ctypes.c_int(NEWUSER)) != 0:
            raise OSError(ctypes.get_errno(), '')
        send({'passed': True, 'stage': 'done', 'errno_category': 'none'})
    except OSError as error:
        send({'passed': False, 'stage': stage, 'errno_category': error_category(error.errno)})
    except BaseException:
        send({'passed': False, 'stage': 'unknown', 'errno_category': 'none'})

def valid_result(value):
    return type(value) is dict and set(value) == {'passed', 'stage', 'errno_category'} and type(value['passed']) is bool and type(value['stage']) is str and type(value['errno_category']) is str and value['stage'] in STAGES and value['errno_category'] in {*ERRNOS.values(), 'other_errno', 'none'} and (not value['passed'] or (value['stage'] == 'done' and value['errno_category'] == 'none'))

def probe():
    result = {'passed': False, 'stage': 'identity', 'errno_category': 'none'}
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or len(list(Path('/proc/self/task').iterdir())) != 1 or os.getresuid() != (1000, 1000, 1000) or os.getresgid() != (1000, 1000, 1000):
        return result
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    read_fd, write_fd = os.pipe()
    pid = -1
    reaped = False
    try:
        # Linux x86_64 SYS_clone=56, NULL stack without CLONE_VM: fork-like child.
        pid = libc.syscall(ctypes.c_long(56), ctypes.c_ulong(NEWUSER | signal.SIGCHLD), ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p())
        if pid == -1:
            return {'passed': False, 'stage': 'clone_user', 'errno_category': error_category(ctypes.get_errno())}
        if pid == 0:
            child_status = 1
            try:
                os.close(read_fd)
                def send(value):
                    os.write(write_fd, json.dumps(value).encode('ascii'))
                child_sequence(libc, 1000, 1000, send)
                os.close(write_fd)
                child_status = 0
            finally:
                # Never return into the parent's descriptor/reaping finally.
                os._exit(child_status)
        os.close(write_fd)
        write_fd = -1
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            got, status = os.waitpid(pid, os.WNOHANG)
            if got:
                reaped = True
                if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                    return {'passed': False, 'stage': 'unknown', 'errno_category': 'none'}
                raw = os.read(read_fd, 513)
                try:
                    value = json.loads(raw) if len(raw) <= 512 else None
                except (ValueError, UnicodeError):
                    value = None
                return value if valid_result(value) else {'passed': False, 'stage': 'unknown', 'errno_category': 'none'}
            time.sleep(.02)
        return {'passed': False, 'stage': 'timeout', 'errno_category': 'none'}
    finally:
        if pid > 0 and not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)

if __name__ == '__main__':
    print(json.dumps({'schema': 1, 'kernel_facts': kernel_facts(), 'eligibility': probe()}, sort_keys=True))
