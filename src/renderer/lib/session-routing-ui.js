let activeWebview = null;
let snapshot = null;
let panel = null;
let message = null;
let api = null;

function guestStatus(webview) {
  if (!webview) return null;
  try { return snapshot?.guests.find((value) => value.id === webview.getWebContentsId()); } catch { return null; }
}

export function isSessionRoutingBlocked(webview) {
  return Boolean(snapshot && (!snapshot.ui.allowed || (webview && !guestStatus(webview)?.allowed)));
}

function render() {
  if (!panel) return;
  const guest = guestStatus(activeWebview);
  const blocked = isSessionRoutingBlocked(activeWebview);
  panel.hidden = !blocked;
  panel.parentElement?.classList.toggle('routing-blocked', blocked);
  if (!blocked) return;
  const failed = [snapshot.ui, guest].some((value) => value && ['quarantined', 'retired', 'unknown'].includes(value.state));
  message.textContent = failed
    ? 'Freedom could not apply its network protection settings. Requests remain blocked. Restart Freedom to try again.'
    : 'Freedom is updating network protection. Requests are paused until the update succeeds.';
}

function accept(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.ui || !Array.isArray(value.guests) || (snapshot && value.revision <= snapshot.revision)) return;
  if (![value.ui, ...value.guests].every((item) => typeof item.allowed === 'boolean' &&
      Number.isSafeInteger(item.generation) && item.generation >= 0 && typeof item.state === 'string')) return;
  snapshot = value;
  render();
}

export function refreshSessionRoutingNotice(webview = activeWebview) {
  activeWebview = webview;
  render();
  if (api) Promise.resolve(api.getRoutingStatus()).then(accept).catch(() => {});
}

export function initSessionRoutingUi() {
  panel = document.getElementById('routing-notice');
  message = document.getElementById('routing-notice-message');
  const bridge = window.electronAPI;
  if (!panel || !message || typeof bridge?.getRoutingStatus !== 'function' ||
      typeof bridge.onRoutingStatusUpdate !== 'function') return;
  api = bridge;
  // Subscribe before requesting the snapshot. Revisions prevent stale replies.
  api.onRoutingStatusUpdate(accept);
  refreshSessionRoutingNotice();
}
