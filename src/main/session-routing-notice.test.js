const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionRoutingNoticeStore, showPreviousRoutingNotice } = require('./session-routing-notice');
const { createSessionRoutingTermination } = require('./session-routing-termination');

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('routing protection notice', () => {
  let directory;
  let store;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-routing-notice-'));
    store = createSessionRoutingNoticeStore(directory);
  });
  afterEach(() => jest.restoreAllMocks());

  test('constructing storage does not populate a profile before migration', () => {
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(store.read()).toBeNull();
  });

  test('a fresh store reads only a fixed reason and never error text or browsing data', () => {
    store.record('https://private.example/path?credential=secret');
    const bytes = fs.readFileSync(path.join(directory, 'session-routing-notice.json'), 'utf8');
    expect(bytes).not.toContain('private.example');
    expect(bytes).not.toContain('secret');
    expect(createSessionRoutingNoticeStore(directory).read()).toMatchObject({ version: 1, code: 'routing_failure' });
    expect(fs.statSync(path.join(directory, 'session-routing-notice.json')).mode & 0o777).toBe(0o600);
  });

  test.each(['invalid JSON', JSON.stringify({ version: 1, code: 'closeAllConnections_failed', id: 'bad' }), 'x'.repeat(1025)])(
    'ignores malformed or oversized markers', (bytes) => {
      fs.writeFileSync(path.join(directory, 'session-routing-notice.json'), bytes);
      expect(store.read()).toBeNull();
    });

  test('does not follow a marker symlink', () => {
    const target = path.join(directory, 'unrelated');
    fs.writeFileSync(target, 'sensitive');
    fs.symlinkSync(target, path.join(directory, 'session-routing-notice.json'));
    expect(store.read()).toBeNull();
  });

  test('the read remains bounded if the file grew after metadata was checked', () => {
    store.record('pac_resource_failed');
    const filename = path.join(directory, 'session-routing-notice.json');
    fs.appendFileSync(filename, ' '.repeat(2048));
    jest.spyOn(fs, 'fstatSync').mockReturnValue({ size: 100, isFile: () => true });
    expect(store.read()).toBeNull();
  });

  test('acknowledging an older identical reason cannot erase a newer event', () => {
    store.record('guard_resource_failed');
    const older = store.read();
    store.record('guard_resource_failed');
    const newer = store.read();
    store.acknowledge(older);
    expect(store.read()).toEqual(newer);
    store.acknowledge(newer);
    expect(store.read()).toBeNull();
  });

  test('startup waits for acknowledgment before routing can repeat the previous failure', async () => {
    store.record('pac_resource_failed');
    let acknowledge;
    const dialog = { showMessageBox: jest.fn(() => new Promise((resolve) => { acknowledge = resolve; })) };
    const nextStartup = jest.fn();
    const startup = showPreviousRoutingNotice(store, dialog).then(nextStartup);
    await flush();
    expect(nextStartup).not.toHaveBeenCalled();
    expect(store.read()).not.toBeNull();
    expect(dialog.showMessageBox.mock.calls[0][0].detail).toContain('routing service stopped');
    acknowledge({ response: 0 });
    await startup;
    expect(store.read()).toBeNull();
    expect(nextStartup).toHaveBeenCalledTimes(1);
  });

  test('failed dialog retains the marker for another launch', async () => {
    store.record('guard_drain_failed');
    await showPreviousRoutingNotice(store, { showMessageBox: () => Promise.reject(new Error('dialog')) });
    expect(store.read()).not.toBeNull();
  });

  test('disk failure cannot veto exit, and logger failure cannot skip the marker', () => {
    const app = { exit: jest.fn() };
    const log = { error: jest.fn(() => { throw new Error('logger'); }) };
    const terminate = createSessionRoutingTermination({ app, log, markQuitting: jest.fn(), recordNotice: store.record });
    terminate('guard_resource_failed');
    expect(store.read().code).toBe('guard_resource_failed');
    expect(app.exit).toHaveBeenCalledWith(70);
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk'); });
    createSessionRoutingTermination({ app, log, markQuitting: jest.fn(), recordNotice: store.record })('guard_drain_failed');
    expect(write).toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledTimes(2);
  });
});
