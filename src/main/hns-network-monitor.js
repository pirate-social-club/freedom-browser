const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function interfaceIdentity() {
  return JSON.stringify(Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries || []).filter((entry) => !entry.internal).map((entry) =>
      [name, entry.family, entry.address, entry.netmask])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

// Mullvad's other event records may contain account identifiers. Never log or
// retain those records: classify a bounded prefix before collecting a line.
function createTunnelEventParser(onState, onInvalid) {
  let prefix = '';
  let record = '';
  let collecting = false;
  let discarding = false;
  let broken = false;
  return (chunk) => {
    if (broken) return;
    for (const byte of chunk) {
      const char = String.fromCharCode(byte);
      if (char === '\n') {
        if (collecting) {
          try {
            const value = JSON.parse(record);
            if (!['disconnected', 'connecting', 'connected', 'disconnecting', 'error'].includes(value.state)) throw new Error();
            const stable = value.state === 'connected' ||
              (value.state === 'disconnected' && value.details?.locked_down === false);
            onState(stable);
          } catch { broken = true; onInvalid('vpn_event_invalid'); }
        } else if (!discarding && prefix.trim() && ![
          'Warning: You are not logged in to an account.',
          'Warning: This device has been revoked.',
        ].includes(prefix.trim())) { broken = true; onInvalid('vpn_event_invalid'); }
        prefix = ''; record = ''; collecting = false; discarding = false;
        if (broken) return;
        continue;
      }
      if (discarding) continue;
      if (collecting) {
        if (record.length >= 65536) { broken = true; record = ''; onInvalid('vpn_event_too_large'); return; }
        record += char;
        continue;
      }
      prefix += char;
      if (/^\s*\{\s*"state"\s*:/.test(prefix)) {
        collecting = true; record = prefix; prefix = '';
      } else if (prefix.length >= 64 || /^\s*\{\s*"(?!state")[^"\s]+"\s*:/.test(prefix)) {
        discarding = true; prefix = '';
      }
    }
  };
}

function createHnsNetworkMonitor({ net, powerMonitor, onChange, onStable = () => {} }) {
  let stopped = false;
  let suspended = false;
  let vpnStable = true;
  let observerFailed = false;
  let listener;
  let startup;
  let listenerClosed;
  let closing;
  let identity = interfaceIdentity();
  let online = net.isOnline();
  const allowed = () => !stopped && !suspended && online && vpnStable && !observerFailed;
  function changed(reason) {
    if (stopped) return;
    onChange(reason);
    if (allowed()) onStable();
  }
  const suspend = () => { suspended = true; changed('system_suspend'); };
  const resume = () => { suspended = false; changed('system_resume'); };
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  const timer = setInterval(() => {
    const nextIdentity = interfaceIdentity();
    const nextOnline = net.isOnline();
    if (nextIdentity !== identity || nextOnline !== online) {
      identity = nextIdentity; online = nextOnline; changed('network_changed');
    }
  }, 2000);
  timer.unref?.();
  if (fs.existsSync('/usr/bin/mullvad')) {
    vpnStable = false;
    let seen = false;
    const invalidate = (reason) => { observerFailed = true; vpnStable = false; clearTimeout(startup); changed(reason); };
    const consume = createTunnelEventParser((stable) => {
      if (observerFailed || stopped) return;
      clearTimeout(startup);
      vpnStable = stable;
      if (seen) changed('vpn_state_changed');
      else { seen = true; if (allowed()) onStable(); }
    }, invalidate);
    try {
      listener = spawn('/usr/bin/mullvad', ['status', '--json', 'listen'], {
        shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
      listenerClosed = new Promise((resolve) => listener.once('close', resolve));
      listener.stdout.on('data', consume);
      // Read and discard diagnostic bytes without logging them.
      listener.stderr.on('data', () => {});
      listener.on('error', () => invalidate('vpn_observer_failed'));
      listener.on('close', () => invalidate('vpn_observer_closed'));
      startup = setTimeout(() => invalidate('vpn_observer_startup_timeout'), 5000);
    } catch { invalidate('vpn_observer_failed'); }
  }
  function close() {
    if (closing) return closing;
    stopped = true;
    clearInterval(timer); clearTimeout(startup);
    powerMonitor.removeListener('suspend', suspend);
    powerMonitor.removeListener('resume', resume);
    closing = (async () => {
      if (!listener || listener.exitCode !== null || listener.signalCode != null) return;
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { listener.kill('SIGKILL'); reject(new Error('VPN observer did not stop')); }, 5000);
      });
      listener.kill('SIGTERM');
      try { await Promise.race([listenerClosed, deadline]); }
      finally { clearTimeout(timer); }
    })();
    return closing;
  }

  return { allowed, close };
}

module.exports = { createHnsNetworkMonitor, createTunnelEventParser };
