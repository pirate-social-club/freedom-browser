(() => {
  const destination = 'https://app.pirate/';
  const state = document.getElementById('hns-home-state');
  const detail = document.getElementById('hns-home-detail');
  let navigating = false;

  const render = (registry) => {
    const hns = registry?.hns || {};
    if (hns.mode === 'bundled' && hns.synced === true && hns.api && !navigating) {
      navigating = true;
      location.replace(destination);
      return;
    }
    if (hns.mode === 'disabled') {
      state.textContent = 'Handshake is disabled';
      detail.textContent = 'Enable it in Settings → Nodes to use app.pirate.';
      return;
    }
    state.textContent = hns.mode === 'bundled' ? 'Syncing Handshake headers' : 'Starting Handshake';
    detail.textContent = Number.isFinite(hns.height) && hns.height > 0
      ? `Header height ${hns.height}. app.pirate will open automatically when ready.`
      : 'app.pirate will open automatically when the resolver is ready.';
  };

  window.freedomAPI.getServiceRegistry().then(render).catch(() => {
    state.textContent = 'Handshake status unavailable';
  });
  window.freedomAPI.onServiceRegistryUpdated(render);
})();
