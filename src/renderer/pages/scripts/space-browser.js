const params = new URLSearchParams(window.location.search);
const type = params.get('type') || 'error';
const handle = params.get('handle') || '@unknown';
const reason = params.get('reason') || '';
const message = params.get('message') || '';
const txid = params.get('txid') || '';
const n = params.get('n') || '';
const rootPubkey = params.get('rootPubkey') || '';
const proofRootHash = params.get('proofRootHash') || '';
const acceptedAnchorHeight = params.get('acceptedAnchorHeight') || '';
const acceptedAnchorBlockHash = params.get('acceptedAnchorBlockHash') || '';
const acceptedAnchorRootHash = params.get('acceptedAnchorRootHash') || '';
const controlClass = params.get('controlClass') || '';
const operationClass = params.get('operationClass') || '';
const canonicalHandle = params.get('canonicalHandle') || '';
const observationProvider = params.get('observationProvider') || '';
const source = params.get('source') || '';
const webUrl = params.get('webUrl') || '';
const proofVerified = params.get('proofVerified') || '';

const descriptionEl = document.getElementById('description');
const statusEl = document.getElementById('status');
const detailsEl = document.getElementById('details');
const hintEl = document.getElementById('hint');

const addRow = (label, value, variant = 'mono') => {
  if (!value) return;
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');

  dt.textContent = label;
  dd.textContent = value;
  if (variant !== 'mono') {
    dd.dataset.variant = variant;
  }

  wrapper.appendChild(dt);
  wrapper.appendChild(dd);
  detailsEl.appendChild(wrapper);
};

addRow('Handle', handle);

if (type === 'ok') {
  statusEl.textContent = 'Resolved';
  descriptionEl.textContent =
    'Freedom resolved this Space. Browser-native web targets are not wired in yet, so this page shows the current root data instead.';
  addRow('Canonical Handle', canonicalHandle && canonicalHandle !== handle ? canonicalHandle : '');
  addRow('Current Outpoint', txid && n ? `${txid}:${n}` : '');
  addRow('Root Pubkey', rootPubkey);
  addRow('Proof Root Hash', proofRootHash);
  addRow('Accepted Anchor Height', acceptedAnchorHeight, 'text');
  addRow('Accepted Anchor Block', acceptedAnchorBlockHash);
  addRow('Accepted Anchor Root', acceptedAnchorRootHash);
  addRow('Proof Status', proofVerified === 'true' ? 'Verified' : proofVerified === 'false' ? 'Unverified' : '', 'text');
  addRow('Control Class', controlClass, 'text');
  addRow('Operation Class', operationClass, 'text');
  addRow('Resolver Source', source, 'text');
  addRow('Observation Provider', observationProvider, 'text');
  addRow('Published Web Target', webUrl);
  hintEl.textContent = 'This is a neutral resolver result page, not Pirate-owned content.';
} else if (type === 'not_found') {
  statusEl.textContent = 'Not Found';
  descriptionEl.textContent =
    'Freedom could not find a Space with this handle.';
  addRow('Reason', reason, 'text');
  hintEl.textContent = 'Check the spelling and try again.';
} else {
  statusEl.textContent = 'Resolver Error';
  descriptionEl.textContent =
    'Freedom could not reach a Spaces resolver for this handle.';
  addRow('Reason', reason, 'text');
  addRow('Message', message, 'text');
  hintEl.textContent = 'The resolver is unavailable right now. Try again in a moment.';
}
