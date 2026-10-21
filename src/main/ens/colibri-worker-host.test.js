const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({ warn: (...args) => mockLogWarn(...args), info: jest.fn() }));

const host = require('./colibri-worker-host');

const STORAGE_DIR = '/tmp/freedom-test-userdata/colibri';
const CONFIG = { chainId: 1, proverUrl: 'https://p.example', zkProof: true };
let spawned;

function lastWorker() {
  return spawned[spawned.length - 1];
}

function sentRequests(worker) {
  return worker.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'request');
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

// Start a request and let the fake worker report ready so it gets posted.
async function startRequest(client, args, opts) {
  const promise = client.request(args, opts);
  promise.catch(() => {});
  await flush();
  const worker = lastWorker();
  if (!worker.readySent) {
    worker.readySent = true;
    worker.emit('message', { type: 'ready' });
    await flush();
  }
  return { promise, worker, id: sentRequests(worker).at(-1).id };
}

beforeEach(() => {
  jest.useFakeTimers();
  spawned = [];
  mockLogWarn.mockReset();
  Worker.mockReset();
  Worker.mockImplementation(() => {
    const worker = new EventEmitter();
    jest.spyOn(worker, 'on');
    worker.postMessage = jest.fn();
    worker.terminate = jest.fn(() => Promise.resolve(1));
    worker.unref = jest.fn();
    spawned.push(worker);
    return worker;
  });
  host.resetForTest({ storageDir: STORAGE_DIR });
});

afterEach(() => {
  host.resetForTest();
  jest.useRealTimers();
});

describe('colibri worker host', () => {
  test('spawns one isolated, unref’d worker per chain with the storage dir', async () => {
    const client = host.createClient(CONFIG);
    const { promise, worker, id } = await startRequest(client, { method: 'eth_blockNumber' });
    expect(Worker).toHaveBeenCalledWith(expect.stringMatching(/colibri-worker\.js$/), {
      workerData: { storageDir: STORAGE_DIR },
      execArgv: [],
      env: { C4_DISABLE_NATIVE: '1' },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    // unref() after the listeners: adding a 'message' listener re-refs it.
    expect(worker.unref).toHaveBeenCalled();
    expect(worker.unref.mock.invocationCallOrder[0])
      .toBeGreaterThan(Math.max(...worker.on.mock.invocationCallOrder));
    expect(sentRequests(worker)[0]).toEqual({
      type: 'request', id, clientId: expect.any(Number), config: CONFIG,
      method: 'eth_blockNumber', params: [],
    });
    worker.emit('message', { type: 'result', id, ok: true, result: '0x10' });
    await expect(promise).resolves.toBe('0x10');

    // Same chain, another client: same worker. Another chain: its own worker.
    await startRequest(host.createClient(CONFIG), { method: 'eth_chainId' });
    expect(Worker).toHaveBeenCalledTimes(1);
    await startRequest(host.createClient({ ...CONFIG, chainId: 100 }), { method: 'eth_chainId' });
    expect(Worker).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(2);
  });

  test('revives worker errors with code and revert data for ethers/the router', async () => {
    const { promise, worker, id } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call', params: [{}] });
    worker.emit('message', {
      type: 'result', id, ok: false,
      error: { name: 'ProviderRpcError', message: 'execution reverted', code: 3, data: '0xdead' },
    });
    await expect(promise).rejects.toMatchObject({
      name: 'ProviderRpcError', message: 'execution reverted', code: 3, data: '0xdead',
    });
  });

  test('a request settling before its deadline leaves no timers or probes', async () => {
    const { promise, worker, id } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    worker.emit('message', { type: 'result', id, ok: true, result: '0x' });
    await promise;
    jest.advanceTimersByTime(10 * 60_000);
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  test('terminates a worker still verifying past the deadline and starts a fresh one', async () => {
    const client = host.createClient(CONFIG);
    const { promise, worker } = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000);
    const ping = worker.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'ping');
    expect(ping).toBeDefined();
    // Busy in synchronous WASM: no pong.
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toThrow(/Colibri worker replaced: verification still running/);
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringMatching(/chain 1 worker replaced/));

    // A late 'exit' from the terminated worker is absorbed, and the next
    // request gets a new worker rather than the stuck one.
    worker.emit('exit', 1);
    const next = await startRequest(client, { method: 'eth_blockNumber' });
    expect(next.worker).not.toBe(worker);
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('leaves a responsive worker waiting on the network until the abandon cap', async () => {
    const { promise, worker } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000);
    const ping = worker.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'ping');
    worker.emit('message', { type: 'pong', id: ping.id });
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(worker.terminate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(host.ABANDONED_MS);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toThrow(/request abandoned after its deadline/);
  });

  test('requests without a caller deadline get the default liveness check', async () => {
    const { worker } = await startRequest(host.createClient(CONFIG), { method: 'eth_call' });
    jest.advanceTimersByTime(host.DEFAULT_DEADLINE_MS - 1);
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    jest.advanceTimersByTime(1);
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
  });

  test('a WASM trap retires the worker once its in-flight requests drain', async () => {
    const client = host.createClient(CONFIG);
    const a = await startRequest(client, { method: 'eth_getTransactionReceipt' });
    const b = await startRequest(client, { method: 'eth_blockNumber' });
    const trapped = a.worker;
    trapped.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 WASM verifier trapped (memory access out of bounds); replacing the worker'
    );
    // New work goes to a fresh worker straight away.
    const c = await startRequest(client, { method: 'eth_chainId' });
    expect(c.worker).not.toBe(trapped);
    trapped.emit('message', {
      type: 'result', id: a.id, ok: false,
      error: { name: 'RuntimeError', message: 'memory access out of bounds' },
    });
    await expect(a.promise).rejects.toMatchObject({ name: 'RuntimeError' });
    expect(trapped.terminate).not.toHaveBeenCalled();
    trapped.emit('message', { type: 'result', id: b.id, ok: true, result: '0x1' });
    await expect(b.promise).resolves.toBe('0x1');
    expect(trapped.terminate).toHaveBeenCalledTimes(1);
    expect(c.worker.terminate).not.toHaveBeenCalled();
  });

  // #750: one unknown-hash lookup keeping the worker busy past its deadline
  // used to fail every unrelated request on that worker with it.
  test('a stuck-worker kill sends bystanders still inside their deadline to the new worker', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_getTransactionReceipt' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(client, { method: 'eth_call', params: [{ to: '0xabc' }] },
      { deadlineMs: 2000 });
    expect(bystander.worker).toBe(stuck.worker);
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    expect(stuck.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stuck.promise).rejects.toThrow(/verification still running after its deadline/);
    // Two requests of different methods were on the worker: whose deadline
    // fired first says nothing about which one the verifier was spinning in.
    await expect(stuck.promise).rejects.toHaveProperty('colibriBystander', true);
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );

    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(stuck.worker);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_call', params: [{ to: '0xabc' }] });
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: '0x01' });
    await expect(bystander.promise).resolves.toBe('0x01');
  });

  test('a resent bystander keeps what is left of its deadline and is not resent twice', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(client, { method: 'eth_chainId' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    await expect(stuck.promise).rejects.toThrow(/still running/);
    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    expect(sentRequests(fresh)).toHaveLength(1);
    // It spent 1500 of its 2000 ms on the killed worker: its deadline ping
    // comes 500 ms later, not a full 2000 ms later.
    jest.advanceTimersByTime(499);
    expect(fresh.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    jest.advanceTimersByTime(1);
    expect(fresh.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    // Overdue on the fresh worker too: it fails with it this time.
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    await expect(bystander.promise).rejects.toThrow(/still running/);
    await flush();
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test.each(['never ready', 'ready after expiry'])(
    'a resent bystander settles at its deadline when the replacement is %s',
    async (readiness) => {
      const client = host.createClient(CONFIG);
      const stuck = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
      jest.advanceTimersByTime(1500);
      const bystander = await startRequest(client, { method: 'eth_chainId' }, { deadlineMs: 2000 });
      jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
      await expect(stuck.promise).rejects.toThrow(/still running/);
      await flush();
      const fresh = lastWorker();
      const settled = jest.fn();
      bystander.promise.then(settled, settled);

      await jest.advanceTimersByTimeAsync(499);
      expect(settled).not.toHaveBeenCalled();
      expect(sentRequests(fresh)).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      await expect(bystander.promise).rejects.toMatchObject({
        name: 'ColibriWorkerError',
        message: expect.stringMatching(/deadline expired/),
        colibriBystander: true,
      });
      if (readiness === 'ready after expiry') {
        fresh.emit('message', { type: 'ready' });
        await flush();
      }
      expect(sentRequests(fresh)).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test('replacement readiness cannot post after expiry before its timer callback runs', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(client, { method: 'eth_chainId' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    await expect(stuck.promise).rejects.toThrow(/still running/);
    await flush();
    const fresh = lastWorker();
    // Advance the wall clock without running timers, then deliver readiness.
    jest.setSystemTime(Date.now() + 500);
    fresh.emit('message', { type: 'ready' });
    await expect(bystander.promise).rejects.toHaveProperty('colibriBystander', true);
    expect(sentRequests(fresh)).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('initial worker startup still starts the budget at first readiness', async () => {
    const client = host.createClient(CONFIG);
    const promise = client.request({ method: 'eth_chainId' }, { deadlineMs: 1000 });
    const settled = jest.fn();
    promise.then(settled, settled);
    await flush();
    jest.advanceTimersByTime(5000);
    expect(settled).not.toHaveBeenCalled();
    const worker = lastWorker();
    worker.emit('message', { type: 'ready' });
    await flush();
    const [posted] = sentRequests(worker);
    worker.emit('message', { type: 'result', id: posted.id, ok: true, result: '0x1' });
    await expect(promise).resolves.toBe('0x1');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a stuck-worker kill does not resend a destroyed client’s request', async () => {
    const stuck = await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    const other = host.createClient(CONFIG);
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(other, { method: 'eth_chainId' }, { deadlineMs: 2000 });
    other.destroy();
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    await expect(stuck.promise).rejects.toThrow(/still running/);
    await expect(bystander.promise).rejects.toThrow(/Colibri worker replaced/);
    await expect(bystander.promise).rejects.toHaveProperty('colibriBystander', true);
    await flush();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  // The router's per-method fault backoff skips an error marked this way: an
  // eth_call that only queued behind an unknown-hash lookup did not fault.
  test('a bystander already past its own deadline fails, marked as a bystander', async () => {
    const client = host.createClient(CONFIG);
    const stuck = await startRequest(client, { method: 'eth_getTransactionReceipt' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const overdue = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 1000 });
    // Its own deadline (2500) passes; the stuck request's probe (3000) kills
    // the worker before its own (3500) would.
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    expect(stuck.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(stuck.promise).rejects.toHaveProperty('colibriBystander', true);
    await expect(overdue.promise).rejects.toThrow(/Colibri worker replaced/);
    await expect(overdue.promise).rejects.toHaveProperty('colibriBystander', true);
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '2 request(s) failed'
    );
  });

  test('a stuck worker with one request on it blames that request', async () => {
    const { promise } =
      await startRequest(host.createClient(CONFIG), { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000 + host.STUCK_PROBE_MS);
    await expect(promise).rejects.toThrow(/verification still running/);
    await expect(promise).rejects.not.toHaveProperty('colibriBystander');
  });

  // R2-M1: a receipt lookup with the configured timeout spins the verifier; a
  // page eth_call's shorter deadline fires first. eth_call must not be blamed,
  // and the receipt lookup, resent, is blamed once it spins alone.
  test('the request whose deadline fires first is not blamed for another one spinning', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt' }, { deadlineMs: 5000 });
    const call = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    expect(call.worker).toBe(spinner.worker);
    jest.advanceTimersByTime(2000 + host.STUCK_PROBE_MS);
    expect(spinner.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(call.promise).rejects.toThrow(/verification still running/);
    await expect(call.promise).rejects.toHaveProperty('colibriBystander', true);

    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_getTransactionReceipt' });
    // Spins again, alone this time: now it is the known culprit.
    jest.advanceTimersByTime(2000 + host.STUCK_PROBE_MS);
    await expect(spinner.promise).rejects.toThrow(/verification still running/);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
  });

  // R3-M1: a dApp polling a pending-tx receipt every second queues its next
  // poll behind the spinning lookup during the 1s probe. That poll was posted
  // after the ping, so it never reached the stuck worker: the spinner is still
  // the only suspect, is blamed (counts toward the router's fault backoff),
  // and the poll is resent.
  test('a request posted after the liveness ping is not a suspect', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] },
      { deadlineMs: 2000 });
    jest.advanceTimersByTime(2000);
    expect(spinner.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    jest.advanceTimersByTime(500);
    const poll = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] },
      { deadlineMs: 2000 });
    expect(poll.worker).toBe(spinner.worker);
    jest.advanceTimersByTime(host.STUCK_PROBE_MS - 500);
    expect(spinner.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(spinner.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );

    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(spinner.worker);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: null });
    await expect(poll.promise).resolves.toBeNull();
  });

  // R4-M1: the same dApp poll, but posted a second after the spinner and so
  // before the ping (1s poll, 2s deadline). Both are suspects; they share a
  // method, and the router's fault backoff is per method, so the deadline
  // holder is blamed. The poll, out of deadline as the probe expires, fails
  // as a bystander: exactly one fault is counted.
  test('suspects of a single method are attributed to it', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 2000 });
    jest.advanceTimersByTime(1000);
    const poll = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 2000 });
    expect(poll.worker).toBe(spinner.worker);
    jest.advanceTimersByTime(1000);
    expect(spinner.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(spinner.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(spinner.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
    await expect(poll.promise).rejects.toHaveProperty('colibriBystander', true);
  });

  test('of single-method suspects with deadline left, only the blamed one is not resent', async () => {
    const client = host.createClient(CONFIG);
    const spinner = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 2000 });
    jest.advanceTimersByTime(1000);
    const poll = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpending'] },
      { deadlineMs: 5000 });
    jest.advanceTimersByTime(1000 + host.STUCK_PROBE_MS);
    await expect(spinner.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );
    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_getTransactionReceipt', params: ['0xpending'] });
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: null });
    await expect(poll.promise).resolves.toBeNull();
  });

  // R5-M1: of single-method suspects, the deadline holder is blamed even when
  // it is not the oldest. A page's 2s receipt lookup lands behind a wallet
  // waitForTransaction lookup running on the configured timeout: the page's
  // overdue request is blamed, the wallet's older one (deadline left) resent.
  test('of single-method suspects, the deadline holder is blamed, not the oldest', async () => {
    const client = host.createClient(CONFIG);
    const wallet = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xwallet'] },
      { deadlineMs: 10_000 });
    jest.advanceTimersByTime(500);
    const page = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xpage'] },
      { deadlineMs: 2000 });
    expect(page.worker).toBe(wallet.worker);
    jest.advanceTimersByTime(2000);
    expect(wallet.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(wallet.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(page.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(page.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed, 1 sent to the new worker'
    );
    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(wallet.worker);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const sent = sentRequests(fresh);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'eth_getTransactionReceipt', params: ['0xwallet'] });
    fresh.emit('message', { type: 'result', id: sent[0].id, ok: true, result: null });
    await expect(wallet.promise).resolves.toBeNull();
  });

  // R4-M2: the deadline holder settles during the probe, so the worker then
  // blocked in the one other suspect. That one is blamed and, although it has
  // deadline left, failed rather than resent: it would spin again.
  test('a suspect blamed for a stuck worker is failed, not resent', async () => {
    const client = host.createClient(CONFIG);
    const holder = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1000);
    const blocker = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] },
      { deadlineMs: 5000 });
    jest.advanceTimersByTime(1000);
    expect(holder.worker.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    holder.worker.emit('message', { type: 'result', id: holder.id, ok: true, result: '0x2' });
    await expect(holder.promise).resolves.toBe('0x2');
    jest.advanceTimersByTime(host.STUCK_PROBE_MS);
    expect(holder.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(blocker.promise).rejects.toThrow(/verification still running after its deadline/);
    await expect(blocker.promise).rejects.not.toHaveProperty('colibriBystander');
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 worker replaced (verification still running after its deadline); ' +
      '1 request(s) failed'
    );
    await flush();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  test('a worker replaced with no culprit marks nobody as a bystander', async () => {
    const client = host.createClient(CONFIG);
    const a = await startRequest(client, { method: 'eth_call' });
    const b = await startRequest(client, { method: 'eth_chainId' });
    a.worker.emit('exit', 1);
    await expect(a.promise).rejects.not.toHaveProperty('colibriBystander');
    await expect(b.promise).rejects.not.toHaveProperty('colibriBystander');
  });

  test('after a trap, a request the retired instance refused is retried once on a fresh worker', async () => {
    const client = host.createClient(CONFIG);
    const a = await startRequest(client, { method: 'eth_getTransactionReceipt', params: ['0xunknown'] });
    const b = await startRequest(client, { method: 'eth_blockNumber' });
    const trapped = a.worker;
    trapped.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    // The trapping request itself fails: asking again would trap again.
    trapped.emit('message', {
      type: 'result', id: a.id, ok: false,
      error: { name: 'ProviderRpcError', message: 'memory access out of bounds', code: -32603 },
    });
    await expect(a.promise).rejects.toThrow(/memory access out of bounds/);
    await expect(a.promise).rejects.not.toHaveProperty('colibriBystander');
    const refused = {
      name: 'ProviderRpcError',
      message: 'Colibri WASM runtime was retired after a trap; refusing execute()',
    };
    trapped.emit('message', { type: 'result', id: b.id, ok: false, error: refused, retry: true });
    expect(trapped.terminate).toHaveBeenCalledTimes(1);
    await flush();
    const fresh = lastWorker();
    expect(fresh).not.toBe(trapped);
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_blockNumber' });

    // Refused again on the fresh worker: no second retry.
    fresh.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    fresh.emit('message', { type: 'result', id: resent.id, ok: false, error: refused, retry: true });
    await expect(b.promise).rejects.toThrow(/retired after a trap/);
    await expect(b.promise).rejects.toHaveProperty('colibriBystander', true);
    await flush();
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('a worker that exits fails its requests instead of leaving them pending', async () => {
    const { promise, worker } = await startRequest(host.createClient(CONFIG), { method: 'eth_call' });
    worker.emit('error', new Error('Worker terminated due to reaching memory limit'));
    await expect(promise).rejects.toThrow(/memory limit/);
    worker.emit('exit', 1);
  });

  test('an init failure rejects waiting callers and the next call respawns', async () => {
    const client = host.createClient(CONFIG);
    const promise = client.request({ method: 'eth_call' });
    promise.catch(() => {});
    await flush();
    lastWorker().emit('message', { type: 'init-error', error: { message: 'EACCES' } });
    await expect(promise).rejects.toThrow(/failed to start: init failed \(EACCES\)/);
    host.ensureWorker(1).catch(() => {});
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('destroy tells every worker the client used to drop it', async () => {
    const client = host.createClient(CONFIG);
    const { worker, id } = await startRequest(client, { method: 'eth_chainId' });
    worker.emit('message', { type: 'result', id, ok: true, result: '0x1' });
    client.destroy();
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'destroy', clientId: sentRequests(worker)[0].clientId,
    });
    await expect(client.request({ method: 'eth_chainId' })).rejects.toThrow(/destroyed/);
  });
});

// The worker has no network of its own: the verifier's requests come back as
// 'fetch' messages and are dialled here, on the session the client was made
// for, through the (injected) gateway transport.
describe('colibri worker host network bridge', () => {
  const { retireBrowsingSession } = require('../browsing-transport');
  const URL_OK = 'https://p.example/proof';
  let transport;
  let nextFid;
  let session;

  const okTransport = (body = '{"result":"0x2a"}', init = {}) =>
    jest.fn(async () => new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', ...init.headers },
    }));

  // Settles when the transport is aborted, the way gatewayFetch does.
  const hangingTransport = () => jest.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    });
  }));

  function useTransport(fn) {
    transport = fn;
    host.resetForTest({ storageDir: STORAGE_DIR, transport: (...args) => transport(...args) });
  }

  // What the worker posts for one verifier request (colibri-worker.js).
  function askToFetch(worker, clientId, overrides = {}) {
    const fid = nextFid++;
    worker.emit('message', {
      type: 'fetch',
      fid,
      clientId,
      url: URL_OK,
      method: 'POST',
      headers: [['accept', 'application/json'], ['content-type', 'application/json']],
      body: '{"id":1}',
      ...overrides,
    });
    return fid;
  }

  function replies(worker, fid) {
    return worker.postMessage.mock.calls.filter(
      ([message]) => message.type === 'fetch-result' && message.fid === fid
    );
  }

  async function replyTo(worker, fid) {
    for (let i = 0; i < 100 && replies(worker, fid).length === 0; i += 1) {
      await Promise.resolve();
    }
    return replies(worker, fid)[0];
  }

  // A client with one request in flight on its chain's ready worker.
  async function clientOnWorker(options = {}) {
    const client = host.createClient({ ...CONFIG, session, ...options });
    const started = await startRequest(client, { method: 'eth_blockNumber' });
    const { clientId } = sentRequests(started.worker).at(-1);
    return { client, clientId, ...started };
  }

  const REFUSED = {
    type: 'fetch-result', fid: expect.any(Number), ok: false,
    error: { name: 'TypeError', message: 'Colibri network request refused' },
  };

  beforeEach(() => {
    nextFid = 1;
    session = { id: `private-${Math.random()}` };
    useTransport(okTransport());
  });

  test("dials on the client's session with redirects refused and only the verifier's headers", async () => {
    const { worker, clientId } = await clientOnWorker();
    const fid = askToFetch(worker, clientId, {
      headers: [['accept', 'application/json'], ['x-extra', 'dropped'], ['content-type', 'application/json']],
    });
    const [reply, transfer] = await replyTo(worker, fid);

    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init, deps] = transport.mock.calls[0];
    expect(url).toBe(URL_OK);
    expect(init).toEqual({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"id":1}',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(deps.session).toBe(session);

    expect(reply).toEqual({
      type: 'fetch-result', fid, ok: true, status: 200, statusText: 'OK',
      headers: [['content-type', 'application/json']],
      body: expect.any(ArrayBuffer),
    });
    // The bytes move to the worker rather than being copied.
    expect(transfer).toEqual([reply.body]);
    expect(new TextDecoder().decode(reply.body)).toBe('{"result":"0x2a"}');
  });

  test('drops the encoding headers that describe bytes Chromium already decoded', async () => {
    useTransport(okTransport('{}', { headers: { 'content-encoding': 'gzip', 'content-length': '2' } }));
    const { worker, clientId } = await clientOnWorker();
    const [reply] = await replyTo(worker, askToFetch(worker, clientId));
    expect(reply.headers).toEqual([['content-type', 'application/json']]);
  });

  test.each([
    ['plain http to a remote host', { url: 'http://p.example/proof' }],
    ['user-info in the URL', { url: 'https://user:secret@p.example/proof' }],
    ['a URL that does not parse', { url: 'not a url' }],
    ['a method the verifier never uses', { method: 'PUT' }],
    ['a GET with a body', { method: 'GET' }],
    ['a body that is not a string', { body: 42 }],
    ['malformed headers', { headers: [['accept']] }],
    ['a body over the cap', { body: 'x'.repeat(1024 * 1024 + 1) }],
  ])('refuses %s without dialling, and names no URL', async (_label, overrides) => {
    const { worker, clientId } = await clientOnWorker();
    const fid = askToFetch(worker, clientId, overrides);
    const [reply] = await replyTo(worker, fid);
    expect(reply).toEqual({ ...REFUSED, fid });
    expect(JSON.stringify(reply)).not.toContain('p.example');
    expect(transport).not.toHaveBeenCalled();
  });

  test('plain http to a loopback node is dialled (gatewayFetch keeps it on Node fetch)', async () => {
    const { worker, clientId } = await clientOnWorker();
    const [reply] = await replyTo(worker, askToFetch(worker, clientId, { url: 'http://127.0.0.1:8545/' }));
    expect(reply).toMatchObject({ ok: true, status: 200 });
    expect(transport.mock.calls[0][0]).toBe('http://127.0.0.1:8545/');
  });

  test('a body of exactly the cap is dialled', async () => {
    const { worker, clientId } = await clientOnWorker();
    const body = 'x'.repeat(host.MAX_BRIDGE_REQUEST_BYTES);
    await replyTo(worker, askToFetch(worker, clientId, { body }));
    expect(transport.mock.calls[0][1].body).toBe(body);
  });

  test('refuses a client it does not know, a destroyed one, and one without a session', async () => {
    const { client, worker, clientId } = await clientOnWorker();
    expect(await replyTo(worker, askToFetch(worker, clientId + 1000))).toEqual([
      expect.objectContaining({ ok: false }),
      undefined,
    ]);

    // A client without a session runs on the default session's worker.
    const sessionless = await startRequest(host.createClient(CONFIG), { method: 'eth_chainId' });
    expect(sessionless.worker).not.toBe(worker);
    const sessionlessId = sentRequests(sessionless.worker).at(-1).clientId;
    expect((await replyTo(sessionless.worker, askToFetch(sessionless.worker, sessionlessId)))[0])
      .toMatchObject({ ok: false });

    client.destroy();
    expect((await replyTo(worker, askToFetch(worker, clientId)))[0]).toMatchObject({ ok: false });
    expect(transport).not.toHaveBeenCalled();
  });

  test('refuses a fetch for a client that has never been on that worker', async () => {
    const { worker: chainOneWorker, clientId } = await clientOnWorker();
    // The same client id, asked for by another chain's worker.
    const other = await startRequest(host.createClient({ ...CONFIG, chainId: 100, session }),
      { method: 'eth_chainId' });
    expect(other.worker).not.toBe(chainOneWorker);
    const [reply] = await replyTo(other.worker, askToFetch(other.worker, clientId));
    expect(reply).toMatchObject({ ok: false });
    expect(transport).not.toHaveBeenCalled();
  });

  test('serves a retiring worker\'s draining requests, and posts nothing to a terminated one', async () => {
    const { worker, clientId } = await clientOnWorker();
    worker.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    expect((await replyTo(worker, askToFetch(worker, clientId)))[0]).toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][2]).toEqual({ session });

    worker.emit('exit', 1);
    const fid = askToFetch(worker, clientId);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(replies(worker, fid)).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test("refuses, and aborts in flight, a retired session's fetches; others carry on", async () => {
    useTransport(hangingTransport());
    const { worker, clientId } = await clientOnWorker();
    const otherSession = { id: 'other' };
    const other = await clientOnWorker({ session: otherSession });
    const inFlight = askToFetch(worker, clientId);
    const otherFlight = askToFetch(other.worker, other.clientId);
    await Promise.resolve();
    const signals = transport.mock.calls.map(([, init]) => init.signal);

    retireBrowsingSession(session);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect((await replyTo(worker, inFlight))[0]).toMatchObject({
      ok: false, error: { message: 'Colibri network request failed' },
    });
    expect(replies(other.worker, otherFlight)).toEqual([]);

    const [refused] = await replyTo(worker, askToFetch(worker, clientId));
    expect(refused).toMatchObject({ ok: false, error: { message: 'Colibri network request refused' } });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('refuses an answer declared over the cap before reading it', async () => {
    let signal;
    useTransport(jest.fn(async (_url, init) => {
      signal = init.signal;
      return new Response('{}', {
        status: 200,
        headers: { 'content-length': String(host.MAX_BRIDGE_RESPONSE_BYTES + 1) },
      });
    }));
    const { worker, clientId } = await clientOnWorker();
    const [reply] = await replyTo(worker, askToFetch(worker, clientId));
    expect(reply).toMatchObject({ ok: false, error: { message: 'Colibri network request failed' } });
    expect(signal.aborted).toBe(true);
  });

  test('cuts off an answer that streams past the cap', async () => {
    const MIB = new Uint8Array(1024 * 1024);
    let pulled = 0;
    let signal;
    useTransport(jest.fn(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        pull(controller) {
          pulled += 1;
          if (pulled > 64) controller.close();
          else controller.enqueue(MIB);
        },
      }), { status: 200 });
    }));
    const { worker, clientId } = await clientOnWorker();
    const fid = askToFetch(worker, clientId);
    for (let i = 0; i < 2000 && replies(worker, fid).length === 0; i += 1) await Promise.resolve();
    expect(replies(worker, fid)[0][0]).toMatchObject({ ok: false });
    expect(signal.aborted).toBe(true);
    expect(pulled).toBeLessThanOrEqual(host.MAX_BRIDGE_RESPONSE_BYTES / MIB.byteLength + 2);
  });

  test('aborts a destroyed client’s fetches in flight', async () => {
    useTransport(hangingTransport());
    const { client, worker, clientId } = await clientOnWorker();
    askToFetch(worker, clientId);
    await Promise.resolve();
    client.destroy();
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test('aborts the fetches of a replaced worker', async () => {
    useTransport(hangingTransport());
    const { worker, clientId } = await clientOnWorker();
    askToFetch(worker, clientId);
    await Promise.resolve();
    worker.emit('error', new Error('Worker terminated due to reaching memory limit'));
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test('aborts the fetches of a retired worker when it terminates, not before', async () => {
    useTransport(hangingTransport());
    const { worker, clientId, id } = await clientOnWorker();
    askToFetch(worker, clientId);
    await Promise.resolve();
    const { signal } = transport.mock.calls[0][1];
    worker.emit('message', { type: 'trap', message: 'memory access out of bounds' });
    expect(signal.aborted).toBe(false);
    worker.emit('message', { type: 'result', id, ok: true, result: '0x1' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });

  test('shutdown aborts everything in flight and takes nothing new', async () => {
    useTransport(hangingTransport());
    const { worker, clientId } = await clientOnWorker();
    askToFetch(worker, clientId);
    await Promise.resolve();
    host.shutdown();
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    const [reply] = await replyTo(worker, askToFetch(worker, clientId));
    expect(reply).toMatchObject({ ok: false, error: { message: 'Colibri network request refused' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  // The verifier's state records which names were resolved (STORAGE).
  test('each session gets a worker of its own per chain; only the default one stores on disk', async () => {
    const storageOf = (worker) => Worker.mock.calls[spawned.indexOf(worker)][1].workerData.storageDir;
    const normal = await startRequest(host.createClient(CONFIG), { method: 'eth_chainId' });
    const mine = await clientOnWorker();
    const again = await startRequest(host.createClient({ ...CONFIG, session }), { method: 'eth_chainId' });
    const other = await clientOnWorker({ session: { id: 'other' } });
    const otherChain = await clientOnWorker({ chainId: 100 });

    expect(storageOf(normal.worker)).toBe(STORAGE_DIR);
    expect(mine.worker).not.toBe(normal.worker);
    expect(again.worker).toBe(mine.worker);
    expect(other.worker).not.toBe(mine.worker);
    expect(otherChain.worker).not.toBe(mine.worker);
    for (const { worker } of [mine, other, otherChain]) expect(storageOf(worker)).toBeNull();
    expect(Worker).toHaveBeenCalledTimes(4);
  });

  test("a retired session's worker terminates once drained and is never respawned", async () => {
    const { client, worker, id, promise } = await clientOnWorker();
    const normal = await startRequest(host.createClient(CONFIG), { method: 'eth_chainId' });

    retireBrowsingSession(session);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', { type: 'result', id, ok: false, error: { message: 'fetch failed' } });
    await expect(promise).rejects.toThrow('fetch failed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(normal.worker.terminate).not.toHaveBeenCalled();

    await expect(client.request({ method: 'eth_chainId' })).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await expect(host.ensureWorker(1, session)).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  test('a request waiting for a retired session’s worker to start is refused', async () => {
    const client = host.createClient({ ...CONFIG, session });
    const promise = client.request({ method: 'eth_chainId' });
    promise.catch(() => {});
    await flush();
    const worker = lastWorker();

    retireBrowsingSession(session);
    await expect(promise).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.emit('message', { type: 'ready' });
    await flush();
    expect(sentRequests(worker)).toEqual([]);
  });

  test('a bystander resent to a fresh worker keeps its deadline and its session', async () => {
    const client = host.createClient({ ...CONFIG, session });
    const stuck = await startRequest(client, { method: 'eth_call' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(1500);
    const bystander = await startRequest(client, { method: 'eth_chainId' }, { deadlineMs: 2000 });
    jest.advanceTimersByTime(500 + host.STUCK_PROBE_MS);
    await expect(stuck.promise).rejects.toThrow(/still running/);
    await flush();
    const fresh = lastWorker();
    fresh.emit('message', { type: 'ready' });
    await flush();
    const [resent] = sentRequests(fresh);
    expect(resent).toMatchObject({ method: 'eth_chainId' });

    const [reply] = await replyTo(fresh, askToFetch(fresh, resent.clientId));
    expect(reply).toMatchObject({ ok: true });
    expect(transport.mock.calls[0][2].session).toBe(session);

    // Its deadline ping comes 500 ms in, what it had left, not 2000 ms in.
    jest.advanceTimersByTime(499);
    expect(fresh.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(false);
    jest.advanceTimersByTime(1);
    expect(fresh.postMessage.mock.calls.some(([m]) => m.type === 'ping')).toBe(true);
    fresh.emit('message', { type: 'result', id: resent.id, ok: true, result: '0x1' });
    await expect(bystander.promise).resolves.toBe('0x1');
  });
});
