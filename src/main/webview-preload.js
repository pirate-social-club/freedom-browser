/**
 * Preload script for webviews
 *
 * This runs in the context of all webviews:
 * - Exposes freedomAPI for internal pages (freedom://history, etc.)
 * - Handles context menu for all pages
 */

const { contextBridge, ipcRenderer } = require('electron');
const IPC = require('../shared/ipc-channels');

// Internal pages list — canonical source is src/shared/internal-pages.json,
// served by the main process via sync IPC so preloads don't need require().
const internalPages = ipcRenderer.sendSync('internal:get-pages');

// Whitelist of all internal page files (routable + other like error.html)
const ALLOWED_FILES = [...Object.values(internalPages.routable), ...internalPages.other];

const isInternalPage = () => {
  const location = globalThis.location;
  if (!location || location.protocol !== 'file:') return false;
  const pathname = location.pathname || '';
  return ALLOWED_FILES.some((file) => pathname.endsWith(`/pages/${file}`));
};

const guardInternal =
  (name, fn) =>
  (...args) => {
    if (!isInternalPage()) {
      const url = globalThis.location?.href || 'unknown';
      console.warn(`[freedomAPI] blocked "${name}" on non-internal page: ${url}`);
      return Promise.reject(new Error('freedomAPI is only available on internal pages'));
    }
    return fn(...args);
  };

// Expose APIs to internal pages (guarded for safety)
contextBridge.exposeInMainWorld('freedomAPI', {
  // History
  getHistory: guardInternal('getHistory', (options) => ipcRenderer.invoke('history:get', options)),
  addHistory: guardInternal('addHistory', (entry) => ipcRenderer.invoke('history:add', entry)),
  removeHistory: guardInternal('removeHistory', (id) => ipcRenderer.invoke('history:remove', id)),
  clearHistory: guardInternal('clearHistory', () => ipcRenderer.invoke('history:clear')),

  // Settings (read-only for internal pages)
  getSettings: guardInternal('getSettings', () => ipcRenderer.invoke('settings:get')),

  // Service registry (read-only for internal pages)
  getServiceRegistry: guardInternal('getServiceRegistry', () =>
    ipcRenderer.invoke(IPC.SERVICE_REGISTRY_GET)
  ),
  onServiceRegistryUpdate: guardInternal('onServiceRegistryUpdate', (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const handler = (_event, registry) => callback(registry);
    ipcRenderer.on(IPC.SERVICE_REGISTRY_UPDATE, handler);

    return () => {
      ipcRenderer.removeListener(IPC.SERVICE_REGISTRY_UPDATE, handler);
    };
  }),

  // Bookmarks (read-only for internal pages)
  getBookmarks: guardInternal('getBookmarks', () => ipcRenderer.invoke('bookmarks:get')),

  // Navigation
  openInNewTab: guardInternal('openInNewTab', (url) =>
    ipcRenderer.invoke('internal:open-url-in-new-tab', url)
  ),

  // Favicons
  getCachedFavicon: guardInternal('getCachedFavicon', (url) =>
    ipcRenderer.invoke('favicon:get-cached', url)
  ),

  // Radicle
  seedRadicle: guardInternal('seedRadicle', (rid) => ipcRenderer.invoke('radicle:seed', rid)),
  getRadicleStatus: guardInternal('getRadicleStatus', () => ipcRenderer.invoke('radicle:getStatus')),
  getRadicleRepoPayload: guardInternal('getRadicleRepoPayload', (rid) =>
    ipcRenderer.invoke('radicle:getRepoPayload', rid)
  ),
  syncRadicleRepo: guardInternal('syncRadicleRepo', (rid) =>
    ipcRenderer.invoke('radicle:syncRepo', rid)
  ),
});

// ============================================
// Context Menu Handler (works on all pages)
// ============================================

// Get context information when right-clicking
document.addEventListener(
  'contextmenu',
  (event) => {
    const context = {
      x: event.clientX,
      y: event.clientY,
      pageUrl: window.location.href,
      pageTitle: document.title,
      linkUrl: null,
      linkText: null,
      selectedText: null,
      imageSrc: null,
      imageAlt: null,
      isEditable: false,
      mediaType: null,
    };

    // Check for selected text
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      context.selectedText = selection.toString();
    }

    // Walk up the DOM tree to find links, images, etc.
    let element = event.target;
    while (element && element !== document.body) {
      // Check for links
      if (element.tagName === 'A' && element.href) {
        context.linkUrl = element.href;
        context.linkText = element.textContent?.trim() || '';
      }

      // Check for images
      if (element.tagName === 'IMG' && element.src) {
        context.imageSrc = element.src;
        context.imageAlt = element.alt || '';
        context.mediaType = 'image';
      }

      // Check for video
      if (element.tagName === 'VIDEO') {
        context.mediaType = 'video';
        if (element.src) {
          context.mediaSrc = element.src;
        } else if (element.querySelector('source')) {
          context.mediaSrc = element.querySelector('source').src;
        }
      }

      // Check for audio
      if (element.tagName === 'AUDIO') {
        context.mediaType = 'audio';
        if (element.src) {
          context.mediaSrc = element.src;
        } else if (element.querySelector('source')) {
          context.mediaSrc = element.querySelector('source').src;
        }
      }

      // Check if element is editable
      if (
        element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        element.isContentEditable
      ) {
        context.isEditable = true;
      }

      element = element.parentElement;
    }

    // Prevent the default context menu
    event.preventDefault();

    // Send context info to the host renderer
    ipcRenderer.sendToHost('context-menu', context);
  },
  true
);

// Handle context menu actions from the renderer
ipcRenderer.on('context-menu-action', (_event, action, data) => {
  switch (action) {
    case 'copy':
      document.execCommand('copy');
      break;
    case 'cut':
      document.execCommand('cut');
      break;
    case 'paste':
      document.execCommand('paste');
      break;
    case 'select-all':
      document.execCommand('selectAll');
      break;
    case 'copy-text':
      if (data?.text) {
        navigator.clipboard.writeText(data.text).catch(console.error);
      }
      break;
  }
});

// ============================================
// Ethereum Provider (EIP-1193)
// ============================================

// Pending requests waiting for response
const pendingRequests = new Map();
let requestId = 0;

// Event listeners
const eventListeners = {
  connect: [],
  disconnect: [],
  chainChanged: [],
  accountsChanged: [],
  message: [],
};

// Provider state (updated by renderer)
let providerState = {
  chainId: null,
  accounts: [],
  isConnected: false,
};

/**
 * Generate unique request ID
 */
function getNextRequestId() {
  return ++requestId;
}

/**
 * EIP-1193 Provider Error
 */
class ProviderRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = 'ProviderRpcError';
  }
}

/**
 * The Ethereum provider object injected as window.ethereum
 */
const ethereumProvider = {
  // MetaMask compatibility
  isMetaMask: true,
  isFreedomBrowser: true,

  // State getters
  get chainId() {
    return providerState.chainId;
  },
  get selectedAddress() {
    return providerState.accounts[0] || null;
  },
  get networkVersion() {
    if (!providerState.chainId) return null;
    return String(parseInt(providerState.chainId, 16));
  },

  /**
   * Check if connected to the network
   */
  isConnected() {
    return providerState.isConnected;
  },

  /**
   * EIP-1193 request method - main entry point
   */
  async request({ method, params }) {
    if (!method) {
      throw new ProviderRpcError(4200, 'Invalid request: method is required');
    }

    const id = getNextRequestId();
    const origin = window.location.origin;

    return new Promise((resolve, reject) => {
      // Store the pending request
      pendingRequests.set(id, { resolve, reject, method });

      // Send request to renderer via host
      ipcRenderer.sendToHost('dapp:provider-request', {
        id,
        method,
        params: params || [],
        origin,
      });

      // Timeout after 5 minutes for transactions, 60 seconds for other requests
      const timeout = method === 'eth_sendTransaction' ? 300000 : 60000;
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new ProviderRpcError(4200, 'Request timed out'));
        }
      }, timeout);
    });
  },

  /**
   * Add event listener
   */
  on(event, handler) {
    if (eventListeners[event]) {
      eventListeners[event].push(handler);
    }
    return this;
  },

  /**
   * Remove event listener
   */
  removeListener(event, handler) {
    if (eventListeners[event]) {
      const index = eventListeners[event].indexOf(handler);
      if (index > -1) {
        eventListeners[event].splice(index, 1);
      }
    }
    return this;
  },

  /**
   * Add event listener (alias)
   */
  addListener(event, handler) {
    return this.on(event, handler);
  },

  /**
   * Remove all listeners for an event
   */
  removeAllListeners(event) {
    if (event && eventListeners[event]) {
      eventListeners[event] = [];
    }
    return this;
  },

  // Legacy methods for compatibility
  enable() {
    return this.request({ method: 'eth_requestAccounts' });
  },

  send(methodOrPayload, paramsOrCallback) {
    // Handle different call signatures
    if (typeof methodOrPayload === 'string') {
      return this.request({ method: methodOrPayload, params: paramsOrCallback });
    }
    // Legacy payload format
    if (typeof paramsOrCallback === 'function') {
      this.sendAsync(methodOrPayload, paramsOrCallback);
      return;
    }
    return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
  },

  sendAsync(payload, callback) {
    this.request({ method: payload.method, params: payload.params })
      .then((result) => {
        callback(null, { id: payload.id, jsonrpc: '2.0', result });
      })
      .catch((error) => {
        callback(error, null);
      });
  },
};

/**
 * Emit event to listeners
 */
function emitProviderEvent(event, data) {
  if (eventListeners[event]) {
    eventListeners[event].forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        console.error(`[Ethereum Provider] Error in ${event} handler:`, err);
      }
    });
  }
}

// Handle responses from renderer
ipcRenderer.on('dapp:provider-response', (_event, { id, result, error }) => {
  const pending = pendingRequests.get(id);
  if (pending) {
    pendingRequests.delete(id);
    if (error) {
      pending.reject(new ProviderRpcError(error.code || 4000, error.message, error.data));
    } else {
      pending.resolve(result);
    }
  }
});

// Handle events from renderer (accountsChanged, chainChanged, etc.)
ipcRenderer.on('dapp:provider-event', (_event, { event, data }) => {
  // Update internal state
  if (event === 'chainChanged') {
    providerState.chainId = data;
  } else if (event === 'accountsChanged') {
    providerState.accounts = data || [];
  } else if (event === 'connect') {
    providerState.isConnected = true;
    providerState.chainId = data?.chainId || null;
  } else if (event === 'disconnect') {
    providerState.isConnected = false;
    providerState.accounts = [];
  }

  // Emit to dApp listeners
  emitProviderEvent(event, data);
});

// Handle state sync from renderer (initial state)
ipcRenderer.on('dapp:provider-state', (_event, state) => {
  providerState = { ...providerState, ...state };
});

// Expose window.ethereum at preload time so synchronous page scripts can detect it.
try {
  contextBridge.exposeInMainWorld('ethereum', ethereumProvider);
  window.dispatchEvent?.(new Event('ethereum#initialized'));
} catch (err) {
  console.error('[webview-preload] Failed to inject ethereum provider:', err);
}

console.log('[webview-preload] Loaded (freedomAPI + context menu + ethereum provider)');
