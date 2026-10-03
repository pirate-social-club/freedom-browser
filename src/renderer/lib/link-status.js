// Chrome-style link hover URL preview at the bottom of the page area.

let linkStatusEl = null;
let linkStatusUrlEl = null;
let hideTimer = null;
let showTimer = null;
let revealFrame = null;
let currentSide = 'left';
let hoverText = '';
let loadingText = '';

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 250;

// Cap before assigning to textContent — `update-target-url` will happily
// forward megabyte-scale `data:` / `javascript:` URLs from a hostile (or
// merely sloppy) embedded iframe, which a single ellipsis-styled element
// shouldn't have to chew on every hover. Chrome / Firefox truncate around
// the same range; users can still see the full target via right-click +
// "Copy link address" on the page itself.
const MAX_URL_LENGTH = 2048;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

const scheduleFrame = (callback) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  callback();
  return null;
};

const cancelScheduledFrame = () => {
  if (revealFrame == null) return;
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(revealFrame);
  }
  revealFrame = null;
};

export const initLinkStatus = () => {
  linkStatusEl = document.getElementById('link-status');
  linkStatusUrlEl = document.getElementById('link-status-url');
  hoverText = '';
  loadingText = '';
};

const applySide = (side) => {
  if (!linkStatusEl) return;
  if (side === 'right') {
    linkStatusEl.classList.add('link-status--right');
  } else {
    linkStatusEl.classList.remove('link-status--right');
  }
};

/**
 * Set which corner the preview anchors to. Called when the cursor enters
 * or leaves the default bottom-left position so the bar gets out of the
 * way of the link the user is hovering.
 * @param {'left' | 'right'} side
 */
export const setLinkStatusSide = (side) => {
  const next = side === 'right' ? 'right' : 'left';
  if (next === currentSide) return;
  currentSide = next;
  applySide(currentSide);
};

/**
 * Clear the link hover preview.
 * @param {{ immediate?: boolean }} [options] When `immediate` is true, the
 *   bar is hidden synchronously with no fade-out — used by tab switches
 *   so the previous tab's URL never visibly trails into the new tab.
 */
export const clearLinkStatus = (options = {}) => {
  hoverText = '';
  loadingText = '';
  hideStatus(options);
};

const hideStatus = (options = {}) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  // A queued reveal frame would otherwise re-add `visible` after we hide,
  // leaving the element with `hidden=true` + `.visible` and skipping the
  // next show delay. Cancel it before touching the class.
  cancelScheduledFrame();

  const finishHide = () => {
    if (!linkStatusEl || !linkStatusUrlEl) return;
    linkStatusUrlEl.textContent = '';
    linkStatusEl.hidden = true;
  };

  if (options.immediate) {
    linkStatusEl.classList.remove('visible');
    finishHide();
    return;
  }

  if (!linkStatusEl.classList.contains('visible')) {
    finishHide();
    return;
  }

  linkStatusEl.classList.remove('visible');

  if (prefersReducedMotion()) {
    finishHide();
    return;
  }

  hideTimer = setTimeout(() => {
    hideTimer = null;
    finishHide();
  }, HIDE_DELAY_MS);
};

const swapVisibleText = (text) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  cancelScheduledFrame();
  linkStatusUrlEl.textContent = text;
  linkStatusEl.hidden = false;
  applySide(currentSide);
  if (!linkStatusEl.classList.contains('visible')) {
    linkStatusEl.classList.add('visible');
  }
};

const revealLinkStatus = (url) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  linkStatusUrlEl.textContent = url;
  linkStatusEl.hidden = false;
  applySide(currentSide);

  if (prefersReducedMotion()) {
    linkStatusEl.classList.add('visible');
    return;
  }

  linkStatusEl.classList.remove('visible');
  cancelScheduledFrame();
  revealFrame = scheduleFrame(() => {
    revealFrame = null;
    linkStatusEl?.classList.add('visible');
  });
};

const truncateUrl = (url) =>
  url.length > MAX_URL_LENGTH ? url.slice(0, MAX_URL_LENGTH) : url;

export const clearHoverStatus = () => {
  hoverText = '';
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  cancelScheduledFrame();

  if (loadingText) {
    swapVisibleText(loadingText);
    return;
  }

  hideStatus();
};

export const showLinkStatus = (url) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) {
    clearHoverStatus();
    return;
  }
  const trimmed = truncateUrl(raw);
  hoverText = trimmed;

  // A pending hide means the bar was visible moments ago and is mid-fade.
  // Treat that as still visible so re-hovers within the fade window swap
  // text instantly instead of restarting the show delay.
  const wasFadingOut = hideTimer !== null;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // Already visible (or mid fade-out): swap text in place, no fade.
  if (linkStatusEl.classList.contains('visible') || wasFadingOut) {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    cancelScheduledFrame();
    swapVisibleText(trimmed);
    return;
  }

  // Not yet visible: defer reveal so brief mouse passes don't flicker the bar.
  if (showTimer) {
    clearTimeout(showTimer);
  }
  showTimer = setTimeout(() => {
    showTimer = null;
    revealLinkStatus(trimmed);
  }, SHOW_DELAY_MS);
};

export const showLoadingStatus = (message) => {
  if (!linkStatusEl || !linkStatusUrlEl) return;

  const raw = typeof message === 'string' ? message.trim() : '';
  if (!raw) {
    clearLoadingStatus();
    return;
  }
  loadingText = truncateUrl(raw);

  // Hover URLs are direct pointer feedback, so keep them above the
  // background loading diagnostic until the hover clears.
  if (hoverText || showTimer) return;

  if (linkStatusEl.classList.contains('visible') || hideTimer) {
    swapVisibleText(loadingText);
    return;
  }

  revealLinkStatus(loadingText);
};

export const clearLoadingStatus = (options = {}) => {
  loadingText = '';
  if (hoverText || showTimer) return;
  hideStatus(options);
};
