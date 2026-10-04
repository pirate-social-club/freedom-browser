// A lightweight, app-wide hover tooltip: a single floating element shown after
// a short delay near the cursor and hidden on leave. Used for surfaces that need
// a custom-timed hint instead of the browser's native `title` (whose appear/hide
// timing can't be configured). The delay is the one source of truth for hover
// tooltip timing in the chrome — the trust popover's "Copy" hint reuses it too,
// so every hover hint in the app feels the same.

// Appear delay before a hovered tooltip is shown. Hide is immediate on leave.
export const TOOLTIP_HOVER_DELAY_MS = 250;

let tooltipEl = null;
let showTimer = null;

const ensureEl = () => {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'hover-tooltip';
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
};

const hide = () => {
  clearTimeout(showTimer);
  showTimer = null;
  if (tooltipEl) tooltipEl.hidden = true;
};

// Show `text` just below/right of (clientX, clientY) after the shared delay,
// matching the trust "Copy" tooltip's placement.
const scheduleShow = (text, clientX, clientY) => {
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    const el = ensureEl();
    el.textContent = text;
    el.style.left = `${clientX + 12}px`;
    el.style.top = `${clientY + 18}px`;
    el.hidden = false;
  }, TOOLTIP_HOVER_DELAY_MS);
};

// Bind hover-tooltip behaviour to `el`. `getText(el)` returns the tooltip text,
// or a falsy value to suppress it (e.g. when a label isn't actually clipped).
export const bindHoverTooltip = (el, getText) => {
  el.addEventListener('mouseenter', (event) => {
    const text = getText(el);
    if (text) scheduleShow(text, event.clientX, event.clientY);
  });
  el.addEventListener('mouseleave', hide);
};
