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
STAGES = ('identity', 'clone_user', 'deny_setgroups_open', 'deny_setgroups_write', 'deny_setgroups_short_write', 'gid_map_open', 'gid_map_write', 'gid_map_short_write', 'uid_map_open', 'uid_map_write', 'uid_map_short_write', 'drop_capabilities', 'verify_capabilities', 'second_user', 'done', 'timeout', 'unknown')

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

FACT_KEYS = ('cap_sys_admin_bit', 'dumpable_user', 'effective_fsuid_visible_match', 'setgroups_owner_visible_match', 'gid_map_owner_visible_match', 'uid_map_owner_visible_match')

def child_access_facts(libc):
    facts = {key: None for key in FACT_KEYS}
    try:
        header = CapHeader(0x20080522, 0)
        data = (CapData * 2)()
        if libc.capget(ctypes.byref(header), ctypes.byref(data)) == 0:
            facts['cap_sys_admin_bit'] = bool(data[0].effective & (1 << 21))
    except Exception:
        pass
    try:
        value = libc.prctl(ctypes.c_int(3), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0))
        if value in (0, 1, 2):
            facts['dumpable_user'] = value == 1
    except Exception:
        pass
    try:
        with open('/proc/self/status', 'rb') as status:
            raw = status.read(8192)
        fields = next(line.split()[1:] for line in raw.splitlines() if line.startswith(b'Uid:'))
        if len(fields) == 4 and all(value.isdigit() for value in fields):
            facts['effective_fsuid_visible_match'] = fields[1] == fields[3]
    except (OSError, StopIteration):
        pass
    for key, path in [('setgroups_owner_visible_match', '/proc/self/setgroups'), ('gid_map_owner_visible_match', '/proc/self/gid_map'), ('uid_map_owner_visible_match', '/proc/self/uid_map')]:
        try:
            facts[key] = os.stat(path).st_uid == os.geteuid()
        except OSError:
            pass
    return facts

def child_sequence(libc, uid, gid, send):
    stage = 'unknown'
    facts = child_access_facts(libc)
    try:
        writes = []
        if Path('/proc/self/setgroups').exists():
            writes.append(('deny_setgroups', '/proc/self/setgroups', b'deny'))
        writes.extend([('gid_map', '/proc/self/gid_map', ('%d %d 1\n' % (gid, gid)).encode('ascii')), ('uid_map', '/proc/self/uid_map', ('%d %d 1\n' % (uid, uid)).encode('ascii'))])
        for prefix, path, payload in writes:
            stage = prefix + '_open'
            fd = os.open(path, os.O_WRONLY)
            try:
                stage = prefix + '_write'
                written = os.write(fd, payload)
                if written != len(payload):
                    send({'passed': False, 'stage': prefix + '_short_write', 'errno_category': 'none', 'proc_access': facts})
                    return
            finally:
                os.close(fd)
        stage = 'drop_capabilities'
        header = CapHeader(0x20080522, 0)
        data = (CapData * 2)()
        if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
            raise OSError(ctypes.get_errno(), '')
        stage = 'verify_capabilities'
        if libc.capget(ctypes.byref(header), ctypes.byref(data)) != 0:
            raise OSError(ctypes.get_errno(), '')
        if any(item.effective or item.permitted or item.inheritable for item in data):
            send({'passed': False, 'stage': stage, 'errno_category': 'none', 'proc_access': facts})
            return
        stage = 'second_user'
        if libc.unshare(ctypes.c_int(NEWUSER)) != 0:
            raise OSError(ctypes.get_errno(), '')
        send({'passed': True, 'stage': 'done', 'errno_category': 'none', 'proc_access': facts})
    except OSError as error:
        send({'passed': False, 'stage': stage, 'errno_category': error_category(error.errno), 'proc_access': facts})
    except BaseException:
        send({'passed': False, 'stage': 'unknown', 'errno_category': 'none', 'proc_access': facts})

def valid_result(value):
    return type(value) is dict and set(value) == {'passed', 'stage', 'errno_category', 'proc_access'} and (value['proc_access'] is None or (type(value['proc_access']) is dict and set(value['proc_access']) == set(FACT_KEYS) and all(item is None or type(item) is bool for item in value['proc_access'].values()))) and type(value['passed']) is bool and type(value['stage']) is str and type(value['errno_category']) is str and value['stage'] in STAGES and value['errno_category'] in {*ERRNOS.values(), 'other_errno', 'none'} and (not value['passed'] or (value['stage'] == 'done' and value['errno_category'] == 'none'))

def probe():
    result = {'passed': False, 'stage': 'identity', 'errno_category': 'none', 'proc_access': None}
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
            return {'passed': False, 'stage': 'clone_user', 'errno_category': error_category(ctypes.get_errno()), 'proc_access': None}
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
                    return {'passed': False, 'stage': 'unknown', 'errno_category': 'none', 'proc_access': None}
                raw = os.read(read_fd, 1025)
                try:
                    value = json.loads(raw) if len(raw) <= 1024 else None
                except (ValueError, UnicodeError):
                    value = None
                return value if valid_result(value) else {'passed': False, 'stage': 'unknown', 'errno_category': 'none', 'proc_access': None}
            time.sleep(.02)
        return {'passed': False, 'stage': 'timeout', 'errno_category': 'none', 'proc_access': None}
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
