const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

describe('link-status', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  const buildElements = () => {
    const linkStatusEl = createElement('div');
    linkStatusEl.hidden = true;
    const linkStatusUrlEl = createElement('span');
    return { linkStatusEl, linkStatusUrlEl };
  };

  const loadModule = async ({ withDom = true, reduceMotion = false } = {}) => {
    jest.resetModules();
    jest.useFakeTimers();

    let elements = null;
    if (withDom) {
      elements = buildElements();
      global.document = createDocument({
        elementsById: {
          'link-status': elements.linkStatusEl,
          'link-status-url': elements.linkStatusUrlEl,
        },
      });
    } else {
      global.document = createDocument({});
    }

    // rAF-aware shim: the real DOM applies opacity transitions via
    // requestAnimationFrame, and link-status.js coordinates against that
    // timing. Returning a handle (rather than firing synchronously) lets
    // tests verify the cancellation behaviour from PR review #1.
    // link-status.js looks up rAF on globalThis (matches browser semantics
    // where globalThis === window). In Jest's Node environment globalThis
    // is `global`, so install the shim there.
    let nextFrame = 1;
    const queuedFrames = new Map();
    global.window = {
      matchMedia: jest.fn(() => ({ matches: reduceMotion })),
    };
    global.requestAnimationFrame = jest.fn((cb) => {
      const handle = nextFrame++;
      queuedFrames.set(handle, cb);
      return handle;
    });
    global.cancelAnimationFrame = jest.fn((handle) => {
      queuedFrames.delete(handle);
    });
    const flushFrames = () => {
      const callbacks = Array.from(queuedFrames.values());
      queuedFrames.clear();
      callbacks.forEach((cb) => cb());
    };

    const mod = await import('./link-status.js');
    return { mod, elements, flushFrames, queuedFrames };
  };

  afterEach(() => {
    jest.useRealTimers();
    global.document = originalDocument;
    global.window = originalWindow;
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
  });

  test('shows URL after the show delay and clears on empty target', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLinkStatus('https://example.com/path');
    expect(elements.linkStatusUrlEl.textContent).toBe('');
    expect(elements.linkStatusEl.hidden).toBe(true);

    jest.advanceTimersByTime(200);
    flushFrames();
    expect(elements.linkStatusUrlEl.textContent).toBe('https://example.com/path');
    expect(elements.linkStatusEl.hidden).toBe(false);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);

    mod.showLinkStatus('');
    jest.runAllTimers();
    expect(elements.linkStatusUrlEl.textContent).toBe('');
    expect(elements.linkStatusEl.hidden).toBe(true);
  });

  test('cancels pending show when hover ends before delay elapses', async () => {
    const { mod, elements } = await loadModule();
    mod.initLinkStatus();

    mod.showLinkStatus('https://example.com/');
    mod.showLinkStatus('');
    jest.runAllTimers();
    expect(elements.linkStatusUrlEl.textContent).toBe('');
    expect(elements.linkStatusEl.hidden).toBe(true);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(false);
  });

  test('updates text in place when already visible', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLinkStatus('https://a.example/');
    jest.advanceTimersByTime(200);
    flushFrames();
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);

    elements.linkStatusEl.classList.add.mockClear();
    mod.showLinkStatus('https://b.example/');
    expect(elements.linkStatusUrlEl.textContent).toBe('https://b.example/');
    expect(elements.linkStatusEl.classList.add).not.toHaveBeenCalledWith('visible');
  });

  test('handles missing DOM elements safely', async () => {
    const { mod } = await loadModule({ withDom: false });
    expect(() => {
      mod.initLinkStatus();
      mod.showLinkStatus('https://example.com/');
      mod.clearLinkStatus();
      mod.clearLinkStatus({ immediate: true });
      mod.setLinkStatusSide('right');
    }).not.toThrow();
  });

  test('setLinkStatusSide toggles the right-anchor class', async () => {
    const { mod, elements } = await loadModule();
    mod.initLinkStatus();

    mod.setLinkStatusSide('right');
    expect(elements.linkStatusEl.classList.contains('link-status--right')).toBe(true);

    mod.setLinkStatusSide('left');
    expect(elements.linkStatusEl.classList.contains('link-status--right')).toBe(false);
  });

  test('reveal applies the current side', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.setLinkStatusSide('right');
    mod.showLinkStatus('https://example.com/');
    jest.advanceTimersByTime(200);
    flushFrames();
    expect(elements.linkStatusEl.classList.contains('link-status--right')).toBe(true);
  });

  test('clearLinkStatus({ immediate: true }) hides synchronously', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLinkStatus('https://example.com/');
    jest.advanceTimersByTime(200);
    flushFrames();
    expect(elements.linkStatusEl.hidden).toBe(false);

    mod.clearLinkStatus({ immediate: true });
    expect(elements.linkStatusUrlEl.textContent).toBe('');
    expect(elements.linkStatusEl.hidden).toBe(true);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(false);
  });

  test('immediate clear cancels a queued reveal frame', async () => {
    // Regression: without cancelAnimationFrame, the rAF queued by
    // revealLinkStatus would fire after switchTab's immediate clear and
    // re-add `.visible` to a hidden bar — leaving stale state that
    // skipped the next show delay. See PR review item #1.
    const { mod, elements, queuedFrames, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLinkStatus('https://example.com/');
    jest.advanceTimersByTime(200);
    expect(queuedFrames.size).toBe(1);
    expect(elements.linkStatusEl.hidden).toBe(false);

    mod.clearLinkStatus({ immediate: true });
    expect(queuedFrames.size).toBe(0);

    flushFrames();
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(false);
    expect(elements.linkStatusEl.hidden).toBe(true);
  });

  test('re-hovering during fade-out swaps text instantly', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLinkStatus('https://a.example/');
    jest.advanceTimersByTime(200);
    flushFrames();
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);

    mod.showLinkStatus('');
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(false);
    expect(elements.linkStatusEl.hidden).toBe(false);

    mod.showLinkStatus('https://b.example/');
    expect(elements.linkStatusUrlEl.textContent).toBe('https://b.example/');
    expect(elements.linkStatusEl.hidden).toBe(false);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);
  });

  test('truncates pathologically long URLs before assigning to textContent', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    const longUrl = 'data:text/html,' + 'A'.repeat(10_000);
    mod.showLinkStatus(longUrl);
    jest.advanceTimersByTime(200);
    flushFrames();
    expect(elements.linkStatusUrlEl.textContent.length).toBe(2048);
    expect(longUrl.startsWith(elements.linkStatusUrlEl.textContent)).toBe(true);
  });

  test('reduced motion path applies visible class without scheduling rAF', async () => {
    const { mod, elements, queuedFrames } = await loadModule({ reduceMotion: true });
    mod.initLinkStatus();

    mod.showLinkStatus('https://example.com/');
    jest.advanceTimersByTime(200);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);
    expect(queuedFrames.size).toBe(0);
  });

  test('shows loading status without waiting for hover delay', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLoadingStatus('IPFS: Finding providers…');
    expect(elements.linkStatusUrlEl.textContent).toBe('IPFS: Finding providers…');
    expect(elements.linkStatusEl.hidden).toBe(false);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(false);

    flushFrames();
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);
  });

  test('hover URL temporarily overrides loading status then restores it', async () => {
    const { mod, elements, flushFrames } = await loadModule();
    mod.initLinkStatus();

    mod.showLoadingStatus('IPFS: Finding providers…');
    flushFrames();
    expect(elements.linkStatusUrlEl.textContent).toBe('IPFS: Finding providers…');

    mod.showLinkStatus('https://hovered.example/');
    expect(elements.linkStatusUrlEl.textContent).toBe('https://hovered.example/');

    mod.clearHoverStatus();
    expect(elements.linkStatusUrlEl.textContent).toBe('IPFS: Finding providers…');
    expect(elements.linkStatusEl.hidden).toBe(false);
    expect(elements.linkStatusEl.classList.contains('visible')).toBe(true);
  });

  test('pending hover does not hide loading status until hover delay elapses', async () => {
    const { mod, elements } = await loadModule();
    mod.initLinkStatus();

    mod.showLoadingStatus('IPFS: Receiving content…');
    mod.showLinkStatus('https://hovered.example/');

    expect(elements.linkStatusUrlEl.textContent).toBe('IPFS: Receiving content…');

    mod.clearHoverStatus();
    jest.runAllTimers();
    expect(elements.linkStatusUrlEl.textContent).toBe('IPFS: Receiving content…');
    expect(elements.linkStatusEl.hidden).toBe(false);
  });
});
