/* global securityKeyPrompt */
const $ = (id) => document.getElementById(id);
let kind;
securityKeyPrompt.onRequest((request) => {
  kind = request.kind;
  document.documentElement.dataset.theme = request.theme;
  $('origin').textContent = request.origin;
  $('rp').textContent = request.rp;
  $('title').textContent = kind === 'pin' ? 'Unlock your security key' : 'Choose your passkey';
  $('pin-fields').hidden = kind !== 'pin';
  $('account-fields').hidden = kind !== 'account';
  if (kind === 'pin') {
    const messages = {
      'wrong-pin': 'That PIN was not accepted.',
      'too-short': Number.isSafeInteger(request.minPinLength) && request.minPinLength > 0
        ? `That PIN is too short. Minimum length: ${request.minPinLength} characters.` : 'That PIN is too short.',
      'invalid-characters': 'That PIN contains invalid characters.',
      'internal-uv-locked': 'Use your PIN to unlock the security key.',
    };
    const remaining = request.attemptsRemaining === 1 ? '1 attempt remains' : `${request.attemptsRemaining} attempts remain`;
    $('message').textContent = `${messages[request.error] || 'Enter the PIN for your security key.'} ${remaining} before the key locks.`;
    $('pin').focus();
  } else {
    $('message').textContent = 'Choose the account to sign in with.';
    for (const account of request.accounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name || account.displayName || 'Unnamed passkey';
      $('account').append(option);
    }
    $('account').focus();
  }
});
$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = kind === 'pin' ? $('pin').value : $('account').value;
  if (!value) return;
  $('pin').value = '';
  securityKeyPrompt.respond('submit', value);
});
$('cancel').addEventListener('click', () => securityKeyPrompt.respond('cancel'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') securityKeyPrompt.respond('cancel');
});
