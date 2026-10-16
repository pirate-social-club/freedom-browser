// Shared hover tooltip for internal pages (freedom://…), loaded as a classic
// <script src> because these pages run in a webview without an ES-module
// bundler. It is the page-side twin of the chrome's lib/hover-tooltip.js (an ES
// module the chrome imports); the two are kept deliberately parallel — same
// delay, same single floating element, same placement — because the module
// systems differ and can't share one file without a build step. Keep behaviour
// in sync if either changes.
//
// Exposes window.bindHoverTooltip(el, getText) and window.hideHoverTooltip().
// The created element uses the `.hover-tooltip` class, so a page must style it.
(function () {
  // Appear delay before a hovered tooltip is shown. Hide is immediate on leave.
  const TOOLTIP_HOVER_DELAY_MS = 250;
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

  const hideHoverTooltip = () => {
    clearTimeout(showTimer);
    showTimer = null;
    if (tooltipEl) tooltipEl.hidden = true;
  };

  // Bind hover-tooltip behaviour to `el`. `getText(el)` returns the tooltip
  // text, or a falsy value to suppress it (e.g. when a label isn't clipped).
  const bindHoverTooltip = (el, getText) => {
    el.addEventListener('mouseenter', (event) => {
      const text = getText(el);
      if (!text) return;
      const x = event.clientX;
      const y = event.clientY;
      clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        const node = ensureEl();
        node.textContent = text;
        node.style.left = `${x + 12}px`;
        node.style.top = `${y + 18}px`;
        node.hidden = false;
      }, TOOLTIP_HOVER_DELAY_MS);
    });
    el.addEventListener('mouseleave', hideHoverTooltip);
  };

  window.bindHoverTooltip = bindHoverTooltip;
  window.hideHoverTooltip = hideHoverTooltip;
})();
