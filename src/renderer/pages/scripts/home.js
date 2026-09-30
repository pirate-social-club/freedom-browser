const HOME_ICANN_URL = 'https://pirate.sc/';

let activeSettings = { enableHnsIntegration: true };

const statusEl = document.getElementById('home-status');
const destinationEl = document.getElementById('home-destination');
const heightRowEl = document.getElementById('home-height-row');
const heightEl = document.getElementById('home-height');
const openLinkEl = document.getElementById('home-open-link');
const noteEl = document.getElementById('home-note');

function isHnsReady(registry) {
  const hns = registry?.hns;
  if (!hns) return false;
  if (activeSettings.enableHnsIntegration !== true) return false;
  if (hns.mode !== 'bundled') return false;
  if (hns.localResolverReady !== true) return false;
  return true;
}

function updateHome(registry = {}) {
  const hns = registry?.hns || {};
  const ready = isHnsReady(registry);
  destinationEl.textContent = 'Local welcome';
  openLinkEl.href = HOME_ICANN_URL;
  openLinkEl.textContent = 'Open pirate.sc';

  if (typeof hns.height === 'number' && hns.height > 0) {
    heightRowEl.hidden = false;
    heightEl.textContent = String(hns.height);
  } else {
    heightRowEl.hidden = true;
    heightEl.textContent = '0';
  }

  if (ready) {
    statusEl.textContent = 'Ready';
    noteEl.textContent = 'Enter an HNS address in the address bar.';
    return;
  }

  if (activeSettings.enableHnsIntegration !== true) {
    statusEl.textContent = 'Disabled';
    noteEl.textContent = 'HNS is off. You can still browse regular websites.';
    return;
  }

  if (hns.mode === 'bundled') {
    statusEl.textContent = hns.statusMessage || 'Syncing';
    noteEl.textContent = 'The HNS resolver is not ready yet. Choose an address to browse.';
    return;
  }

  statusEl.textContent = 'Starting';
  noteEl.textContent = 'Waiting for the bundled resolver.';
}

async function bootstrap() {
  try {
    activeSettings = await window.freedomAPI.getSettings();
  } catch {
    activeSettings = { enableHnsIntegration: true };
  }

  let registry;

  try {
    registry = await window.freedomAPI.getServiceRegistry();
  } catch {
    registry = {};
  }

  updateHome(registry);

  window.freedomAPI.onServiceRegistryUpdate((nextRegistry) => {
    updateHome(nextRegistry);
  });
}

document.addEventListener('DOMContentLoaded', bootstrap);
