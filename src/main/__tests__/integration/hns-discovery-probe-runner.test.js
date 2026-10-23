const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./hns-discovery-probe-runner');

describe('HNS probe process evidence', () => {
  let root;
  let child;
  let spawnImpl;
  let profile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-hns-evidence-test-'));
    child = Object.assign(new EventEmitter(), {
      pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(),
    });
    spawnImpl = jest.fn((_binary, _args, options) => {
      profile = options.env.FREEDOM_PROBE_USER_DATA;
      return child;
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
    profile = undefined;
  });
  const start = (options = {}) => runProbe({
    electronPath: '/fixture/electron', probePath: '/fixture/probe.js', timeoutMs: 90_000,
    evidenceRoot: root, spawnImpl, ...options,
  });
  const read = () => {
    const directory = path.join(root, fs.readdirSync(root)[0]);
    return {
      process: JSON.parse(fs.readFileSync(path.join(directory, 'process.json'), 'utf8')),
      stdout: fs.readFileSync(path.join(directory, 'stdout.log')),
      stderr: fs.readFileSync(path.join(directory, 'stderr.log')),
    };
  };

  test('retains exact bytes across chunk boundaries and the parsed result', async () => {
    const pending = start();
    const raw = Buffer.from('PROBE-START {}\nPROBE-RESULT {"value":"λ"}\n');
    const split = raw.indexOf(Buffer.from('λ')) + 1;
    child.stdout.emit('data', raw.subarray(0, split));
    child.stdout.emit('data', raw.subarray(split));
    child.stderr.emit('data', Buffer.from('synthetic diagnostic\n'));
    child.emit('close', 0, null);
    await expect(pending).resolves.toEqual({ value: 'λ' });
    const evidence = read();
    expect(evidence.stdout).toEqual(raw);
    expect(evidence.stderr.toString()).toBe('synthetic diagnostic\n');
    expect(evidence.process).toMatchObject({ mode: 'protected', pid: 123, closed: true,
      exitCode: 0, signal: null, timedOut: false, resultFound: true, stdoutBytes: raw.length });
    expect(evidence.process.wrapperVersions.node).toBe(process.versions.node);
    expect(fs.existsSync(profile)).toBe(false);
  });

  test('records a nonzero exit even when the original assertions can consume its JSON', async () => {
    const pending = start({ env: { FREEDOM_PROBE_WITHOUT_BLINK_SETTINGS: '1' } });
    child.stdout.emit('data', Buffer.from('PROBE-RESULT {"hintLookups":[]}\n'));
    child.emit('close', 7, null);
    await expect(pending).resolves.toEqual({ hintLookups: [] });
    expect(read().process).toMatchObject({ mode: 'control', exitCode: 7, closed: true });
    expect(spawnImpl.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBe('');
  });

  test.each([
    ['missing', 'PROBE-FAILED synthetic failure\n', 'no result'],
    ['malformed', 'PROBE-RESULT {broken}\n', 'invalid JSON'],
  ])('retains %s output before rejecting', async (_label, raw, error) => {
    const pending = start();
    child.stdout.emit('data', Buffer.from(raw));
    child.stderr.emit('data', Buffer.from('synthetic stderr'));
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow(error);
    expect(read().stdout.toString()).toBe(raw);
    expect(read().stderr.toString()).toBe('synthetic stderr');
    expect(read().process.exitCode).toBe(1);
    expect(Boolean(read().process.parseError)).toBe(error === 'invalid JSON');
  });

  test('retains timeout and late close evidence at the unchanged ninety-second bound', async () => {
    jest.useFakeTimers();
    const pending = start();
    const rejection = expect(pending).rejects.toThrow('90000ms');
    child.stdout.emit('data', Buffer.from('partial probe output'));
    jest.advanceTimersByTime(89_999);
    expect(child.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await rejection;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(read().process).toMatchObject({ timedOut: true, closed: false, elapsedMs: 90_000 });
    child.stderr.emit('data', Buffer.from('late child output'));
    child.emit('close', null, 'SIGKILL');
    expect(read().process).toMatchObject({ timedOut: true, closed: true, exitCode: null, signal: 'SIGKILL' });
    expect(read().stderr.toString()).toBe('late child output');
    expect(fs.existsSync(profile)).toBe(false);
  });

  test('retains an asynchronous spawn failure with no result or exit status', async () => {
    const pending = start();
    child.emit('error', new Error('synthetic spawn refusal'));
    await expect(pending).rejects.toThrow('synthetic spawn refusal');
    expect(read().process).toMatchObject({ spawnError: 'synthetic spawn refusal', closed: false,
      exitCode: null, resultFound: false });
    expect(fs.existsSync(profile)).toBe(false);
  });

  test('retains a synchronous spawn exception and removes its owned profile', async () => {
    spawnImpl.mockImplementation((_binary, _args, options) => {
      profile = options.env.FREEDOM_PROBE_USER_DATA;
      throw new Error('synthetic invalid spawn');
    });
    await expect(start()).rejects.toThrow('synthetic invalid spawn');
    expect(read().process.spawnError).toBe('synthetic invalid spawn');
    expect(fs.existsSync(profile)).toBe(false);
  });

  test('uses a different evidence directory for every invocation', async () => {
    let pending = start();
    child.stdout.emit('data', Buffer.from('PROBE-RESULT {}\n'));
    child.emit('close', 0, null);
    await pending;
    child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(),
    });
    pending = start();
    child.stdout.emit('data', Buffer.from('PROBE-RESULT {}\n'));
    child.emit('close', 0, null);
    await pending;
    expect(fs.readdirSync(root)).toHaveLength(2);
  });

  test('evidence capture failure cannot produce a passing probe result', async () => {
    const pending = start();
    const directory = path.join(root, fs.readdirSync(root)[0]);
    fs.mkdirSync(path.join(directory, 'stdout.log'));
    child.stdout.emit('data', Buffer.from('PROBE-RESULT {}\n'));
    child.emit('close', 0, null);
    await expect(pending).rejects.toThrow();
  });
});
