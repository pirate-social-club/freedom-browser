const { EventEmitter } = require('events');
const { observeRendererHints } = require('./hns-renderer-hint-observer');

function fixture({ enabled = true, existing = '' } = {}) {
  const app = new EventEmitter();
  const switches = new Map([['blink-settings', existing]]);
  app.commandLine = { getSwitchValue: (name) => switches.get(name) || '',
    appendSwitch: (name, value) => switches.set(name, value) };
  let now = 100;
  const observation = observeRendererHints(app, { enabled, clock: () => now });
  const create = (id) => {
    const contents = Object.assign(new EventEmitter(), { id });
    app.emit('web-contents-created', {}, contents);
    return contents;
  };
  return { app, switches, observation, create, advance: (ms) => { now += ms; } };
}
const emit = (contents, name) => contents.emit('console-message', { message: 'DNS prefetch triggered for ' + name });

test('ordinary CI attaches no observer and changes no launch settings', () => {
  const f = fixture({ enabled: false, existing: 'dnsPrefetchingEnabled=false' });
  expect(f.app.listenerCount('web-contents-created')).toBe(0);
  expect(f.switches.get('blink-settings')).toBe('dnsPrefetchingEnabled=false');
  expect(f.observation.snapshot()).toEqual({ enabled: false, overflow: false, contentsIds: [], messages: [] });
});

test('logging preserves protected startup rather than enabling prefetching', () => {
  const f = fixture({ existing: 'dnsPrefetchingEnabled=false' });
  expect(f.switches.get('blink-settings')).toBe('dnsPrefetchingEnabled=false,logDnsPrefetchAndPreconnect=true');
  expect(fixture().switches.get('blink-settings')).toBe('logDnsPrefetchAndPreconnect=true');
});

test('records first and second-page native messages before guest attachment', () => {
  const f = fixture();
  const normal = f.create(1);
  emit(normal, 'header-default.hnsprobe');
  f.advance(12);
  const privateGuest = f.create(2);
  emit(privateGuest, 'html-private-r2.unlistedprobe');
  expect(f.observation.snapshot().messages).toEqual([
    { contentsId: 1, name: 'header-default.hnsprobe', ms: 0 },
    { contentsId: 2, name: 'html-private-r2.unlistedprobe', ms: 12 },
  ]);
});

test('retains only bounded synthetic names, excluding page text and arbitrary URLs', () => {
  const f = fixture();
  const contents = f.create(1);
  for (const message of [null, {}, { message: 1 }, { message: 'page log' },
    { message: 'DNS prefetch triggered for example.com' },
    { message: 'DNS prefetch triggered for header-default.hnsprobe\nextra' }]) contents.emit('console-message', message);
  expect(f.observation.snapshot().messages).toEqual([]);
});

test('message overflow is explicit and bounded', () => {
  const f = fixture();
  const contents = f.create(1);
  for (let index = 0; index < 65; index += 1) emit(contents, 'html-default.pirate');
  expect(f.observation.snapshot().messages).toHaveLength(64);
  expect(f.observation.snapshot().overflow).toBe(true);
});

test('contents overflow attaches no additional listener and is explicit', () => {
  const f = fixture();
  for (let id = 0; id < 16; id += 1) f.create(id);
  const excess = f.create(17);
  expect(excess.listenerCount('console-message')).toBe(0);
  expect(f.observation.snapshot().contentsIds).toHaveLength(16);
  expect(f.observation.snapshot().overflow).toBe(true);
});

test('snapshots cannot mutate the retained observation', () => {
  const f = fixture();
  emit(f.create(1), 'html-default.pirate');
  const snapshot = f.observation.snapshot();
  snapshot.contentsIds.push(99);
  snapshot.messages[0].name = 'changed';
  expect(f.observation.snapshot().contentsIds).toEqual([1]);
  expect(f.observation.snapshot().messages[0].name).toBe('html-default.pirate');
});
