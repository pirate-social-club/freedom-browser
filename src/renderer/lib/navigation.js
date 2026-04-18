// Navigation, webview, and address bar handling
import { state } from './state.js';
import { pushDebug } from './debug.js';
import { updateBookmarkButtonVisibility } from './bookmarks-ui.js';
import { updateGithubBridgeIcon } from './github-bridge-ui.js';
import {
  applyEnsSuffix,
  buildRadicleDisabledUrl,
  buildViewSourceNavigation,
  deriveDisplayAddress,
  deriveSwitchedTabDisplay,
  extractEnsResolutionMetadata,
  getBookmarkBarState,
  getOriginalUrlFromErrorPage,
  getRadicleDisplayUrl,
  resolveProtocolIconType,
} from './navigation-utils.js';
import {
  formatBzzUrl,
  formatIpfsUrl,
  formatRadicleUrl,
  deriveBzzBaseFromUrl,
  deriveIpfsBaseFromUrl,
  deriveRadBaseFromUrl,
  normalizeHnsHostInput,
  parseSpacesRootInput,
} from './url-utils.js';
import {
  getActiveWebview,
  getActiveTab,
  getActiveTabState,
  setWebviewEventHandler,
  updateActiveTabTitle,
  updateTabFavicon,
  setTabLoading,
  getTabs,
} from './tabs.js';
import {
  homeUrl,
  homeUrlNormalized,
  landingUrl,
  landingUrlNormalized,
  isHomeUrl,
  isHnsHomeReady,
  errorUrlBase,
  internalPages,
  detectProtocol,
  isHistoryRecordable,
  getInternalPageName,
  parseEnsInput,
} from './page-urls.js';

// Helper to get active tab's navigation state (with fallback to empty object)
const getNavState = () => getActiveTabState() || {};

const electronAPI = window.electronAPI;
const RADICLE_DISABLED_MESSAGE =
  'Radicle integration is disabled. Enable it in Settings > Experimental';

// DOM elements (initialized in initNavigation)
let addressInput = null;
let navForm = null;
let backBtn = null;
let forwardBtn = null;
let reloadBtn = null;
let homeBtn = null;
let bookmarksBar = null;
let protocolIcon = null;

// Bookmark bar toggle state: true = always show, false = hide on non-home pages (default)
let bookmarkBarOverride = false;

// Track previous active tab ID to save address bar state when switching
let previousActiveTabId = null;



// Last recorded URL to avoid duplicates in quick succession
let lastRecordedUrl = null;

// Track if current tab is viewing source (view-source: URLs report inner URL in events)
let isViewingSource = false;

// Callback when history is recorded (for autocomplete cache refresh)
let onHistoryRecorded = null;
export const setOnHistoryRecorded = (callback) => {
  onHistoryRecorded = callback;
};

const isSingleLabelHostname = (value = '') => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname || '';
    return Boolean(hostname) && !hostname.includes('.');
  } catch {
    return false;
  }
};

const isBundledHnsReady = () => {
  if (!state.enableHnsIntegration) return false;
  return state.registry?.hns?.canaryReady === true;
};

const normalizeExplicitHnsUrlInput = (value = '') => {
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.port || parsed.username || parsed.password) {
      return null;
    }

    const candidate = `${parsed.hostname}${parsed.pathname}${parsed.search}${parsed.hash}`;
    return normalizeHnsHostInput(candidate);
  } catch {
    return null;
  }
};

const selectSpacesTargetUrl = (result) => {
  if (!result || result.type !== 'ok') return null;

  if (isHnsHomeReady() && result.freedomUrl) {
    return result.freedomUrl;
  }

  return result.webUrl || result.freedomUrl || result.selectedUrl || null;
};

const rememberDisplayAlias = (navState, targetUrl, displayValue) => {
  if (!navState || !targetUrl || !displayValue) return;
  if (!navState.displayAliases) {
    navState.displayAliases = new Map();
  }
  navState.displayAliases.set(targetUrl, displayValue);
};

const deriveDisplayForUrl = (url, navState = getNavState()) =>
  deriveDisplayAddress({
    url,
    bzzRoutePrefix: state.bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix: state.ipfsRoutePrefix,
    ipnsRoutePrefix: state.ipnsRoutePrefix,
    radicleApiPrefix: state.radicleApiPrefix,
    knownEnsNames: state.knownEnsNames,
    displayAliases: navState?.displayAliases,
  });

const buildSpaceBrowserUrl = (result = {}, requestedHandle = '') => {
  const pageUrl = new URL('pages/space-browser.html', window.location.href);
  const handle = result.handle || requestedHandle;
  if (handle) {
    pageUrl.searchParams.set('handle', handle);
  }
  if (result.type) {
    pageUrl.searchParams.set('type', result.type);
  }
  if (result.reason) {
    pageUrl.searchParams.set('reason', result.reason);
  }
  if (result.message) {
    pageUrl.searchParams.set('message', result.message);
  }
  if (result.fallbackReason) {
    pageUrl.searchParams.set('fallbackReason', result.fallbackReason);
  }
  if (result.txid) {
    pageUrl.searchParams.set('txid', result.txid);
  }
  if (Number.isInteger(result.n)) {
    pageUrl.searchParams.set('n', String(result.n));
  }
  if (result.rootPubkey) {
    pageUrl.searchParams.set('rootPubkey', result.rootPubkey);
  }
  if (result.proofRootHash) {
    pageUrl.searchParams.set('proofRootHash', result.proofRootHash);
  }
  if (Number.isInteger(result.acceptedAnchorHeight)) {
    pageUrl.searchParams.set('acceptedAnchorHeight', String(result.acceptedAnchorHeight));
  }
  if (result.acceptedAnchorBlockHash) {
    pageUrl.searchParams.set('acceptedAnchorBlockHash', result.acceptedAnchorBlockHash);
  }
  if (result.acceptedAnchorRootHash) {
    pageUrl.searchParams.set('acceptedAnchorRootHash', result.acceptedAnchorRootHash);
  }
  if (result.controlClass) {
    pageUrl.searchParams.set('controlClass', result.controlClass);
  }
  if (result.operationClass) {
    pageUrl.searchParams.set('operationClass', result.operationClass);
  }
  if (result.canonicalHandle) {
    pageUrl.searchParams.set('canonicalHandle', result.canonicalHandle);
  }
  if (result.observationProvider) {
    pageUrl.searchParams.set('observationProvider', result.observationProvider);
  }
  if (typeof result.proofVerified === 'boolean') {
    pageUrl.searchParams.set('proofVerified', result.proofVerified ? 'true' : 'false');
  }
  if (result.source) {
    pageUrl.searchParams.set('source', result.source);
  }
  if (result.webUrl) {
    pageUrl.searchParams.set('webUrl', result.webUrl);
  }
  if (result.freedomUrl) {
    pageUrl.searchParams.set('freedomUrl', result.freedomUrl);
  }
  return pageUrl.toString();
};

const loadSpacesResultPage = ({
  webview,
  navState,
  result,
  displayValue,
  requestedHandle,
}) => {
  const targetUrl = buildSpaceBrowserUrl(result, requestedHandle);
  rememberDisplayAlias(navState, targetUrl, displayValue);
  addressInput.value = displayValue;
  navState.pendingTitleForUrl = targetUrl;
  navState.pendingNavigationUrl = targetUrl;
  navState.hasNavigatedDuringCurrentLoad = false;
  safeLoadUrl(webview, targetUrl, 'spaces-result');
  syncBzzBase(null);
  syncIpfsBase(null);
  syncRadBase(null);
  updateProtocolIcon();
};

const loadHnsNotReadyPage = (webview, navState, inputValue, hnsUrl, hnsState) => {
  const errorUrl = new URL(errorUrlBase);
  errorUrl.searchParams.set('error', 'HNS_NOT_READY');
  errorUrl.searchParams.set('url', hnsUrl);
  if (hnsState?.height > 0) {
    errorUrl.searchParams.set('height', String(hnsState.height));
  }
  addressInput.value = inputValue;
  navState.pendingHnsUrl = hnsUrl;
  navState.pendingTitleForUrl = hnsUrl;
  navState.pendingNavigationUrl = errorUrl.toString();
  navState.hasNavigatedDuringCurrentLoad = false;
  safeLoadUrl(webview, errorUrl.toString(), 'hns-not-ready');
  syncBzzBase(null);
  syncIpfsBase(null);
  syncRadBase(null);
};

const clearPendingHnsNavigation = (navState) => {
  if (!navState) return;
  navState.pendingHnsUrl = null;
};

const setLoading = (isLoading) => {
  setTabLoading(isLoading);
  updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
};

const isBenignLoadUrlError = (err) => {
  const code = err?.code || '';
  const errno = err?.errno;
  const message = String(err?.message || '');

  return (
    code === 'ERR_ABORTED' ||
    code === 'ERR_FAILED' ||
    errno === -3 ||
    errno === -2 ||
    message.includes('ERR_ABORTED') ||
    message.includes('ERR_FAILED')
  );
};

const safeLoadUrl = (webview, url, context = 'navigation') => {
  try {
    const result = webview.loadURL(url);
    Promise.resolve(result).catch((err) => {
      if (isBenignLoadUrlError(err)) {
        pushDebug(
          `[Nav] Ignored ${context} loadURL noise for ${url}: ${err.code || err.errno || err.message}`
        );
        return;
      }
      pushDebug(`[Nav] loadURL failed during ${context} for ${url}: ${err.message || err}`);
      console.error(`[Nav] loadURL failed during ${context}`, err);
    });
  } catch (err) {
    if (isBenignLoadUrlError(err)) {
      pushDebug(
        `[Nav] Ignored ${context} loadURL noise for ${url}: ${err.code || err.errno || err.message}`
      );
      return;
    }
    throw err;
  }
};

const storeEnsResolutionMetadata = (targetUri, ensName, { trackProtocol = true } = {}) => {
  const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(targetUri, ensName);

  for (const [key, name] of knownEnsPairs) {
    state.knownEnsNames.set(key, name);
  }

  if (trackProtocol && resolvedProtocol) {
    state.ensProtocols.set(ensName, resolvedProtocol);
  }
};

// Track certificate status for current page
let currentPageSecure = false;

// Update protocol icon based on address bar value
const updateProtocolIcon = () => {
  if (!protocolIcon) return;

  const protocol = resolveProtocolIconType({
    value: addressInput?.value || '',
    ensProtocols: state.ensProtocols,
    enableRadicleIntegration: state.enableRadicleIntegration,
    currentPageSecure,
  });

  if (protocol) {
    protocolIcon.setAttribute('data-protocol', protocol);
    protocolIcon.classList.add('visible');
  } else {
    protocolIcon.removeAttribute('data-protocol');
    protocolIcon.classList.remove('visible');
  }
};

// Set page security status (called from certificate-error handler)
export const setPageSecure = (secure) => {
  currentPageSecure = secure;
  updateProtocolIcon();
};

const updateNavigationState = () => {
  const webview = getActiveWebview();
  if (!webview) {
    if (backBtn) backBtn.disabled = true;
    if (forwardBtn) forwardBtn.disabled = true;
    return;
  }
  try {
    if (backBtn) backBtn.disabled = !webview.canGoBack();
    if (forwardBtn) forwardBtn.disabled = !webview.canGoForward();
  } catch (err) {
    pushDebug(`[Nav] Webview not ready for canGoBack/canGoForward: ${err.message}`);
    if (backBtn) backBtn.disabled = true;
    if (forwardBtn) forwardBtn.disabled = true;
  }
};

const ensureWebContentsId = () => {
  const navState = getNavState();
  if (navState.cachedWebContentsId) {
    return Promise.resolve(navState.cachedWebContentsId);
  }
  if (navState.resolvingWebContentsId) {
    return navState.resolvingWebContentsId;
  }
  navState.resolvingWebContentsId = new Promise((resolve) => {
    const attempt = () => {
      const webview = getActiveWebview();
      if (webview && typeof webview.getWebContentsId === 'function') {
        const value = webview.getWebContentsId();
        if (typeof value === 'number' && value > 0) {
          navState.cachedWebContentsId = value;
          resolve(value);
          return;
        }
      }
      setTimeout(attempt, 50);
    };
    attempt();
  });
  return navState.resolvingWebContentsId;
};

const syncBzzBase = (nextBase) => {
  const navState = getNavState();
  if (!electronAPI || (!electronAPI.setBzzBase && !electronAPI.clearBzzBase)) {
    return;
  }
  if (navState.currentBzzBase === nextBase) {
    return;
  }
  navState.currentBzzBase = nextBase || null;
  ensureWebContentsId()
    .then((id) => {
      if (!id) return;
      if (navState.currentBzzBase) {
        electronAPI.setBzzBase?.(id, navState.currentBzzBase);
      } else {
        electronAPI.clearBzzBase?.(id);
      }
    })
    .catch((err) => {
      console.error('Failed to sync bzz base', err);
    });
};

const syncIpfsBase = (nextBase) => {
  const navState = getNavState();
  if (!electronAPI || (!electronAPI.setIpfsBase && !electronAPI.clearIpfsBase)) {
    return;
  }
  if (navState.currentIpfsBase === nextBase) {
    return;
  }
  navState.currentIpfsBase = nextBase || null;
  ensureWebContentsId()
    .then((id) => {
      if (!id) return;
      if (navState.currentIpfsBase) {
        electronAPI.setIpfsBase?.(id, navState.currentIpfsBase);
      } else {
        electronAPI.clearIpfsBase?.(id);
      }
    })
    .catch((err) => {
      console.error('Failed to sync ipfs base', err);
    });
};

const syncRadBase = (nextBase) => {
  const navState = getNavState();
  if (!electronAPI || (!electronAPI.setRadBase && !electronAPI.clearRadBase)) {
    return;
  }
  if (navState.currentRadBase === nextBase) {
    return;
  }
  navState.currentRadBase = nextBase || null;
  ensureWebContentsId()
    .then((id) => {
      if (!id) return;
      if (navState.currentRadBase) {
        electronAPI.setRadBase?.(id, navState.currentRadBase);
      } else {
        electronAPI.clearRadBase?.(id);
      }
    })
    .catch((err) => {
      console.error('Failed to sync rad base', err);
    });
};

export const loadTarget = (value, displayOverride = null, targetWebview = null) => {
  // Use provided webview or fall back to active webview
  const webview = targetWebview || getActiveWebview();
  const navState = getNavState();
  if (!webview) {
    pushDebug('No active webview to load target');
    return;
  }

  clearPendingHnsNavigation(navState);

  // Handle view-source: URLs - need to resolve dweb URLs before loading
  if (value.startsWith('view-source:')) {
    isViewingSource = true; // Track that this tab is viewing source
    const innerUrl = value.slice(12); // 'view-source:'.length === 12

    // If inner URL is a dweb URL, we need to resolve it first
    // Check for ENS
    const ens = parseEnsInput(innerUrl);
    if (ens && electronAPI?.resolveEns) {
      const capturedWebview = webview;
      setLoading(true);
      addressInput.value = `view-source:ens://${ens.name}`;
      updateProtocolIcon();
      electronAPI
        .resolveEns(ens.name)
        .then((result) => {
          setLoading(false);
          if (!result || result.type !== 'ok') {
            alert(`ENS resolution failed for ${ens.name}: ${result?.reason || 'no response'}`);
            return;
          }
          // Build target URI with path suffix
          const targetUri = applyEnsSuffix(result.uri, ens.suffix);
          storeEnsResolutionMetadata(targetUri, ens.name, { trackProtocol: false });

          const { loadUrl } = buildViewSourceNavigation({
            value: `view-source:${targetUri}`,
            bzzRoutePrefix: state.bzzRoutePrefix,
            homeUrlNormalized,
            ipfsRoutePrefix: state.ipfsRoutePrefix,
            ipnsRoutePrefix: state.ipnsRoutePrefix,
            radicleApiPrefix: state.radicleApiPrefix,
            knownEnsNames: state.knownEnsNames,
          });

          if (loadUrl === `view-source:${targetUri}`) {
            alert(`Unsupported protocol: ${result.protocol}`);
            return;
          }
          safeLoadUrl(capturedWebview, loadUrl, 'view-source-ens');
        })
        .catch((err) => {
          setLoading(false);
          alert(`ENS resolution error: ${err.message}`);
        });
      return;
    }

    const viewSourceNavigation = buildViewSourceNavigation({
      value,
      bzzRoutePrefix: state.bzzRoutePrefix,
      homeUrlNormalized,
      ipfsRoutePrefix: state.ipfsRoutePrefix,
      ipnsRoutePrefix: state.ipnsRoutePrefix,
      radicleApiPrefix: state.radicleApiPrefix,
      knownEnsNames: state.knownEnsNames,
    });
    addressInput.value = viewSourceNavigation.addressValue;
    updateProtocolIcon();
    safeLoadUrl(webview, viewSourceNavigation.loadUrl, 'view-source');
    return;
  }

  // Not viewing source for regular navigation
  isViewingSource = false;

  // Handle freedom:// protocol for internal pages
  const fbMatch = value.match(/^freedom:\/\/([a-zA-Z0-9-]+)$/i);
  if (fbMatch) {
    const pageName = fbMatch[1].toLowerCase();
    const pageUrl = internalPages[pageName];
    if (pageUrl) {
      safeLoadUrl(webview, pageUrl, 'internal-page');
      pushDebug(`Loading internal page: ${pageName}`);
    } else {
      pushDebug(`Unknown internal page: ${pageName}`);
      alert(
        `Unknown internal page: ${pageName}\nAvailable: ${Object.keys(internalPages).join(', ')}`
      );
    }
    return;
  }

  // Try ENS first (ens:// or .eth/.box addresses)
  const ens = parseEnsInput(value);
  if (ens && electronAPI?.resolveEns) {
    // Capture the webview reference before async operation to prevent loading in wrong tab
    const capturedWebview = webview;
    setLoading(true);
    pushDebug(`Resolving ENS name: ${ens.name}`);
    electronAPI
      .resolveEns(ens.name)
      .then((result) => {
        setLoading(false);
        if (!result) {
          alert('ENS resolution failed: no response');
          return;
        }

        if (result.type !== 'ok') {
          const reason = result.reason || 'Unknown error';
          pushDebug(`ENS resolution failed for ${ens.name}: ${reason}`);
          alert(`ENS resolution failed for ${ens.name}: ${reason}`);
          return;
        }

        if (result.protocol !== 'bzz' && result.protocol !== 'ipfs' && result.protocol !== 'ipns') {
          pushDebug(`ENS content for ${ens.name} uses unsupported protocol ${result.protocol}`);
          alert(
            `ENS content uses unsupported protocol "${result.protocol}". Supported: Swarm (bzz), IPFS, IPNS.`
          );
          return;
        }

        const targetUri = applyEnsSuffix(result.uri, ens.suffix);

        pushDebug(`ENS resolved: ${ens.name} -> ${targetUri}`);

        storeEnsResolutionMetadata(targetUri, ens.name);

        // Pass captured webview to ensure we load in the correct tab
        loadTarget(
          targetUri,
          displayOverride || 'ens://' + ens.name + (ens.suffix || ''),
          capturedWebview
        );
      })
      .catch((err) => {
        setLoading(false);
        console.error('ENS resolution error', err);
        pushDebug(`ENS resolution error for ${ens.name}: ${err.message}`);
        alert(`ENS resolution error for ${ens.name}: ${err.message}`);
      });
    return;
  }

  const spacesInput = parseSpacesRootInput(value);
  if (spacesInput) {
    const displayValue = displayOverride || spacesInput.displayValue;
    const capturedWebview = webview;
    const capturedNavState = navState;

    if (!electronAPI?.resolveSpace) {
      loadSpacesResultPage({
        webview: capturedWebview,
        navState: capturedNavState,
        result: {
          type: 'error',
          handle: spacesInput.routeKey,
          reason: 'RESOLVER_UNAVAILABLE',
          message: 'Spaces resolver is unavailable in this build.',
        },
        displayValue,
        requestedHandle: spacesInput.routeKey,
      });
      return;
    }

    setLoading(true);
    pushDebug(`[AddressBar] Resolving Spaces handle: ${spacesInput.routeKey}`);
    electronAPI
      .resolveSpace(spacesInput.routeKey)
      .then((result) => {
        setLoading(false);

        const selectedUrl = selectSpacesTargetUrl(result);
        if (result?.type === 'ok' && selectedUrl) {
          loadTarget(selectedUrl, displayValue, capturedWebview);
          return;
        }

        loadSpacesResultPage({
          webview: capturedWebview,
          navState: capturedNavState,
          result:
            result || {
              type: 'error',
              handle: spacesInput.routeKey,
              reason: 'EMPTY_RESOLUTION',
              message: 'Spaces resolver returned no data.',
            },
          displayValue,
          requestedHandle: spacesInput.routeKey,
        });
      })
      .catch((err) => {
        setLoading(false);
        console.error('Spaces resolution error', err);
        loadSpacesResultPage({
          webview: capturedWebview,
          navState: capturedNavState,
          result: {
            type: 'error',
            handle: spacesInput.routeKey,
            reason: 'SPACES_RESOLUTION_ERROR',
            message: err.message,
          },
          displayValue,
          requestedHandle: spacesInput.routeKey,
        });
      });
    return;
  }

  // Try Radicle (rad:RID or rad://RID)
  if (value.trim().toLowerCase().startsWith('rad:') || value.trim().toLowerCase().startsWith('rad://')) {
    if (!state.enableRadicleIntegration) {
      pushDebug(RADICLE_DISABLED_MESSAGE);
      const disabledUrl = buildRadicleDisabledUrl(window.location.href, value.trim());
      addressInput.value = value.trim();
      navState.pendingNavigationUrl = disabledUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      safeLoadUrl(webview, disabledUrl, 'radicle-disabled');
      syncRadBase(null);
      syncBzzBase(null);
      syncIpfsBase(null);
      return;
    }
    const radicleTarget = formatRadicleUrl(value, state.radicleBase);
    if (radicleTarget) {
      addressInput.value = displayOverride || radicleTarget.displayValue;
      pushDebug(`[AddressBar] Loading Radicle target, set to: ${addressInput.value}`);
      navState.pendingTitleForUrl = radicleTarget.targetUrl;
      navState.pendingNavigationUrl = radicleTarget.targetUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      // If node is offline, pass status param so rad-browser.html shows error immediately
      if (state.currentRadicleStatus === 'stopped' || state.currentRadicleStatus === 'error') {
        const offlineUrl = new URL(radicleTarget.targetUrl);
        offlineUrl.searchParams.set('status', 'offline');
        safeLoadUrl(webview, offlineUrl.toString(), 'radicle-offline');
      } else {
        safeLoadUrl(webview, radicleTarget.targetUrl, 'radicle');
      }
      pushDebug(`Loading ${radicleTarget.displayValue} via ${radicleTarget.targetUrl}`);
      // rad-browser.html handles its own API calls, no base sync needed
      syncRadBase(null);
      syncBzzBase(null);
      syncIpfsBase(null);
      updateProtocolIcon();
      return;
    }
    // Invalid Radicle ID — show error page
    const withoutScheme = value.trim().replace(/^rad:\/\//i, '').replace(/^rad:/i, '');
    pushDebug(`Invalid Radicle ID: ${withoutScheme}`);
    const errorUrl = new URL('pages/rad-browser.html', window.location.href);
    errorUrl.searchParams.set('error', 'invalid-rid');
    errorUrl.searchParams.set('input', withoutScheme);
    addressInput.value = value.trim();
    navState.pendingNavigationUrl = errorUrl.toString();
    navState.hasNavigatedDuringCurrentLoad = false;
    safeLoadUrl(webview, errorUrl.toString(), 'radicle-error');
    syncRadBase(null);
    syncBzzBase(null);
    syncIpfsBase(null);
    return;
  }

  // Try IPFS (ipfs://, ipns://, or raw CID)
  const ipfsTarget = formatIpfsUrl(value, state.ipfsRoutePrefix);
  if (ipfsTarget) {
    // Clear ENS mapping if directly navigating (not via ENS resolution)
    if (!displayOverride?.startsWith('ens://')) {
      const cidMatch = ipfsTarget.displayValue.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
      const ipnsMatch = ipfsTarget.displayValue.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
      if (cidMatch) state.knownEnsNames.delete(cidMatch[1]);
      if (ipnsMatch) state.knownEnsNames.delete(ipnsMatch[1]);
    }
    addressInput.value = displayOverride || ipfsTarget.displayValue;
    pushDebug(`[AddressBar] Loading IPFS target, set to: ${addressInput.value}`);
    rememberDisplayAlias(navState, ipfsTarget.targetUrl, displayOverride);
    navState.pendingTitleForUrl = ipfsTarget.targetUrl;
    navState.pendingNavigationUrl = ipfsTarget.targetUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    safeLoadUrl(webview, ipfsTarget.targetUrl, 'ipfs');
    pushDebug(`Loading ${ipfsTarget.displayValue} via ${ipfsTarget.targetUrl}`);
    syncIpfsBase(ipfsTarget.baseUrl || null);
    syncBzzBase(null); // Clear bzz base when loading IPFS
    syncRadBase(null); // Clear rad base when loading IPFS
    return;
  }

  // Try Swarm/bzz
  const target = formatBzzUrl(value, state.bzzRoutePrefix);
  if (target) {
    // Clear ENS mapping if directly navigating (not via ENS resolution)
    if (!displayOverride?.startsWith('ens://')) {
      const hashMatch = target.displayValue.match(/^bzz:\/\/([a-fA-F0-9]+)/);
      if (hashMatch) state.knownEnsNames.delete(hashMatch[1].toLowerCase());
    }
    addressInput.value = displayOverride || target.displayValue;
    pushDebug(`[AddressBar] Loading target, set to: ${addressInput.value}`);
    rememberDisplayAlias(navState, target.targetUrl, displayOverride);
    navState.pendingTitleForUrl = target.targetUrl;
    navState.pendingNavigationUrl = target.targetUrl;
    navState.hasNavigatedDuringCurrentLoad = false;
    safeLoadUrl(webview, target.targetUrl, 'swarm');
    pushDebug(`Loading ${target.displayValue} via ${target.targetUrl}`);
    syncBzzBase(target.baseUrl || null);
    syncIpfsBase(null); // Clear ipfs base when loading bzz
    syncRadBase(null); // Clear rad base when loading bzz
    return;
  }

  // Explicit http(s) URLs targeting native HNS hosts should use the same
  // readiness gate as bare HNS input.
  if (state.enableHnsIntegration) {
    const explicitHnsUrl = normalizeExplicitHnsUrlInput(value);
    if (explicitHnsUrl) {
      const hnsState = state.registry?.hns;
      if (!isBundledHnsReady()) {
        loadHnsNotReadyPage(webview, navState, displayOverride || value, explicitHnsUrl, hnsState);
        return;
      }

      addressInput.value = displayOverride || value;
      pushDebug(`[AddressBar] HNS explicit URL: ${value} -> ${explicitHnsUrl}`);
      rememberDisplayAlias(navState, explicitHnsUrl, displayOverride);
      navState.pendingTitleForUrl = explicitHnsUrl;
      navState.pendingNavigationUrl = explicitHnsUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      safeLoadUrl(webview, explicitHnsUrl, 'explicit-hns');
      syncBzzBase(null);
      syncIpfsBase(null);
      syncRadBase(null);
      return;
    }
  }

  // Try HTTP/HTTPS URLs
  if (value.startsWith('http://') || value.startsWith('https://')) {
    addressInput.value = displayOverride || value;
    pushDebug(`[AddressBar] Loading HTTP(S) target: ${value}`);
    rememberDisplayAlias(navState, value, displayOverride);
    navState.pendingTitleForUrl = value;
    navState.pendingNavigationUrl = value;
    navState.hasNavigatedDuringCurrentLoad = false;
    safeLoadUrl(webview, value, 'http');
    pushDebug(`Loading ${value}`);
    syncBzzBase(null);
    syncIpfsBase(null);
    syncRadBase(null);
    return;
  }

  // Try native HNS hostname normalization (when HNS is enabled)
  if (state.enableHnsIntegration) {
    const hnsUrl = normalizeHnsHostInput(value);
    if (hnsUrl) {
      const hnsState = state.registry?.hns;
      if (!isBundledHnsReady()) {
        loadHnsNotReadyPage(webview, navState, displayOverride || value, hnsUrl, hnsState);
        return;
      }

      addressInput.value = displayOverride || value;
      pushDebug(`[AddressBar] HNS normalization: ${value} -> ${hnsUrl}`);
      rememberDisplayAlias(navState, hnsUrl, displayOverride);
      navState.pendingTitleForUrl = hnsUrl;
      navState.pendingNavigationUrl = hnsUrl;
      navState.hasNavigatedDuringCurrentLoad = false;
      safeLoadUrl(webview, hnsUrl, 'hns');
      syncBzzBase(null);
      syncIpfsBase(null);
      syncRadBase(null);
      return;
    }
  }

  pushDebug('Ignoring empty input or invalid URL.');
};

const stopLoadingAndRestore = () => {
  const navState = getNavState();
  if (!navState.isWebviewLoading) {
    return false;
  }
  const webview = getActiveWebview();
  if (webview) {
    webview.stop();
  }
  navState.isWebviewLoading = false;
  const targetUrl = navState.hasNavigatedDuringCurrentLoad
    ? navState.pendingNavigationUrl || navState.currentPageUrl
    : navState.currentPageUrl;
  if (targetUrl) {
    const display = deriveDisplayForUrl(targetUrl, navState);
    addressInput.value = display;
    pushDebug(`[AddressBar] Restored to: ${display} (raw: ${targetUrl})`);
  }
  reloadBtn.dataset.state = 'reload';
  return true;
};

export const loadHomePage = () => {
  const webview = getActiveWebview();
  const navState = getNavState();
  if (!webview) {
    pushDebug('No active webview to load home page');
    return;
  }
  syncBzzBase(null);
  syncIpfsBase(null);
  syncRadBase(null);
  addressInput.value = landingUrl;
  updateProtocolIcon();
  clearPendingHnsNavigation(navState);
  navState.pendingNavigationUrl = landingUrlNormalized;
  navState.hasNavigatedDuringCurrentLoad = false;
  safeLoadUrl(webview, landingUrl, 'home');
  pushDebug('Loading home page');
};

export const resumePendingHnsNavigationIfReady = () => {
  if (!isBundledHnsReady()) return false;

  const webview = getActiveWebview();
  const navState = getNavState();
  const pendingHnsUrl = navState?.pendingHnsUrl;
  if (!webview || !pendingHnsUrl) return false;

  clearPendingHnsNavigation(navState);
  addressInput.value = pendingHnsUrl;
  navState.pendingTitleForUrl = pendingHnsUrl;
  navState.pendingNavigationUrl = pendingHnsUrl;
  navState.hasNavigatedDuringCurrentLoad = false;
  safeLoadUrl(webview, pendingHnsUrl, 'hns-resume');
  pushDebug(`[HNS] Resuming pending navigation: ${pendingHnsUrl}`);
  syncBzzBase(null);
  syncIpfsBase(null);
  syncRadBase(null);
  updateProtocolIcon();
  return true;
};

// Shared error-page retry logic used by both reload variants and the reload button
const retryErrorPageOrReload = (webview, hard) => {
  const current = webview.getURL();
  const originalUrl = getOriginalUrlFromErrorPage(current, errorUrlBase);
  if (originalUrl) {
    pushDebug(`Retrying original URL from error page: ${originalUrl}`);
    loadTarget(originalUrl);
    return;
  }
  if (current.startsWith(errorUrlBase) || current.includes('/error.html?')) {
    try {
      new URL(current);
    } catch (err) {
      pushDebug(`[Nav] Could not extract original URL from error page: ${err.message}`);
    }
  }

  if (hard) {
    webview.reloadIgnoringCache();
    pushDebug('Hard reload triggered');
  } else {
    webview.reload();
    pushDebug('Reload triggered');
  }
};

export const reloadPage = () => {
  const webview = getActiveWebview();
  if (!webview) return;
  retryErrorPageOrReload(webview, false);
};

export const hardReloadPage = () => {
  const webview = getActiveWebview();
  if (!webview) return;
  retryErrorPageOrReload(webview, true);
};

const handleNavigationEvent = (event) => {
  const navState = getNavState();
  const webview = getActiveWebview();
  if (event.url) {
    pushDebug(`[Navigation] Event URL: ${event.url}`);

    // Check if we're on a view-source page by examining the actual webview URL
    // (event.url doesn't include the view-source: prefix, but webview.getURL() does)
    const webviewUrl = webview?.getURL?.() || '';
    const urlIsViewSource = webviewUrl.startsWith('view-source:');

    // Update view-source state (important for back/forward navigation)
    if (urlIsViewSource !== isViewingSource) {
      isViewingSource = urlIsViewSource;
      navState.isViewingSource = urlIsViewSource;
      pushDebug(
        `[Navigation] isViewingSource updated to: ${isViewingSource} (webview URL: ${webviewUrl})`
      );
    }

    // Handle view-source pages - derive display URL and update tab title
    if (urlIsViewSource) {
      // Skip home page navigation events during view-source load
      if (isHomeUrl(event.url) || event.url === homeUrlNormalized) {
        return;
      }
      const displayInner = deriveDisplayAddress({
        url: event.url,
        bzzRoutePrefix: state.bzzRoutePrefix,
        homeUrlNormalized,
        ipfsRoutePrefix: state.ipfsRoutePrefix,
        ipnsRoutePrefix: state.ipnsRoutePrefix,
        radicleApiPrefix: state.radicleApiPrefix,
        knownEnsNames: state.knownEnsNames,
        displayAliases: navState.displayAliases,
      });
      const displayUrl = `view-source:${displayInner || event.url}`;
      addressInput.value = displayUrl;
      pushDebug(`[AddressBar] View source: ${displayUrl}`);
      navState.currentPageUrl = webviewUrl;
      // Update tab title to "view-source:<address>"
      updateActiveTabTitle(displayUrl);
      electronAPI?.setWindowTitle?.(displayUrl);
      updateNavigationState();
      updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
      updateProtocolIcon();
      return;
    }

    // Check for internal pages first
    const internalPageName = getInternalPageName(event.url);
    if (internalPageName) {
      addressInput.value = internalPageName === 'home' ? '' : `freedom://${internalPageName}`;
      pushDebug(`[AddressBar] Internal page: freedom://${internalPageName}`);
      electronAPI?.setWindowTitle?.(
        internalPageName === 'home'
          ? 'New Tab'
          : `${internalPageName.charAt(0).toUpperCase() + internalPageName.slice(1)}`
      );
      navState.pendingTitleForUrl = event.url;
      navState.pendingNavigationUrl = event.url;
      navState.currentPageUrl = event.url;
      navState.hasNavigatedDuringCurrentLoad = true;
      updateNavigationState();
      updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
      updateProtocolIcon();
      return;
    }

    // Check for rad-browser.html URLs (Radicle protocol)
    const radicleDisplayUrl = getRadicleDisplayUrl(event.url);
    if (radicleDisplayUrl) {
      addressInput.value = radicleDisplayUrl;
      pushDebug(`[AddressBar] Radicle page: ${radicleDisplayUrl}`);
      navState.pendingTitleForUrl = event.url;
      navState.pendingNavigationUrl = event.url;
      navState.currentPageUrl = event.url;
      navState.hasNavigatedDuringCurrentLoad = true;
      updateNavigationState();
      updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
      updateProtocolIcon();
      return;
    }

    if (event.url.startsWith(errorUrlBase)) {
      try {
        const parsed = new URL(event.url);
        const originalUrl = parsed.searchParams.get('url');
        if (originalUrl) {
          const display = deriveDisplayForUrl(originalUrl, navState);
          addressInput.value = display;
          pushDebug(`[AddressBar] Error Page -> Original: ${display}`);
        } else {
          addressInput.value = 'Error';
        }
      } catch (err) {
        pushDebug(`[Nav] Could not parse error page URL: ${err.message}`);
        addressInput.value = 'Error';
      }
      electronAPI?.setWindowTitle?.('Error');
    } else {
      const derived = deriveDisplayAddress({
        url: event.url,
        bzzRoutePrefix: state.bzzRoutePrefix,
        homeUrlNormalized,
        ipfsRoutePrefix: state.ipfsRoutePrefix,
        ipnsRoutePrefix: state.ipnsRoutePrefix,
        radicleApiPrefix: state.radicleApiPrefix,
        knownEnsNames: state.knownEnsNames,
        displayAliases: navState.displayAliases,
      });

      // Don't clear address bar if navigating to about:blank and it has a value
      // (happens during "open in new window" before loadTarget runs)
      if (event.url === 'about:blank' && addressInput.value) {
        pushDebug(`[AddressBar] Preserved (about:blank navigation)`);
      } else if (addressInput.value !== derived) {
        addressInput.value = derived;
        pushDebug(`[AddressBar] Updated to: ${derived} (derived from ${event.url})`);
      } else {
        pushDebug(`[AddressBar] Skipped update (already ${derived})`);
      }

      // Sync bases for all protocols
      const bzzBase = deriveBzzBaseFromUrl(event.url);
      const ipfsBase = deriveIpfsBaseFromUrl(event.url);
      const radBase = deriveRadBaseFromUrl(event.url);
      syncBzzBase(bzzBase);
      syncIpfsBase(ipfsBase);
      syncRadBase(radBase);
    }

    navState.pendingTitleForUrl = event.url;
    navState.pendingNavigationUrl = event.url;
    navState.currentPageUrl = event.url;
    navState.hasNavigatedDuringCurrentLoad = true;

    pushDebug(`Navigated to ${event.url}`);
  }
  updateNavigationState();
  updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
  updateProtocolIcon();
};

// Update bookmark bar visibility for a URL change
const updateBookmarkBarState = (url) => {
  if (!bookmarksBar) return;
  const bookmarkBarState = getBookmarkBarState({
    url,
    bookmarkBarOverride,
    homeUrl,
    homeUrlNormalized,
  });
  if (bookmarkBarState.visible) {
    // Always show on new tab page regardless of toggle
    bookmarksBar.classList.remove('hidden');
  } else {
    bookmarksBar.classList.add('hidden');
  }
  // Disable the menu item on the new tab page (toggle has no effect there)
  electronAPI?.setBookmarkBarToggleEnabled?.(!bookmarkBarState.isHomePage);
};

// Toggle bookmark bar visibility and persist to settings
export const toggleBookmarkBar = async () => {
  bookmarkBarOverride = !bookmarkBarOverride;
  // Apply immediately
  const webview = getActiveWebview();
  const url = webview?.getURL?.() || '';
  updateBookmarkBarState(url);
  // Sync checkbox state in system menu
  electronAPI?.setBookmarkBarChecked?.(bookmarkBarOverride);
  pushDebug(`Bookmark bar: ${bookmarkBarOverride ? 'always shown' : 'always hidden'}`);
  // Persist to settings
  const settings = await electronAPI?.getSettings?.();
  if (settings) {
    settings.showBookmarkBar = bookmarkBarOverride;
    await electronAPI?.saveSettings?.(settings);
  }
};

// Called when settings change to refresh current page if needed
export const onSettingsChanged = () => {
  const navState = getNavState();
  updateProtocolIcon();
  if (!state.enableRadicleIntegration && addressInput?.value?.trim().toLowerCase().startsWith('rad:')) {
    loadTarget(addressInput.value);
    return;
  }
  if (navState.currentPageUrl && navState.currentPageUrl.startsWith('bzz://')) {
    loadTarget(addressInput.value);
  }
};

export const initNavigation = () => {
  // Initialize DOM elements
  addressInput = document.getElementById('address-input');
  navForm = document.getElementById('nav-form');
  backBtn = document.getElementById('back-btn');
  forwardBtn = document.getElementById('forward-btn');
  reloadBtn = document.getElementById('reload-btn');
  homeBtn = document.getElementById('home-btn');
  bookmarksBar = document.querySelector('.bookmarks');
  protocolIcon = document.getElementById('protocol-icon');

  // Load bookmark bar visibility from saved settings
  electronAPI?.getSettings?.().then((settings) => {
    if (settings && typeof settings.showBookmarkBar === 'boolean') {
      bookmarkBarOverride = settings.showBookmarkBar;
      electronAPI?.setBookmarkBarChecked?.(bookmarkBarOverride);
    }
  });

  // Address bar events
  addressInput.addEventListener('focus', () => {
    addressInput.select();
  });

  addressInput.addEventListener('focusin', () => {
    const navState = getNavState();
    navState.addressBarSnapshot = addressInput.value;
  });

  // Update protocol icon as user types
  addressInput.addEventListener('input', () => {
    updateProtocolIcon();
  });

  addressInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      const navState = getNavState();
      if (!stopLoadingAndRestore() && navState.addressBarSnapshot) {
        addressInput.value = navState.addressBarSnapshot;
      } else if (navState.pendingTitleForUrl) {
        addressInput.value = deriveDisplayForUrl(navState.pendingTitleForUrl, navState);
      }
      updateProtocolIcon();
      addressInput.blur();
    }
  });

  // Form submission (navigate)
  navForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = addressInput.value;

    // Handle freedom:// protocol for internal pages
    const fbMatch = raw.match(/^freedom:\/\/([a-zA-Z0-9-]+)$/i);
    if (fbMatch) {
      const pageName = fbMatch[1].toLowerCase();
      const pageUrl = internalPages[pageName];
      if (pageUrl) {
        const webview = getActiveWebview();
        if (webview) {
          safeLoadUrl(webview, pageUrl, 'protocol-test');
          pushDebug(`Loading internal page: ${pageName}`);
        }
      } else {
        pushDebug(`Unknown internal page: ${pageName}`);
        alert(
          `Unknown internal page: ${pageName}\nAvailable: ${Object.keys(internalPages).join(', ')}`
        );
      }
      addressInput.blur();
      return;
    }

    const ens = parseEnsInput(raw);

    if (ens && electronAPI?.resolveEns) {
      // Capture the webview reference before async operation to prevent loading in wrong tab
      const capturedWebview = getActiveWebview();
      setLoading(true);
      pushDebug(`Resolving ENS name: ${ens.name}`);
      electronAPI
        .resolveEns(ens.name)
        .then((result) => {
          setLoading(false);
          if (!result) {
            alert('ENS resolution failed: no response');
            return;
          }

          if (result.type !== 'ok') {
            const reason = result.reason || 'Unknown error';
            pushDebug(`ENS resolution failed for ${ens.name}: ${reason}`);
            alert(`ENS resolution failed for ${ens.name}: ${reason}`);
            return;
          }

          // Support both Swarm (bzz) and IPFS protocols
          if (
            result.protocol !== 'bzz' &&
            result.protocol !== 'ipfs' &&
            result.protocol !== 'ipns'
          ) {
            pushDebug(`ENS content for ${ens.name} uses unsupported protocol ${result.protocol}`);
            alert(
              `ENS content uses unsupported protocol "${result.protocol}". Supported: Swarm (bzz), IPFS, IPNS.`
            );
            return;
          }

          const targetUri = applyEnsSuffix(result.uri, ens.suffix);

          pushDebug(`ENS resolved: ${ens.name} -> ${targetUri}`);

          storeEnsResolutionMetadata(targetUri, ens.name);

          // Pass captured webview to ensure we load in the correct tab
          loadTarget(targetUri, 'ens://' + ens.name + (ens.suffix || ''), capturedWebview);
          addressInput.blur();
        })
        .catch((err) => {
          setLoading(false);
          console.error('ENS resolution error', err);
          pushDebug(`ENS resolution error for ${ens.name}: ${err.message}`);
          alert(`ENS resolution error for ${ens.name}: ${err.message}`);
        });
    } else {
      const target = formatBzzUrl(raw, state.bzzRoutePrefix);
      if (target) {
        let hashToCheck = null;
        if (target.targetUrl.startsWith('bzz://')) {
          const match = target.targetUrl.match(/^bzz:\/\/([a-fA-F0-9]+)/);
          if (match) hashToCheck = match[1];
        } else if (target.baseUrl) {
          const match = target.baseUrl.match(/\/bzz\/([a-fA-F0-9]+)/);
          if (match) hashToCheck = match[1];
        }
        if (hashToCheck) {
          state.knownEnsNames.delete(hashToCheck.toLowerCase());
        }
      }

      loadTarget(raw);
      addressInput.blur();
    }
  });

  // Navigation buttons
  backBtn.addEventListener('click', () => {
    const webview = getActiveWebview();
    if (webview?.canGoBack()) webview.goBack();
  });

  forwardBtn.addEventListener('click', () => {
    const webview = getActiveWebview();
    if (webview?.canGoForward()) webview.goForward();
  });

  reloadBtn.addEventListener('click', (e) => {
    const navState = getNavState();
    if (navState.isWebviewLoading) {
      stopLoadingAndRestore();
      reloadBtn.dataset.state = 'reload';
      return;
    }

    const webview = getActiveWebview();
    if (!webview) return;

    retryErrorPageOrReload(webview, e.shiftKey);
  });

  homeBtn?.addEventListener('click', () => {
    loadHomePage();
  });

  // Register webview event handler with tabs module
  setWebviewEventHandler((eventName, data) => {
    const webview = getActiveWebview();
    const navState = getNavState();

    switch (eventName) {
      case 'did-start-loading':
        setLoading(true);
        navState.isWebviewLoading = true;
        reloadBtn.dataset.state = 'stop';
        pushDebug('Webview started loading.');
        break;

      case 'did-stop-loading':
        setLoading(false);
        navState.isWebviewLoading = false;
        navState.hasNavigatedDuringCurrentLoad = false;
        navState.pendingNavigationUrl = '';
        reloadBtn.dataset.state = 'reload';
        if (data.url) {
          updateBookmarkBarState(data.url);
        }
        updateNavigationState();

        // Record history entry after successful page load
        {
          const displayUrl = addressInput?.value;
          const internalUrl = data.url;
          const activeTab = getActiveTab();

          // Update favicon for current tab (always, not just when recording history)
          // Skip internal pages and view-source pages (view-source should use default globe icon)
          if (
            activeTab &&
            displayUrl &&
            !displayUrl.startsWith('freedom://') &&
            !displayUrl.startsWith('view-source:')
          ) {
            // Fetch and cache favicon in background, then update tab favicon
            // Use displayUrl as cache key (so bzz://, ipfs:// sites get unique favicons)
            // Use internalUrl for fetching (the actual HTTP gateway URL)
            electronAPI
              ?.fetchFaviconWithKey?.(internalUrl, displayUrl)
              .then((favicon) => {
                if (favicon) {
                  updateTabFavicon(activeTab.id, displayUrl);
                }
              })
              .catch((err) => {
                pushDebug(`[Nav] Favicon fetch failed for ${displayUrl}: ${err.message}`);
              });

            // Also try to show cached favicon immediately
            updateTabFavicon(activeTab.id, displayUrl);
          }

          // Record history (only once per URL)
          if (isHistoryRecordable(displayUrl, internalUrl) && displayUrl !== lastRecordedUrl) {
            const title = activeTab?.title || '';
            const protocol = detectProtocol(displayUrl);

            electronAPI
              ?.addHistory?.({
                url: displayUrl,
                title,
                protocol,
              })
              .then(() => {
                pushDebug(`[History] Recorded: ${displayUrl}`);
                // Notify autocomplete to refresh cache
                onHistoryRecorded?.();
              })
              .catch((err) => {
                console.error('[History] Failed to record:', err);
              });

            lastRecordedUrl = displayUrl;
          }
        }

        pushDebug('Webview finished loading.');
        break;

      case 'did-fail-load':
        if (webview) webview.classList.remove('hidden');
        setLoading(false);
        navState.isWebviewLoading = false;
        navState.hasNavigatedDuringCurrentLoad = false;
        reloadBtn.dataset.state = 'reload';
        updateNavigationState();

        if (data.event && data.event.errorCode !== -3 && webview) {
          const errorUrl = new URL('pages/error.html', window.location.href);
          const failedUrl = data.event.validatedURL || data.event.url || '';
          const failedError = data.event.errorDescription || data.event.errorCode;
          const isHnsLookupFailure =
            failedError === 'ERR_TUNNEL_CONNECTION_FAILED' && isSingleLabelHostname(failedUrl);

          if (isHnsLookupFailure && !isBundledHnsReady()) {
            errorUrl.searchParams.set('error', 'HNS_NOT_READY');
            if (state.registry?.hns?.height > 0) {
              errorUrl.searchParams.set('height', String(state.registry.hns.height));
            }
          } else {
            errorUrl.searchParams.set('error', isHnsLookupFailure ? 'HNS_LOOKUP_FAILED' : failedError);
          }
          errorUrl.searchParams.set('url', failedUrl);
          safeLoadUrl(webview, errorUrl.toString(), 'error-page');
        }

        pushDebug(
          `Webview failed: ${data.event?.errorDescription || data.event?.errorCode} (${data.event?.validatedURL || 'unknown url'})`
        );
        break;

      case 'did-navigate':
        if (webview) webview.classList.add('hidden');
        // Update bookmarks bar visibility based on destination
        updateBookmarkBarState(data.event?.url);
        // Check if navigated to HTTPS (assume secure until certificate-error fires)
        if (data.event?.url?.startsWith('https://')) {
          currentPageSecure = true;
        } else {
          currentPageSecure = false;
        }
        pushDebug(`did-navigate event fired: ${data.event?.url}`);
        if (data.event) handleNavigationEvent(data.event);
        // Notify other modules that navigation completed (for dApp connection banner)
        document.dispatchEvent(new CustomEvent('navigation-completed'));
        break;

      case 'certificate-error':
        // Certificate error occurred - mark page as insecure
        currentPageSecure = false;
        updateProtocolIcon();
        pushDebug(`Certificate error: ${data.event?.error}`);
        break;

      case 'did-navigate-in-page':
        if (data.event) handleNavigationEvent(data.event);
        // Notify other modules that navigation completed (for dApp connection banner)
        document.dispatchEvent(new CustomEvent('navigation-completed'));
        break;

      case 'dom-ready':
        if (webview) webview.classList.remove('hidden');
        updateNavigationState();
        ensureWebContentsId();
        pushDebug('Webview ready.');
        break;

      case 'tab-switched':
        // Save address bar state to previous tab before switching
        if (previousActiveTabId && previousActiveTabId !== data.tabId) {
          const prevTab = getTabs().find((t) => t.id === previousActiveTabId);
          if (prevTab && prevTab.navigationState) {
            prevTab.navigationState.addressBarSnapshot = addressInput.value;
            prevTab.navigationState.isViewingSource = isViewingSource;
          }
        }
        previousActiveTabId = data.tabId;

        // Update UI state when switching tabs - restore from tab's navigation state
        if (data.tab) {
          const tabNavState = data.tab.navigationState || {};
          const isLoading = data.tab.isLoading || false;
          const url = data.tab.url || tabNavState.currentPageUrl || '';

          // Restore view-source state for this tab (check URL for new tabs)
          isViewingSource = tabNavState.isViewingSource || url.startsWith('view-source:');

          // If tab is loading, prefer addressBarSnapshot (what user typed/was shown)
          // Otherwise derive from the actual URL
          const display = deriveSwitchedTabDisplay({
            url,
            isLoading,
            addressBarSnapshot: tabNavState.addressBarSnapshot,
            isViewingSource,
            bzzRoutePrefix: state.bzzRoutePrefix,
            homeUrlNormalized,
            ipfsRoutePrefix: state.ipfsRoutePrefix,
            ipnsRoutePrefix: state.ipnsRoutePrefix,
            radicleApiPrefix: state.radicleApiPrefix,
            knownEnsNames: state.knownEnsNames,
            displayAliases: tabNavState.displayAliases,
          });
          // Don't clear address bar if it has a value and we're on about:blank
          // (happens during "open in new window" before loadTarget runs)
          if (url === 'about:blank' && addressInput.value) {
            // Keep existing address bar value
          } else {
            addressInput.value = display;
          }
          // Update bookmarks bar visibility based on current page
          updateBookmarkBarState(url);
          // Sync bases for the switched-to tab
          if (tabNavState.currentBzzBase) {
            syncBzzBase(tabNavState.currentBzzBase);
          }
          if (tabNavState.currentIpfsBase) {
            syncIpfsBase(tabNavState.currentIpfsBase);
          }
          if (tabNavState.currentRadBase) {
            syncRadBase(tabNavState.currentRadBase);
          }
          // Sync navigationState.currentPageUrl if tab.url is more recent
          if (data.tab.url && data.tab.url !== tabNavState.currentPageUrl) {
            tabNavState.currentPageUrl = data.tab.url;
          }
          // Sync loading state - use tab.isLoading as source of truth
          setLoading(isLoading);
          tabNavState.isWebviewLoading = isLoading;
          reloadBtn.dataset.state = isLoading ? 'stop' : 'reload';
          // Focus address bar only for new empty tabs (home page)
          // Don't focus for: view-source, links opened in new tab/window, etc.
          const isEmptyNewTab =
            !isViewingSource &&
            !addressInput.value &&
            (isHomeUrl(url) || url === homeUrlNormalized || !url);
          if (data.isNewTab && isEmptyNewTab) {
            addressInput.focus();
          }
          // Update favicon for the switched-to tab (in case it wasn't set)
          if (!data.tab.favicon && display && !display.startsWith('freedom://')) {
            updateTabFavicon(data.tab.id, display);
          }
        }
        updateNavigationState();
        updateBookmarkButtonVisibility();
  updateGithubBridgeIcon();
        updateProtocolIcon();
        break;
    }
  });

  // IPC handler for toggle bookmark bar
  electronAPI?.onToggleBookmarkBar?.(() => {
    toggleBookmarkBar();
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (event) => {
    // Cmd+Shift+R / Ctrl+Shift+R - Hard Reload (check first, before soft reload)
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key &&
      event.key.toLowerCase() === 'r' &&
      !event.altKey
    ) {
      event.preventDefault();
      hardReloadPage();
    }
    // Cmd+R / Ctrl+R - Reload (soft, uses cache)
    else if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key &&
      event.key.toLowerCase() === 'r' &&
      !event.altKey
    ) {
      event.preventDefault();
      reloadPage();
    } else if (event.key === 'Escape') {
      if (stopLoadingAndRestore()) {
        event.preventDefault();
        if (
          document.activeElement &&
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== addressInput
        ) {
          document.activeElement.blur();
        }
      }
    }
  });

  // Note: No initial loadHomePage() - tabs module handles the first tab
};

export const upgradeHomePageIfNeeded = (oldHomeUrl) => {
  const tabs = getTabs();
  if (!tabs.length) return;

  let upgradedCount = 0;

  for (const tab of tabs) {
    const currentUrl = tab.webview?.getURL?.() || tab.url || tab.navigationState?.currentPageUrl || '';
    if (currentUrl !== oldHomeUrl) continue;

    tab.url = landingUrl;
    if (tab.navigationState) {
      tab.navigationState.currentPageUrl = landingUrl;
      tab.navigationState.pendingNavigationUrl = landingUrlNormalized;
      tab.navigationState.hasNavigatedDuringCurrentLoad = false;
    }

    if (tab.id === getActiveTab()?.id) {
      syncBzzBase(null);
      syncIpfsBase(null);
      syncRadBase(null);
      if (addressInput) {
        addressInput.value = landingUrl;
      }
    }

    tab.webview?.loadURL?.(landingUrl);
    upgradedCount++;
  }

  if (upgradedCount > 0) {
    pushDebug(`Homepage upgraded: ${oldHomeUrl} -> ${landingUrl} (${upgradedCount} tab(s))`);
  }
};
