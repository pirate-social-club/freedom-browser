const HOME_ICANN_URL = 'https://pirate.sc/';
const HOME_HNS_URL = 'https://app.pirate/';
const REDIRECT_DELAY_MS = 350;

let activeSettings = { enableHnsIntegration: true };
let redirectTimeout = null;

const statusEl = document.getElementById('home-status');
const destinationEl = document.getElementById('home-destination');
const heightRowEl = document.getElementById('home-height-row');
const heightEl = document.getElementById('home-height');
const openLinkEl = document.getElementById('home-open-link');
const noteEl = document.getElementById('home-note');

function clearRedirect() {
  if (!redirectTimeout) return;
  clearTimeout(redirectTimeout);
  redirectTimeout = null;
}

function scheduleRedirect(url) {
  clearRedirect();
  redirectTimeout = setTimeout(() => {
    window.location.replace(url);
  }, REDIRECT_DELAY_MS);
}

function isHnsReady(registry) {
  const hns = registry?.hns;
  if (!hns) return false;
  if (activeSettings.enableHnsIntegration !== true) return false;
  if (hns.mode !== 'bundled') return false;
  if (hns.canaryReady !== true) return false;
  return true;
}

function updateHome(registry = {}) {
  const hns = registry?.hns || {};
  const ready = isHnsReady(registry);
  const destinationUrl = ready ? HOME_HNS_URL : HOME_ICANN_URL;
  const destinationLabel = ready ? 'app.pirate' : 'pirate.sc';

  destinationEl.textContent = destinationLabel;
  openLinkEl.href = destinationUrl;
  openLinkEl.textContent = ready ? 'Open app.pirate' : 'Open pirate.sc';

  if (typeof hns.height === 'number' && hns.height > 0) {
    heightRowEl.hidden = false;
    heightEl.textContent = String(hns.height);
  } else {
    heightRowEl.hidden = true;
    heightEl.textContent = '0';
  }

  if (ready) {
    statusEl.textContent = 'Ready';
    noteEl.textContent = 'Opening app.pirate/';
    scheduleRedirect(HOME_HNS_URL);
    return;
  }

  clearRedirect();

  if (activeSettings.enableHnsIntegration !== true) {
    statusEl.textContent = 'Disabled';
    noteEl.textContent = 'HNS is off. Using the web fallback.';
    return;
  }

  if (hns.mode === 'bundled') {
    statusEl.textContent = hns.statusMessage || 'Syncing';
    noteEl.textContent = 'Using pirate.sc until HNS is ready.';
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
