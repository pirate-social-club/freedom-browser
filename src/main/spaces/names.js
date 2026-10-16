// Spaces names as typed: `@space` for a root, `name@space` for a name inside
// it. Each label follows the protocol's SLabel rule (spaces_protocol 0.5,
// slabel.rs): 1 to 62 of a-z, 0-9 and '-', with no leading, trailing or
// doubled '-', except after an `xn--` punycode prefix. ASCII letters are
// lowercased; anything else is not a Spaces name. Numeric `#` labels are not
// accepted here. src/renderer/lib/url-utils.js applies the same rule to
// address-bar input.
const MAX_LABEL_LENGTH = 62;

function isSpaceLabel(label) {
  if (typeof label !== 'string' || label.length < 1 || label.length > MAX_LABEL_LENGTH)
    return false;
  const checked = label.startsWith('xn--') && label.length > 4 ? label.slice(4) : label;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checked);
}

/** `{ handle, space, member }` for a valid name (member null for a root), else null. */
function parseSpaceHandle(input) {
  if (typeof input !== 'string') return null;
  const match = /^([^@]*)@([^@]+)$/.exec(input.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()));
  if (!match) return null;
  const [, member, space] = match;
  if (!isSpaceLabel(space) || (member && !isSpaceLabel(member))) return null;
  return { handle: `${member}@${space}`, space: `@${space}`, member: member || null };
}

module.exports = { isSpaceLabel, parseSpaceHandle };
