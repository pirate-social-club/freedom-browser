const params = new URLSearchParams(window.location.search);
const type = params.get('type') || 'error';
const handle = params.get('handle') || '@unknown';
const description = document.getElementById('description');
const status = document.getElementById('status');
const details = document.getElementById('details');
const hint = document.getElementById('hint');

const addRow = (label, value, text = false) => {
  if (!value) return;
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const definition = document.createElement('dd');
  term.textContent = label;
  definition.textContent = value;
  if (text) definition.className = 'text';
  wrapper.append(term, definition);
  details.appendChild(wrapper);
};

addRow('Handle', handle);

if (type === 'ok') {
  status.textContent = 'Resolved';
  description.textContent = 'Freedom verified this Space, but it has no published browser target.';
  addRow('Canonical handle', params.get('canonicalHandle'));
  addRow('Current outpoint', params.get('outpoint'));
  addRow('Root public key', params.get('rootPubkey'));
  addRow('Proof root hash', params.get('proofRootHash'));
  addRow('Accepted anchor height', params.get('acceptedAnchorHeight'), true);
  addRow('Accepted anchor block', params.get('acceptedAnchorBlockHash'));
  addRow('Accepted anchor root', params.get('acceptedAnchorRootHash'));
  addRow('Control class', params.get('controlClass'), true);
  addRow('Operation class', params.get('operationClass'), true);
  addRow('Observation provider', params.get('observationProvider'), true);
  hint.textContent = 'This is a neutral resolver result, not Pirate-owned content.';
} else if (type === 'not_found') {
  status.textContent = 'Not found';
  description.textContent = 'Freedom could not find a Space with this handle.';
  addRow('Reason', params.get('reason'), true);
  hint.textContent = 'Check the spelling and try again.';
} else {
  status.textContent = 'Resolver unavailable';
  description.textContent = 'Freedom could not obtain a verified Spaces result.';
  addRow('Reason', params.get('reason'), true);
  addRow('Message', params.get('message'), true);
  hint.textContent = 'Nothing was opened. Try again when the verifier is available.';
}
