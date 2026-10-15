#!/usr/bin/env node

/**
 * Pass an `npm audit --json` report only when every finding traces back to an
 * advisory recorded in `ops/dependency-repair/accepted-advisories.json`.
 *
 * The release playbook (docs/agent-playbooks/release-process.md, "Audit
 * warnings") lets an advisory with no acceptable fix stand when it is not
 * exploitable in Freedom's usage, provided the reason is written down. This
 * makes that record machine-checked: an accepted advisory names the exact
 * vulnerable package, range and locked paths, the complete chain of packages
 * that depend on it, each with its locked versions and paths (the reachability
 * the written reason argues about), the highest severity it was accepted at,
 * the reason and a review date. A new advisory, the same advisory on another
 * package, range or path, any change to the dependent chain, a higher
 * severity, a lapsed review date, or an acceptance the report no longer needs
 * fails it.
 *
 *   node scripts/ci/accepted-advisories.js <audit.json> [accepted.json] [package-lock.json]
 */

const fs = require('fs');
const path = require('path');

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const DEFAULT_ACCEPTED = path.join(
  __dirname,
  '..',
  '..',
  'ops',
  'dependency-repair',
  'accepted-advisories.json'
);
const DEFAULT_LOCK = path.join(__dirname, '..', '..', 'package-lock.json');

/**
 * Every audit entry that reaches `name` through its `via` package names,
 * transitively, as `{ package, direct, versions, paths }` sorted by package.
 * Versions come from the lock, so a bump anywhere in the chain changes the
 * record; `direct` is npm's isDirect, so Freedom taking a chain package as its
 * own dependency changes it too.
 */
function dependentChain(audit, name, lock) {
  const reached = new Set([name]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [dependent, entry] of Object.entries(audit.vulnerabilities)) {
      if (reached.has(dependent)) continue;
      if ((entry.via || []).some((via) => typeof via === 'string' && reached.has(via))) {
        reached.add(dependent);
        grew = true;
      }
    }
  }
  reached.delete(name);
  return [...reached].sort().map((dependent) => {
    const entry = audit.vulnerabilities[dependent];
    const paths = [...(entry.nodes || [])].sort();
    const versions = [...new Set(paths.map((node) => lock?.packages?.[node]?.version ?? 'unlocked'))].sort();
    return { package: dependent, direct: entry.isDirect === true, versions, paths };
  });
}

/**
 * Every advisory object an `npm audit --json` (v2) report carries, one per
 * vulnerable package it was reported on, with that package's locked paths.
 * Nothing is merged by URL: the same advisory on two packages is two findings.
 */
function rootAdvisories(audit, lock) {
  if (!audit || audit.auditReportVersion !== 2 || typeof audit.vulnerabilities !== 'object') {
    throw new Error('expected an npm audit --json report (auditReportVersion 2)');
  }
  const roots = [];
  for (const entry of Object.values(audit.vulnerabilities)) {
    for (const via of entry.via || []) {
      if (via && typeof via === 'object') {
        roots.push({
          ...via,
          nodes: Array.isArray(entry.nodes) ? [...entry.nodes].sort() : [],
          chain: dependentChain(audit, entry.name, lock),
        });
      }
    }
  }
  return roots;
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Every reason the report is not covered by the accepted list; empty means it passes. */
function evaluate(audit, accepted, lock, today = new Date().toISOString().slice(0, 10)) {
  const entries = accepted.advisories || [];
  const used = new Set();
  const problems = [];
  for (const advisory of rootAdvisories(audit, lock)) {
    const entry = entries.find(
      (candidate) =>
        candidate.url === advisory.url &&
        candidate.package === advisory.name &&
        candidate.range === advisory.range
    );
    if (!entry) {
      problems.push(`${advisory.url} on ${advisory.name} ${advisory.range} is not an accepted advisory`);
      continue;
    }
    used.add(entry);
    const paths = [...(entry.paths || [])].sort();
    if (!sameList(advisory.nodes, paths)) {
      problems.push(
        `${advisory.url} on ${advisory.name} is locked at ${advisory.nodes.join(', ') || 'no path'}, accepted only at ${paths.join(', ') || 'no path'}`
      );
    }
    // One order for both sides: plain code-unit sort of the rendered links.
    const describe = (chain) =>
      chain
        .map((link) => `${link.package}@${link.versions.join('|')}${link.direct ? ' (direct)' : ''} at ${link.paths.join('|')}`)
        .sort();
    const reported = describe(advisory.chain);
    const recorded = describe(entry.chain || []);
    if (!sameList(reported, recorded)) {
      const added = reported.filter((link) => !recorded.includes(link));
      const gone = recorded.filter((link) => !reported.includes(link));
      problems.push(
        `${advisory.url} on ${advisory.name} is reached by a different dependent chain than was accepted` +
          (added.length ? `; new: ${added.join(', ')}` : '') +
          (gone.length ? `; no longer: ${gone.join(', ')}` : '')
      );
    }
    if (SEVERITIES.indexOf(advisory.severity) > SEVERITIES.indexOf(entry.maxSeverity)) {
      problems.push(`${advisory.url} is ${advisory.severity}, accepted only up to ${entry.maxSeverity}`);
    }
    if (!(typeof entry.reviewBy === 'string' && today <= entry.reviewBy)) {
      problems.push(`${advisory.url} acceptance lapsed on ${entry.reviewBy}`);
    }
    if (!(typeof entry.reason === 'string' && entry.reason.trim())) {
      problems.push(`${advisory.url} has no written reason`);
    }
  }
  for (const entry of entries) {
    if (!used.has(entry)) {
      problems.push(`${entry.url} on ${entry.package} is accepted but no longer reported; remove the acceptance`);
    }
  }
  return problems;
}

function main(argv = process.argv.slice(2)) {
  const [auditPath, acceptedPath = DEFAULT_ACCEPTED, lockPath = DEFAULT_LOCK] = argv;
  if (!auditPath) {
    console.error('usage: accepted-advisories.js <audit.json> [accepted.json] [package-lock.json]');
    return 2;
  }
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const accepted = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const problems = evaluate(audit, accepted, lock);
  const roots = rootAdvisories(audit, lock);
  if (problems.length) {
    for (const problem of problems) console.error(`[accepted-advisories] ${problem}`);
    return 1;
  }
  console.log(
    `[accepted-advisories] ${roots.length} advisory finding${roots.length === 1 ? '' : 's'}, all accepted` +
      (roots.length ? `: ${roots.map((advisory) => `${advisory.url} on ${advisory.name}`).join(', ')}` : '')
  );
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { evaluate, rootAdvisories, dependentChain, main };
