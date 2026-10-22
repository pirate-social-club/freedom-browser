jest.mock('@playwright/test', () => ({ expect: (value) => expect(value) }), { virtual: true });

const { expectHttpCacheMiss } = require('./http-cache-evidence');

const state = (keys = []) => ({
  activeWebContentsId: 12,
  contents: [{ id: 12, type: 'webview', sessionIndex: 0 }],
  caches: [{ sizeBytes: keys.length * 200, persistent: true, storagePath: '/scratch' }],
  snapshots: [{ exists: true, entries: keys.map((key) => ({ key })) }],
});

test('permits unrelated cache content while proving B absent', () => {
  expect(() => expectHttpCacheMiss(state(['1/0/https://example.test/dictionary']), 'ipfs://control-B', 'before B')).not.toThrow();
});

test.each(['before B', 'after B'])('rejects a cached B key %s without clearing it', (phase) => {
  expect(() => expectHttpCacheMiss(state(['1/0/ipfs://control-b/']), 'ipfs://control-B', phase)).toThrow();
});

test('also catches B in an HTTP gateway key', () => {
  expect(() => expectHttpCacheMiss(state(['1/0/https://example.test/ipfs/control-b']), 'ipfs://control-B', 'after B')).toThrow();
});

test('requires the actual active webview to be measured', () => {
  expect(() => expectHttpCacheMiss({ ...state(), activeWebContentsId: 13 }, 'bzz://control-B', 'before B')).toThrow('not measured');
});

test('requires a preserved snapshot for a persistent cache', () => {
  expect(() => expectHttpCacheMiss({ ...state(), snapshots: [] }, 'bzz://control-B', 'before B')).toThrow();
});

test('requires an in-memory cache to be empty', () => {
  const memory = { ...state(), caches: [{ sizeBytes: 100, persistent: false }] };
  expect(() => expectHttpCacheMiss(memory, 'bzz://control-B', 'after B')).toThrow();
});
