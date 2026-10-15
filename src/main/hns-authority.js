const { performance } = require('perf_hooks');

const METADATA_LEASE_MS = 10000;
const TRANSPORT_LEASE_MS = 15000;
const VALIDATION_LEASE_MS = 15000;
const MAX_TIP_AGE_SECONDS = 2 * 60 * 60;
const MAX_TIP_FUTURE_SECONDS = 10 * 60;

// A generation's authority is separate from its process/display state. Reads
// check monotonic leases at the point of use, even if the event loop was late.
function createHnsAuthority({ onInvalid = () => {}, monotonic = () => performance.now(), wallTime = () => Date.now() } = {}) {
  let retired = false;
  let published = false;
  const deadlines = { metadata: 0, transport: 0, validation: 0 };

  function retire() { retired = true; }

  function isValid() {
    const now = monotonic();
    const valid = !retired && Object.values(deadlines).every((deadline) => deadline > now);
    if (!valid && published && !retired) {
      retire();
      onInvalid('hns_authority_lease_expired');
    }
    return valid;
  }

  function renew(kind, duration) {
    if (retired) return false;
    // Never revive a previously published generation after a missed lease.
    if (published && !isValid()) return false;
    deadlines[kind] = monotonic() + duration;
    return true;
  }

  function metadata(state) {
    const age = wallTime() / 1000 - state.tipTime;
    if (!state.synced || !/^[0-9a-f]{64}$/.test(state.tipHash || '') ||
        !Number.isSafeInteger(state.tipTime) || age > MAX_TIP_AGE_SECONDS || age < -MAX_TIP_FUTURE_SECONDS) {
      if (published && !retired) { retire(); onInvalid('hns_chain_not_fresh'); }
      return false;
    }
    return renew('metadata', METADATA_LEASE_MS);
  }

  function publish() {
    if (!isValid()) return false;
    published = true;
    return true;
  }

  return { metadata, transport: () => renew('transport', TRANSPORT_LEASE_MS),
    validation: () => renew('validation', VALIDATION_LEASE_MS), isValid, publish, retire };
}

module.exports = { createHnsAuthority, METADATA_LEASE_MS, TRANSPORT_LEASE_MS, VALIDATION_LEASE_MS,
  MAX_TIP_AGE_SECONDS, MAX_TIP_FUTURE_SECONDS };
