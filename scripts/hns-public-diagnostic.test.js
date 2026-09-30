jest.mock('fs');
jest.mock('./hns-packaged-smoke', () => ({ runSmoke: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runSmoke } = require('./hns-packaged-smoke');
const { main } = require('./hns-public-diagnostic');

describe('bounded public diagnostic', () => {
  const originalUnit = process.env.FREEDOM_DIAGNOSTIC_UNIT;
  const originalResources = process.env.FREEDOM_DIAGNOSTIC_RESOURCES;
  const originalExitCode = process.exitCode;
  let files;
  let output;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = 0;
    process.env.FREEDOM_DIAGNOSTIC_UNIT = 'diagnostic-fixture';
    process.env.FREEDOM_DIAGNOSTIC_RESOURCES = '/fixture/resources';
    files = {
      'cpu.max': '100000 100000',
      'memory.max': '536870912',
      'memory.swap.max': '0',
      'memory.peak': '123456',
      'memory.events': 'max 0\noom 0\noom_kill 0',
      'memory.swap.peak': '0',
    };
    fs.readFileSync.mockImplementation((name) => {
      if (name === '/proc/self/cgroup') return '0::/system.slice/diagnostic-fixture.service\n';
      if (name === '/proc/self/status') return 'Cpus_allowed_list:\t0\n';
      const key = path.basename(name);
      if (!(key in files)) throw new Error('Fixture receipt missing');
      return files[key];
    });
    jest.spyOn(os, 'getPriority').mockReturnValue(19);
    output = jest.spyOn(console, 'log').mockImplementation(() => {});
    runSmoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = originalExitCode;
    if (originalUnit === undefined) delete process.env.FREEDOM_DIAGNOSTIC_UNIT;
    else process.env.FREEDOM_DIAGNOSTIC_UNIT = originalUnit;
    if (originalResources === undefined) delete process.env.FREEDOM_DIAGNOSTIC_RESOURCES;
    else process.env.FREEDOM_DIAGNOSTIC_RESOURCES = originalResources;
  });

  test.each([
    ['cpu.max', '100001 100000'],
    ['cpu.max', 'max 100000'],
    ['cpu.max', '100000 0'],
    ['memory.max', '536870913'],
    ['memory.max', 'max'],
    ['memory.swap.max', '1'],
  ])('rejects unsafe %s=%s before starting the helper', async (key, value) => {
    files[key] = value;
    await expect(main()).rejects.toThrow('limits not enforced');
    expect(runSmoke).not.toHaveBeenCalled();
  });

  test('rejects a foreign cgroup before starting the helper', async () => {
    fs.readFileSync.mockReturnValue('0::/system.slice/another.service\n');
    await expect(main()).rejects.toThrow('cgroup mismatch');
    expect(runSmoke).not.toHaveBeenCalled();
  });

  test('runs only after resource preflight and retains both boundary receipts', async () => {
    await main();
    expect(runSmoke).toHaveBeenCalledWith({ resourcesDir: '/fixture/resources', timeoutMs: 240000 });
    const records = output.mock.calls.map(([line]) => JSON.parse(line));
    expect(records.map((entry) => entry.type)).toEqual([
      'effective-resource-preflight', 'resource-receipt', 'resource-receipt',
    ]);
    expect(process.exitCode).toBe(0);
  });

  test('fails without exposing a requested host or raw error stack', async () => {
    const privateMessage = 'private-fixture.invalid certificate and routing details';
    runSmoke.mockRejectedValue(new Error(privateMessage));
    await main();
    expect(process.exitCode).toBe(1);
    expect(output.mock.calls.flat().join('\n')).not.toContain(privateMessage);
    expect(output).toHaveBeenCalledWith('Required public-host diagnostic failed; inspect indexed categories above');
  });

  test('missing final resource accounting cannot turn into a pass', async () => {
    runSmoke.mockImplementation(async () => { delete files['memory.events']; });
    await main();
    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalledWith('Resource receipt unavailable');
  });

  test('an interrupted exercise stays failed even if its request later resolves', async () => {
    let complete;
    runSmoke.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const running = main();
    process.emit('SIGTERM');
    complete();
    await running;
    expect(process.exitCode).toBe(1);
  });

  test.each([
    ['inactive', 'dead', 0],
    ['failed', 'failed', 0],
    ['active', 'running', 1],
    ['inactive', 'failed', 1],
    ['failed', 'dead', 1],
  ])('workflow distinguishes stopped %s/%s from live or mixed states', (active, substate, expected) => {
    const workflow = jest.requireActual('fs').readFileSync(
      path.join(__dirname, '../.github/workflows/hns-public-diagnostic.yml'), 'utf8'
    );
    const functionSource = workflow.match(/ {10}stopped_state\(\) \{[\s\S]*?\n {10}\}/);
    expect(functionSource).not.toBeNull();
    const result = spawnSync('/bin/bash', ['-c', `${functionSource[0]}\nstopped_state`], {
      env: { ...process.env, status: `ActiveState=${active}\nSubState=${substate}\n` },
      encoding: 'utf8', timeout: 3000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(expected);
  });
});
