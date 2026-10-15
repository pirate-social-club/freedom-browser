const { evaluate, rootAdvisories } = require('./accepted-advisories');
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

// The shape `npm audit --json` writes: the vulnerable package carries the
// advisory object and its locked paths, its dependents name it by package.
const finding = (root, nodes = [`node_modules/${root.name}`], effects = ['@ethersproject/signing-key']) => ({
  name: root.name,
  severity: root.severity,
  via: [root],
  nodes,
  effects,
});
const report = (...findings) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries([
    ...findings.map((entry) => [entry.name, entry]),
    [
      '@ethersproject/signing-key',
      { name: '@ethersproject/signing-key', severity: 'low', via: ['elliptic'], nodes: ['node_modules/@ethersproject/signing-key'] },
    ],
  ]),
});
const current = () => report(finding(advisory()));

describe('accepted advisories gate', () => {
  test('the recorded elliptic acceptance covers the current report shape', () => {
    expect(evaluate(current(), accepted, TODAY)).toEqual([]);
  });

  test('reports each advisory once per vulnerable package, with its locked paths', () => {
    expect(rootAdvisories(current())).toEqual([
      expect.objectContaining({ url: ELLIPTIC, name: 'elliptic', nodes: ['node_modules/elliptic'] }),
    ]);
  });

  test('refuses an advisory nobody accepted', () => {
    const other = advisory({ name: 'sprintf-js', url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c', range: '<=1.1.3' });
    expect(evaluate(report(finding(advisory()), finding(other)), accepted, TODAY)).toEqual([
      expect.stringContaining('sprintf-js <=1.1.3 is not an accepted advisory'),
    ]);
  });

  test('refuses the accepted advisory reported on a second package, even beside the accepted one', () => {
    const other = advisory({ name: 'aaa-other', severity: 'critical', range: '*' });
    expect(evaluate(report(finding(advisory()), finding(other)), accepted, TODAY)).toEqual([
      expect.stringContaining('aaa-other * is not an accepted advisory'),
    ]);
  });

  test('refuses the accepted advisory on a widened range', () => {
    expect(evaluate(report(finding(advisory({ range: '<=6.6.2' }))), accepted, TODAY)).toEqual([
      expect.stringContaining('elliptic <=6.6.2 is not an accepted advisory'),
      expect.stringContaining('no longer reported'),
    ]);
  });

  test('refuses the accepted package reached through a new locked path', () => {
    const nested = finding(advisory(), ['node_modules/elliptic', 'node_modules/some-wallet/node_modules/elliptic']);
    expect(evaluate(report(nested), accepted, TODAY)).toEqual([
      expect.stringContaining('accepted only at node_modules/elliptic'),
    ]);
  });

  test('refuses the accepted package reached by a new dependent', () => {
    const wider = finding(advisory(), undefined, ['@ethersproject/signing-key', 'some-new-wallet']);
    expect(evaluate(report(wider), accepted, TODAY)).toEqual([
      expect.stringContaining('accepted only through @ethersproject/signing-key'),
    ]);
  });

  test('refuses a severity above the accepted one', () => {
    expect(evaluate(report(finding(advisory({ severity: 'moderate' }))), accepted, TODAY)).toEqual([
      expect.stringContaining('accepted only up to low'),
    ]);
  });

  test('refuses an acceptance past its review date', () => {
    const [entry] = accepted.advisories;
    expect(evaluate(current(), accepted, '2099-01-01')).toEqual([
      expect.stringContaining(`lapsed on ${entry.reviewBy}`),
    ]);
  });

  test('refuses an acceptance without a written reason', () => {
    const bare = { advisories: [{ ...accepted.advisories[0], reason: ' ' }] };
    expect(evaluate(current(), bare, TODAY)).toEqual([expect.stringContaining('no written reason')]);
  });

  test('refuses an acceptance the report no longer needs', () => {
    expect(evaluate({ auditReportVersion: 2, vulnerabilities: {} }, accepted, TODAY)).toEqual([
      expect.stringContaining('no longer reported; remove the acceptance'),
    ]);
  });

  test('passes a clean report against an empty list', () => {
    expect(evaluate({ auditReportVersion: 2, vulnerabilities: {} }, { advisories: [] }, TODAY)).toEqual([]);
  });

  test('refuses something that is not an npm audit report', () => {
    expect(() => evaluate({}, accepted)).toThrow('auditReportVersion 2');
  });
});
