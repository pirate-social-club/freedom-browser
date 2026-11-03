const { CASES, classifyAll, classifyCase } = require('./classify-results');

function fixture(context, representation, exposed = false) {
  const events = [{ type: 'runtime', context,
    versions: { electron: '44.9.3', node: '24.22.0', undici: '7.29.1' }, builtinSource: { available: false } }];
  if (representation === 'hostile') {
    events.push({ type: 'fetch-rejected', context });
    events.push({ type: exposed ? 'uncaught-error' : 'request-settled', context });
  } else {
    events.push({ type: 'fetch-completed', context, status: 200, bodyMatches: true }, { type: 'request-settled', context });
  }
  if (context === 'worker') events.push({ type: 'worker-exit', context: 'main', code: exposed ? 42 : 0 });
  return { context, representation, binarySha256: 'fixture-binary', timedOut: false, outputOverflow: false,
    parseErrors: 0, serverThreadGone: true, server: { requestReceived: true, responseWritten: true,
      socketComplete: true, peerCompletion: 'eof' }, interfaces: ['lo'],
    resources: { 'cpu.max': '100000 100000', 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '256' },
    memoryEvents: 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
    processExitCode: exposed && context === 'main' ? 42 : 0, events };
}

test('six completed cases distinguish controlled exposure without accepting a browser', () => {
  const rows = CASES.map(({ context, representation }) => fixture(context, representation, representation === 'hostile'));
  const result = classifyAll(rows, 'fixture-binary');
  expect(result).toMatchObject({ complete: true, diagnosticOnly: true, accepted: false,
    exposureObservedContexts: ['main', 'worker'], runtimeRepairApproved: false, representativeWorkerOnly: true });
  expect(result.results.filter((row) => row.classification === 'uncaught-error-observed'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ uninstrumentedBrowserCrashProven: false })]));
});

test('a completed non-reproduction remains explicitly short of clearance', () => {
  const result = classifyCase(fixture('main', 'hostile'), 'fixture-binary');
  expect(result.classification).toBe('not-reproduced-not-clearance');
});

test.each(['timeout', 'overflow', 'socket', 'thread', 'native', 'version', 'network', 'memory', 'parse', 'control-body', 'missing-runtime'])(
  'refuses incomplete or incorrect %s evidence', (kind) => {
    const row = fixture('main', 'json');
    if (kind === 'timeout') row.timedOut = true;
    if (kind === 'overflow') row.outputOverflow = true;
    if (kind === 'socket') row.server.socketComplete = false;
    if (kind === 'thread') row.serverThreadGone = false;
    if (kind === 'native') row.binarySha256 = 'different-binary';
    if (kind === 'version') row.events[0].versions.undici = '7.30.1';
    if (kind === 'network') row.interfaces.push('eth0');
    if (kind === 'memory') row.memoryEvents = 'oom 1\noom_kill 1\n';
    if (kind === 'parse') row.parseErrors = 1;
    if (kind === 'control-body') row.events[1].bodyMatches = false;
    if (kind === 'missing-runtime') row.events.shift();
    expect(() => classifyCase(row, 'fixture-binary')).toThrow();
  });

test('a hostile event cannot compensate for either failed normal control', () => {
  const rows = CASES.map(({ context, representation }) => fixture(context, representation, representation === 'hostile'));
  rows[1].events.find((event) => event.type === 'fetch-completed').status = 500;
  expect(() => classifyAll(rows, 'fixture-binary')).toThrow();
});

test('a worker uncaught event without its separate exit is inconclusive', () => {
  const row = fixture('worker', 'hostile', true);
  row.events = row.events.filter((event) => event.type !== 'worker-exit');
  expect(() => classifyCase(row, 'fixture-binary')).toThrow();
});

test('partial, repeated and reordered samples cannot replace the fixed sample', () => {
  const rows = CASES.map(({ context, representation }) => fixture(context, representation));
  expect(() => classifyAll(rows.slice(1), 'fixture-binary')).toThrow();
  expect(() => classifyAll([...rows, rows[0]], 'fixture-binary')).toThrow();
  expect(() => classifyAll([...rows].reverse(), 'fixture-binary')).toThrow();
});
