const { createTunnelEventParser } = require('./hns-network-monitor');

test('tunnel events can be fragmented and unrelated account events are discarded', () => {
  const state = jest.fn(); const invalid = jest.fn();
  const consume = createTunnelEventParser(state, invalid);
  for (const part of ['Warning: You are not logged in to an account.\n', 'Warning: This device has been revoked.\n', '{"sta', 'te":"connected"}\n', '{"device":{"account_number":"private-value"}}\n',
    '{"state":"disconnected","details":{"locked_down":false}}\n']) consume(Buffer.from(part));
  expect(state.mock.calls).toEqual([[true], [true]]);
  expect(invalid).not.toHaveBeenCalled();
});

test.each(['connecting', 'disconnecting', 'error'])('unstable tunnel state %s withdraws authority', (value) => {
  const state = jest.fn();
  createTunnelEventParser(state, jest.fn())(Buffer.from(JSON.stringify({ state: value }) + '\n'));
  expect(state).toHaveBeenCalledWith(false);
});

test('locked-down disconnected state remains unavailable', () => {
  const state = jest.fn();
  createTunnelEventParser(state, jest.fn())(Buffer.from('{"state":"disconnected","details":{"locked_down":true}}\n'));
  expect(state).toHaveBeenCalledWith(false);
});

test('malformed or oversized tunnel records fail closed and never recover in that parser', () => {
  for (const bad of ['{"state":invalid}\n', '{"state":"connected","details":"' + 'x'.repeat(65536)]) {
    const state = jest.fn(); const invalid = jest.fn(); const consume = createTunnelEventParser(state, invalid);
    consume(Buffer.from(bad)); consume(Buffer.from('{"state":"connected"}\n'));
    expect(invalid).toHaveBeenCalledTimes(1); expect(state).not.toHaveBeenCalled();
  }
});
