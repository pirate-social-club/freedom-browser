const assert = require('node:assert/strict');

const CASES = ['main', 'worker'].flatMap((context) =>
  ['json', 'gzip', 'hostile'].map((representation) => ({ context, representation }))
);

function classifyCase(row, binaryHash) {
  assert.equal(row.binarySha256, binaryHash, 'Wrong native binary');
  assert.equal(row.timedOut, false);
  assert.equal(row.outputOverflow, false);
  assert.equal(row.parseErrors, 0);
  assert.equal(row.serverThreadGone, true);
  assert.equal(row.server.requestReceived, true);
  assert.equal(row.server.responseWritten, true);
  assert.equal(row.server.socketComplete, true, 'Socket completion missing');
  assert.ok(['eof', 'reset'].includes(row.server.peerCompletion));
  assert.equal(row.server.error, undefined);
  assert.deepEqual(row.interfaces, ['lo']);
  assert.deepEqual(row.resources, { 'cpu.max': '100000 100000', 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '256' });
  const memory = Object.fromEntries(row.memoryEvents.trim().split('\n').map((line) => line.split(/\s+/)));
  assert.equal(memory.oom, '0');
  assert.equal(memory.oom_kill, '0');
  const events = row.events.filter((event) => event.context === row.context);
  const runtime = events.filter((event) => event.type === 'runtime');
  assert.equal(runtime.length, 1, 'Missing or repeated runtime identity');
  assert.deepEqual(runtime[0].versions, { electron: '44.9.3', node: '24.22.0', undici: '7.29.1' });
  assert.equal(row.events.some((event) => event.type === 'worker-error'), false);
  const uncaught = events.filter((event) => event.type === 'uncaught-error');
  const finished = events.filter((event) => event.type === 'fetch-completed');
  const settled = events.some((event) => event.type === 'request-settled');
  const rejected = events.some((event) => event.type === 'fetch-rejected');
  const workerExit = row.events.find((event) => event.type === 'worker-exit');
  if (row.representation !== 'hostile') {
    assert.equal(uncaught.length, 0);
    assert.equal(rejected, false);
    assert.equal(settled, true);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].bodyMatches, true);
    assert.equal(finished[0].status, 200);
    assert.equal(row.processExitCode, 0);
    if (row.context === 'worker') assert.equal(workerExit?.code, 0);
    return { classification: 'normal-control-passed', context: row.context, representation: row.representation };
  }
  assert.equal(finished.length, 0, 'Malformed response unexpectedly accepted');
  if (uncaught.length) {
    assert.equal(uncaught.length, 1);
    assert.equal(row.processExitCode, row.context === 'main' ? 42 : 0);
    if (row.context === 'worker') assert.equal(workerExit?.code, 42);
    return { classification: 'uncaught-error-observed', context: row.context,
      fetchRejectionObserved: rejected, diagnosticTermination: true, uninstrumentedBrowserCrashProven: false };
  }
  assert.equal(rejected, true);
  assert.equal(settled, true);
  assert.equal(row.processExitCode, 0);
  if (row.context === 'worker') assert.equal(workerExit?.code, 0);
  return { classification: 'not-reproduced-not-clearance', context: row.context };
}

function classifyAll(rows, binaryHash) {
  assert.deepEqual(rows.map(({ context, representation }) => ({ context, representation })), CASES,
    'Exactly six fixed cases, once each');
  const results = rows.map((row) => classifyCase(row, binaryHash));
  return { diagnosticOnly: true, accepted: false, complete: true, results,
    exposureObservedContexts: results.filter((row) => row.classification === 'uncaught-error-observed').map((row) => row.context),
    representativeWorkerOnly: true, runtimeRepairApproved: false };
}

module.exports = { CASES, classifyCase, classifyAll };
