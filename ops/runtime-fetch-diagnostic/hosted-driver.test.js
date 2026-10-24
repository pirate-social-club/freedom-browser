const { caseContainerArguments } = require('./hosted-driver');

test('the hosted container uses one compatible CPU quota without NanoCPUs', () => {
  const args = caseContainerArguments({ name: 'sample', owner: 'sample-owner', binaryHash: 'a'.repeat(64),
    image: 'sample-image', context: 'main', representation: 'json' });
  const value = (option) => args[args.indexOf(option) + 1];
  // Docker refuses --cpus (NanoCPUs) together with either CFS option,
  // before the normal-response control or Electron can start.
  expect(args).not.toContain('--cpus');
  expect(args).toContain('--cpu-quota');
  expect(args).toContain('--cpu-period');
  expect(Number(value('--cpu-quota')) / Number(value('--cpu-period'))).toBe(1);
  expect(Number(value('--cpu-period'))).toBeGreaterThan(0);
});
