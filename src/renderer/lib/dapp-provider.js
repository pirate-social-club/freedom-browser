/**
 * dApp Provider Handler (Renderer Side)
 *
 * Handles Ethereum provider requests from webviews:
 * - Routes read-only RPC calls to main process
 * - Manages connection requests (shows approval UI)
 * - Handles transaction signing (shows approval UI)
 *
 * Communication flow:
 * webview (window.ethereum) → renderer (this) → main (RPC/signing)
 */

import { showDappConnect, getSelectedChainId, setSelectedChainId, updateConnectionBanner, showDappTxApproval, showDappSignApproval } from './wallet-ui.js';
import { getPermissionContext } from './dapp-permission-key.js';

// Feature flag state
let identityWalletEnabled = false;

// Load initial flag state and listen for changes
window.electronAPI?.getSettings?.().then((settings) => {
  identityWalletEnabled = settings?.enableIdentityWallet === true;
}).catch(() => {});
window.addEventListener('settings:updated', (event) => {
  identityWalletEnabled = event.detail?.enableIdentityWallet === true;
});

// Provider state per webview (keyed by webview ID or reference)
const providerStates = new WeakMap();

// Current active webview reference (set by tabs.js)
let activeWebview = null;

// All webviews with provider wiring, for provider-wide chain/account events.
const providerWebviews = new Set();

/**
 * EIP-1193 error codes
 */
const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Unauthorized' },
  UNSUPPORTED_METHOD: { code: 4200, message: 'Method not supported' },
  DISCONNECTED: { code: 4900, message: 'Disconnected' },
  CHAIN_NOT_ADDED: { code: 4902, message: 'Unrecognized chain ID' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid parameters' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

/**
 * Methods that can be handled without user approval (read-only)
 */
const READ_ONLY_METHODS = [
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
  'web3_clientVersion',
  'web3_sha3',
];

/**
 * Get or create provider state for a webview
 */
function getProviderState(webview) {
  if (!providerStates.has(webview)) {
    providerStates.set(webview, {
      chainId: null,
      accounts: [],
      isConnected: false,
    });
  }
  return providerStates.get(webview);
}

/**
 * Get the current chain ID in hex format
 */
async function getCurrentChainId() {
  try {
    // Get from wallet UI's selected chain
    const chainId = getSelectedChainId();
    if (chainId) {
      return '0x' + chainId.toString(16);
    }
    // Default to Gnosis Chain
    return '0x64';
  } catch {
    return '0x64';
  }
}

/**
 * Handle a provider request from a webview
 */
async function handleProviderRequest(webview, request) {
  const { id, method, params } = request;

  // Gate: if Identity & Wallet feature is disabled, reject all provider requests
  if (!identityWalletEnabled) {
    sendProviderResponse(webview, id, null, ERRORS.DISCONNECTED);
    return;
  }

  console.log('[DappProvider] handleProviderRequest:', { id, method, params });

  const webviewUrl = typeof webview?.getURL === 'function' ? webview.getURL() : '';
  const { displayUrl, permissionKey } = getPermissionContext({
    webviewUrl,
    requestOrigin: request.origin,
  });

  console.log('[DappProvider] Using permissionKey:', permissionKey);

  if (!permissionKey) {
    sendProviderResponse(webview, id, null, ERRORS.UNAUTHORIZED);
    return;
  }

  try {
    let result;

    // Handle different method categories
    if (method === 'eth_chainId') {
      result = await getCurrentChainId();
    } else if (method === 'net_version') {
      const chainId = await getCurrentChainId();
      result = String(parseInt(chainId, 16));
    } else if (method === 'eth_accounts') {
      // Return connected accounts (empty if not connected)
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (permission) {
        const walletsResult = await window.wallet.getDerivedWallets();
        const wallets = walletsResult.success ? walletsResult.wallets : [];
        const wallet = wallets.find((w) => w.index === permission.walletIndex);
        result = wallet ? [wallet.address] : [];
      } else {
        result = [];
      }
    } else if (method === 'eth_requestAccounts') {
      // Check if already connected
      const permission = await window.dappPermissions.getPermission(permissionKey);
      if (permission) {
        // Already connected, return accounts
        const walletsResult = await window.wallet.getDerivedWallets();
        const wallets = walletsResult.success ? walletsResult.wallets : [];
        const wallet = wallets.find((w) => w.index === permission.walletIndex);
        result = wallet ? [wallet.address] : [];
        // Update last used
        await window.dappPermissions.updateLastUsed(permissionKey);
      } else {
        // Need to show connection approval UI
        console.log('[DappProvider] Showing connect UI for:', permissionKey);
        result = await new Promise((resolve, reject) => {
          showDappConnect(displayUrl, permissionKey, resolve, reject, webview);
        });
        console.log('[DappProvider] Connect UI resolved with:', result);
      }
    } else if (READ_ONLY_METHODS.includes(method)) {
      // Proxy read-only calls to RPC
      result = await proxyRpcCall(method, params);
    } else if (method === 'wallet_switchEthereumChain') {
      // Handle chain switching
      result = await handleSwitchChain(params, permissionKey, webview);
    } else if (method === 'eth_sendTransaction') {
      // Need transaction approval
      result = await showDappTxApproval(webview, permissionKey, params[0]);
    } else if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      // Need signing approval
      result = await showDappSignApproval(webview, permissionKey, method, params);
    } else if (method === 'eth_sign') {
      // Deprecated and dangerous - reject
      throw { ...ERRORS.UNSUPPORTED_METHOD, message: 'eth_sign is deprecated for security reasons' };
    } else {
      // Unknown method
      throw ERRORS.UNSUPPORTED_METHOD;
    }

    // Send success response
    sendProviderResponse(webview, id, result, null);
  } catch (error) {
    // Send error response
    const err = {
      code: error.code || ERRORS.INTERNAL_ERROR.code,
      message: error.message || 'Unknown error',
      data: error.data,
    };
    sendProviderResponse(webview, id, null, err);
  }
}

/**
 * Proxy an RPC call to the main process
 * Tries multiple RPC endpoints with fallback on failure
 */
async function proxyRpcCall(method, params) {
  // Get current chain ID
  const chainIdHex = await getCurrentChainId();
  const chainId = parseInt(chainIdHex, 16);

  // Get effective RPC URLs (includes provider URLs if configured)
  const urlsResult = await window.rpcManager.getEffectiveUrls(chainId);
  const rpcUrls = urlsResult.success ? urlsResult.urls : [];

  if (rpcUrls.length === 0) {
    // No RPC URLs available - give helpful error message
    const chainsResult = await window.chainRegistry.getChains();
    const chains = chainsResult.success ? chainsResult.chains : {};
    const chain = chains[chainId];
    const chainName = chain?.name || `Chain ${chainId}`;
    throw {
      ...ERRORS.INTERNAL_ERROR,
      message: `${chainName} requires an RPC provider. Please configure Alchemy, Infura, or DRPC in Settings.`,
    };
  }

  // Try each RPC URL until one succeeds (via main process to avoid renderer CSP)
  let lastError = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const data = await window.wallet.proxyRpc(rpcUrl, method, params);

      if (!data.success) {
        // RPC returned an error - try next endpoint
        console.warn(`[DappProvider] RPC error from ${rpcUrl}:`, data.error?.message);
        lastError = { code: data.error?.code, message: data.error?.message };
        continue;
      }

      return data.result;
    } catch (err) {
      // IPC/network error - try next endpoint
      console.warn(`[DappProvider] RPC proxy failed for ${rpcUrl}:`, err.message);
      lastError = { ...ERRORS.INTERNAL_ERROR, message: err.message };
    }
  }

  // All endpoints failed
  throw lastError || { ...ERRORS.INTERNAL_ERROR, message: `All RPC endpoints failed for chain ${chainId}` };
}

/**
 * Handle wallet_switchEthereumChain
 */
async function handleSwitchChain(params, permissionKey, webview) {
  if (!params || !params[0] || !params[0].chainId) {
    throw ERRORS.INVALID_PARAMS;
  }

  const requestedChainId = parseInt(params[0].chainId, 16);
  const result = await window.chainRegistry.getChains();
  const chains = result.success ? result.chains : {};

  if (!chains[requestedChainId]) {
    throw ERRORS.CHAIN_NOT_ADDED;
  }

  // Check if the chain is available (has RPC configured)
  const availabilityResult = await window.chainRegistry.isChainAvailable(requestedChainId);
  if (!availabilityResult.available) {
    const chain = chains[requestedChainId];
    throw {
      code: 4902,
      message: `${chain.name} requires an RPC provider. Please configure Alchemy, Infura, or DRPC in Settings.`,
    };
  }

  // Update the permission with new chain
  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (permission) {
    await window.dappPermissions.updateLastUsed(permissionKey, requestedChainId);
  }

  // Update wallet UI's selected chain to match
  setSelectedChainId(requestedChainId);

  // Emit chainChanged event to the dApp
  const chainIdHex = '0x' + requestedChainId.toString(16);
  if (webview) {
    sendProviderEvent(webview, 'chainChanged', chainIdHex);
    console.log('[DappProvider] Emitted chainChanged:', chainIdHex);
  }

  return null;
}

/**
 * Send a response back to the webview
 */
function sendProviderResponse(webview, id, result, error) {
  console.log('[DappProvider] sendProviderResponse:', { id, result, error, hasWebview: !!webview, hasSend: !!(webview && webview.send) });
  if (webview && webview.send) {
    webview.send('dapp:provider-response', { id, result, error });
  } else {
    console.error('[DappProvider] Cannot send response - webview or send missing');
  }
}

/**
 * Send an event to a webview
 */
function sendProviderEvent(webview, event, data) {
  if (webview && webview.send) {
    webview.send('dapp:provider-event', { event, data });
  }
}

/**
 * Setup provider request listener for a webview
 */
export function setupWebviewProvider(webview) {
  if (!webview) return;

  providerWebviews.add(webview);
  webview.addEventListener('destroyed', () => {
    providerWebviews.delete(webview);
  });

  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'dapp:provider-request') {
      const request = event.args[0];
      handleProviderRequest(webview, request);
    }
  });

  // Initialize provider state for this webview
  getProviderState(webview);
}

export function unregisterWebviewProvider(webview) {
  providerWebviews.delete(webview);
}

/**
 * Set the active webview (for sending events)
 */
export function setActiveWebview(webview) {
  activeWebview = webview;

  // Update connection banner after a small delay to allow address bar to update
  setTimeout(() => {
    updateConnectionBanner();
  }, 50);
}

/**
 * Get the current active webview
 */
export function getActiveWebview() {
  return activeWebview;
}

/**
 * Emit accountsChanged event to a webview
 */
export function emitAccountsChanged(webview, accounts) {
  sendProviderEvent(webview, 'accountsChanged', accounts);
}

/**
 * Emit chainChanged event to a webview
 */
export function emitChainChanged(webview, chainId) {
  sendProviderEvent(webview, 'chainChanged', chainId);
}

/**
 * Emit connect event to a webview
 */
export function emitConnect(webview, chainId) {
  sendProviderEvent(webview, 'connect', { chainId });
}

/**
 * Emit disconnect event to a webview
 */
export function emitDisconnect(webview, error) {
  sendProviderEvent(webview, 'disconnect', error || { code: 4900, message: 'Disconnected' });
}

/**
 * Broadcast event to all webviews (when chain changes globally, etc.)
 */
export function broadcastProviderEvent(event, data) {
  for (const webview of providerWebviews) {
    sendProviderEvent(webview, event, data);
  }
}

// Export state for wallet UI to access
export const walletState = {
  selectedChainId: 100, // Default to Gnosis
};

// Make walletState accessible globally for provider
if (typeof window !== 'undefined') {
  window.walletState = walletState;
}
