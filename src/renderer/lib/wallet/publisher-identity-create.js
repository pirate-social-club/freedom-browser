/**
 * Shared publisher identity creation screen.
 */

import { walletState, registerScreenHider } from './wallet-state.js';

let screen;
let backBtn;
let cancelBtn;
let saveBtn;
let originEl;
let labelInput;
let errorEl;

let pending = null;

export function initPublisherIdentityCreate() {
  screen = document.getElementById('sidebar-publisher-identity-create');
  backBtn = document.getElementById('publisher-identity-create-back');
  cancelBtn = document.getElementById('publisher-identity-create-cancel');
  saveBtn = document.getElementById('publisher-identity-create-save');
  originEl = document.getElementById('publisher-identity-create-origin');
  labelInput = document.getElementById('publisher-identity-create-label');
  errorEl = document.getElementById('publisher-identity-create-error');

  registerScreenHider(() => closePublisherIdentityCreate({ reject: true }));

  backBtn?.addEventListener('click', handleCancel);
  cancelBtn?.addEventListener('click', handleCancel);
  saveBtn?.addEventListener('click', handleSave);
  labelInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleSave();
  });
}

export function showPublisherIdentityCreate(origin) {
  return new Promise((resolve, reject) => {
    if (pending) {
      pending.reject({ code: 4001, message: 'Superseded by new identity creation request' });
    }

    pending = { origin, resolve, reject };
    if (originEl) originEl.textContent = origin;
    if (labelInput) labelInput.value = '';
    hideError();

    walletState.identityView?.classList.add('hidden');
    screen?.classList.remove('hidden');
    setTimeout(() => labelInput?.focus(), 0);
  });
}

export function closePublisherIdentityCreate(options = {}) {
  const { reject = false } = options;
  const wasVisible = screen && !screen.classList.contains('hidden');
  screen?.classList.add('hidden');
  if (labelInput) labelInput.value = '';
  hideError();

  if (reject && wasVisible && pending) {
    pending.reject({ code: 4001, message: 'User dismissed publisher identity creation' });
    pending = null;
  }
}

async function handleSave() {
  if (!pending) return;

  const label = labelInput?.value?.trim() || '';
  if (!label) {
    showError('Enter a label for this identity.');
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  try {
    const state = await window.swarmFeedStore.createAppScopedIdentity(pending.origin, {
      label,
      activate: true,
    });
    const { resolve } = pending;
    pending = null;
    closePublisherIdentityCreate();
    resolve(state);
  } catch (err) {
    showError(err.message || 'Failed to create publisher identity.');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function handleCancel() {
  if (!pending) return;
  const { resolve } = pending;
  pending = null;
  closePublisherIdentityCreate();
  resolve(null);
}

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  if (!errorEl) return;
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
}
