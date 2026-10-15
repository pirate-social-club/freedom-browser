const { evaluate, rootAdvisories, dependentChain } = require('./accepted-advisories');
const accepted = require('../../ops/dependency-repair/accepted-advisories.json');

const ELLIPTIC = 'https://github.com/advisories/GHSA-848j-6mx2-7j84';
const TODAY = '2026-10-15';

const advisory = (overrides = {}) => ({
  source: 1112030,
  name: 'elliptic',
  url: ELLIPTIC,
  severity: 'low',
  range: '<=6.6.1',
  ...overrides,
});

// The accepted chain, rebuilt as `npm audit --json` reports it: each
// dependent names the package it reaches the advisory through.
const RECORDED = accepted.advisories[0].chain;
const VIA = {
  '@ethersproject/signing-key': ['elliptic'],
  '@ethersproject/transactions': ['@ethersproject/signing-key'],
  '@ethersproject/abstract-provider': ['@ethersproject/transactions'],
  '@ethersproject/abstract-signer': ['@ethersproject/abstract-provider'],
  '@ethersproject/hash': ['@ethersproject/abstract-signer'],
  '@ethersproject/abi': ['@ethersproject/hash'],
  '@ledgerhq/evm-tools': ['@ethersproject/hash'],
  '@ledgerhq/hw-app-eth': ['@ethersproject/abi', '@ethersproject/transactions', '@ledgerhq/evm-tools'],
};

const vulnerable = (root = advisory(), nodes = [`node_modules/${root.name}`]) => ({
  name: root.name,
  severity: root.severity,
  via: [root],
  nodes,
});

function report({ root = advisory(), extra = {} } = {}) {
  const vulnerabilities = { [root.name]: vulnerable(root) };
  for (const link of RECORDED) {
    vulnerabilities[link.package] = { name: link.package, severity: 'low', via: VIA[link.package], nodes: link.paths };
  }
  return { auditReportVersion: 2, vulnerabilities: { ...vulnerabilities, ...extra } };
}

const lockFor = (overrides = {}) => ({
  packages: Object.fromEntries([
    ['node_modules/elliptic', { version: '6.6.1' }],
    ...RECORDED.flatMap((link) => link.paths.map((node) => [node, { version: link.versions[0] }])),
    ...Object.entries(overrides),
  ]),
});

describe('accepted advisories gate', () => {
  test('the recorded acceptance pins the whole chain up to the Ledger app', () => {
    expect(RECORDED.map((link) => link.package)).toEqual(Object.keys(VIA).sort());
    expect(RECORDED.find((link) => link.package === '@ledgerhq/hw-app-eth').versions).toEqual(['7.10.0']);
  });

  test('the recorded acceptance covers the current report shape', () => {
    expect(evaluate(report(), accepted, lockFor(), TODAY)).toEqual([]);
  });

  test('reports each advisory once per vulnerable package, with its locked paths and chain', () => {
    expect(rootAdvisories(report(), lockFor())).toEqual([
      expect.objectContaining({ url: ELLIPTIC, name: 'elliptic', nodes: ['node_modules/elliptic'], chain: RECORDED }),
    ]);
  });

  test('follows the chain transitively, not only the direct dependent', () => {
    expect(dependentChain(report(), 'elliptic', lockFor()).map((link) => link.package)).toContain('@ledgerhq/hw-app-eth');
  });

  test('refuses a new package that reaches the advisory through an existing dependent', () => {
    const wallet = { name: 'some-new-wallet', severity: 'low', via: ['@ethersproject/signing-key'], nodes: ['node_modules/some-new-wallet'] };
    expect(evaluate(report({ extra: { 'some-new-wallet': wallet } }), accepted, lockFor({ 'node_modules/some-new-wallet': { version: '1.0.0' } }), TODAY)).toEqual([
      expect.stringContaining('new: some-new-wallet@1.0.0 at node_modules/some-new-wallet'),
    ]);
  });

  test('refuses a version change anywhere in the chain', () => {
    expect(evaluate(report(), accepted, lockFor({ 'node_modules/@ledgerhq/hw-app-eth': { version: '7.11.0' } }), TODAY)).toEqual([
      expect.stringContaining('new: @ledgerhq/hw-app-eth@7.11.0'),
    ]);
  });

  test('refuses an advisory nobody accepted', () => {
    const other = advisory({ name: 'sprintf-js', url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c', range: '<=1.1.3' });
    expect(evaluate(report({ extra: { 'sprintf-js': vulnerable(other) } }), accepted, lockFor(), TODAY)).toEqual([
      expect.stringContaining('sprintf-js <=1.1.3 is not an accepted advisory'),
    ]);
  });

  test('refuses the accepted advisory reported on a second package, even beside the accepted one', () => {
    const other = advisory({ name: 'aaa-other', severity: 'critical', range: '*' });
    expect(evaluate(report({ extra: { 'aaa-other': vulnerable(other) } }), accepted, lockFor(), TODAY)).toEqual([
      expect.stringContaining('aaa-other * is not an accepted advisory'),
    ]);
  });

  test('refuses the accepted advisory on a widened range', () => {
    expect(evaluate(report({ root: advisory({ range: '<=6.6.2' }) }), accepted, lockFor(), TODAY)).toEqual([
      expect.stringContaining('elliptic <=6.6.2 is not an accepted advisory'),
      expect.stringContaining('no longer reported'),
    ]);
  });

  test('refuses the accepted package reached through a new locked path', () => {
    const r = report();
    r.vulnerabilities.elliptic.nodes = ['node_modules/elliptic', 'node_modules/some-wallet/node_modules/elliptic'];
    expect(evaluate(r, accepted, lockFor(), TODAY)).toEqual([expect.stringContaining('accepted only at node_modules/elliptic')]);
  });

  test('refuses a severity above the accepted one', () => {
    expect(evaluate(report({ root: advisory({ severity: 'moderate' }) }), accepted, lockFor(), TODAY)).toEqual([
      expect.stringContaining('accepted only up to low'),
    ]);
  });

  test('refuses an acceptance past its review date', () => {
    const [entry] = accepted.advisories;
    expect(evaluate(report(), accepted, lockFor(), '2099-01-01')).toEqual([expect.stringContaining(`lapsed on ${entry.reviewBy}`)]);
  });

  test('refuses an acceptance without a written reason', () => {
    const bare = { advisories: [{ ...accepted.advisories[0], reason: ' ' }] };
    expect(evaluate(report(), bare, lockFor(), TODAY)).toEqual([expect.stringContaining('no written reason')]);
  });

  test('refuses an acceptance the report no longer needs', () => {
    expect(evaluate({ auditReportVersion: 2, vulnerabilities: {} }, accepted, lockFor(), TODAY)).toEqual([
      expect.stringContaining('no longer reported; remove the acceptance'),
    ]);
  });

  test('passes a clean report against an empty list', () => {
    expect(evaluate({ auditReportVersion: 2, vulnerabilities: {} }, { advisories: [] }, lockFor(), TODAY)).toEqual([]);
  });

  test('refuses something that is not an npm audit report', () => {
    expect(() => evaluate({}, accepted, lockFor())).toThrow('auditReportVersion 2');
  });
});
