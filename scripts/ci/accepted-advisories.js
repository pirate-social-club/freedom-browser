#!/usr/bin/env node

/**
 * Pass an `npm audit --json` report only when every finding traces back to an
 * advisory recorded in `ops/dependency-repair/accepted-advisories.json`.
 *
 * The release playbook (docs/agent-playbooks/release-process.md, "Audit
 * warnings") lets an advisory with no acceptable fix stand when it is not
 * exploitable in Freedom's usage, provided the reason is written down. This
 * makes that record machine-checked: an accepted advisory names the exact
 * vulnerable package, range and locked paths, the highest severity it was
 * accepted at, the written reason and a review date. A new advisory, the same
 * advisory on another package, range or path, a higher severity, a lapsed
 * review date, or an acceptance the report no longer needs fails the gate.
 *
 *   node scripts/ci/accepted-advisories.js <audit.json> [accepted.json]
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

/**
 * Every advisory object an `npm audit --json` (v2) report carries, one per
 * vulnerable package it was reported on, with that package's locked paths.
 * Nothing is merged by URL: the same advisory on two packages is two findings.
 */
function rootAdvisories(audit) {
  if (!audit || audit.auditReportVersion !== 2 || typeof audit.vulnerabilities !== 'object') {
    throw new Error('expected an npm audit --json report (auditReportVersion 2)');
  }
  const roots = [];
  for (const entry of Object.values(audit.vulnerabilities)) {
    for (const via of entry.via || []) {
      if (via && typeof via === 'object') {
        roots.push({ ...via, nodes: Array.isArray(entry.nodes) ? [...entry.nodes].sort() : [] });
      }
    }
  }
  return roots;
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Every reason the report is not covered by the accepted list; empty means it passes. */
function evaluate(audit, accepted, today = new Date().toISOString().slice(0, 10)) {
  const entries = accepted.advisories || [];
  const used = new Set();
  const problems = [];
  for (const advisory of rootAdvisories(audit)) {
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
  const [auditPath, acceptedPath = DEFAULT_ACCEPTED] = argv;
  if (!auditPath) {
    console.error('usage: accepted-advisories.js <audit.json> [accepted.json]');
    return 2;
  }
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const accepted = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
  const problems = evaluate(audit, accepted);
  const roots = rootAdvisories(audit);
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

module.exports = { evaluate, rootAdvisories, main };
