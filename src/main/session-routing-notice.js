const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const reasons = {
  closeAllConnections_failed: 'Existing network connections could not be closed.',
  capability_closeAllConnections: 'The connection protection API was unavailable.',
  closeAllConnections_timeout: 'Closing existing network connections took too long.',
  setProxy_timeout: 'Applying the network route took too long.',
  forceReloadProxyConfig_timeout: 'Reloading the network route took too long.',
  guard_drain_failed: 'Protected network connections could not be closed.',
  guard_drain_timeout: 'Closing protected network connections took too long.',
  prepare_timeout: 'Preparing the protected network route took too long.',
  retire_resources_timeout: 'Closing the previous network route took too long.',
  pac_resource_failed: 'The local network routing service stopped working.',
  guard_resource_failed: 'The Handshake protection service stopped working.',
  generation_exhausted: 'Network protection could not establish a current policy.',
  intent_generation_exhausted: 'Network protection could not establish a current policy.',
  routing_failure: 'Network protection could not confirm that traffic was contained.',
};

function normalizeRoutingReason(code) {
  return Object.hasOwn(reasons, code) ? code : 'routing_failure';
}

// Construct only after profile migration. Store no exception, URL or history.
// Atomic replacement is best effort: filesystem I/O can still block or fail.
function createSessionRoutingNoticeStore(userData) {
  const filename = path.join(userData, 'session-routing-notice.json');
  function replace(value) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  }
  function read() {
    let descriptor;
    try {
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 1024) return null;
      const bytes = Buffer.alloc(1025);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > 1024) return null;
      const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (value?.version !== 1 || typeof value.id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(value.id) || !Object.hasOwn(reasons, value.code) ||
          Object.keys(value).sort().join(',') !== 'code,id,version') return null;
      return value;
    } catch { return null; } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return {
    record(code) { replace({ version: 1, id: randomUUID(), code: normalizeRoutingReason(code) }); },
    read,
    acknowledge(notice) {
      if (read()?.id === notice.id) replace({ version: 1, acknowledged: true });
    },
  };
}

async function showPreviousRoutingNotice(store, dialog) {
  let notice;
  try { notice = store.read(); } catch { return; }
  if (!notice) return;
  try {
    await dialog.showMessageBox({
      type: 'warning', title: 'Freedom protected your traffic',
      message: 'Freedom closed to protect your traffic.',
      detail: `${reasons[notice.code]} Unsaved work and downloads may have been interrupted. This notice does not confirm that network protection has recovered.`,
      buttons: ['OK'], noLink: true,
    });
    store.acknowledge(notice);
  } catch { /* Retain the notice if the native dialog is unavailable. */ }
}

module.exports = { createSessionRoutingNoticeStore, normalizeRoutingReason, showPreviousRoutingNotice };
