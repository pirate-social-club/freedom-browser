// macOS-style hover behaviour for side flyouts / submenus.
//
// Native macOS submenus don't open the instant the pointer touches the parent
// row — there's a short delay before opening, and a slightly longer delay
// before closing so the cursor can travel diagonally across the small gap into
// the submenu without it snapping shut. This helper provides that timing in a
// reusable way so every submenu we add behaves consistently.
//
// Usage:
//   const hover = attachSubmenuHover(wrapEl, { open, close });
//   triggerEl.addEventListener('click', hover.openNow); // bypass the delay
//   // later: hover.cancel() to abort pending timers, hover.destroy() to detach.

// Tuned to feel like native macOS submenus: a small open delay, a slightly
// longer close delay (the cursor needs a moment to reach the submenu).
export const SUBMENU_OPEN_DELAY_MS = 150;
export const SUBMENU_CLOSE_DELAY_MS = 180;

/**
 * Wire macOS-style hover open/close timing onto a submenu wrapper element.
 *
 * @param {HTMLElement|null} wrap  The element that contains BOTH the trigger
 *   row and the submenu, so moving onto the submenu doesn't fire mouseleave.
 * @param {object} opts
 * @param {() => void} opts.open   Show the submenu.
 * @param {() => void} opts.close  Hide the submenu.
 * @param {number} [opts.openDelay]
 * @param {number} [opts.closeDelay]
 * @param {boolean} [opts.closeOnLeave=true]  When false, leaving the wrapper
 *   does NOT close the submenu (it stays open until dismissed some other way,
 *   e.g. an outside click). Leaving still cancels a not-yet-fired open so a
 *   quick brush over the trigger won't pop it open after the cursor has gone.
 * @returns {{ openNow: () => void, cancel: () => void, destroy: () => void }}
 */
export function attachSubmenuHover(
  wrap,
  {
    open,
    close,
    openDelay = SUBMENU_OPEN_DELAY_MS,
    closeDelay = SUBMENU_CLOSE_DELAY_MS,
    closeOnLeave = true,
  } = {}
) {
  if (!wrap) {
    return { openNow: () => {}, cancel: () => {}, destroy: () => {} };
  }

  let openTimer = null;
  let closeTimer = null;

  const clearOpenTimer = () => {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const handleEnter = () => {
    clearCloseTimer();
    if (openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      open?.();
    }, openDelay);
  };

  const handleLeave = () => {
    clearOpenTimer();
    clearCloseTimer();
    if (!closeOnLeave) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      close?.();
    }, closeDelay);
  };

  wrap.addEventListener('mouseenter', handleEnter);
  wrap.addEventListener('mouseleave', handleLeave);

  return {
    // Open immediately, bypassing the hover delay (for click / keyboard).
    openNow: () => {
      clearOpenTimer();
      clearCloseTimer();
      open?.();
    },
    // Abort any pending open/close (e.g. when the parent menu closes).
    cancel: () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    destroy: () => {
      clearOpenTimer();
      clearCloseTimer();
      wrap.removeEventListener('mouseenter', handleEnter);
      wrap.removeEventListener('mouseleave', handleLeave);
    },
  };
}
