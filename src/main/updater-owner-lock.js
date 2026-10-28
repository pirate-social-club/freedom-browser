// Legacy app-wide updater entries remain protected during profile deletion.
// Evaluation builds do not acquire an updater lock or run an updater.
const UPDATER_LOCK_TARGET = 'updater-owner';
const UPDATER_LOCK_DIR = 'updater-owner.lock';

module.exports = { UPDATER_LOCK_DIR, UPDATER_LOCK_TARGET };
