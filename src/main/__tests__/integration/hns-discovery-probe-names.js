/**
 * How `hns-namespace-discovery.test.js` and its Electron probe read the names
 * the probe's resolver was asked for. Kept in its own module so the unit job,
 * which skips the Electron probes, still tests it
 * (`hns-discovery-probe-names.test.js`).
 *
 * A host with a DNS search list retries a name that does not exist with each
 * search suffix appended. GitHub's hosted runners have one under
 * `internal.cloudapp.net`, so the probe's resolver sees `img.unlistedprobe`
 * and then `img.unlistedprobe.<suffix>`; `LOCALDOMAIN` produces the same on a
 * workstation. A host could also try the suffixed form first. So:
 *   - a name is under a root when the root is any of its labels, which counts
 *     a suffixed lookup under a listed root as the leak it is;
 *   - an expected control name is seen when it was looked up bare or with any
 *     suffix after it.
 */

// True for a name that has `root` as one of its labels.
const under = (root) => (name) => String(name).split('.').includes(root);

// The one of `expected` that `name` is, bare or with a search suffix after it,
// or null.
function expectedNameOf(name, expected) {
  const value = String(name);
  return expected.find((candidate) => value === candidate || value.startsWith(`${candidate}.`)) ?? null;
}

// The distinct names in `queried`, sorted, with each lookup of an expected
// name reduced to that name. Anything else is kept as it was asked for, so a
// comparison with `expected` still fails on it.
function namesSeen(queried, expected) {
  return [...new Set(queried.map((name) => expectedNameOf(name, expected) ?? String(name)))].sort();
}

module.exports = { under, expectedNameOf, namesSeen };
