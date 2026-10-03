describe('profile-registry-watcher', () => {
  let fs;
  let watchProfileRegistry;
  let stopWatchingProfileRegistry;
  let watchCallback;
  let mockWatcher;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.doMock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    fs = require('fs');
    mockWatcher = { close: jest.fn(), on: jest.fn() };
    jest.spyOn(fs, 'watch').mockImplementation((_dir, cb) => {
      watchCallback = cb;
      return mockWatcher;
    });
    ({ watchProfileRegistry, stopWatchingProfileRegistry } = require('./profile-registry-watcher'));
  });

  afterEach(() => {
    stopWatchingProfileRegistry();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('watches the app root directory (survives atomic rename)', () => {
    watchProfileRegistry('/app/root', () => {});
    expect(fs.watch).toHaveBeenCalledWith('/app/root', expect.any(Function));
  });

  test('debounces and fires onChange once for registry-file changes', () => {
    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('rename', 'profile-registry.json');
    watchCallback('change', 'profile-registry.json');
    expect(onChange).not.toHaveBeenCalled();

    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('ignores the atomic-write temp file and unrelated files', () => {
    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('rename', 'profile-registry.json.4321.tmp');
    watchCallback('change', 'something-else.json');

    jest.advanceTimersByTime(200);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('reacts when the platform omits the filename', () => {
    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('change', null);
    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('with no filename, only fires when the registry file actually changed', () => {
    // On null-filename platforms the watched dir is shared with busy siblings
    // (catalog lock, Profiles/…). Gate on the registry mtime so unrelated
    // writes don't rebuild the menu + rebroadcast.
    let mtimeMs = 1000;
    jest.spyOn(fs, 'statSync').mockImplementation(() => ({ mtimeMs }));

    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange); // captures initial mtime 1000

    // A sibling write fires the watcher but the registry mtime is unchanged.
    watchCallback('change', null);
    jest.advanceTimersByTime(150);
    expect(onChange).not.toHaveBeenCalled();

    // The registry file itself changes → fire.
    mtimeMs = 2000;
    watchCallback('change', null);
    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Another sibling write at the same mtime → suppressed again.
    watchCallback('change', null);
    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('with a named registry-file event, fires regardless of mtime', () => {
    // The named-filename path has already confirmed it's the registry file, so
    // it must not be gated by the mtime check.
    jest.spyOn(fs, 'statSync').mockImplementation(() => ({ mtimeMs: 1000 }));

    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('change', 'profile-registry.json');
    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('no-ops without an appRoot or callback', () => {
    expect(typeof watchProfileRegistry()).toBe('function');
    expect(fs.watch).not.toHaveBeenCalled();
  });

  test('stop closes the underlying watcher', () => {
    watchProfileRegistry('/app/root', () => {});
    stopWatchingProfileRegistry();
    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
