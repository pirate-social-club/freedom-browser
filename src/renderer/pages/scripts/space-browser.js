// Why a Spaces name did not open. A name whose owner signed an https website
// never lands here: the browser loads that website instead. Every field is
// written as text.
const params = new URLSearchParams(window.location.search);
const type = params.get('type') || 'error';
const handle = params.get('handle') || '';
const reason = params.get('reason') || '';
const message = params.get('message') || '';
const anchorHeight = params.get('anchorHeight') || '';

const REASONS = {
  NO_WEBSITE_RECORD: [
    'Website not published',
    'The owner of this Space has not signed a website for it.',
  ],
  INVALID_WEBSITE_RECORD: [
    'Website not usable',
    "The owner's signed website record does not name exactly one https address.",
  ],
  SPACE_NOT_FOUND: ['Not found', 'The relays have no Space by this name.'],
  MEMBER_NAMES_UNSUPPORTED: ['Not supported yet', 'Names inside a Space cannot be verified yet.'],
  INVALID_HANDLE: ['Not a Space name', 'This is not a valid Space name.'],
  ANCHORS_UNAVAILABLE: [
    'Cannot verify',
    'Freedom could not get a recent, agreed view of the Spaces chain to check this name against.',
  ],
  PROOF_UNVERIFIED: [
    'Cannot verify',
    'None of the relays returned a proof for this name that checks out.',
  ],
  PROOF_UNCONFIRMED: [
    'Cannot verify',
    'Too few relays returned a proof of who owns this Space to trust it.',
  ],
  SESSION_UNAVAILABLE: ['Cannot verify', 'This window is closing.'],
};

const [status, description] =
  REASONS[reason] ||
  (type === 'refused'
    ? ['Not opened', 'This Space did not open.']
    : ['Cannot verify', 'Freedom could not check this Space.']);

document.getElementById('status').textContent = status;
document.getElementById('description').textContent = description;

const detailsEl = document.getElementById('details');
const addRow = (label, value) => {
  if (!value) return;
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  wrapper.appendChild(dt);
  wrapper.appendChild(dd);
  detailsEl.appendChild(wrapper);
};

addRow('Space', handle);
addRow('Verified at Bitcoin block', /^\d+$/.test(anchorHeight) ? anchorHeight : '');
addRow('Detail', type === 'error' ? message : '');

document.getElementById('hint').textContent = type === 'error' ? 'Try again in a moment.' : '';
