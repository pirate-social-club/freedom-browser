(() => {
  const destination = document.getElementById('destination');
  const state = document.getElementById('state');
  const detail = document.getElementById('detail');
  let pendingUrl = null;
  let navigating = false;

  const ready = (hns) => hns?.mode === 'bundled' && hns.synced === true && Boolean(hns.api);
  const render = (registry) => {
    const hns = registry?.hns || {};
    if (ready(hns) && pendingUrl && !navigating) {
      navigating = true;
      location.replace(pendingUrl);
      return;
    }
    if (hns.mode === 'disabled') {
      state.textContent = 'Handshake is disabled for this profile';
      detail.textContent = 'Enable it in Settings → Nodes to open this name.';
      return;
    }
    state.textContent = hns.mode === 'bundled' ? 'Syncing Handshake headers' : 'Starting Handshake';
    detail.textContent = Number.isFinite(hns.height) && hns.height > 0
      ? `Current header height: ${hns.height}`
      : 'Waiting for the first sync update.';
  };

  Promise.all([
    window.freedomAPI.getPendingHnsNavigation(),
    window.freedomAPI.getServiceRegistry(),
  ]).then(([url, registry]) => {
    pendingUrl = url;
    try { destination.textContent = url ? new URL(url).hostname : 'Handshake destination'; }
    catch { destination.textContent = 'Handshake destination'; }
    render(registry);
  }).catch(() => {
    state.textContent = 'Handshake status unavailable';
  });
  window.freedomAPI.onServiceRegistryUpdated(render);
})();
