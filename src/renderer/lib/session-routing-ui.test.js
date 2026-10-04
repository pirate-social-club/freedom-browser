const originalWindow = global.window;
const originalDocument = global.document;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const policy = (allowed, state = allowed ? 'ready' : 'quarantined') => ({ allowed, state, generation: 1 });
const value = (revision, ui = policy(true), guests = []) => ({ revision, ui, guests });

async function fixture() {
  jest.resetModules();
  const panel = { hidden: true, parentElement: { classList: { toggle: jest.fn() } } };
  const message = { textContent: '' };
  const pending = [];
  let push;
  global.document = { getElementById: (id) => id === 'routing-notice' ? panel : message };
  global.window = { electronAPI: {
    onRoutingStatusUpdate: jest.fn((callback) => { push = callback; }),
    getRoutingStatus: jest.fn(() => new Promise((resolve) => { pending.push(resolve); })),
  } };
  const mod = await import('./session-routing-ui.js');
  mod.initSessionRoutingUi();
  return { ...mod, panel, message, pending, push: (snapshot) => push(snapshot), api: global.window.electronAPI };
}

afterEach(() => { global.window = originalWindow; global.document = originalDocument; });

test('a late initial snapshot cannot hide a newer quarantine', async () => {
  const f = await fixture();
  expect(f.api.onRoutingStatusUpdate.mock.invocationCallOrder[0])
    .toBeLessThan(f.api.getRoutingStatus.mock.invocationCallOrder[0]);
  f.push(value(2, policy(false)));
  f.pending[0](value(1));
  await flush();
  expect(f.panel.hidden).toBe(false);
  expect(f.message.textContent).toContain('Requests remain blocked');
  expect(f.isSessionRoutingBlocked(null)).toBe(true);
  f.push(value(3));
  expect(f.panel.hidden).toBe(true);
});

test('switching tabs uses the actual active guest and stale replies cannot affect another tab', async () => {
  const f = await fixture();
  const a = { getWebContentsId: () => 11 };
  const b = { getWebContentsId: () => 12 };
  f.push(value(5, policy(true), [{ id: 11, ...policy(false) }, { id: 12, ...policy(true) }]));
  f.refreshSessionRoutingNotice(a);
  expect(f.panel.hidden).toBe(false);
  expect(f.isSessionRoutingBlocked(a)).toBe(true);
  f.refreshSessionRoutingNotice(b);
  expect(f.panel.hidden).toBe(true);
  f.pending[1](value(4, policy(false)));
  await flush();
  expect(f.panel.hidden).toBe(true);
  expect(f.isSessionRoutingBlocked(b)).toBe(false);
});

test('unknown guests stay covered, and malformed observations cannot dismiss quarantine', async () => {
  const f = await fixture();
  f.push(value(1));
  const guest = { getWebContentsId: () => 13 };
  f.refreshSessionRoutingNotice(guest);
  expect(f.panel.hidden).toBe(false);
  f.push(value(2, policy(false)));
  f.push(value(3, { allowed: 'true', generation: 2, state: 'ready' }));
  expect(f.panel.hidden).toBe(false);
  expect(f.panel.parentElement.classList.toggle).toHaveBeenLastCalledWith('routing-blocked', true);
  f.push(value(4, policy(true), [{ id: 13, ...policy(true) }]));
  expect(f.panel.hidden).toBe(true);
});

test('a pending update explains the temporary pause without claiming a failure', async () => {
  const f = await fixture();
  f.push(value(1, policy(false, 'updating')));
  expect(f.message.textContent).toContain('updating network protection');
  expect(f.message.textContent).not.toContain('Restart');
  expect(Object.keys(f.api).sort()).toEqual(['getRoutingStatus', 'onRoutingStatusUpdate']);
});
