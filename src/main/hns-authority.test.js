const { createHnsAuthority, METADATA_LEASE_MS, MAX_TIP_AGE_SECONDS } = require('./hns-authority');

function fixture() {
  let clock = 100;
  const onInvalid = jest.fn();
  const state = { synced: true, tipHash: 'a'.repeat(64), tipTime: 100000 };
  const authority = createHnsAuthority({ onInvalid, monotonic: () => clock, wallTime: () => 100000000 });
  return { authority, state, onInvalid, advance: (ms) => { clock += ms; } };
}

test('bootstrap requires all three fresh leases before publication', () => {
  const { authority, state } = fixture();
  expect(authority.publish()).toBe(false);
  authority.metadata(state); authority.transport();
  expect(authority.publish()).toBe(false);
  authority.validation(); expect(authority.publish()).toBe(true);
});

test('an admission detects expiry without a timer and never revives old authority', () => {
  const { authority, state, onInvalid, advance } = fixture();
  authority.metadata(state); authority.transport(); authority.validation(); authority.publish();
  advance(METADATA_LEASE_MS + 1);
  expect(authority.isValid()).toBe(false);
  expect(onInvalid).toHaveBeenCalledTimes(1);
  expect(authority.metadata(state)).toBe(false);
  expect(authority.transport()).toBe(false);
  expect(authority.publish()).toBe(false);
});

test.each([
  { synced: false }, { tipHash: 'bad' }, { tipTime: 100000 - MAX_TIP_AGE_SECONDS - 1 }, { tipTime: 100601 },
])('stale or invalid local chain state revokes an accepted generation: %j', (change) => {
  const { authority, state, onInvalid } = fixture();
  authority.metadata(state); authority.transport(); authority.validation(); authority.publish();
  expect(authority.metadata({ ...state, ...change })).toBe(false);
  expect(authority.isValid()).toBe(false);
  expect(onInvalid).toHaveBeenCalledTimes(1);
});

test('initial synchronization may progress without restarting the candidate', () => {
  const { authority, state, onInvalid } = fixture();
  expect(authority.metadata({ ...state, synced: false })).toBe(false);
  expect(onInvalid).not.toHaveBeenCalled();
  authority.metadata(state); authority.transport(); authority.validation();
  expect(authority.publish()).toBe(true);
});
