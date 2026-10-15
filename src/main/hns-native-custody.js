const fs = require('fs');
const { performance } = require('perf_hooks');

function parseProcessStat(text) {
  const end = text.lastIndexOf(') ');
  const first = text.indexOf(' (');
  if (first < 1 || end < first) throw new Error('Invalid native process identity');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const identity = { pid: Number(text.slice(0, first)), state: fields[0], parent: Number(fields[1]),
    group: Number(fields[2]), threads: Number(fields[17]), start: fields[19] };
  if (![identity.pid, identity.parent, identity.group, identity.threads].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !/^\d+$/.test(identity.start || '')) throw new Error('Invalid native process identity');
  return identity;
}

function assertNoUnresolvedNativeGeneration(journalPath) {
  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (journal.schema !== 1 || journal.status !== 'closed') throw new Error('Pending native generation');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    const refused = new Error('Unresolved native HNS generation requires cleanup');
    refused.code = 'HNS_CUSTODY_UNRESOLVED'; throw refused;
  }
}

function createHnsNativeCustody(receiptPath, { journalPath, readFile = fs.readFileSync, stat = fs.statSync,
  writeFile = fs.writeFileSync,
  signal = process.kill, uid = process.getuid(), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => performance.now() } = {}) {
  let parent;
  let owned;
  let capturing;
  function journal(status) {
    if (journalPath) writeFile(journalPath, JSON.stringify({ schema: 1, status, receipt: receiptPath, uid, parent, owned }), { mode: 0o600 });
  }
  function current(pid) {
    try {
      const first = parseProcessStat(readFile(`/proc/${pid}/stat`, 'utf8'));
      if (stat(`/proc/${pid}`).uid !== uid) throw new Error('Unexpected native process owner');
      const second = parseProcessStat(readFile(`/proc/${pid}/stat`, 'utf8'));
      if (first.start !== second.start || first.pid !== second.pid) throw new Error('Native process identity changed');
      return second;
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
  }
  function bindParent(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Helper PID unavailable');
    parent = current(pid);
    if (!parent || parent.pid !== pid) throw new Error('Helper process identity unavailable');
    journal('pending');
  }
  function capture() {
    if (capturing) return capturing;
    capturing = (async () => {
      if (!parent) throw new Error('Native custody has no bound helper');
      const deadline = clock() + 5000;
      while (clock() < deadline) {
        let receipt;
        try { receipt = parseProcessStat(readFile(receiptPath, 'utf8')); }
        catch (error) {
          if (error.code && error.code !== 'ENOENT') throw error;
          await pause(25); continue;
        }
        if (receipt.parent !== parent.pid || receipt.group !== receipt.pid) throw new Error('Native generation receipt mismatch');
        const live = current(receipt.pid);
        if (live && (live.start !== receipt.start || live.group !== receipt.group)) throw new Error('Native process receipt was reused');
        owned = receipt; journal('pending');
        return;
      }
      throw new Error('Native launch receipt unavailable');
    })();
    return capturing;
  }
  function same(live) { return live && live.pid === owned.pid && live.start === owned.start; }
  async function terminate() {
    await capture();
    const deadline = clock() + 5000;
    let sent = false;
    while (clock() < deadline) {
      const live = current(owned.pid);
      if (!same(live)) { journal('closed'); return; }
      if (live.group !== owned.group) throw new Error('Native process group changed');
      if (['Z', 'X'].includes(live.state) && live.threads === 1) { journal('closed'); return; }
      // Match the private generation receipt, UID and start identity directly
      // before signalling. /proc + kill is not an atomic pidfd operation.
      if (!sent) {
        try { signal(-owned.group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        sent = true;
      }
      await pause(25);
    }
    throw new Error('Native HNS resolver did not stop');
  }
  return { prepare: () => journal('pending'), neverSpawned: () => journal('closed'),
    bindParent, capture, terminate, isCaptured: () => Boolean(owned) };
}

module.exports = { createHnsNativeCustody, parseProcessStat, assertNoUnresolvedNativeGeneration };
