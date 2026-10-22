jest.mock('@playwright/test', () => ({ expect: (value) => expect(value) }), { virtual: true });

const { expectEmptyHttpCache } = require('./http-cache-evidence');

const state = (sizeBytes) => ({
  activeWebContentsId: 12,
  contents: [{ id: 12, type: 'webview', sessionIndex: 0 }],
  caches: [{ sizeBytes }],
});

test('accepts a measured empty cache', () => {
  expect(() => expectEmptyHttpCache(state(0), 'ipfs://control-B', 'before B')).not.toThrow();
});

test.each(['before B', 'after B'])('rejects cached content %s instead of making the control cold', (phase) => {
  expect(() => expectEmptyHttpCache(state(200), 'ipfs://control-B', phase)).toThrow();
});

test('requires the actual active webview to be included in the measurement', () => {
  const wrongGuest = { ...state(0), activeWebContentsId: 13 };
  expect(() => expectEmptyHttpCache(wrongGuest, 'bzz://control-B', 'before B')).toThrow('not measured');
});

test('rejects a second session with cached content too', () => {
  const otherSession = state(0);
  otherSession.caches.push({ sizeBytes: 100 });
  expect(() => expectEmptyHttpCache(otherSession, 'bzz://control-B', 'after B')).toThrow();
});
