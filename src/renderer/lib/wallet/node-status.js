/**
 * Node Status Module
 *
 * Node cards, status badges, Swarm notifications.
 */

import { buildBeeUrl } from '../state.js';

// DOM references
let swarmModeBadge;
let swarmStatusBadge;
let walletNotification;

// Node status tracking
let nodeStatusUnsubscribers = [];

export function initNodeStatus() {
  // Node card elements
  swarmModeBadge = document.getElementById('swarm-mode-badge');
  swarmStatusBadge = document.getElementById('swarm-status-badge');

  // Notification elements
  walletNotification = document.getElementById('wallet-notification');

  // Setup node card collapse/expand
  setupNodeCards();

  // Subscribe to node status updates
  subscribeToNodeStatus();
}

// ============================================
// Node Cards (Collapsible)
// ============================================

function setupNodeCards() {
  // Add click listeners to all node card headers
  document.querySelectorAll('.node-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const nodeName = header.dataset.node;
      toggleNodeCard(nodeName);
    });
  });

  // Upgrade node button
  const upgradeBtn = document.getElementById('swarm-upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleUpgradeNode();
    });
  }
}

function toggleNodeCard(nodeName) {
  const card = document.getElementById(`node-card-${nodeName}`);
  const content = document.getElementById(`${nodeName}-card-content`);

  if (!card || !content) return;

  const isExpanded = card.classList.contains('expanded');

  if (isExpanded) {
    card.classList.remove('expanded');
    content.classList.add('hidden');
  } else {
    card.classList.add('expanded');
    content.classList.remove('hidden');
  }
}

function handleUpgradeNode() {
  // TODO: Implement upgrade flow
  console.log('[WalletUI] Upgrade to light node - coming soon');
  alert('Upgrade to Light Node - coming soon');
}

// ============================================
// Node Status Subscriptions
// ============================================

function subscribeToNodeStatus() {
  // Clean up any existing subscriptions
  nodeStatusUnsubscribers.forEach(unsub => unsub?.());
  nodeStatusUnsubscribers = [];

  // Subscribe to Swarm/Bee status
  if (window.bee?.onStatusUpdate) {
    const unsubBee = window.bee.onStatusUpdate(({ status, error }) => {
      updateSwarmStatus(status, error);
    });
    if (unsubBee) nodeStatusUnsubscribers.push(unsubBee);
  }

  // Subscribe to IPFS status
  if (window.ipfs?.onStatusUpdate) {
    const unsubIpfs = window.ipfs.onStatusUpdate(({ status, error }) => {
      updateIpfsStatus(status, error);
    });
    if (unsubIpfs) nodeStatusUnsubscribers.push(unsubIpfs);
  }

  // Subscribe to Radicle status
  if (window.radicle?.onStatusUpdate) {
    const unsubRadicle = window.radicle.onStatusUpdate(({ status, error }) => {
      updateRadicleStatus(status, error);
    });
    if (unsubRadicle) nodeStatusUnsubscribers.push(unsubRadicle);
  }

  // Get initial status
  fetchInitialNodeStatus();
}

async function fetchInitialNodeStatus() {
  try {
    if (window.bee?.getStatus) {
      const { status, error } = await window.bee.getStatus();
      updateSwarmStatus(status, error);
    }

    if (window.ipfs?.getStatus) {
      const { status, error } = await window.ipfs.getStatus();
      updateIpfsStatus(status, error);
    }

    if (window.radicle?.getStatus) {
      const { status, error } = await window.radicle.getStatus();
      updateRadicleStatus(status, error);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch initial node status:', err);
  }
}

function updateSwarmStatus(status, _error) {
  if (swarmStatusBadge) {
    let statusText;
    let statusValue;

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    swarmStatusBadge.textContent = statusText;
    swarmStatusBadge.dataset.status = statusValue;
  }

  if (status === 'running') {
    fetchSwarmMode();
    hideNotification();
  } else if (swarmModeBadge) {
    swarmModeBadge.textContent = '--';
  }
}

async function fetchSwarmMode() {
  if (!swarmModeBadge) return;

  try {
    const response = await fetch(buildBeeUrl('/status'));
    if (response.ok) {
      const data = await response.json();
      if (data.beeMode) {
        const mode = data.beeMode.charAt(0).toUpperCase() + data.beeMode.slice(1);
        swarmModeBadge.textContent = mode;
      }
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch Swarm mode:', err);
    swarmModeBadge.textContent = '--';
  }
}

function updateIpfsStatus(status, _error) {
  const badge = document.getElementById('ipfs-status-badge');
  if (badge) {
    let statusText;
    let statusValue;

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    badge.textContent = statusText;
    badge.dataset.status = statusValue;
  }
}

function updateRadicleStatus(status, _error) {
  const badge = document.getElementById('radicle-status-badge');
  if (badge) {
    let statusText;
    let statusValue;

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    badge.textContent = statusText;
    badge.dataset.status = statusValue;
  }
}

function hideNotification() {
  if (walletNotification) {
    walletNotification.classList.add('hidden');
  }
}
