const { createHnsNativeCustody, parseProcessStat } = require('./hns-native-custody');

function processStat(pid, parent, group, start = '100', state = 'S', threads = 1) {
  const fields = [state, parent, group, ...Array(14).fill(0), threads, 0, start];
  return `${pid} (a process ) name) ${fields.join(' ')}\n`;
}

function fixture({ receipt = processStat(22, 11, 22), live = processStat(22, 11, 22) } = {}) {
  let time = 0;
  let process = live;
  const readFile = jest.fn((path) => {
    if (path === '/receipt') {
      if (receipt === null) throw Object.assign(new Error(), { code: 'ENOENT' });
      return receipt;
    }
    if (path === '/proc/11/stat') return processStat(11, 1, 10, '90');
    if (!process) throw Object.assign(new Error(), { code: 'ENOENT' });
    return process;
  });
  const signal = jest.fn(() => { process = processStat(22, 1, 22, '100', 'Z'); });
  const writeFile = jest.fn();
  const custody = createHnsNativeCustody('/receipt', { journalPath: '/journal', readFile, writeFile,
    stat: () => ({ uid: 1000 }), uid: 1000, signal, clock: () => time,
    pause: async (ms) => { time += ms; } });
  custody.prepare(); custody.bindParent(11);
  return { custody, signal, writeFile, setLive: (value) => { process = value; } };
}

test('parses start identity after the last parenthesis, preserving large ticks as a string', () => {
  expect(parseProcessStat(processStat(22, 11, 22, '99999999999999999999'))).toMatchObject({
    pid: 22, parent: 11, group: 22, threads: 1, start: '99999999999999999999',
  });
});

test('reconciles the exact native group and records completion only after native exit', async () => {
  const { custody, signal, writeFile } = fixture();
  await custody.capture(); await custody.terminate();
  expect(signal).toHaveBeenCalledWith(-22, 'SIGKILL');
  expect(JSON.parse(writeFile.mock.calls.at(-1)[1]).status).toBe('closed');
});

test('retains established ownership across reparenting', async () => {
  const { custody, signal, setLive } = fixture();
  await custody.capture(); setLive(processStat(22, 1, 22)); await custody.terminate();
  expect(signal).toHaveBeenCalledTimes(1);
});

test('a reused PID is never signalled after the original identity was captured', async () => {
  const { custody, signal, setLive } = fixture();
  await custody.capture(); setLive(processStat(22, 1, 22, '200')); await custody.terminate();
  expect(signal).not.toHaveBeenCalled();
});

test.each([null, '', processStat(22, 99, 22), processStat(22, 11, 99)])('missing, partial or mismatched receipt stays pending: %s', async (receipt) => {
  const { custody, signal, writeFile } = fixture({ receipt });
  await expect(custody.terminate()).rejects.toThrow();
  expect(signal).not.toHaveBeenCalled();
  expect(writeFile.mock.calls.every((call) => JSON.parse(call[1]).status === 'pending')).toBe(true);
});

test('a zombie leader with remaining threads cannot close the generation', async () => {
  const { custody, signal, setLive } = fixture();
  await custody.capture(); setLive(processStat(22, 1, 22, '100', 'Z', 2));
  signal.mockImplementation(() => {});
  await expect(custody.terminate()).rejects.toThrow('did not stop');
});

test('a living original process that changed group remains unresolved', async () => {
  const { custody, signal, setLive, writeFile } = fixture();
  await custody.capture(); setLive(processStat(22, 1, 33));
  await expect(custody.terminate()).rejects.toThrow('group changed');
  expect(signal).not.toHaveBeenCalled();
  expect(JSON.parse(writeFile.mock.calls.at(-1)[1]).status).toBe('pending');
});
