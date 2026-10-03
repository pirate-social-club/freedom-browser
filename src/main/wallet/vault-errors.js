/**
 * Canonical vault error contract.
 *
 * Every place that throws when the vault is locked uses
 * `VAULT_LOCKED_MESSAGE`. Every place that recovers from that throw uses
 * `isVaultLockedError(err)` — never compares the literal string.
 *
 * This was previously open-coded across 8 throw sites and 3 comparison
 * sites; a typo on either side silently broke recovery flows (most
 * notably x402 auto-pay → unlock-resume). Centralising it here removes
 * that risk. No dependencies — keep it that way so any module can
 * require it without circular-import worries.
 */

const VAULT_LOCKED_MESSAGE = 'Vault is locked';

function isVaultLockedError(err) {
  return err?.message === VAULT_LOCKED_MESSAGE;
}

module.exports = { VAULT_LOCKED_MESSAGE, isVaultLockedError };
