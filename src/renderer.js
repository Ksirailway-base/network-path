



(function () {
  'use strict';

  let captureState = {enabled: false, selectedTabId: null, revision: -1};
  let captureStageInfo = {stage: '', targetAttached: false, networkEnabled: false};
  let lastTargetError = '';
  let captureBusy = false;
  const btnCapture = document.getElementById('btnCapture');
  const captureStatus = document.getElementById('captureStatus');

  function stageStatusLabel() {
    const s = captureStageInfo.stage;
    if (s === 'recording') return 'Recording';
    if (s === 'network_pending') return 'Enabling Network...';
    if (s === 'target_pending') return 'Waiting for target attach';
    if (s === 'ready') return 'Idle';
    if (s === 'waiting_extension') return 'No extension';
    return 'Capture stopped';
  }

  function applyCaptureState(next) {
    if (!next || (next.epoch === captureState.epoch && next.revision < captureState.revision)) return;
    captureState = next;
    openTabsSelect.value = next.selectedTabId == null ? '' : String(next.selectedTabId);
    if (typeof InterceptController !== 'undefined' && InterceptController.renderState) {
      try { InterceptController.renderState(); } catch (e) {}
    }
    btnCapture.textContent = next.enabled ? 'Stop capture' : 'Start capture';
    captureStatus.textContent = stageStatusLabel();
    captureStatus.title = next.enabled
      ? 'Stage: ' + (captureStageInfo.stage || 'requested') + '. Recording is shown only after the extension confirms the target attach and Network.enable.'
      : 'Backend capture is disabled.';
  }
  async function changeCapture(enabled, tabId) {
    if (captureBusy) return;
    captureBusy = true; btnCapture.disabled = true; openTabsSelect.disabled = true;
    try { applyCaptureState(await window.api.setCaptureState(enabled, tabId)); }
    catch (error) { showToast('Capture control failed: ' + (error.message || error), 'error'); applyCaptureState(captureState); }
    finally { captureBusy = false; btnCapture.disabled = false; openTabsSelect.disabled = false; }
  }
  
  const requests = new Map(); 
  const starredIds = new Set();
  let selectedRequestId = null;
  let activeFilter = 'All';
  let activeMethodFilter = 'ALL';
  let activeProtoFilter = 'ALL';
  let activeStatusGroupFilter = null;
  let searchInBody = false;
  let searchText = '';
  let autoScroll = true;
  let currentOutputDir = '';
  let currentSiteFilter = '';

  
  const THEME_KEY = 'np-theme';
  const DENSE_KEY = 'np-dense';
  const FILTERS_KEY = 'np-filters-v1';

  function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  function applyDense(on) {
    document.documentElement.classList.toggle('dense', Boolean(on));
    const b = document.getElementById('btnDenseToggle');
    if (b) b.classList.toggle('active', Boolean(on));
  }
  function initAppearance() {
    let theme = 'dark';
    let dense = false;
    try {
      theme = localStorage.getItem(THEME_KEY) || 'dark';
      dense = localStorage.getItem(DENSE_KEY) === '1';
    } catch (e) {}
    applyTheme(theme);
    applyDense(dense);
    const tBtn = document.getElementById('btnThemeToggle');
    if (tBtn) tBtn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    });
    const dBtn = document.getElementById('btnDenseToggle');
    if (dBtn) dBtn.addEventListener('click', () => {
      const next = !document.documentElement.classList.contains('dense');
      applyDense(next);
      try { localStorage.setItem(DENSE_KEY, next ? '1' : '0'); } catch (e) {}
    });
  }

  function persistFilters() {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({
        category: activeFilter,
        method: activeMethodFilter,
        proto: activeProtoFilter,
        status: activeStatusGroupFilter,
        search: searchFilterInput.value.trim(),
        searchInBody: chkSearchBody ? chkSearchBody.checked : false,
        site: siteFilterInput.value.trim(),
        trackers: chkFilterTrackers ? chkFilterTrackers.checked : true,
        autoScroll: chkAutoScroll ? chkAutoScroll.checked : true
      }));
    } catch (e) {}
  }

  function restoreFilters() {
    let f = null;
    try { f = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch (e) {}
    if (!f) return;
    if (f.category) {
      const tab = document.querySelector('.res-tab[data-type="' + f.category + '"]');
      if (tab) {
        document.querySelectorAll('.res-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        activeFilter = f.category;
      }
    }
    if (f.method) {
      const chip = document.querySelector('.method-chip[data-method="' + f.method + '"]');
      if (chip) {
        methodFilters.querySelectorAll('.method-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        activeMethodFilter = f.method;
      }
    }
    if (f.proto) {
      const ps = document.getElementById('protoSelect');
      if (ps) { ps.value = f.proto; activeProtoFilter = f.proto; }
    }
    if (f.status) {
      const el = document.getElementById('stat' + f.status);
      if (el) { activeStatusGroupFilter = f.status; el.classList.add('active'); }
    }
    if (f.search) {
      searchFilterInput.value = f.search;
      searchText = f.search.toLowerCase();
      btnClearSearch.style.display = 'block';
    }
    if (f.searchInBody && chkSearchBody) { chkSearchBody.checked = true; searchInBody = true; }
    if (typeof f.site === 'string' && f.site) {
      siteFilterInput.value = f.site;
      updateSiteFilterDisplay();
    }
    if (typeof f.trackers === 'boolean' && chkFilterTrackers) {
      chkFilterTrackers.checked = f.trackers;
      filterTrackers = f.trackers;
    }
    if (typeof f.autoScroll === 'boolean' && chkAutoScroll) {
      chkAutoScroll.checked = f.autoScroll;
      autoScroll = f.autoScroll;
    }
  }
  let counts = {
    All: 0,
    Doc: 0,
    CSS: 0,
    JS: 0,
    Font: 0,
    Img: 0,
    Media: 0,
    Manifest: 0,
    Socket: 0,
    Wasm: 0,
    Starred: 0,
    Other: 0
  };

  
  const chromeStatusBadge = document.getElementById('chromeStatusBadge');
  const chromeStatusText = document.getElementById('chromeStatusText');
  const statChromeStatus = document.getElementById('statChromeStatus');
  const statActiveFilter = document.getElementById('statActiveFilter');

  const siteFilterInput = document.getElementById('siteFilterInput');
  const btnClearFilter = document.getElementById('btnClearFilter');
  const openTabsSelect = document.getElementById('openTabsSelect');

  
  const navTraffic = document.getElementById('navTraffic');
  const navIntercept = document.getElementById('navIntercept');
  const chkInterceptEnabled = document.getElementById('chkInterceptEnabled');
  const interceptStateEl = document.getElementById('interceptState');
  const interceptQueueEl = document.getElementById('interceptQueue');
  const btnInterceptForwardAll = document.getElementById('btnInterceptForwardAll');
  const navRepeater = document.getElementById('navRepeater');
  const navSitemap = document.getElementById('navSitemap');
  const navMockRules = document.getElementById('navMockRules');
  const navSessions = document.getElementById('navSessions');
  const navDiff = document.getElementById('navDiff');


  
  const sitemapTreeContent = document.getElementById('sitemapTreeContent');
  const sitemapSelectedPathText = document.getElementById('sitemapSelectedPathText');
  const sitemapMatchingCount = document.getElementById('sitemapMatchingCount');
  const sitemapRequestsList = document.getElementById('sitemapRequestsList');
  const btnRefreshSitemap = document.getElementById('btnRefreshSitemap');

  
  const repTabsBar = document.getElementById('repTabsBar');
  const btnRepNewTab = document.getElementById('btnRepNewTab');

  const btnLaunchChrome = document.getElementById('btnLaunchChrome');
  const btnCheckConnection = document.getElementById('btnCheckConnection');
  const btnNewSession = document.getElementById('btnNewSession');
  const btnClear = document.getElementById('btnClear');
  const confirmClearModal = document.getElementById('confirmClearModal');
  const btnCloseClearModal = document.getElementById('btnCloseClearModal');
  const btnCancelClear = document.getElementById('btnCancelClear');
  const btnConfirmClear = document.getElementById('btnConfirmClear');
  const btnExtBridge = document.getElementById('btnExtBridge');
  const extBridgeModal = document.getElementById('extBridgeModal');
  const btnCloseExtModal = document.getElementById('btnCloseExtModal');
  const btnOpenExtFolderDirect = document.getElementById('btnOpenExtFolderDirect');
  const btnOpenFolder = document.getElementById('btnOpenFolder');
  const statOutputDir = document.getElementById('statOutputDir');

  const resourceTabs = document.getElementById('resourceTabs');
  const methodFilters = document.getElementById('methodFilters');
  const searchFilterInput = document.getElementById('searchFilterInput');
  const btnClearSearch = document.getElementById('btnClearSearch');
  const chkSearchBody = document.getElementById('chkSearchBody');
  const chkFilterTrackers = document.getElementById('chkFilterTrackers');
  const chkAutoScroll = document.getElementById('chkAutoScroll');
  let filterTrackers = true;

  const tablePane = document.getElementById('tablePane');
  const requestsTableBody = document.getElementById('requestsTableBody');
  const emptyState = document.getElementById('emptyState');
  const toastContainer = document.getElementById('toastContainer');
  const btnEmptyLaunchChrome = document.getElementById('btnEmptyLaunchChrome');
  const btnEmptyExtGuide = document.getElementById('btnEmptyExtGuide');
  const btnEmptyOpenFolder = document.getElementById('btnEmptyOpenFolder');

  
  const ICONS = {
    star: '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.8l2.2 4.5 5 .7-3.6 3.5.9 4.9-4.5-2.4-4.5 2.4.9-4.9L2.8 8l5-.7z"/></svg>',
    starFilled: '<svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.8l2.2 4.5 5 .7-3.6 3.5.9 4.9-4.5-2.4-4.5 2.4.9-4.9L2.8 8l5-.7z"/></svg>',
    plus: '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>',
    globe: '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.4 2.2 2.4 12.8 0 15M10 2.5c-2.4 2.2-2.4 12.8 0 15"/></svg>',
    file: '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/></svg>',
    arrowUp: '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15V5"/><path d="M5.5 9.5L10 5l4.5 4.5"/></svg>',
    arrowDown: '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5v10"/><path d="M5.5 10.5L10 15l4.5-4.5"/></svg>'
  };

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message, type = 'info', duration = 3500) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast-item ${type}`;

    toast.innerHTML = `
      <span class="toast-dot ${type}"></span>
      <span class="toast-msg">${escapeHtml(message)}</span>
    `;

    toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, duration);
  }

  const paneResizer = document.getElementById('paneResizer');
  const detailsPane = document.getElementById('detailsPane');
  const detailsEmpty = document.getElementById('detailsEmpty');
  const detailsContent = document.getElementById('detailsContent');
  const btnCloseDetails = document.getElementById('btnCloseDetails');

  
  const detailTabs = document.querySelectorAll('.detail-tab');
  const tabContents = {
    headers: document.getElementById('tab-headers'),
    preview: document.getElementById('tab-preview'),
    response: document.getElementById('tab-response'),
    initiator: document.getElementById('tab-initiator'),
    timing: document.getElementById('tab-timing'),
    auth: document.getElementById('tab-auth'),
    security: document.getElementById('tab-security')
  };

  const btnExportMenu = document.getElementById('btnExportMenu');
  const exportDropdown = document.getElementById('exportDropdown');
  const cardAuthToken = document.getElementById('cardAuthToken');
  const authSummaryContent = document.getElementById('authSummaryContent');
  const cardCookies = document.getElementById('cardCookies');
  const cookiesContent = document.getElementById('cookiesContent');
  const btnCopyAuthToken = document.getElementById('btnCopyAuthToken');
  const btnCopyJwtPayload = document.getElementById('btnCopyJwtPayload');
  const btnCopyCookieHeader = document.getElementById('btnCopyCookieHeader');
  const btnCopyCookiesJson = document.getElementById('btnCopyCookiesJson');

  let currentAuthToken = '';
  let currentJwtPayload = null;
  let currentCookieHeader = '';
  let currentCookiesList = [];

  
  const btnOpenRepeater = document.getElementById('btnOpenRepeater');
  const btnOpenDiff = document.getElementById('btnOpenDiff');

  const repeaterModal = document.getElementById('repeaterModal');
  const repMethod = document.getElementById('repMethod');
  const repUrl = document.getElementById('repUrl');
  const btnRepSend = document.getElementById('btnRepSend');
  const repReqHeadersText = document.getElementById('repReqHeadersText');
  const repReqBodyText = document.getElementById('repReqBodyText');
  const btnRepFormatBody = document.getElementById('btnRepFormatBody');
  const repStatusBadge = document.getElementById('repStatusBadge');
  const repStatusText = document.getElementById('repStatusText');
  const repMetaStats = document.getElementById('repMetaStats');
  const repRespBodyContent = document.getElementById('repRespBodyContent');
  const btnRepCopyResponse = document.getElementById('btnRepCopyResponse');
  const btnRepBeautifyResponse = document.getElementById('btnRepBeautifyResponse');
  const repResHeadersGrid = document.getElementById('repResHeadersGrid');
  const btnRepCopyHeaders = document.getElementById('btnRepCopyHeaders');

  const diffModal = document.getElementById('diffModal');
  const diffSelectA = document.getElementById('diffSelectA');
  const diffSelectB = document.getElementById('diffSelectB');
  const diffResultsContainer = document.getElementById('diffResultsContainer');

  
  const btnRefreshSessions = document.getElementById('btnRefreshSessions');
  const btnEmptyTrash = document.getElementById('btnEmptyTrash');
  const trashBlock = document.getElementById('trashBlock');
  const btnRunCompare = document.getElementById('btnRunCompare');
  const sessionsListEl = document.getElementById('sessionsList');
  const sessCompareA = document.getElementById('sessCompareA');
  const sessCompareB = document.getElementById('sessCompareB');
  const sessionsCompareResults = document.getElementById('sessionsCompareResults');

  
  const mockRulesBadge = document.getElementById('mockRulesBadge');
  const mockModal = document.getElementById('mockModal');
  const btnCloseMockModal = document.getElementById('btnCloseMockModal');
  const mockRulesCount = document.getElementById('mockRulesCount');
  const btnNewMockRule = document.getElementById('btnNewMockRule');
  const mockRulesList = document.getElementById('mockRulesList');
  const mockEditorEmpty = document.getElementById('mockEditorEmpty');
  const mockEditorForm = document.getElementById('mockEditorForm');
  const mockRuleName = document.getElementById('mockRuleName');
  const mockRuleEnabled = document.getElementById('mockRuleEnabled');
  const mockRuleMethod = document.getElementById('mockRuleMethod');
  const mockRuleUrlPattern = document.getElementById('mockRuleUrlPattern');
  const mockRuleStatus = document.getElementById('mockRuleStatus');
  const mockRuleContentType = document.getElementById('mockRuleContentType');
  const mockRuleHeaders = document.getElementById('mockRuleHeaders');
  const btnMockFormatJson = document.getElementById('btnMockFormatJson');
  const btnMockClearBody = document.getElementById('btnMockClearBody');
  const mockRuleBody = document.getElementById('mockRuleBody');
  const btnDeleteMockRule = document.getElementById('btnDeleteMockRule');
  const btnDuplicateMockRule = document.getElementById('btnDuplicateMockRule');
  const btnSaveMockRule = document.getElementById('btnSaveMockRule');
  const btnMockThisRequest = document.getElementById('btnMockThisRequest');

  const securityStatePill = document.getElementById('securityStatePill');
  const securityStateText = document.getElementById('securityStateText');
  const securityConnGrid = document.getElementById('securityConnGrid');


  
  const generalHeadersGrid = document.getElementById('generalHeadersGrid');
  const cardQueryParams = document.getElementById('cardQueryParams');
  const queryParamsGrid = document.getElementById('queryParamsGrid');
  const cardRequestPayload = document.getElementById('cardRequestPayload');
  const requestPayloadContent = document.getElementById('requestPayloadContent');
  const responseHeadersGrid = document.getElementById('responseHeadersGrid');
  const requestHeadersGrid = document.getElementById('requestHeadersGrid');

  const previewContainer = document.getElementById('previewContainer');
  const responseBodyContent = document.getElementById('responseBodyContent');
  const responseMeta = document.getElementById('responseMeta');
  const btnCopyResponse = document.getElementById('btnCopyResponse');
  const btnCopyAsMenu = document.getElementById('btnCopyAsMenu');
  const copyAsDropdown = document.getElementById('copyAsDropdown');
  const btnBeautifyResponse = document.getElementById('btnBeautifyResponse');
  const btnOpenSavedFile = document.getElementById('btnOpenSavedFile');

  const initiatorSummaryGrid = document.getElementById('initiatorSummaryGrid');
  const initiatorStackContainer = document.getElementById('initiatorStackContainer');
  const waterfallContainer = document.getElementById('waterfallContainer');

  
  const statTotalRequests = document.getElementById('statTotalRequests');
  const statTotalBytes = document.getElementById('statTotalBytes');
  const statWebSockets = document.getElementById('statWebSockets');
  const statDelivery = document.getElementById('statDelivery');
  const stat2xx = document.getElementById('stat2xx');
  const stat3xx = document.getElementById('stat3xx');
  const stat4xx = document.getElementById('stat4xx');
  const stat5xx = document.getElementById('stat5xx');

  
  
  

  let lastTabsSignature = null;

  function switchWorkspaceView(viewName) {
    const views = {
      traffic: document.getElementById('viewTraffic'),
      intercept: document.getElementById('viewIntercept'),
      repeater: document.getElementById('viewRepeater'),
      sitemap: document.getElementById('viewSitemap'),
      mock: document.getElementById('viewMock'),
      sessions: document.getElementById('viewSessions'),
      diff: document.getElementById('viewDiff'),
      intercept: document.getElementById('viewIntercept')
    };
    const navs = {
      traffic: navTraffic,
      intercept: navIntercept,
      repeater: navRepeater,
      sitemap: navSitemap,
      mock: navMockRules,
      sessions: navSessions,
      diff: navDiff,
      intercept: navIntercept
    };

    for (const [k, v] of Object.entries(views)) {
      if (v) v.style.display = (k === viewName) ? 'flex' : 'none';
    }
    for (const [k, n] of Object.entries(navs)) {
      if (n) {
        if (k === viewName) n.classList.add('active');
        else n.classList.remove('active');
      }
    }

    if (viewName === 'sitemap') {
      SitemapController.render();
    }
    if (viewName === 'sessions') {
      SessionsController.refresh();
    }
    if (viewName === 'intercept') {
      InterceptController.refresh();
    }
  }

  function setActiveNav(navBtn) {
    if (navBtn === navTraffic) switchWorkspaceView('traffic');
    else if (navBtn === navIntercept) switchWorkspaceView('intercept');
    else if (navBtn === navRepeater) switchWorkspaceView('repeater');
    else if (navBtn === navSitemap) switchWorkspaceView('sitemap');
    else if (navBtn === navMockRules) switchWorkspaceView('mock');
    else if (navBtn === navDiff) switchWorkspaceView('diff');
  }

  
  
  

  let lastInitialState = null;

  async function init() {
    setupEventListeners();
    setupIpcListeners();
    await MockController.init();
    try { applyCaptureState(await window.api.getCaptureState()); } catch (error) { captureStatus.textContent = "Capture controls unavailable"; }

    try {
      const state = await window.api.getInitialState();
      if (state) {
        lastInitialState = state;
        if (state.currentOutputDir) {
          updateDirectoryDisplay(state.currentOutputDir);
        }
        if (state.targetSiteFilter) {
          siteFilterInput.value = state.targetSiteFilter;
          currentSiteFilter = state.targetSiteFilter;
          updateSiteFilterDisplay();
        }
        updateChromeStatusDisplay(state);
        if (Array.isArray(state.openTabs)) {
          renderTabsDropdown(state.openTabs);
        }
        if (state.browserName && btnEmptyLaunchChrome) {
          btnEmptyLaunchChrome.textContent = 'Launch ' + state.browserName;
          const desc = document.querySelector('#emptyState .empty-desc');
          if (desc) desc.textContent = 'Load the bridge extension into a Chromium browser (Chrome, Edge, Brave, Vivaldi, Opera), select a tab, then press Start capture. Firefox/Safari are not supported.';
        }
        if (Array.isArray(state.savedRequests) && state.savedRequests.length > 0) {
          state.savedRequests.forEach((req) => {
            requests.set(req.id, req);
          });
          recalculateCounts();
          renderAllRows();
        }
        if (state.sessionStats) {
          updateStatsFooter(state.sessionStats);
        }
        if (state.excludeTrackers !== undefined) {
          filterTrackers = Boolean(state.excludeTrackers);
          if (chkFilterTrackers) {
            chkFilterTrackers.checked = filterTrackers;
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  function updateDirectoryDisplay(dirPath) {
    currentOutputDir = dirPath;
    if (statOutputDir) statOutputDir.textContent = String(dirPath || '').startsWith('\\\\?\\') ? String(dirPath).slice(4) : dirPath;
  }

  function updateChromeStatusDisplay(statusObj) {
    if (statusObj && statusObj.delivery && statDelivery) {
      const d = statusObj.delivery;
      statDelivery.textContent = `${d.queued || 0} queued / ${d.dropped || 0} dropped`;
      statDelivery.title = `Delivery queue: ${d.queued || 0} events, ${formatBytes(d.backlogBytes || 0)} backlog, ${d.dropped || 0} dropped, ${d.sent || 0} sent`;
      statDelivery.style.color = (d.dropped || 0) > 0 ? 'var(--accent-red)' : '';
    }
    if (statusObj && typeof statusObj.targetError === 'string' && statusObj.targetError && lastTargetError !== statusObj.targetError) {
      lastTargetError = statusObj.targetError;
      showToast('Capture target error: ' + statusObj.targetError, 'error', 6000);
    }
    if (statusObj && typeof statusObj.captureStage === 'string') {
      captureStageInfo = {
        stage: statusObj.captureStage,
        targetAttached: Boolean(statusObj.targetAttached),
        networkEnabled: Boolean(statusObj.networkEnabled)
      };
    }
    if (statusObj && statusObj.bridgeError) {
      chromeStatusBadge.className = 'status-indicator-badge error';
      chromeStatusBadge.title = statusObj.bridgeError;
      chromeStatusText.textContent = 'Port 8765 In Use';
      if (statChromeStatus) {
        statChromeStatus.textContent = 'Port 8765 Conflict';
        statChromeStatus.style.color = '';
      }
      captureStatus.textContent = stageStatusLabel();
      return;
    }

    const isExtension = statusObj && statusObj.isExtensionConnected;
    const isPort = statusObj && statusObj.isPortConnected;
    const isConn = (statusObj && statusObj.isConnected) || isExtension || isPort;
    const stage = captureStageInfo.stage;

    if (isExtension && stage === 'recording') {
      chromeStatusBadge.className = 'status-indicator-badge connected';
      chromeStatusBadge.title = 'Extension connected; capturing the selected tab';
      chromeStatusText.textContent = 'Recording';
      statChromeStatus.textContent = 'Recording';
      statChromeStatus.style.color = '';
    } else if (isExtension && stage === 'target_pending') {
      chromeStatusBadge.className = 'status-indicator-badge waiting';
      chromeStatusBadge.title = 'Extension active, target not attached yet';
      chromeStatusText.textContent = 'Attaching...';
      statChromeStatus.textContent = 'Target Pending';
      statChromeStatus.style.color = '';
    } else if (isExtension && stage === 'network_pending') {
      chromeStatusBadge.className = 'status-indicator-badge waiting';
      chromeStatusBadge.title = 'Target attached, enabling Network domain';
      chromeStatusText.textContent = 'Enabling Network...';
      statChromeStatus.textContent = 'Enabling Network';
      statChromeStatus.style.color = '';
    } else if (isExtension) {
      chromeStatusBadge.className = 'status-indicator-badge connected';
      chromeStatusBadge.title = 'Extension connected; capture is stopped';
      chromeStatusText.textContent = 'Extension ready';
      statChromeStatus.textContent = 'Extension Active';
      statChromeStatus.style.color = '';
    } else if (isPort) {
      
      
      chromeStatusBadge.className = 'status-indicator-badge waiting';
      chromeStatusBadge.title = `Debug port ${statusObj.chromePort || 9222} is open, but capture requires the bridge extension`;
      chromeStatusText.textContent = `Port ${statusObj.chromePort || 9222} (no capture)`;
      statChromeStatus.textContent = `Port ${statusObj.chromePort || 9222} (no capture)`;
      statChromeStatus.style.color = '';
    } else if (isConn) {
      chromeStatusBadge.className = 'status-indicator-badge connected';
      chromeStatusText.textContent = 'Chrome Connected';
      statChromeStatus.textContent = 'Connected';
      statChromeStatus.style.color = '';
    } else {
      chromeStatusBadge.className = 'status-indicator-badge waiting';
      chromeStatusBadge.title = 'Load the extension from the extension/ folder via chrome://extensions';
      chromeStatusText.textContent = 'No extension';
      statChromeStatus.textContent = 'Disconnected';
      statChromeStatus.style.color = '';
    }

    if (typeof captureStatus !== 'undefined' && captureStatus) {
      captureStatus.textContent = stageStatusLabel();
    }
  }

  function updateSiteFilterDisplay() {
    const val = siteFilterInput.value.trim();
    currentSiteFilter = val;
    persistFilters();
    btnClearFilter.style.display = val ? 'inline-block' : 'none';
    statActiveFilter.textContent = val ? val : 'None (All traffic)';
  }

  function renderTabsDropdown(tabs) {
    
    
    const signature = JSON.stringify(tabs || []);
    if (signature === lastTabsSignature && openTabsSelect.options.length > 0) {
      return;
    }
    lastTabsSignature = signature;

    const currentVal = captureState.selectedTabId == null ? '' : String(captureState.selectedTabId);
    openTabsSelect.innerHTML = '<option value="">Select target tab</option>';

    if (!tabs || tabs.length === 0) return;

    tabs.forEach((tab) => {
      const opt = document.createElement('option');
      opt.value = String(tab.id);
      let host = '';
      try {
        host = new URL(tab.url).hostname;
      } catch (e) {
        host = tab.url;
      }
      const activeMark = tab.active ? '[Active] ' : '';
      const title = tab.title ? (tab.title.length > 40 ? tab.title.substring(0, 40) + '...' : tab.title) : host;
      opt.textContent = `${activeMark}${title} (${host})`;
      openTabsSelect.appendChild(opt);
    });

    if (currentVal) {
      if (!Array.from(openTabsSelect.options).some(option => option.value === currentVal)) {
        const missing = document.createElement('option'); missing.value = currentVal; missing.textContent = 'Unavailable tab #' + currentVal; openTabsSelect.appendChild(missing);
      }
      openTabsSelect.value = currentVal;
    }
  }

  
  
  

  function setupEventListeners() {
    
    let filterDebounce = null;
    siteFilterInput.addEventListener('input', () => {
      updateSiteFilterDisplay();
      recalculateCounts();
      renderAllRows();
      clearTimeout(filterDebounce);
      filterDebounce = setTimeout(() => {
        
      }, 300);
    });

    btnClearFilter.addEventListener('click', () => {
      siteFilterInput.value = '';
      updateSiteFilterDisplay();
      recalculateCounts();
      renderAllRows();
      
    });

    
    openTabsSelect.addEventListener('change', () => {
      const tabId = openTabsSelect.value ? Number(openTabsSelect.value) : null;
      changeCapture(false, tabId); 
    });
    btnCapture.addEventListener('click', () => changeCapture(!captureState.enabled, captureState.selectedTabId));

    
    if (btnCheckConnection) {
      btnCheckConnection.addEventListener('click', async () => {
        btnCheckConnection.disabled = true;
        showToast('Checking connection to Chrome...', 'info', 1500);
        try {
          const res = await window.api.checkConnection();
          if (res) {
            updateChromeStatusDisplay(res);
            if (Array.isArray(res.openTabs)) {
              renderTabsDropdown(res.openTabs);
            }
            if (res.isExtensionConnected) {
              showToast('Connected! Chrome extension is active and capturing.', 'success', 3500);
            } else if (res.isPortConnected) {
              showToast(`Debug port ${res.chromePort || 9222} is open, but capture requires the bridge extension. Load extension/ via chrome://extensions.`, 'warning', 5000);
            } else {
              showToast('Chrome is not connected yet. Click "Launch Chrome" or load the extension.', 'warning', 4500);
            }
          } else {
            showToast('No response from backend bridge.', 'error', 3500);
          }
        } catch (e) {
          showToast('Connection check error: ' + (e?.message || e), 'error', 4000);
        } finally {
          setTimeout(() => {
            btnCheckConnection.disabled = false;
          }, 600);
        }
      });
    }

    
    if (btnNewSession) {
      btnNewSession.addEventListener('click', async () => {
        try {
          const res = await window.api.startNewSession();
          requests.clear();
          selectedRequestId = null;
          resetCounts();
          renderAllRows();
          hideDetails();
          if (res && res.currentOutputDir) {
            updateDirectoryDisplay(res.currentOutputDir);
            showToast('New session started: ' + res.currentOutputDir, 'success', 3500);
          }
        } catch (err) {
          showToast(err?.message || String(err), err?.code === 'UNSUPPORTED_CAPABILITY' ? 'warning' : 'error', 5000);
        }
      });
    }

    
    
    
    
    async function handleLaunchChrome() {
      const val = siteFilterInput.value.trim();
      const targetUrl = val && val !== '*' ? (val.startsWith('http') ? val : `https://${val}`) : '';
      const browserName = (lastInitialState && lastInitialState.browserName) || 'Chromium browser';
      if (btnLaunchChrome) btnLaunchChrome.disabled = true;
      if (btnEmptyLaunchChrome) btnEmptyLaunchChrome.disabled = true;
      showToast(`Launching ${browserName} with the Network-path extension...`, 'info', 2500);

      try {
        const ok = await window.api.launchChrome(targetUrl);
        if (ok !== false) {
          showToast(`${browserName} launched! Load the extension if it is not installed yet, then browse any site.`, 'success', 5000);
        } else {
          showToast('Could not launch the browser automatically. Please load the unpacked extension from extension/ folder.', 'warning', 6000);
        }
      } catch (err) {
        showToast('Launch failed: ' + (err?.message || err || 'Unknown error') + ' — install Chrome, Edge, Brave, Vivaldi or Opera (Firefox/Safari are not supported).', 'error', 7000);
      } finally {
        setTimeout(() => {
          if (btnLaunchChrome) btnLaunchChrome.disabled = false;
          if (btnEmptyLaunchChrome) btnEmptyLaunchChrome.disabled = false;
        }, 1200);
      }
    }

    if (btnLaunchChrome) {
      btnLaunchChrome.addEventListener('click', handleLaunchChrome);
    }
    if (btnEmptyLaunchChrome) {
      btnEmptyLaunchChrome.addEventListener('click', handleLaunchChrome);
    }

    if (btnEmptyExtGuide) {
      btnEmptyExtGuide.addEventListener('click', () => {
        if (extBridgeModal) extBridgeModal.style.display = 'flex';
      });
    }
    const btnEmptyCdpDirect = document.getElementById('btnEmptyCdpDirect');
    if (btnEmptyCdpDirect) {
      btnEmptyCdpDirect.addEventListener('click', async () => {
        const val = siteFilterInput.value.trim();
        const target = val && val !== '*' ? (val.startsWith('http') ? val : `https://${val}`) : '';
        try {
          const res = await window.api.startCdpDirect(target);
          showToast('CDP-direct capture started' + (res.tabUrl ? ': ' + res.tabUrl : '') + '. Browse the debug browser — requests land here.', 'success', 6000);
        } catch (e) {
          showToast('CDP-direct failed: ' + (e?.message || e), 'error', 6000);
        }
      });
    }

    if (btnEmptyOpenFolder) {
      btnEmptyOpenFolder.addEventListener('click', async () => {
        showToast('Opening logs folder in Windows Explorer...', 'info', 2000);
        await window.api.openFolder(currentOutputDir);
      });
    }

    
    btnClear.addEventListener('click', () => {
      if (confirmClearModal) {
        confirmClearModal.style.display = 'flex';
      } else {
        performClear();
      }
    });

    if (btnCloseClearModal) {
      btnCloseClearModal.addEventListener('click', () => {
        if (confirmClearModal) confirmClearModal.style.display = 'none';
      });
    }
    if (btnCancelClear) {
      btnCancelClear.addEventListener('click', () => {
        if (confirmClearModal) confirmClearModal.style.display = 'none';
      });
    }
    if (btnConfirmClear) {
      btnConfirmClear.addEventListener('click', async () => {
        if (confirmClearModal) confirmClearModal.style.display = 'none';
        await performClear();
        showToast('View cleared. Saved files and capture are unchanged.', 'info', 3000);
      });
    }

    async function performClear() {
      requests.clear();
      selectedRequestId = null;
      resetCounts();
      renderAllRows();
      hideDetails();
      pendingRowUpdates.clear();
    }

    
    if (btnOpenFolder) {
      btnOpenFolder.addEventListener('click', async () => {
        showToast('Opening logs directory in Windows Explorer...', 'info', 2000);
        await window.api.openFolder(currentOutputDir);
      });
    }

    
    resourceTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.res-tab');
      if (!tab) return;
      document.querySelectorAll('.res-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.getAttribute('data-type');
      persistFilters();
      renderAllRows();
    });

    
    searchFilterInput.addEventListener('input', () => {
      searchText = searchFilterInput.value.trim().toLowerCase();
      btnClearSearch.style.display = searchText ? 'block' : 'none';
      persistFilters();
      renderAllRows();
    });

    btnClearSearch.addEventListener('click', () => {
      searchFilterInput.value = '';
      searchText = '';
      btnClearSearch.style.display = 'none';
      persistFilters();
      renderAllRows();
    });

    
    if (methodFilters) {
      methodFilters.addEventListener('click', (e) => {
        const chip = e.target.closest('.method-chip');
        if (!chip) return;
        methodFilters.querySelectorAll('.method-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        activeMethodFilter = chip.getAttribute('data-method') || 'ALL';
        persistFilters();
        renderAllRows();
      });
    }

    
    const protoSelect = document.getElementById('protoSelect');
    if (protoSelect) {
      protoSelect.addEventListener('change', () => {
        activeProtoFilter = protoSelect.value || 'ALL';
        persistFilters();
        renderAllRows();
      });
    }

    
    if (chkSearchBody) {
      chkSearchBody.addEventListener('change', () => {
        searchInBody = chkSearchBody.checked;
        persistFilters();
        renderAllRows();
      });
    }

    
    [
      { id: 'stat2xx', group: '2xx' },
      { id: 'stat3xx', group: '3xx' },
      { id: 'stat4xx', group: '4xx' },
      { id: 'stat5xx', group: '5xx' }
    ].forEach(({ id, group }) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        if (activeStatusGroupFilter === group) {
          activeStatusGroupFilter = null;
          el.classList.remove('active');
        } else {
          activeStatusGroupFilter = group;
          document.querySelectorAll('.status-count').forEach((c) => c.classList.remove('active'));
          el.classList.add('active');
        }
        persistFilters();
        renderAllRows();
      });
    });

    
    restoreFilters();
    initAppearance();

    
    if (chkFilterTrackers) {
      chkFilterTrackers.addEventListener('change', () => {
        filterTrackers = chkFilterTrackers.checked;
        persistFilters();
        window.api.setExcludeTrackers(filterTrackers).catch((err) => {
          if (err && err.code === 'UNSUPPORTED_CAPABILITY') return; 
          showToast('Tracker filter sync failed: ' + (err?.message || err), 'warning');
        });
        recalculateCounts();
        renderAllRows();
      });
    }

    
    chkAutoScroll.addEventListener('change', () => {
      autoScroll = chkAutoScroll.checked;
      persistFilters();
    });

    
    detailTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        detailTabs.forEach((t) => t.classList.remove('active'));
        Object.values(tabContents).forEach((c) => c.classList.remove('active'));

        tab.classList.add('active');
        const tabKey = tab.getAttribute('data-tab');
        if (tabContents[tabKey]) {
          tabContents[tabKey].classList.add('active');
        }
      });
    });

    btnCloseDetails.addEventListener('click', () => {
      hideDetails();
    });

    
    btnCopyResponse.addEventListener('click', () => {
      const req = requests.get(selectedRequestId);
      if (req && req.response && req.response.body) {
        const text = typeof req.response.body === 'object'
          ? JSON.stringify(req.response.body, null, 2)
          : String(req.response.body);
        copyToClipboard(text, btnCopyResponse, 'Copied!');
      }
    });

    
    if (btnCopyAsMenu && copyAsDropdown) {
      btnCopyAsMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        copyAsDropdown.classList.toggle('show');
      });

      document.addEventListener('click', (e) => {
        if (!copyAsDropdown.contains(e.target) && e.target !== btnCopyAsMenu) {
          copyAsDropdown.classList.remove('show');
        }
      });

      copyAsDropdown.querySelectorAll('.dropdown-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          copyAsDropdown.classList.remove('show');
          const format = item.getAttribute('data-format');
          const req = requests.get(selectedRequestId);
          if (!req) {
            copyToClipboard('', btnCopyAsMenu, 'Select a request first!');
            return;
          }
          let code = '';
          switch (format) {
            case 'curl':
              code = CodeGenerator.toCurl(req);
              break;
            case 'py-curl-cffi':
              code = CodeGenerator.toPythonCurlCffi(req);
              break;
            case 'py-requests':
              code = CodeGenerator.toPythonRequests(req);
              break;
            case 'py-httpx':
              code = CodeGenerator.toPythonHttpx(req);
              break;
            case 'fetch':
              code = CodeGenerator.toFetch(req);
              break;
          }
          if (code) {
            copyToClipboard(code, btnCopyAsMenu, 'Copied Code!');
          }
        });
      });
    }

    
    if (btnBeautifyResponse) {
      btnBeautifyResponse.addEventListener('click', () => {
        const text = responseBodyContent.textContent;
        if (!text || text.startsWith('(No response body')) return;
        try {
          const parsed = JSON.parse(text);
          responseBodyContent.textContent = JSON.stringify(parsed, null, 2);
        } catch (e) {}
        const orig = btnBeautifyResponse.innerHTML;
        btnBeautifyResponse.innerHTML = '<span class="btn-label" style="color: var(--accent-green);">Formatted</span>';
        setTimeout(() => {
          btnBeautifyResponse.innerHTML = orig;
        }, 1200);
      });
    }

    
    if (btnExportMenu && exportDropdown) {
      btnExportMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.toggle('show');
        exportDropdown.style.display = exportDropdown.classList.contains('show') ? 'flex' : 'none';
      });

      document.addEventListener('click', (e) => {
        if (!exportDropdown.contains(e.target) && e.target !== btnExportMenu) {
          exportDropdown.classList.remove('show');
          exportDropdown.style.display = 'none';
        }
      });

      exportDropdown.querySelectorAll('.dropdown-item').forEach((item) => {
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          exportDropdown.classList.remove('show');
          exportDropdown.style.display = 'none';
          const type = item.getAttribute('data-export');
          const matching = [];
          requests.forEach((r) => {
            if (matchesCurrentFilter(r)) matching.push(r);
          });
          if (matching.length === 0) {
            copyToClipboard('', btnExportMenu, 'No requests to export!');
            return;
          }

          let filename = '';
          let content = '';
          let mime = 'application/json';

          switch (type) {
            case 'har':
              filename = 'session.har';
              content = ExportManager.toHAR(matching);
              mime = 'application/json';
              break;
            case 'postman':
              filename = 'postman_collection.json';
              content = ExportManager.toPostman(matching);
              mime = 'application/json';
              break;
            case 'csv':
              filename = 'requests.csv';
              content = ExportManager.toCSV(matching);
              mime = 'text/csv';
              break;
            case 'json':
              filename = 'requests.json';
              content = ExportManager.toJSON(matching);
              mime = 'application/json';
              break;
            case 'swagger':
              filename = 'openapi.json';
              content = ExportManager.toOpenAPI(matching);
              mime = 'application/json';
              break;
            case 'scraper':
              filename = 'scraper.py';
              content = ExportManager.toScraper(matching);
              mime = 'text/x-python';
              break;
          }

          if (content) {
            await ExportManager.saveAndDownload(filename, content, mime);
            copyToClipboard('', btnExportMenu, `Exported ${filename}!`);
          }
        });
      });
    }

    
    if (btnCopyAuthToken) {
      btnCopyAuthToken.addEventListener('click', () => {
        if (currentAuthToken) {
          copyToClipboard(currentAuthToken, btnCopyAuthToken, 'Copied Token!');
        }
      });
    }

    if (btnCopyJwtPayload) {
      btnCopyJwtPayload.addEventListener('click', () => {
        if (currentJwtPayload) {
          copyToClipboard(JSON.stringify(currentJwtPayload, null, 2), btnCopyJwtPayload, 'Copied Claims!');
        }
      });
    }

    if (btnCopyCookieHeader) {
      btnCopyCookieHeader.addEventListener('click', () => {
        if (currentCookieHeader) {
          copyToClipboard(currentCookieHeader, btnCopyCookieHeader, 'Copied Cookies!');
        }
      });
    }

    if (btnCopyCookiesJson) {
      btnCopyCookiesJson.addEventListener('click', () => {
        if (currentCookiesList && currentCookiesList.length > 0) {
          copyToClipboard(JSON.stringify(currentCookiesList, null, 2), btnCopyCookiesJson, 'Copied JSON!');
        }
      });
    }

    
    
    if (navTraffic) {
      navTraffic.addEventListener('click', () => switchWorkspaceView('traffic'));
    }
    if (navIntercept) {
      navIntercept.addEventListener('click', () => switchWorkspaceView('intercept'));
    }
    if (navRepeater) {
      navRepeater.addEventListener('click', () => {
        switchWorkspaceView('repeater');
        RepeaterController.open();
      });
    }
    if (navSitemap) {
      navSitemap.addEventListener('click', () => switchWorkspaceView('sitemap'));
    }
    if (navMockRules) {
      navMockRules.addEventListener('click', () => {
        switchWorkspaceView('mock');
        MockController.open();
      });
    }
    if (navSessions) {
      navSessions.addEventListener('click', () => switchWorkspaceView('sessions'));
    }
    if (navIntercept) {
      navIntercept.addEventListener('click', () => switchWorkspaceView('intercept'));
    }
    if (chkInterceptEnabled) {
      chkInterceptEnabled.addEventListener('change', async () => {
        try {
          await window.api.setIntercept(chkInterceptEnabled.checked);
          InterceptController.renderState();
          showToast(chkInterceptEnabled.checked ? 'Intercept on: new requests of the captured tab will pause here.' : 'Intercept off.', 'info', 3500);
        } catch (err) {
          chkInterceptEnabled.checked = !chkInterceptEnabled.checked;
          showToast('Intercept toggle failed: ' + (err?.message || err), 'error', 5000);
        }
      });
    }
    if (btnInterceptForwardAll) {
      btnInterceptForwardAll.addEventListener('click', () => InterceptController.forwardAll());
    }
    if (navDiff) {
      navDiff.addEventListener('click', () => {
        switchWorkspaceView('diff');
        DiffController.open(selectedRequestId);
      });
    }

    if (btnRefreshSessions) {
      btnRefreshSessions.addEventListener('click', () => SessionsController.refresh());
    }
    const btnSearchAll = document.getElementById('btnSearchAll');
    const searchAllInput = document.getElementById('searchAllInput');
    if (btnSearchAll && searchAllInput) {
      const runSearch = () => SessionsController.searchAll(searchAllInput.value);
      btnSearchAll.addEventListener('click', runSearch);
      searchAllInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    }
    if (btnEmptyTrash) {
      btnEmptyTrash.addEventListener('click', async () => {
        if (!window.confirm('Permanently empty the trash? This cannot be undone.')) return;
        try {
          const n = await window.api.emptyTrash();
          showToast(n ? `Trash emptied: ${n} session(s) removed.` : 'Trash is already empty.', 'success', 3500);
          SessionsController.refresh();
        } catch (e) {
          showToast('Empty trash failed: ' + (e?.message || e), 'error', 5000);
        }
      });
    }
    if (btnRunCompare) {
      btnRunCompare.addEventListener('click', () => SessionsController.compare());
    }

    
    if (btnRepNewTab) {
      btnRepNewTab.addEventListener('click', () => RepeaterController.createNewTab());
    }

    
    if (btnRefreshSitemap) {
      btnRefreshSitemap.addEventListener('click', () => SitemapController.render());
    }

    
    const btnExportSitemap = document.getElementById('btnExportSitemap');
    if (btnExportSitemap) {
      btnExportSitemap.addEventListener('click', async () => {
        const hosts = {};
        requests.forEach((r) => {
          if (!r.url) return;
          try {
            const u = new URL(r.url);
            hosts[u.host] = hosts[u.host] || {};
            const tpl = pathTemplate(u.pathname || '/');
            const entry = hosts[u.host][tpl] || { template: tpl, count: 0, methods: [] };
            entry.count++;
            const m = (r.method || 'GET').toUpperCase();
            if (!entry.methods.includes(m)) entry.methods.push(m);
            hosts[u.host][tpl] = entry;
          } catch (e) {}
        });
        const doc = {
          generator: 'Network-path sitemap',
          generatedAt: new Date().toISOString(),
          hosts: Object.fromEntries(Object.entries(hosts).map(([h, tpls]) => [h, Object.values(tpls)]))
        };
        try {
          await window.api.saveExportFile('sitemap.json', JSON.stringify(doc, null, 2));
          showToast('Sitemap exported to the session exports folder (sitemap.json).', 'success', 4000);
        } catch (e) {
          showToast('Sitemap export failed: ' + (e?.message || e), 'error', 5000);
        }
      });
    }

    
    if (btnOpenRepeater) {
      btnOpenRepeater.addEventListener('click', () => {
        const req = requests.get(selectedRequestId);
        if (req) {
          RepeaterController.openWithRequest(req);
          showToast('Request opened in Repeater', 'info');
        } else {
          RepeaterController.open();
        }
        switchWorkspaceView('repeater');
      });
    }

    if (btnOpenDiff) {
      btnOpenDiff.addEventListener('click', () => {
        DiffController.open(selectedRequestId);
        switchWorkspaceView('diff');
      });
    }


    if (btnRepSend) {
      btnRepSend.addEventListener('click', () => {
        RepeaterController.send();
      });
    }

    if (btnRepFormatBody && repReqBodyText) {
      btnRepFormatBody.addEventListener('click', () => {
        const text = repReqBodyText.value.trim();
        if (!text) return;
        try {
          repReqBodyText.value = JSON.stringify(JSON.parse(text), null, 2);
        } catch (e) {}
      });
    }

    if (btnRepCopyResponse && repRespBodyContent) {
      btnRepCopyResponse.addEventListener('click', () => {
        copyToClipboard(repRespBodyContent.textContent, btnRepCopyResponse, 'Copied!');
      });
    }

    if (btnRepBeautifyResponse && repRespBodyContent) {
      btnRepBeautifyResponse.addEventListener('click', () => {
        const text = repRespBodyContent.textContent.trim();
        if (!text) return;
        try {
          repRespBodyContent.textContent = JSON.stringify(JSON.parse(text), null, 2);
        } catch (e) {}
      });
    }

    if (btnRepCopyHeaders) {
      btnRepCopyHeaders.addEventListener('click', () => {
        const lines = [];
        repResHeadersGrid.querySelectorAll('.kv-key').forEach((kEl, idx) => {
          const vEl = repResHeadersGrid.querySelectorAll('.kv-value')[idx];
          if (kEl && vEl) lines.push(`${kEl.textContent} ${vEl.textContent}`);
        });
        if (lines.length > 0) {
          copyToClipboard(lines.join('\n'), btnRepCopyHeaders, 'Copied!');
        }
      });
    }

    
    document.querySelectorAll('[data-rep-req-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[data-rep-req-tab]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-rep-req-tab');
        const hTab = document.getElementById('repReqTabHeaders');
        const bTab = document.getElementById('repReqTabBody');
        if (target === 'headers') {
          if (hTab) hTab.style.display = 'flex';
          if (bTab) bTab.style.display = 'none';
        } else {
          if (hTab) hTab.style.display = 'none';
          if (bTab) bTab.style.display = 'flex';
        }
      });
    });

    document.querySelectorAll('[data-rep-res-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[data-rep-res-tab]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-rep-res-tab');
        const bTab = document.getElementById('repResTabBody');
        const hTab = document.getElementById('repResTabHeaders');
        if (target === 'body') {
          if (bTab) bTab.style.display = 'flex';
          if (hTab) hTab.style.display = 'none';
        } else {
          if (bTab) bTab.style.display = 'none';
          if (hTab) hTab.style.display = 'flex';
        }
      });
    });

    
    if (diffSelectA) {
      diffSelectA.addEventListener('change', () => DiffController.renderDiff());
    }
    if (diffSelectB) {
      diffSelectB.addEventListener('change', () => DiffController.renderDiff());
    }

    
    document.addEventListener('keydown', (e) => {
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const viewRepeater = document.getElementById('viewRepeater');
        if (viewRepeater && viewRepeater.style.display !== 'none') {
          e.preventDefault();
          RepeaterController.send();
        }
      }
      
      if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R') && !e.shiftKey) {
        if (selectedRequestId && requests.has(selectedRequestId)) {
          e.preventDefault();
          const req = requests.get(selectedRequestId);
          RepeaterController.openWithRequest(req);
          showToast('Request sent to Repeater (Ctrl+R)', 'info');
          switchWorkspaceView('repeater');
        }
      }
      
      if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        const viewRepeater = document.getElementById('viewRepeater');
        if (viewRepeater && viewRepeater.style.display !== 'none') {
          e.preventDefault();
          RepeaterController.createNewTab();
        }
      }
    });

    btnOpenSavedFile.addEventListener('click', async () => {
      const req = requests.get(selectedRequestId);
      if (req && req.savedFile) {
        await window.api.openFolder(req.savedFile);
      } else {
        await window.api.openFolder(currentOutputDir);
      }
    });

    setupCopySection('btnCopyQueryParams', () => {
      const req = requests.get(selectedRequestId);
      return req && req.headers && req.headers.queryParams
        ? req.headers.queryParams.map((p) => `${p.key}: ${p.value}`).join('\n')
        : '';
    });

    setupCopySection('btnCopyPayload', () => {
      const req = requests.get(selectedRequestId);
      if (req && req.headers && req.headers.requestPayload) {
        return typeof req.headers.requestPayload === 'object'
          ? JSON.stringify(req.headers.requestPayload, null, 2)
          : String(req.headers.requestPayload);
      }
      return '';
    });

    setupCopySection('btnCopyResponseHeaders', () => {
      const req = requests.get(selectedRequestId);
      if (req && req.headers && req.headers.response) {
        return Object.entries(req.headers.response).map(([k, v]) => `${k}: ${v}`).join('\n');
      }
      return '';
    });

    setupCopySection('btnCopyRequestHeaders', () => {
      const req = requests.get(selectedRequestId);
      if (req && req.headers && req.headers.request) {
        return Object.entries(req.headers.request).map(([k, v]) => `${k}: ${v}`).join('\n');
      }
      return '';
    });

    
    if (btnExtBridge) {
      btnExtBridge.addEventListener('click', () => {
        if (extBridgeModal) extBridgeModal.style.display = 'flex';
      });
    }
    if (btnCloseExtModal) {
      btnCloseExtModal.addEventListener('click', () => {
        if (extBridgeModal) extBridgeModal.style.display = 'none';
      });
    }
    if (extBridgeModal) {
      extBridgeModal.addEventListener('click', (e) => {
        if (e.target === extBridgeModal) extBridgeModal.style.display = 'none';
      });
    }
    if (btnOpenExtFolderDirect) {
      btnOpenExtFolderDirect.addEventListener('click', async () => {
        await window.api.openExtensionFolder();
      });
    }

    
    if (btnNewMockRule) {
      btnNewMockRule.addEventListener('click', () => MockController.createRule());
    }
    if (btnDuplicateMockRule) {
      btnDuplicateMockRule.addEventListener('click', () => MockController.duplicateRule());
    }
    if (btnDeleteMockRule) {
      btnDeleteMockRule.addEventListener('click', () => MockController.deleteRule());
    }
    if (btnSaveMockRule) {
      btnSaveMockRule.addEventListener('click', () => MockController.saveCurrentForm());
    }
    if (btnMockFormatJson && mockRuleBody) {
      btnMockFormatJson.addEventListener('click', () => {
        const text = mockRuleBody.value.trim();
        if (!text) return;
        try {
          mockRuleBody.value = JSON.stringify(JSON.parse(text), null, 2);
        } catch (e) {}
      });
    }
    if (btnMockClearBody && mockRuleBody) {
      btnMockClearBody.addEventListener('click', () => {
        mockRuleBody.value = '';
      });
    }
    if (btnMockThisRequest) {
      btnMockThisRequest.addEventListener('click', () => openMockForCurrentRequest());
    }
    const btnExportMockFixture = document.getElementById('btnExportMockFixture');
    if (btnExportMockFixture) {
      btnExportMockFixture.addEventListener('click', async () => {
        const doc = {
          generator: 'Network-path mock fixture (A-6)',
          exportedAt: new Date().toISOString(),
          rules: MockController.rules,
          samples: Array.from(requests.values()).filter((r) => r.url).slice(-50).map((r) => ({
            url: r.url, method: r.method, status: r.status,
            requestHeaders: r.headers && r.headers.request, responseHeaders: r.headers && r.headers.response
          }))
        };
        try {
          await window.api.saveExportFile('mock-fixture.json', JSON.stringify(doc, null, 2));
          showToast('Mock fixture exported to the session exports folder.', 'success', 3500);
        } catch (e) {
          showToast('Fixture export failed: ' + (e?.message || e), 'error', 5000);
        }
      });
    }

    
    
    const harFileInput = document.getElementById('harFileInput');
    const btnImportHar = document.getElementById('btnImportHar');
    if (btnImportHar && harFileInput) {
      btnImportHar.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.remove('show');
        exportDropdown.style.display = 'none';
        harFileInput.value = '';
        harFileInput.click();
      });
      harFileInput.addEventListener('change', async () => {
        const file = harFileInput.files && harFileInput.files[0];
        if (!file) return;
        showToast('Importing ' + file.name + '...', 'info', 2500);
        try {
          const text = await file.text();
          const res = await window.api.importHar(text);
          if (res && res.outputDir) updateDirectoryDisplay(res.outputDir);
          const skippedNote = res && res.skipped > 0 ? `, ${res.skipped} entries skipped` : '';
          showToast(`Imported ${res.imported} requests${skippedNote} into a new session.`, 'success', 4500);
        } catch (err) {
          showToast('HAR import failed: ' + (err?.message || err), 'error', 6000);
        }
      });
    }

    
    setupResizer();
  }

  function setupCopySection(btnId, getText) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const text = getText();
      if (text) {
        copyToClipboard(text, btn, 'Copied!');
      }
    });
  }

  function copyToClipboard(text, buttonEl, successLabel) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = buttonEl.textContent;
      buttonEl.textContent = successLabel;
      buttonEl.style.color = 'var(--accent-green)';
      setTimeout(() => {
        buttonEl.textContent = orig;
        buttonEl.style.color = '';
      }, 1500);
    });
  }

  function setupResizer() {
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    paneResizer.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = detailsPane.offsetWidth;
      paneResizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = startX - e.clientX;
      const newWidth = Math.max(340, Math.min(window.innerWidth - 350, startWidth + dx));
      detailsPane.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        paneResizer.classList.remove('dragging');
        document.body.style.cursor = '';
      }
    });
  }

  
  
  

  function setupIpcListeners() {
    window.api.onCaptureState(applyCaptureState);
    window.api.onChromeStatus((status) => {
      updateChromeStatusDisplay(status);
      if (status.currentOutputDir) {
        updateDirectoryDisplay(status.currentOutputDir);
      }
      if (status.openTabs) {
        renderTabsDropdown(status.openTabs);
      }
    });

    window.api.onLoadSavedRequests((payload) => {
      requests.clear();
      resetCounts();
      if (payload && payload.outputDir) {
        updateDirectoryDisplay(payload.outputDir);
      }
      if (payload && Array.isArray(payload.requests)) {
        payload.requests.forEach((req) => {
          requests.set(req.id, req);
        });
        recalculateCounts();
        renderAllRows();
      }
      if (payload && payload.stats) {
        updateStatsFooter(payload.stats);
      }
    });

    window.api.onTabsUpdated((tabs) => {
      renderTabsDropdown(tabs);
    });

    function pruneOldRequestsIfNeeded() {
      if (requests.size > 2000) {
        const iter = requests.keys();
        while (requests.size > 1800) {
          const nextKey = iter.next().value;
          if (!nextKey) break;
          if (nextKey !== selectedRequestId) {
            requests.delete(nextKey);
          }
        }
      }
    }

    let latestStats = null;
    let statsFlushScheduled = false;
    function scheduleStatsUpdate(stats) {
      latestStats = stats;
      if (!statsFlushScheduled) {
        statsFlushScheduled = true;
        requestAnimationFrame(() => {
          statsFlushScheduled = false;
          if (latestStats) updateStatsFooter(latestStats);
        });
      }
    }

    window.api.onRequestStarted((data) => {
      if (!requests.has(data.id)) {
        pruneOldRequestsIfNeeded();
        const item = {
          id: data.id,
          timestamp: data.timestamp,
          url: data.url,
          method: data.method,
          resourceType: data.resourceType || 'Other',
          status: 'pending',
          statusText: 'Pending...',
          initiator: data.initiator,
          tabUrl: data.tabUrl || null,
          timing: { durationMs: 0 },
          response: { sizeBytes: 0 }
        };
        requests.set(data.id, item);
        if (matchesSiteOnly(item)) {
          incrementCount(item.resourceType);
          queueRecordUpdate(item.id);


        }
      }
    });

    window.api.onRequestFinished((data) => {
      const existing = requests.get(data.id);
      requests.set(data.id, data);

      if (matchesSiteOnly(data)) {
        if (!existing || !matchesSiteOnly(existing)) {
          incrementCount(data.resourceType || 'Other');
        } else if (existing.resourceType !== data.resourceType) {
          decrementCount(existing.resourceType);
          incrementCount(data.resourceType);
        }
        queueRecordUpdate(data.id);
        sitemapNeedsUpdate = true;
      } else {
        if (existing && matchesSiteOnly(existing)) {
          decrementCount(existing.resourceType);
          queueRecordUpdate(data.id);
        }
      }

      if (selectedRequestId === data.id) {
        renderDetails(data);
      }
    });

    window.api.onSocketEvent((frame) => {
      if (selectedRequestId === frame.socketId) {
        appendSocketFrameToPreview(frame);
      }
    });

    window.api.onSummaryUpdated((stats) => {
      scheduleStatsUpdate(stats);
    });

    window.api.onInterceptPaused((item) => {
      InterceptController.addPaused(item);
      const view = document.getElementById('viewIntercept');
      if (view && view.style.display !== 'none' && view.style.display !== '') return;
      if (Boolean(captureState && captureState.interceptEnabled)) {
        showToast('Request paused: ' + (item.url || '').slice(0, 60), 'info', 2000);
      }
    });
    window.api.onInterceptResolved((data) => {
      InterceptController.removePaused(data && data.requestId);
    });
  }

  
  
  

  function resetCounts() {
    Object.keys(counts).forEach((k) => (counts[k] = 0));
    starredIds.clear();
    updateBadges();
  }

  function incrementCount(type) {
    counts.All = (counts.All || 0) + 1;
    const cat = counts[type] !== undefined ? type : 'Other';
    counts[cat] = (counts[cat] || 0) + 1;
    badgesNeedUpdate = true;
    if (!uiBatchScheduled) {
      uiBatchScheduled = true;
      requestAnimationFrame(flushUiBatch);
    }
  }

  function decrementCount(type) {
    if (counts.All > 0) counts.All--;
    const cat = counts[type] !== undefined ? type : 'Other';
    if (counts[cat] > 0) counts[cat]--;
    badgesNeedUpdate = true;
    if (!uiBatchScheduled) {
      uiBatchScheduled = true;
      requestAnimationFrame(flushUiBatch);
    }
  }

  function updateBadges() {
    Object.entries(counts).forEach(([k, count]) => {
      const badge = document.getElementById(`badge-${k}`);
      if (badge) badge.textContent = count;
    });
    statTotalRequests.textContent = counts.All;
  }

  const KNOWN_TRACKERS = [
    'tiktok.com',
    'clarity.ms',
    'bat.bing.com',
    'doubleclick.net',
    'googleads.g.doubleclick.net',
    'google-analytics.com',
    'googletagmanager.com',
    'posthog.cdndate.net',
    'helpcrunch.com',
    'rdtds.net'
  ];

  function isTrackerUrl(urlStr) {
    if (!urlStr) return false;
    const lower = urlStr.toLowerCase();
    if (KNOWN_TRACKERS.some((d) => lower.includes(d))) return true;
    if (lower.includes('google.') && (lower.includes('/ccm/') || lower.includes('/rmkt/') || lower.includes('/pagead/'))) return true;
    return false;
  }

  function matchesSiteOnly(record) {
    
    if (filterTrackers && isTrackerUrl(record.url)) {
      if (!currentSiteFilter || !record.url.toLowerCase().includes(currentSiteFilter.trim().toLowerCase())) {
        return false;
      }
    }

    if (!currentSiteFilter || currentSiteFilter.trim() === '' || currentSiteFilter.trim() === '*') {
      return true;
    }
    const f = currentSiteFilter.trim().toLowerCase();
    const urlMatch = record.url && record.url.toLowerCase().includes(f);
    const tabMatch = record.tabUrl && record.tabUrl.toLowerCase().includes(f);
    return urlMatch || tabMatch;
  }

  function recalculateCounts() {
    Object.keys(counts).forEach((k) => (counts[k] = 0));
    requests.forEach((req) => {
      if (matchesSiteOnly(req)) {
        counts.All = (counts.All || 0) + 1;
        const cat = counts[req.resourceType] !== undefined ? req.resourceType : 'Other';
        counts[cat] = (counts[cat] || 0) + 1;
        if (starredIds.has(req.id)) {
          counts.Starred = (counts.Starred || 0) + 1;
        }
      }
    });
    updateBadges();
  }

  function toggleStar(id) {
    if (starredIds.has(id)) {
      starredIds.delete(id);
    } else {
      starredIds.add(id);
    }
    recalculateCounts();
    const row = document.getElementById(`row-${id}`);
    if (row) {
      const starBtn = row.querySelector('.btn-star');
      if (starBtn) {
        const isStarred = starredIds.has(id);
        starBtn.className = `btn-star ${isStarred ? 'starred' : ''}`;
        starBtn.innerHTML = isStarred ? ICONS.starFilled : ICONS.star;
      }
    }
    if (activeFilter === 'Starred') {
      renderAllRows();
    }
  }

  function matchesCurrentFilter(record) {
    
    if (!matchesSiteOnly(record)) {
      return false;
    }

    
    if (activeFilter === 'Starred') {
      if (!starredIds.has(record.id)) return false;
    } else if (activeFilter !== 'All' && record.resourceType !== activeFilter) {
      return false;
    }

    
    if (activeMethodFilter && activeMethodFilter !== 'ALL') {
      if ((record.method || 'GET').toUpperCase() !== activeMethodFilter) {
        return false;
      }
    }

    
    if (activeProtoFilter && activeProtoFilter !== 'ALL') {
      const proto = ((record.headers && record.headers.general && record.headers.general.protocol) || '').toLowerCase();
      if (!proto.includes(activeProtoFilter.toLowerCase())) return false;
    }

    
    if (activeStatusGroupFilter) {
      const st = typeof record.status === 'number' ? record.status : 0;
      if (activeStatusGroupFilter === '2xx' && (st < 200 || st >= 300)) return false;
      if (activeStatusGroupFilter === '3xx' && (st < 300 || st >= 400)) return false;
      if (activeStatusGroupFilter === '4xx' && (st < 400 || st >= 500)) return false;
      if (activeStatusGroupFilter === '5xx' && (st < 500 || st >= 600)) return false;
    }

    
    if (searchText) {
      const urlMatch = record.url && record.url.toLowerCase().includes(searchText);
      const methodMatch = record.method && record.method.toLowerCase().includes(searchText);
      const statusMatch = record.status && String(record.status).includes(searchText);
      const typeMatch = record.resourceType && record.resourceType.toLowerCase().includes(searchText);
      let bodyMatch = false;
      if (searchInBody && record.response && record.response.body) {
        const bStr = typeof record.response.body === 'object'
          ? JSON.stringify(record.response.body).toLowerCase()
          : String(record.response.body).toLowerCase();
        bodyMatch = bStr.includes(searchText);
      }
      if (!urlMatch && !methodMatch && !statusMatch && !typeMatch && !bodyMatch) {
        return false;
      }
    }
    return true;
  }

  function renderAllRows() {
    requestsTableBody.innerHTML = '';
    const matching = [];

    requests.forEach((record) => {
      if (matchesCurrentFilter(record)) {
        matching.push(record);
      }
    });

    
    const toRender = matching.length > 500 ? matching.slice(-500) : matching;

    toRender.forEach((record) => {
      const rowEl = createRowElement(record);
      requestsTableBody.appendChild(rowEl);
    });

    if (toRender.length === 0) {
      emptyState.style.display = 'flex';
      requestsTableBody.appendChild(emptyState);
    } else {
      emptyState.style.display = 'none';
      if (autoScroll) {
        requestsTableBody.scrollTop = requestsTableBody.scrollHeight;
      }
    }
  }

  
  const pendingRowUpdates = new Set();
  let uiBatchScheduled = false;
  let badgesNeedUpdate = false;
  let sitemapNeedsUpdate = false;

  function queueRecordUpdate(recordId) {
    pendingRowUpdates.add(recordId);
    if (!uiBatchScheduled) {
      uiBatchScheduled = true;
      requestAnimationFrame(flushUiBatch);
    }
  }

  function flushUiBatch() {
    uiBatchScheduled = false;
    if (pendingRowUpdates.size === 0) {
      if (badgesNeedUpdate) {
        badgesNeedUpdate = false;
        updateBadges();
      }
      return;
    }

    const idsToProcess = Array.from(pendingRowUpdates);
    pendingRowUpdates.clear();

    const fragment = document.createDocumentFragment();
    let addedNewRows = false;

    for (let i = 0; i < idsToProcess.length; i++) {
      const id = idsToProcess[i];
      const record = requests.get(id);
      if (!record) continue;

      const existingRow = document.getElementById(`row-${id}`);
      const matches = matchesCurrentFilter(record);

      if (!matches) {
        if (existingRow) existingRow.remove();
        continue;
      }

      if (existingRow) {
        updateRowContent(existingRow, record);
      } else {
        const rowEl = createRowElement(record);
        fragment.appendChild(rowEl);
        addedNewRows = true;
      }
    }

    if (addedNewRows) {
      emptyState.style.display = 'none';
      requestsTableBody.appendChild(fragment);

      
      while (requestsTableBody.children.length > 500) {
        const firstRow = requestsTableBody.querySelector('.table-row');
        if (firstRow && firstRow.id !== `row-${selectedRequestId}`) {
          firstRow.remove();
        } else {
          break;
        }
      }

      if (autoScroll) {
        requestsTableBody.scrollTop = requestsTableBody.scrollHeight;
      }
    }

    const hasRows = requestsTableBody.querySelector('.table-row') !== null;
    if (!hasRows) {
      emptyState.style.display = 'flex';
      if (!emptyState.parentElement) {
        requestsTableBody.appendChild(emptyState);
      }
    }

    if (badgesNeedUpdate) {
      badgesNeedUpdate = false;
      updateBadges();
    }

    if (sitemapNeedsUpdate) {
      sitemapNeedsUpdate = false;
      const sView = document.getElementById('viewSitemap');
      if (sView && sView.style.display !== 'none') {
        SitemapController.render();
      }
    }
  }

  function appendOrUpdateRow(record) {
    queueRecordUpdate(record.id);
  }

  function createRowElement(record) {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.id = `row-${record.id}`;
    if (selectedRequestId === record.id) {
      row.classList.add('selected');
    }

    updateRowContent(row, record);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-star')) {
        e.stopPropagation();
        toggleStar(record.id);
        return;
      }
      selectRequest(record.id);
    });

    row.addEventListener('dblclick', () => {
      selectRequest(record.id);
      RepeaterController.openWithRequest(record);
      showToast(`Request opened in Repeater (${record.method || 'GET'})`, 'info');
    });

    return row;
  }

  function updateRowContent(row, record) {
    let name = 'req';
    let host = '';
    let gql = null;
    try {
      const u = new URL(record.url);
      const pathParts = u.pathname.split('/').filter(Boolean);
      name = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '/';
      if (u.search) name += u.search;
      host = u.host;
      
      const payload = (record.headers && record.headers.requestPayload) || record.postData;
      const text = typeof payload === 'object' && payload ? JSON.stringify(payload) : String(payload || '');
      if (record.method && record.method.toUpperCase() === 'POST' && /graphql/i.test(record.url)) {
        const parsed = JSON.parse(text);
        const op = parsed.operationName || ((String(parsed.query || '').match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/) || [])[1]);
        if (op) { gql = op; name = '\u25C6 ' + op; }
      }
    } catch (e) {
      name = record.url || 'unknown';
    }

    const statusText = record.status || (record.status === 0 ? '0' : 'pending');
    let statusClass = 'status-pending';
    if (typeof record.status === 'number') {
      if (record.status >= 200 && record.status < 300) statusClass = 'status-2xx';
      else if (record.status >= 300 && record.status < 400) statusClass = 'status-3xx';
      else if (record.status >= 400 && record.status < 500) statusClass = 'status-4xx';
      else if (record.status >= 500) statusClass = 'status-5xx';
      else if (record.status === 0) statusClass = 'status-failed';
    }

    const m = (record.method || 'GET').toLowerCase();
    const methodClass = `method-${m}`;

    const sizeBytes = record.response && record.response.sizeBytes ? record.response.sizeBytes : 0;
    const sizeStr = formatBytes(sizeBytes);
    const duration = record.timing && record.timing.durationMs !== undefined ? `${record.timing.durationMs} ms` : '-';

    let initiatorText = 'Other';
    if (record.initiator) {
      if (record.initiator.type === 'script') {
        const file = record.initiator.url ? record.initiator.url.split('/').pop().split('?')[0] : 'script.js';
        const line = record.initiator.lineNumber !== null ? `:${record.initiator.lineNumber}` : '';
        initiatorText = `${file}${line}`;
      } else {
        initiatorText = record.initiator.type || 'Other';
      }
    }

    const isStarred = starredIds.has(record.id);

    
    let thirdBadge = '';
    try {
      const tabHost = record.tabUrl ? new URL(record.tabUrl).host : '';
      if (tabHost && host && tabHost !== host) {
        thirdBadge = '<span class="host-badge-3rd" title="Third-party host ' + escapeHtml(host) + ' (page: ' + escapeHtml(tabHost) + ')">3rd</span>';
      }
    } catch (e) {}

    row.innerHTML = `
      <div class="col col-star">
        <button class="btn-star ${isStarred ? 'starred' : ''}" data-id="${record.id}" title="Star / Bookmark">
          ${isStarred ? ICONS.starFilled : ICONS.star}
        </button>
      </div>
      <div class="col col-status">
        <span class="status-pill ${statusClass}">
          <span class="status-dot-sm"></span>
          <span>${statusText}</span>
        </span>
      </div>
      <div class="col col-method">
        <span class="method-badge ${methodClass}">${escapeHtml(record.method || 'GET')}</span>
      </div>
      <div class="col col-name req-name-container" title="${escapeHtml(record.url || '')}">
        <div class="req-name">${escapeHtml(name)}</div>
        <div class="req-host">${escapeHtml(host)}${thirdBadge}</div>
      </div>
      <div class="col col-type">
        <span class="type-badge">${escapeHtml(record.resourceType || 'Other')}</span>
        ${gql ? `<span class="type-badge" style="color: var(--accent-purple);" title="GraphQL operation">${escapeHtml(gql)}</span>` : ''}
      </div>
      <div class="col col-initiator" title="${escapeHtml(initiatorText)}">
        <span class="col-initiator-text">${escapeHtml(initiatorText)}</span>
      </div>
      <div class="col col-size size-val">${sizeStr}</div>
      <div class="col col-time time-val">${duration}</div>
    `;
  }

  
  
  

  function selectRequest(id) {
    selectedRequestId = id;
    document.querySelectorAll('.table-row').forEach((r) => r.classList.remove('selected'));
    const selectedRow = document.getElementById(`row-${id}`);
    if (selectedRow) selectedRow.classList.add('selected');

    const record = requests.get(id);
    if (record) {
      renderDetails(record);
    }
  }

  function hideDetails() {
    selectedRequestId = null;
    document.querySelectorAll('.table-row').forEach((r) => r.classList.remove('selected'));
    detailsEmpty.style.display = 'flex';
    detailsContent.style.display = 'none';
  }

  function renderDetails(record) {
    detailsEmpty.style.display = 'none';
    detailsContent.style.display = 'flex';

    renderHeadersTab(record);
    renderPreviewTab(record);
    renderResponseTab(record);
    renderInitiatorTab(record);
    renderTimingTab(record);
    renderAuthTab(record);
    renderSecurityTab(record);
  }

  function renderHeadersTab(record) {
    const g = (record.headers && record.headers.general) || {};
    generalHeadersGrid.innerHTML = `
      <div class="kv-key">Request URL:</div>
      <div class="kv-value" style="word-break: break-all;">${escapeHtml(record.url || '')}</div>
      <div class="kv-key">Request Method:</div>
      <div class="kv-value">${escapeHtml(record.method || 'GET')}</div>
      <div class="kv-key">Status Code:</div>
      <div class="kv-value">${escapeHtml(g.statusCode || `${record.status || 200} ${record.statusText || 'OK'}`)}</div>
      ${g.remoteAddress ? `<div class="kv-key">Remote Address:</div><div class="kv-value">${escapeHtml(g.remoteAddress)}</div>` : ''}
      ${g.protocol ? `<div class="kv-key">Protocol:</div><div class="kv-value">${escapeHtml(g.protocol)}</div>` : ''}
    `;

    const queryParams = (record.headers && record.headers.queryParams) || [];
    if (queryParams.length > 0) {
      cardQueryParams.style.display = 'block';
      queryParamsGrid.innerHTML = queryParams
        .map((p) => `<div class="kv-key">${escapeHtml(p.key)}:</div><div class="kv-value">${escapeHtml(p.value)}</div>`)
        .join('');
    } else {
      cardQueryParams.style.display = 'none';
    }

    const payload = (record.headers && record.headers.requestPayload) || record.postData;
    if (payload) {
      cardRequestPayload.style.display = 'block';
      requestPayloadContent.textContent = typeof payload === 'object' ? JSON.stringify(payload, null, 2) : String(payload);
    } else {
      cardRequestPayload.style.display = 'none';
    }

    const respHeaders = (record.headers && record.headers.response) || {};
    const respEntries = Object.entries(respHeaders);
    if (respEntries.length > 0) {
      responseHeadersGrid.innerHTML = respEntries
        .map(([k, v]) => `<div class="kv-key">${escapeHtml(k)}:</div><div class="kv-value">${escapeHtml(String(v))}</div>`)
        .join('');
    } else {
      responseHeadersGrid.innerHTML = '<div class="text-muted" style="grid-column: span 2;">No response headers</div>';
    }

    const reqHeaders = (record.headers && record.headers.request) || {};
    const reqEntries = Object.entries(reqHeaders);
    if (reqEntries.length > 0) {
      requestHeadersGrid.innerHTML = reqEntries
        .map(([k, v]) => `<div class="kv-key">${escapeHtml(k)}:</div><div class="kv-value">${escapeHtml(String(v))}</div>`)
        .join('');
    } else {
      requestHeadersGrid.innerHTML = '<div class="text-muted" style="grid-column: span 2;">No request headers</div>';
    }
  }

  function renderPreviewTab(record) {
    previewContainer.innerHTML = '';

    const mime = (record.response && record.response.mimeType) || '';
    const body = (record.response && record.response.body) || null;
    const base64 = record.response && record.response.base64Encoded;

    if (record.resourceType === 'Img' || mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'preview-media-img';
      if (base64 && typeof body === 'string') {
        img.src = `data:${mime || 'image/png'};base64,${body}`;
      } else {
        img.src = record.url;
      }
      previewContainer.appendChild(img);
      return;
    }

    if (record.resourceType === 'Media' || mime.startsWith('video/') || mime.startsWith('audio/')) {
      const isVideo = mime.startsWith('video/');
      const mediaEl = document.createElement(isVideo ? 'video' : 'audio');
      mediaEl.className = 'preview-media-player';
      mediaEl.controls = true;
      if (base64 && typeof body === 'string') {
        mediaEl.src = `data:${mime};base64,${body}`;
      } else {
        mediaEl.src = record.url;
      }
      previewContainer.appendChild(mediaEl);
      return;
    }

    if (typeof body === 'object' && body !== null) {
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      pre.textContent = JSON.stringify(body, null, 2);
      previewContainer.appendChild(pre);
      return;
    }

    if (record.resourceType === 'Socket') {
      previewContainer.innerHTML = `
        <div class="section-card">
          <div class="section-card-title">WebSocket Stream</div>
          <div id="socketFramesList" class="stack-trace-container" style="max-height: 300px; overflow-y: auto;">
            <div class="text-muted">Listening for live WebSocket frames from Chrome...</div>
          </div>

          <p class="text-muted">Read-only stream of observed frames. Sending on the page socket is not supported.</p>
        </div>
      `;
      return;
    }

    const pre = document.createElement('pre');
    pre.className = 'code-block';
    pre.textContent = body ? (typeof body === 'string' ? body : JSON.stringify(body, null, 2)) : (record.preview || '(No preview available)');
    previewContainer.appendChild(pre);
  }

  function appendSocketFrameToPreview(frame) {
    const list = document.getElementById('socketFramesList');
    if (!list) return;

    if (list.querySelector('.text-muted')) {
      list.innerHTML = '';
    }

    const frameItem = document.createElement('div');
    frameItem.style.padding = '4px 8px';
    frameItem.style.borderBottom = '1px solid var(--border-subtle)';
    frameItem.style.fontFamily = 'var(--font-mono)';
    frameItem.style.fontSize = '11px';

    const dirBadge = frame.direction === 'SENT'
      ? `<span class="ws-dir sent">${ICONS.arrowUp} SENT</span>`
      : `<span class="ws-dir recv">${ICONS.arrowDown} RECV</span>`;

    frameItem.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
        ${dirBadge}
        <span style="color: var(--text-muted);">${new Date(frame.timestamp).toLocaleTimeString()}</span>
      </div>
      <div style="color: var(--text-code); word-break: break-all;">${escapeHtml(frame.payloadData || frame.preview)}</div>
    `;

    list.appendChild(frameItem);
    list.scrollTop = list.scrollHeight;
  }

  function renderResponseTab(record) {
    const body = record.response ? record.response.body : null;
    const sizeBytes = (record.response && record.response.sizeBytes) || 0;
    const mime = (record.response && record.response.mimeType) || 'unknown';
    const bodyState = record.response && record.response.bodyState;

    responseMeta.textContent = `${formatBytes(sizeBytes)} | ${mime}` + (bodyState ? ` | Body: ${bodyState}` : '');

    if (body === null || body === undefined) {
      responseBodyContent.textContent = '(No response body was returned or body could not be captured)';
    } else if (typeof body === 'object') {
      responseBodyContent.textContent = JSON.stringify(body, null, 2);
    } else {
      responseBodyContent.textContent = String(body);
    }
  }

  function renderInitiatorTab(record) {
    const init = record.initiator || {};
    initiatorSummaryGrid.innerHTML = `
      <div class="kv-key">Initiator Type:</div>
      <div class="kv-value">${escapeHtml(init.type || 'unknown')}</div>
      ${init.url ? `<div class="kv-key">Source Script:</div><div class="kv-value">${escapeHtml(init.url)}</div>` : ''}
      ${init.lineNumber !== null && init.lineNumber !== undefined ? `<div class="kv-key">Line Number:</div><div class="kv-value">${init.lineNumber}</div>` : ''}
      ${init.columnNumber !== null && init.columnNumber !== undefined ? `<div class="kv-key">Column Number:</div><div class="kv-value">${init.columnNumber}</div>` : ''}
    `;

    initiatorStackContainer.innerHTML = '';
    if (init.stack && Array.isArray(init.stack.callFrames) && init.stack.callFrames.length > 0) {
      const list = document.createElement('div');
      list.style.fontFamily = 'var(--font-mono)';
      list.style.fontSize = '11px';

      init.stack.callFrames.forEach((frame) => {
        const item = document.createElement('div');
        item.style.padding = '4px 0';
        item.style.borderBottom = '1px solid rgba(48, 54, 61, 0.3)';
        item.innerHTML = `
          <div style="color: var(--accent-blue); font-weight: 600;">${escapeHtml(frame.functionName || '(anonymous)')}</div>
          <div style="color: var(--text-muted); font-size: 10px;">${escapeHtml(frame.url)}:${frame.lineNumber}:${frame.columnNumber}</div>
        `;
        list.appendChild(item);
      });
      initiatorStackContainer.appendChild(list);
    } else {
      initiatorStackContainer.innerHTML = '<div class="text-muted">No call stack trace available.</div>';
    }
  }

  function renderTimingTab(record) {
    const timing = record.timing || {};
    const b = timing.breakdown || {};
    const totalMs = timing.durationMs || 0;

    waterfallContainer.innerHTML = '';

    const stages = [
      { key: 'DNS Lookup', val: b.dns, color: 'rgba(88, 166, 255, 0.45)' },
      { key: 'Initial Connection', val: b.connect, color: 'rgba(88, 166, 255, 0.55)' },
      { key: 'SSL Handshake', val: b.ssl, color: 'rgba(88, 166, 255, 0.65)' },
      { key: 'Request Sent', val: b.send, color: 'rgba(88, 166, 255, 0.75)' },
      { key: 'Waiting (TTFB)', val: b.ttfb, color: 'rgba(88, 166, 255, 0.9)' },
      { key: 'Content Download', val: b.download, color: 'var(--accent-blue)' }
    ];

    const maxMs = Math.max(totalMs, 1);

    stages.forEach((stage) => {
      const ms = typeof stage.val === 'number' && stage.val > 0 ? stage.val : 0;
      const pct = Math.min(100, Math.max(2, (ms / maxMs) * 100));

      const row = document.createElement('div');
      row.className = 'timing-row';
      row.innerHTML = `
        <div class="timing-label">${stage.key}</div>
        <div class="timing-bar-track">
          <div class="timing-bar-fill" style="width: ${pct}%; background-color: ${stage.color};"></div>
        </div>
        <div class="timing-val">${ms ? `${ms} ms` : '-'}</div>
      `;
      waterfallContainer.appendChild(row);
    });

    const totalRow = document.createElement('div');
    totalRow.className = 'timing-row';
    totalRow.style.marginTop = '10px';
    totalRow.style.borderTop = '1px solid var(--border-subtle)';
    totalRow.style.paddingTop = '8px';
    totalRow.innerHTML = `
      <div class="timing-label" style="font-weight: 700; color: var(--text-primary);">Total Duration</div>
      <div class="timing-bar-track">
        <div class="timing-bar-fill" style="width: 100%; background-color: var(--accent-blue);"></div>
      </div>
      <div class="timing-val" style="font-weight: 700; color: var(--accent-blue);">${totalMs} ms</div>
    `;
    waterfallContainer.appendChild(totalRow);
  }

  function renderAuthTab(record) {
    currentAuthToken = '';
    currentJwtPayload = null;
    currentCookieHeader = '';
    currentCookiesList = [];

    
    const reqHeaders = (record.headers && record.headers.request) || {};
    let rawAuth = null;
    let authHeaderName = 'Authorization';

    for (const [k, v] of Object.entries(reqHeaders)) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'x-access-token' || lower === 'x-auth-token' || lower === 'token') {
        rawAuth = String(v).trim();
        authHeaderName = k;
        break;
      }
    }

    if (!rawAuth && record.headers && Array.isArray(record.headers.queryParams)) {
      const qp = record.headers.queryParams.find((p) => ['token', 'access_token', 'jwt', 'auth'].includes(p.key.toLowerCase()));
      if (qp) {
        rawAuth = qp.value;
        authHeaderName = `Query (${qp.key})`;
      }
    }

    if (rawAuth) {
      let token = rawAuth;
      let tokenType = 'Token';
      if (rawAuth.toLowerCase().startsWith('bearer ')) {
        token = rawAuth.substring(7).trim();
        tokenType = 'Bearer';
      }

      currentAuthToken = token;
      btnCopyAuthToken.style.display = 'inline-block';

      const parts = token.split('.');
      if (parts.length === 3) {
        try {
          const headerJson = JSON.parse(b64UrlDecode(parts[0]));
          const payloadJson = JSON.parse(b64UrlDecode(parts[1]));
          currentJwtPayload = payloadJson;
          btnCopyJwtPayload.style.display = 'inline-block';

          let algHtml = '';
          if (headerJson && headerJson.alg) {
            algHtml = `
              <div class="jwt-claim-card">
                <div class="jwt-claim-label">Algorithm</div>
                <div class="jwt-claim-val">${escapeHtml(headerJson.alg)}${headerJson.typ ? ' (' + escapeHtml(headerJson.typ) + ')' : ''}</div>
              </div>
            `;
          }

          let expHtml = '';
          if (typeof payloadJson.exp === 'number') {
            const expDate = new Date(payloadJson.exp * 1000);
            const now = Date.now();
            const diffMs = expDate.getTime() - now;
            if (diffMs > 0) {
              const diffMin = Math.round(diffMs / 60000);
              const diffHrs = (diffMs / 3600000).toFixed(1);
              const timeStr = diffMin < 60 ? `${diffMin}m` : `${diffHrs}h`;
              expHtml = `
                <div class="jwt-claim-card">
                  <div class="jwt-claim-label">Expires At</div>
                  <div class="jwt-claim-val">${expDate.toLocaleString()}</div>
                  <span class="token-validity-badge valid">Valid (in ${timeStr})</span>
                </div>
              `;
            } else {
              const agoMin = Math.round(Math.abs(diffMs) / 60000);
              const agoHrs = (Math.abs(diffMs) / 3600000).toFixed(1);
              const timeStr = agoMin < 60 ? `${agoMin}m` : `${agoHrs}h`;
              expHtml = `
                <div class="jwt-claim-card">
                  <div class="jwt-claim-label">Expires At</div>
                  <div class="jwt-claim-val">${expDate.toLocaleString()}</div>
                  <span class="token-validity-badge expired">Expired (${timeStr} ago)</span>
                </div>
              `;
            }
          }

          let iatHtml = '';
          if (typeof payloadJson.iat === 'number') {
            const iatDate = new Date(payloadJson.iat * 1000);
            iatHtml = `
              <div class="jwt-claim-card">
                <div class="jwt-claim-label">Issued At</div>
                <div class="jwt-claim-val">${iatDate.toLocaleString()}</div>
              </div>
            `;
          }

          let subHtml = '';
          if (payloadJson.sub) {
            subHtml = `
              <div class="jwt-claim-card">
                <div class="jwt-claim-label">Subject (User ID)</div>
                <div class="jwt-claim-val">${escapeHtml(String(payloadJson.sub))}</div>
              </div>
            `;
          }

          let issHtml = '';
          if (payloadJson.iss) {
            issHtml = `
              <div class="jwt-claim-card">
                <div class="jwt-claim-label">Issuer (iss)</div>
                <div class="jwt-claim-val">${escapeHtml(String(payloadJson.iss))}</div>
              </div>
            `;
          }

          let audHtml = '';
          if (payloadJson.aud) {
            audHtml = `
              <div class="jwt-claim-card">
                <div class="jwt-claim-label">Audience (aud)</div>
                <div class="jwt-claim-val">${escapeHtml(String(payloadJson.aud))}</div>
              </div>
            `;
          }

          authSummaryContent.innerHTML = `
            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px;">
              Detected <strong style="color: var(--accent-green);">${escapeHtml(tokenType)} (JWT)</strong> via <code>${escapeHtml(authHeaderName)}</code>:
            </div>
            <div class="jwt-token-display">
              <span class="jwt-part-header" title="JWT Header">${escapeHtml(parts[0])}</span>.<span class="jwt-part-payload" title="JWT Payload">${escapeHtml(parts[1])}</span>.<span class="jwt-part-signature" title="JWT Signature">${escapeHtml(parts[2])}</span>
            </div>
            <div class="jwt-claims-grid">
              ${algHtml}
              ${subHtml}
              ${expHtml}
              ${iatHtml}
              ${issHtml}
              ${audHtml}
            </div>
            <div style="margin-top: 8px;">
              <div class="jwt-claim-label">Decoded Payload Claims</div>
              <pre class="code-block" style="max-height: 180px; overflow-y: auto;">${escapeHtml(JSON.stringify(payloadJson, null, 2))}</pre>
            </div>
          `;
        } catch (e) {
          renderRawAuthToken(tokenType, authHeaderName, token);
        }
      } else {
        renderRawAuthToken(tokenType, authHeaderName, token);
      }
    } else {
      btnCopyAuthToken.style.display = 'none';
      btnCopyJwtPayload.style.display = 'none';
      authSummaryContent.innerHTML = '<div class="text-muted">No Authorization header or token found in this request.</div>';
    }

    function renderRawAuthToken(type, header, tok) {
      btnCopyJwtPayload.style.display = 'none';
      authSummaryContent.innerHTML = `
        <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px;">
          Detected <strong style="color: var(--accent-blue);">${escapeHtml(type)}</strong> via <code>${escapeHtml(header)}</code>:
        </div>
        <div class="jwt-token-display">${escapeHtml(tok)}</div>
      `;
    }

    
    const cookies = [];

    
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (k.toLowerCase() === 'cookie') {
        const parts = String(v).split(';');
        parts.forEach((p) => {
          const eq = p.indexOf('=');
          if (eq > 0) {
            const cName = p.substring(0, eq).trim();
            const cVal = p.substring(eq + 1).trim();
            cookies.push({ name: cName, value: cVal, source: 'Request', details: '-' });
          }
        });
      }
    }

    
    const respHeaders = (record.headers && record.headers.response) || {};
    for (const [k, v] of Object.entries(respHeaders)) {
      if (k.toLowerCase() === 'set-cookie') {
        const lines = Array.isArray(v) ? v : [String(v)];
        lines.forEach((line) => {
          const parts = line.split(';');
          const first = parts[0] || '';
          const eq = first.indexOf('=');
          if (eq > 0) {
            const cName = first.substring(0, eq).trim();
            const cVal = first.substring(eq + 1).trim();
            const attrs = parts.slice(1).map((a) => a.trim()).join('; ');
            cookies.push({ name: cName, value: cVal, source: 'Response', details: attrs || '-' });
          }
        });
      }
    }

    currentCookiesList = cookies;

    if (cookies.length > 0) {
      currentCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      btnCopyCookieHeader.style.display = 'inline-block';
      btnCopyCookiesJson.style.display = 'inline-block';

      let rowsHtml = cookies
        .map((c) => {
          const badgeClass = c.source === 'Request' ? 'cookie-source-req' : 'cookie-source-res';
          return `
            <tr>
              <td style="font-weight: 600; color: var(--text-primary);">${escapeHtml(c.name)}</td>
              <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(c.value)}">${escapeHtml(c.value)}</td>
              <td><span class="cookie-source-badge ${badgeClass}">${escapeHtml(c.source)}</span></td>
              <td style="color: var(--text-muted); font-size: 10px;">${escapeHtml(c.details)}</td>
            </tr>
          `;
        })
        .join('');

      cookiesContent.innerHTML = `
        <div class="cookies-table-wrapper">
          <table class="cookies-table">
            <thead>
              <tr>
                <th>Cookie Name</th>
                <th>Value</th>
                <th>Source</th>
                <th>Attributes</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;
    } else {
      btnCopyCookieHeader.style.display = 'none';
      btnCopyCookiesJson.style.display = 'none';
      cookiesContent.innerHTML = '<div class="text-muted">No cookies associated with this request or response.</div>';
    }
  }

  function b64UrlDecode(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  }

  function renderSecurityTab(record) {
    if (!record) return;
    const g = (record.headers && record.headers.general) || {};
    let scheme = 'Unavailable';
    let host = 'Unavailable';
    try {
      const url = new URL(record.url);
      scheme = url.protocol.replace(':', '').toUpperCase();
      host = url.hostname || 'Unavailable';
    } catch (_) {}
    securityStatePill.className = 'status-pill';
    securityStateText.textContent = `${scheme} URL — TLS not measured`;
    securityConnGrid.innerHTML = `
      <div class="kv-key">URL scheme:</div><div class="kv-value">${escapeHtml(scheme)}</div>
      <div class="kv-key">Observed response protocol:</div><div class="kv-value">${escapeHtml(g.protocol || 'Unavailable')}</div>
      <div class="kv-key">Remote address:</div><div class="kv-value">${escapeHtml(g.remoteAddress || 'Unavailable')}</div>
      <div class="kv-key">Target host:</div><div class="kv-value">${escapeHtml(host)}</div>
      <div class="kv-key">TLS / certificate / JA3 / JA4:</div><div class="kv-value">Not collected by this recorder. The URL scheme does not establish handshake or certificate validity.</div>
    `;
  }

  
  
  

  function updateStatsFooter(stats) {
    if (!stats) return;
    statTotalBytes.textContent = formatBytes(stats.totalBytes || 0);
    statWebSockets.textContent = stats.byType ? (stats.byType.Socket || 0) : 0;

    if (stats.byStatus) {
      stat2xx.textContent = `2xx: ${stats.byStatus['2xx'] || 0}`;
      stat3xx.textContent = `3xx: ${stats.byStatus['3xx'] || 0}`;
      stat4xx.textContent = `4xx: ${stats.byStatus['4xx'] || 0}`;
      stat5xx.textContent = `5xx: ${stats.byStatus['5xx'] || 0}`;
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  
  
  
  const CodeGenerator = {
    cleanHeaders(headersObj) {
      const result = {};
      if (!headersObj) return result;
      for (const [k, v] of Object.entries(headersObj)) {
        if (k.startsWith(':')) continue;
        result[k] = String(v);
      }
      return result;
    },

    getPayload(record) {
      return (record.headers && record.headers.requestPayload) || record.postData || null;
    },

    toCurl(record) {
      const method = (record.method || 'GET').toUpperCase();
      let parts = [`curl '${record.url}'`, `  -X ${method}`];
      const headers = this.cleanHeaders(record.headers && record.headers.request);
      for (const [k, v] of Object.entries(headers)) {
        parts.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
      }
      const payload = this.getPayload(record);
      if (payload && method !== 'GET' && method !== 'HEAD') {
        const raw = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
        parts.push(`  --data-raw '${raw.replace(/'/g, "'\\''")}'`);
      }
      return parts.join(' \\\n');
    },

    toPythonCurlCffi(record) {
      const method = (record.method || 'GET').toLowerCase();
      const headers = this.cleanHeaders(record.headers && record.headers.request);
      const payload = this.getPayload(record);

      let code = 'from curl_cffi import requests\n\n';
      code += `url = ${JSON.stringify(record.url)}\n`;
      code += `headers = ${JSON.stringify(headers, null, 4)}\n\n`;

      let args = [`url`, `headers=headers`, `impersonate="chrome124"`];

      if (payload && method !== 'get' && method !== 'head') {
        if (typeof payload === 'object') {
          code += `json_data = ${JSON.stringify(payload, null, 4)}\n\n`;
          args.push(`json=json_data`);
        } else {
          code += `data = ${JSON.stringify(String(payload))}\n\n`;
          args.push(`data=data`);
        }
      }

      code += `response = requests.${method}(\n    ${args.join(',\n    ')}\n)\n\n`;
      code += 'print(f"Status: {response.status_code}")\n';
      code += 'print(response.text)\n';
      return code;
    },

    toPythonRequests(record) {
      const method = (record.method || 'GET').toLowerCase();
      const headers = this.cleanHeaders(record.headers && record.headers.request);
      const payload = this.getPayload(record);

      let code = 'import requests\n\n';
      code += `url = ${JSON.stringify(record.url)}\n`;
      code += `headers = ${JSON.stringify(headers, null, 4)}\n\n`;

      let args = [`url`, `headers=headers`];

      if (payload && method !== 'get' && method !== 'head') {
        if (typeof payload === 'object') {
          code += `json_data = ${JSON.stringify(payload, null, 4)}\n\n`;
          args.push(`json=json_data`);
        } else {
          code += `data = ${JSON.stringify(String(payload))}\n\n`;
          args.push(`data=data`);
        }
      }

      code += `response = requests.${method}(\n    ${args.join(',\n    ')}\n)\n\n`;
      code += 'print(f"Status: {response.status_code}")\n';
      code += 'print(response.text)\n';
      return code;
    },

    toPythonHttpx(record) {
      const method = (record.method || 'GET').toLowerCase();
      const headers = this.cleanHeaders(record.headers && record.headers.request);
      const payload = this.getPayload(record);

      let code = 'import asyncio\nimport httpx\n\n';
      code += `url = ${JSON.stringify(record.url)}\n`;
      code += `headers = ${JSON.stringify(headers, null, 4)}\n\n`;

      let args = [`url`, `headers=headers`];

      if (payload && method !== 'get' && method !== 'head') {
        if (typeof payload === 'object') {
          code += `json_data = ${JSON.stringify(payload, null, 4)}\n\n`;
          args.push(`json=json_data`);
        } else {
          code += `data = ${JSON.stringify(String(payload))}\n\n`;
          args.push(`content=data`);
        }
      }

      code += 'async def main():\n';
      code += '    async with httpx.AsyncClient(http2=True, follow_redirects=True) as client:\n';
      code += `        response = await client.${method}(\n            ${args.join(',\n            ')}\n        )\n`;
      code += '        print(f"Status: {response.status_code}")\n';
      code += '        print(response.text)\n\n';
      code += 'asyncio.run(main())\n';
      return code;
    },

    toFetch(record) {
      const method = (record.method || 'GET').toUpperCase();
      const headers = this.cleanHeaders(record.headers && record.headers.request);
      const payload = this.getPayload(record);

      const opts = {
        method: method,
        headers: headers
      };

      if (payload && method !== 'GET' && method !== 'HEAD') {
        opts.body = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      }

      return `fetch(${JSON.stringify(record.url)}, ${JSON.stringify(opts, null, 2)})\n  .then(res => res.text())\n  .then(text => console.log(text))\n  .catch(err => console.error(err));\n`;
    }
  };

  
  
  
  const ExportManager = {
    toHAR(records) {
      const entries = records.map((record) => {
        const reqHeaders = (record.headers && record.headers.request) || {};
        const respHeaders = (record.headers && record.headers.response) || {};
        const timing = record.timing || {};
        const breakdown = timing.breakdown || {};
        const durationMs = timing.durationMs || 0;

        const reqCookies = [];
        if (reqHeaders['cookie'] || reqHeaders['Cookie']) {
          const cStr = reqHeaders['cookie'] || reqHeaders['Cookie'];
          String(cStr).split(';').forEach((p) => {
            const eq = p.indexOf('=');
            if (eq > 0) {
              reqCookies.push({ name: p.substring(0, eq).trim(), value: p.substring(eq + 1).trim() });
            }
          });
        }

        const respCookies = [];
        if (respHeaders['set-cookie'] || respHeaders['Set-Cookie']) {
          const sc = respHeaders['set-cookie'] || respHeaders['Set-Cookie'];
          const lines = Array.isArray(sc) ? sc : [String(sc)];
          lines.forEach((line) => {
            const first = line.split(';')[0] || '';
            const eq = first.indexOf('=');
            if (eq > 0) {
              respCookies.push({ name: first.substring(0, eq).trim(), value: first.substring(eq + 1).trim() });
            }
          });
        }

        const postData = (record.headers && record.headers.requestPayload) || record.postData;
        let postDataObj = undefined;
        if (postData && (record.method || 'GET').toUpperCase() !== 'GET') {
          postDataObj = {
            mimeType: 'application/json',
            text: typeof postData === 'object' ? JSON.stringify(postData) : String(postData)
          };
        }

        const body = record.response ? record.response.body : null;
        let bodyText = '';
        if (body !== null && body !== undefined) {
          bodyText = typeof body === 'object' ? JSON.stringify(body) : String(body);
        }

        return {
          startedDateTime: new Date(record.timestamp || Date.now()).toISOString(),
          time: durationMs,
          request: {
            method: (record.method || 'GET').toUpperCase(),
            url: record.url,
            httpVersion: (record.headers && record.headers.general && record.headers.general.protocol) || 'HTTP/1.1',
            cookies: reqCookies,
            headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value: String(value) })),
            queryString: (record.headers && record.headers.queryParams) ? record.headers.queryParams.map((p) => ({ name: p.key, value: p.value })) : [],
            postData: postDataObj,
            headersSize: -1,
            bodySize: postDataObj ? postDataObj.text.length : 0
          },
          response: {
            status: typeof record.status === 'number' ? record.status : 200,
            statusText: record.statusText || 'OK',
            httpVersion: 'HTTP/1.1',
            cookies: respCookies,
            headers: Object.entries(respHeaders).map(([name, value]) => ({ name, value: String(value) })),
            content: {
              size: (record.response && record.response.sizeBytes) || bodyText.length,
              mimeType: (record.response && record.response.mimeType) || 'application/octet-stream',
              text: bodyText,
              encoding: record.response && record.response.base64Encoded ? 'base64' : undefined
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: (record.response && record.response.sizeBytes) || bodyText.length
          },
          cache: {},
          timings: {
            blocked: -1,
            dns: breakdown.dns || -1,
            connect: breakdown.connect || -1,
            ssl: breakdown.ssl || -1,
            send: breakdown.send || -1,
            wait: breakdown.ttfb || -1,
            receive: breakdown.download || -1
          }
        };
      });

      return JSON.stringify(
        {
          log: {
            version: '1.2',
            creator: { name: 'Network-Path Inspector', version: '2.0.0' },
            pages: [],
            entries: entries
          }
        },
        null,
        2
      );
    },

    toPostman(records) {
      const items = records.map((record) => {
        let parsedUrl = { raw: record.url };
        try {
          const u = new URL(record.url);
          parsedUrl = {
            raw: record.url,
            protocol: u.protocol.replace(':', ''),
            host: u.hostname.split('.'),
            path: u.pathname.split('/').filter(Boolean),
            query: (record.headers && record.headers.queryParams) ? record.headers.queryParams.map((p) => ({ key: p.key, value: p.value })) : []
          };
        } catch (e) {}

        const reqHeaders = (record.headers && record.headers.request) || {};
        const headerList = Object.entries(reqHeaders)
          .filter(([k]) => !k.startsWith(':'))
          .map(([key, value]) => ({ key, value: String(value) }));

        const payload = (record.headers && record.headers.requestPayload) || record.postData;
        let bodyObj = undefined;
        if (payload && (record.method || 'GET').toUpperCase() !== 'GET') {
          bodyObj = {
            mode: 'raw',
            raw: typeof payload === 'object' ? JSON.stringify(payload, null, 2) : String(payload),
            options: { raw: { language: 'json' } }
          };
        }

        let name = record.url;
        try {
          const u = new URL(record.url);
          name = `${record.method || 'GET'} ${u.pathname}`;
        } catch (e) {}

        return {
          name: name,
          request: {
            method: (record.method || 'GET').toUpperCase(),
            header: headerList,
            body: bodyObj,
            url: parsedUrl
          },
          response: []
        };
      });

      return JSON.stringify(
        {
          info: {
            name: 'Network-Path Session Collection',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
          },
          item: items
        },
        null,
        2
      );
    },

    toCSV(records) {
      const headers = ['ID', 'Timestamp', 'Method', 'Status', 'ResourceType', 'URL', 'SizeBytes', 'DurationMs', 'Initiator'];
      const rows = [headers.join(',')];

      records.forEach((r) => {
        const row = [
          r.id || '',
          r.timestamp ? new Date(r.timestamp).toISOString() : '',
          (r.method || 'GET').toUpperCase(),
          r.status || '',
          r.resourceType || 'Other',
          r.url || '',
          (r.response && r.response.sizeBytes) || 0,
          (r.timing && r.timing.durationMs) || 0,
          (r.initiator && r.initiator.type) || 'Other'
        ];
        rows.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      return rows.join('\r\n');
    },

    toJSON(records) {
      return JSON.stringify(records, null, 2);
    },

    toOpenAPI(records, options) {
      const opts = options || {};
      
      
      const maskValue = (v) => String(v).replace(/./g, '*').slice(0, 8) || '(removed)';
      const groups = new Map(); 
      records.forEach((r) => {
        let u;
        try { u = new URL(r.url); } catch (e) { return; }
        const host = u.host;
        const method = (r.method || 'GET').toLowerCase();
        const template = SitemapController ? pathTemplate(u.pathname) : u.pathname;
        const key = host + '|' + template + '|' + method;
        if (!groups.has(key)) {
          groups.set(key, { host, template, method, count: 0, params: new Map(), example: r });
        }
        const g = groups.get(key);
        g.count++;
        
        (r.headers && r.headers.queryParams || []).forEach((qp) => {
          if (!g.params.has(qp.key)) g.params.set(qp.key, qp.value);
        });
      });

      const inferType = (v) => {
        if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
        if (typeof v === 'boolean') return 'boolean';
        return 'string';
      };
      const schemaOf = (v) => {
        if (v === null || v === undefined) return { type: 'string', nullable: true };
        if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOf(v[0]) : {} };
        if (typeof v === 'object') {
          const props = {};
          Object.entries(v).forEach(([k, val]) => { props[k] = schemaOf(val); });
          return { type: 'object', properties: props };
        }
        return { type: inferType(v) };
      };

      const paths = {};
      groups.forEach((g) => {
        const params = [];
        
        (g.template.match(/:(id|uuid|hash|token)/g) || []).forEach((p, i) => {
          params.push({ name: p.slice(1) + (i > 0 ? i : ''), in: 'path', required: true, schema: { type: 'string' } });
        });
        
        const qp = (g.example.headers && g.example.headers.queryParams) || [];
        qp.forEach((p) => params.push({
          name: p.key, in: 'query', required: false,
          schema: { type: inferType(p.value) }, example: /[key|token|secret]/i.test(p.key) ? maskValue(p.value) : p.value
        }));

        const reqHeaders = (g.example.headers && g.example.headers.request) || {};
        
        const hasAuth = Object.keys(reqHeaders).some((k) => /authorization|cookie|x-api-key/i.test(k));

        let requestBody;
        const payload = (g.example.headers && g.example.headers.requestPayload) || g.example.postData;
        if (payload && g.method !== 'get' && g.method !== 'head' && g.method !== 'delete') {
          requestBody = {
            required: true,
            content: { 'application/json': { schema: schemaOf(payload), example: typeof payload === 'object' ? payload : undefined } }
          };
        }

        const respBody = (g.example.response && g.example.response.body) || null;
        const respSchema = schemaOf(respBody && typeof respBody === 'object' ? respBody : {});
        const respExample = respBody && typeof respBody === 'object' ? respBody : undefined;

        const status = String((g.example.status || 200));
        paths['/' + g.template.replace(/^\/+/, '')] = paths['/' + g.template.replace(/^\/+/, '')] || {};
        paths['/' + g.template.replace(/^\/+/, '')][g.method] = {
          summary: `${g.method.toUpperCase()} ${g.template}  (${g.count} captured)`,
          tags: [g.host],
          parameters: params.length ? params : undefined,
          requestBody,
          responses: {
            [status]: {
              description: `${g.example.statusText || ''} — observed ${g.count} time(s)`.trim(),
              content: respBody ? { 'application/json': { schema: respSchema, example: respExample } } : undefined
            }
          },
          'x-network-path': {
            host: g.host,
            captured: g.count,
            securityObserved: hasAuth ? 'Authorization/Cookie present in captured requests (values masked)' : 'none'
          }
        };
      });

      const doc = {
        openapi: '3.0.3',
        info: {
          title: 'Network-path — API surface from captured traffic',
          version: '2.0.0',
          description: 'Generated from ' + records.length + ' captured request(s). ' +
            'Path parameters are inferred (:id/:uuid/:hash/:token). ' +
            'Authorization/Cookie values are masked.'
        },
        servers: Array.from(new Set(records.map((r) => { try { const u = new URL(r.url); return u.origin; } catch (e) { return null; } }).filter(Boolean))).map((u) => ({ url: u })),
        paths
      };
      return JSON.stringify(doc, null, 2);
    },

    toScraper(records, options) {
      const opts = options || {};
      
      
      
      const groups = new Map();
      records.forEach((r) => {
        let u; try { u = new URL(r.url); } catch (e) { return; }
        const template = SitemapController ? pathTemplate(u.pathname) : u.pathname;
        const key = u.host + '|' + template + '|' + (r.method || 'GET').toUpperCase();
        if (!groups.has(key)) groups.set(key, { host: u.host, template, method: (r.method || 'GET').toUpperCase(), url: r.url, params: new Map(), headers: (r.headers && r.headers.request) || {}, count: 0, status429: false });
        const g = groups.get(key);
        g.count++;
        (r.headers && r.headers.queryParams || []).forEach((qp) => {
          const paginated = /^(page|p|offset|cursor|per_page|limit|pageSize)$/i.test(qp.key);
          g.params.set(qp.key, { value: qp.value, paginated });
        });
        if (String(r.status) === '429') g.status429 = true;
      });

      const lines = [];
      lines.push('# Auto-generated by Network-path from captured traffic.');
      lines.push('# Review and adapt before use. Respect the site terms and robots.txt.');
      lines.push('import time');
      lines.push('import requests');
      lines.push('');
      lines.push('session = requests.Session()');
      const headers = records[0] && records[0].headers && records[0].headers.request || {};
      const hdrEntries = Object.entries(headers).filter(([k]) => !/^(host|content-length|cookie)$/i.test(k));
      if (hdrEntries.length) {
        lines.push('session.headers.update({');
        hdrEntries.forEach(([k, v]) => lines.push(`    "${k}": ${JSON.stringify(String(v))},`));
        lines.push('})');
        lines.push('');
      }
      lines.push('def fetch_with_backoff(url, **kwargs):');
      lines.push('    for attempt in range(5):');
      lines.push('        resp = session.get(url, **kwargs) if not kwargs else session.request(kwargs.pop("method", "GET"), url, **kwargs)');
      lines.push('        if resp.status_code == 429:');
      lines.push('            wait = int(resp.headers.get("Retry-After", 2 ** attempt * 2))');
      lines.push('            print(f"429, waiting {wait}s"); time.sleep(wait); continue');
      lines.push('        return resp');
      lines.push('    raise RuntimeError("exhausted retries (429)")');
      lines.push('');
      lines.push('results = []');
      let endpointCount = 0;
      groups.forEach((g) => {
        endpointCount++;
        const paginatedKey = Array.from(g.params.entries()).find(([, v]) => v.paginated);
        lines.push('');
        lines.push(`# ${g.method} ${g.template} (captured ${g.count}x${g.status429 ? ', saw 429' : ''})`);
        const safeName = 'endpoint_' + endpointCount;
        lines.push(`def ${safeName}():`);
        if (paginatedKey) {
          lines.push(`    results_page = []`);
          lines.push(`    for page in range(1, 6):  # adjust range`);
          lines.push(`        resp = fetch_with_backoff(${JSON.stringify(g.url.split('?')[0])}, params={${Array.from(g.params.entries()).map(([k, v]) => v.paginated ? `"${k}": page` : `"${k}": ${JSON.stringify(v.value)}`).join(', ')}}, method=${JSON.stringify(g.method)})`);
          lines.push(`        data = resp.json()`);
          lines.push(`        results_page.extend(data if isinstance(data, list) else data.get("items", []))`);
          lines.push(`    return results_page`);
          lines.push('');
          lines.push(`results.extend(${safeName}())`);
        } else {
          lines.push(`    resp = fetch_with_backoff(${JSON.stringify(g.url.split('?')[0])}, method=${JSON.stringify(g.method)})`);
          lines.push(`    results.append(resp.json())`);
        }
      });
      lines.push('');
      lines.push('print(f"collected {len(results)} result objects")');
      return lines.join('\n');
    },

    async saveAndDownload(filename, content, mimeType) {
      try {
        await window.api.saveExportFile(filename, content);
      } catch (e) {
        console.warn('Could not save to session exports dir:', e);
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }
  };

  
  
  
  const RepeaterController = {
    tabs: [
      {
        id: 1,
        title: 'Req 1',
        method: 'GET',
        url: 'https://httpbin.org/get',
        headersText: 'User-Agent: Network-path/1.0\nAccept: application/json',
        bodyText: '',
        response: null
      }
    ],
    activeTabId: 1,
    nextId: 2,

    init() {
      this.renderTabs();
      this.loadTab(this.tabs[0]?.id || 1);
    },

    createNewTab(prefill) {
      const id = this.nextId++;
      const newTab = {
        id,
        title: (prefill && prefill.title) || `Req ${this.tabs.length + 1}`,
        method: (prefill && prefill.method) || 'GET',
        url: (prefill && prefill.url) || 'https://httpbin.org/get',
        headersText: (prefill && prefill.headersText !== undefined) ? prefill.headersText : 'User-Agent: Network-path/1.0\nAccept: application/json',
        bodyText: (prefill && prefill.bodyText !== undefined) ? prefill.bodyText : '',
        response: (prefill && prefill.response) || null
      };
      this.tabs.push(newTab);
      this.renderTabs();
      this.selectTab(id);
      return newTab;
    },

    closeTab(id, e) {
      if (e) e.stopPropagation();
      if (this.tabs.length <= 1) return; 
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      this.tabs.splice(idx, 1);
      if (this.activeTabId === id) {
        const nextActive = this.tabs[Math.max(0, idx - 1)];
        this.selectTab(nextActive.id);
      } else {
        this.renderTabs();
      }
    },

    saveCurrentTabState() {
      const current = this.tabs.find((t) => t.id === this.activeTabId);
      if (!current) return;
      if (repMethod && repMethod.value) current.method = repMethod.value.trim().toUpperCase();
      if (repUrl && repUrl.value !== undefined) current.url = repUrl.value.trim();
      if (repReqHeadersText && repReqHeadersText.value !== undefined) current.headersText = repReqHeadersText.value;
      if (repReqBodyText && repReqBodyText.value !== undefined) current.bodyText = repReqBodyText.value;
    },

    selectTab(id) {
      this.saveCurrentTabState();
      this.activeTabId = id;
      this.renderTabs();
      this.loadTab(id);
    },

    loadTab(id) {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      if (repMethod) repMethod.value = tab.method;
      if (repUrl) repUrl.value = tab.url;
      if (repReqHeadersText) repReqHeadersText.value = tab.headersText;
      if (repReqBodyText) repReqBodyText.value = tab.bodyText;

      if (tab.response) {
        this.renderResponse(tab.response);
      } else {
        if (repStatusBadge) repStatusBadge.style.display = 'none';
        if (repMetaStats) repMetaStats.textContent = 'Ready to send';
        if (repRespBodyContent) repRespBodyContent.textContent = '(Click Send or Ctrl+Enter to execute request)';
        if (repResHeadersGrid) repResHeadersGrid.innerHTML = '';
      }
    },

    renderTabs() {
      if (!repTabsBar) return;
      repTabsBar.innerHTML = '';

      this.tabs.forEach((tab) => {
        const tabEl = document.createElement('div');
        tabEl.className = `rep-tab-item ${tab.id === this.activeTabId ? 'active' : ''}`;
        tabEl.innerHTML = `
          <span class="rep-tab-method">${escapeHtml(tab.method)}</span>
          <span class="rep-tab-title">${escapeHtml(tab.title)}</span>
          ${this.tabs.length > 1 ? `<span class="rep-tab-close" title="Close tab">✕</span>` : ''}
        `;
        tabEl.addEventListener('click', () => this.selectTab(tab.id));
        const closeBtn = tabEl.querySelector('.rep-tab-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', (e) => this.closeTab(tab.id, e));
        }
        repTabsBar.appendChild(tabEl);
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'rep-tab-add';
      addBtn.id = 'btnRepNewTab';
      addBtn.title = 'Open new Replay Tab';
      addBtn.innerHTML = ICONS.plus;
      addBtn.addEventListener('click', () => this.createNewTab());
      repTabsBar.appendChild(addBtn);
    },

    open(record) {
      if (record) {
        this.openWithRequest(record);
        return;
      }
      if (!this.tabs || this.tabs.length === 0) {
        this.init();
      } else {
        const targetId = this.activeTabId || this.tabs[0].id;
        this.selectTab(targetId);
      }
      switchWorkspaceView('repeater');
    },

    openWithRequest(record) {
      const method = (record.method || 'GET').toUpperCase();
      let pathName = 'endpoint';
      try {
        pathName = new URL(record.url).pathname.split('/').filter(Boolean).pop() || 'req';
      } catch (e) {
        pathName = 'req';
      }
      const title = `${method} /${pathName.slice(0, 12)}`;

      const reqHeaders = (record.headers && record.headers.request) || {};
      const lines = [];
      for (const [k, v] of Object.entries(reqHeaders)) {
        if (!k.startsWith(':')) {
          lines.push(`${k}: ${v}`);
        }
      }

      const payload = (record.headers && record.headers.requestPayload) || record.postData || '';
      const bodyText = typeof payload === 'object' ? JSON.stringify(payload, null, 2) : String(payload);

      this.createNewTab({
        title,
        method,
        url: record.url || '',
        headersText: lines.join('\n'),
        bodyText,
        response: null
      });

      switchWorkspaceView('repeater');

      
      if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && bodyText) {
        const bBtn = document.querySelector('[data-rep-req-tab="body"]');
        if (bBtn) bBtn.click();
      } else {
        const hBtn = document.querySelector('[data-rep-req-tab="headers"]');
        if (hBtn) hBtn.click();
      }
    },

    renderResponse(res) {
      if (!res) return;
      if (repStatusBadge) {
        repStatusBadge.style.display = 'inline-flex';
        repStatusText.textContent = `${res.status} ${res.statusText}`;

        let statusClass = 'status-pending';
        if (res.status >= 200 && res.status < 300) statusClass = 'status-2xx';
        else if (res.status >= 300 && res.status < 400) statusClass = 'status-3xx';
        else if (res.status >= 400 && res.status < 500) statusClass = 'status-4xx';
        else if (res.status >= 500) statusClass = 'status-5xx';
        else if (res.status === 0) statusClass = 'status-failed';
        repStatusBadge.className = `status-pill ${statusClass}`;
      }

      if (repMetaStats) {
        repMetaStats.textContent = `${res.durationMs || 0} ms | ${formatBytes(res.sizeBytes || 0)}`;
      }

      if (repRespBodyContent) {
        if (res.error) {
          repRespBodyContent.textContent = `[Error] ${res.error}`;
        } else if (res.isJson) {
          try {
            repRespBodyContent.textContent = JSON.stringify(JSON.parse(res.body), null, 2);
          } catch (e) {
            repRespBodyContent.textContent = res.body;
          }
        } else {
          repRespBodyContent.textContent = res.body || '(Empty response body)';
        }
      }

      if (repResHeadersGrid) {
        const entries = Object.entries(res.headers || {});
        if (entries.length > 0) {
          repResHeadersGrid.innerHTML = entries
            .map(([k, v]) => `<div class="kv-key">${escapeHtml(k)}:</div><div class="kv-value">${escapeHtml(v)}</div>`)
            .join('');
        } else {
          repResHeadersGrid.innerHTML = '<div class="text-muted" style="grid-column: span 2;">No headers returned</div>';
        }
      }
    },

    async send() {
      this.saveCurrentTabState();
      const current = this.tabs.find((t) => t.id === this.activeTabId);
      if (!current || !current.url) {
        showToast('Please enter a target URL', 'warning');
        return;
      }

      const headers = {};
      const headerLines = (current.headersText || '').split('\n');
      headerLines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const idx = trimmed.indexOf(':');
        if (idx > 0) {
          const k = trimmed.substring(0, idx).trim();
          const v = trimmed.substring(idx + 1).trim();
          if (k) headers[k] = v;
        }
      });

      let body = undefined;
      if (current.method !== 'GET' && current.method !== 'HEAD') {
        const b = (current.bodyText || '').trim();
        if (b) body = b;
      }

      if (btnRepSend) {
        btnRepSend.disabled = true;
        btnRepSend.textContent = 'Sending...';
      }
      if (repMetaStats) repMetaStats.textContent = 'Executing request...';

      try {
        const res = await window.api.sendRepeaterRequest({
          method: current.method,
          url: current.url,
          headers,
          body,
          timeoutSecs: 25
        });

        current.response = res;
        this.renderResponse(res);
        if (res.error) {
          showToast(`Request error: ${res.error}`, 'error');
        } else {
          showToast(`Response received: ${res.status} ${res.statusText}`, res.status < 400 ? 'success' : 'warning');
        }
      } catch (err) {
        if (repMetaStats) repMetaStats.textContent = 'Request failed';
        if (repRespBodyContent) repRespBodyContent.textContent = String(err);
        showToast(`Execution failed: ${err}`, 'error');
      } finally {
        if (btnRepSend) {
          btnRepSend.disabled = false;
          btnRepSend.textContent = 'Send';
        }
      }
    }
  };

  
  
  
  
  
  function pathTemplate(pathname) {
    return (pathname || '/')
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        if (/^\d+$/.test(seg)) {
          
          if (/^(19|20)\d{2}$/.test(seg)) return seg;
          return ':id';
        }
        if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) return ':uuid';
        if (/^[0-9a-f]{16,}$/i.test(seg)) return ':hash';
        if (seg.length > 20 && /^[A-Za-z0-9_-]+$/.test(seg)) return ':token';
        return seg;
      })
      .join('/');
  }

  const SitemapController = {
    selectedHost: null,
    selectedPrefix: null,

    render() {
      if (!sitemapTreeContent) return;
      sitemapTreeContent.innerHTML = '';

      
      const hostsMap = new Map();
      requests.forEach((r) => {
        if (!r.url) return;
        try {
          const u = new URL(r.url);
          const host = u.host;
          if (!hostsMap.has(host)) {
            hostsMap.set(host, new Map());
          }
          const pMap = hostsMap.get(host);
          const path = pathTemplate(u.pathname || '/');
          const bucket = pMap.get(path) || { count: 0, methods: new Set() };
          bucket.count++;
          bucket.methods.add((r.method || 'GET').toUpperCase());
          pMap.set(path, bucket);
        } catch (e) {}
      });

      if (hostsMap.size === 0) {
        sitemapTreeContent.innerHTML = `
          <div class="empty-state" style="padding: 20px 8px; font-size: 11px;">
            No hosts discovered yet.<br>Traffic from Chrome will automatically populate this tree.
          </div>
        `;
        return;
      }

      hostsMap.forEach((paths, host) => {
        const total = Array.from(paths.values()).reduce((a, b) => a + b.count, 0);
        
        if (paths.size > 50) {
          const groups = new Map();
          paths.forEach((bucket, p) => {
            const seg = p.split('/')[1] || '(root)';
            const g = groups.get(seg) || { count: 0, requests: 0 };
            g.count++; g.requests += bucket.count;
            groups.set(seg, g);
          });
          const hostNodeS = document.createElement('div');
          hostNodeS.className = 'sitemap-node';
          hostNodeS.innerHTML = '<span class="sitemap-node-icon">' + ICONS.globe + '</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(host) + '</span><span class="tab-badge">' + total + '</span>';
          sitemapTreeContent.appendChild(hostNodeS);
          groups.forEach((g, seg) => {
            const node = document.createElement('div');
            node.className = 'sitemap-node';
            node.style.paddingLeft = '24px';
            node.innerHTML = '<span class="sitemap-node-icon">' + ICONS.file + '</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis; font-size:11px;">/' + escapeHtml(seg) + '/</span><span style="font-size:9px; color: var(--text-muted);">' + g.count + ' paths</span><span class="tab-badge" style="background: rgba(110,118,129,0.2);">' + g.requests + '</span>';
            node.addEventListener('click', () => {
              this.selectHostAndPath(host, '/' + seg + '/');
              document.querySelectorAll('.sitemap-node').forEach((n) => n.classList.remove('active'));
              node.classList.add('active');
            });
            sitemapTreeContent.appendChild(node);
          });
          return;
        }
        const hostNode = document.createElement('div');
        hostNode.className = 'sitemap-node';
        hostNode.innerHTML = `
          <span class="sitemap-node-icon">${ICONS.globe}</span>
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(host)}</span>
          <span class="tab-badge">${total}</span>
        `;
        hostNode.addEventListener('click', () => {
          this.selectHost(host);
          document.querySelectorAll('.sitemap-node').forEach((n) => n.classList.remove('active'));
          hostNode.classList.add('active');
        });
        sitemapTreeContent.appendChild(hostNode);

        
        paths.forEach((bucket, p) => {
          if (p === '/') return;
          const pathNode = document.createElement('div');
          pathNode.className = 'sitemap-node';
          pathNode.style.paddingLeft = '24px';
          pathNode.innerHTML = `
            <span class="sitemap-node-icon">${ICONS.file}</span>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; font-size: 11px;" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
            <span style="font-size:9px; color: var(--text-muted);">${escapeHtml(Array.from(bucket.methods).join('/'))}</span>
            <span class="tab-badge" style="background: rgba(110,118,129,0.2);">${bucket.count}</span>
          `;
          pathNode.addEventListener('click', () => {
            this.selectHostAndPath(host, p);
            document.querySelectorAll('.sitemap-node').forEach((n) => n.classList.remove('active'));
            pathNode.classList.add('active');
          });
          sitemapTreeContent.appendChild(pathNode);
        });
      });

      if (!this.selectedHost && hostsMap.size > 0) {
        this.selectHost(Array.from(hostsMap.keys())[0]);
      }
    },

    selectHost(host) {
      this.selectedHost = host;
      this.selectedPrefix = null;
      if (sitemapSelectedPathText) sitemapSelectedPathText.textContent = `https://${host}`;
      this.renderMatchingRequests();
    },

    selectHostAndPath(host, p) {
      this.selectedHost = host;
      this.selectedPrefix = p;
      if (sitemapSelectedPathText) sitemapSelectedPathText.textContent = `https://${host}${p}`;
      this.renderMatchingRequests();
    },

    renderMatchingRequests() {
      if (!sitemapRequestsList) return;
      sitemapRequestsList.innerHTML = '';
      const matched = [];
      requests.forEach((r) => {
        if (!r.url) return;
        try {
          const u = new URL(r.url);
          if (u.host === this.selectedHost) {
            const prefixMode = Boolean(this.selectedPrefix && this.selectedPrefix.endsWith('/'));
            const hit = !this.selectedPrefix
              || (prefixMode ? (u.pathname || '/').startsWith(this.selectedPrefix) : pathTemplate(u.pathname || '/') === this.selectedPrefix);
            if (hit) {
              matched.push(r);
            }
          }
        } catch (e) {}
      });

      if (sitemapMatchingCount) sitemapMatchingCount.textContent = `${matched.length} requests`;

      if (matched.length === 0) {
        sitemapRequestsList.innerHTML = '<div class="empty-state">No requests recorded for this path</div>';
        return;
      }

      matched.forEach((r) => {
        const item = document.createElement('div');
        item.className = 'intercept-queue-item';
        
        const isImage = r.resourceType === 'Img'
          || (r.response && /image\//i.test(r.response.mimeType || ''))
          || /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(r.url || '');
        const body = `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <span class="method-chip ${(r.method || 'GET').toLowerCase()}">${escapeHtml(r.method || 'GET')}</span>
            <span class="status-pill status-${String(r.status || 0).charAt(0)}xx" style="font-size:10px;">${r.status || '-'}</span>
          </div>
          <div class="code-font" style="font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
        `;
        if (isImage) {
          item.innerHTML = `
            <div class="sitemap-request-with-thumb">
              <div class="sitemap-thumb-wrap" title="Image preview">
                <img src="${escapeHtml(r.url)}" loading="lazy" onerror="this.parentElement.classList.add('failed')">
              </div>
              <div style="flex:1; min-width:0;">${body}</div>
            </div>
          `;
        } else {
          item.innerHTML = body;
        }
        item.addEventListener('click', (e) => {
          if (e.target && e.target.closest && e.target.closest('.sitemap-thumb-wrap')) return;
          selectedRequestId = r.id;
          switchWorkspaceView('traffic');
          selectRequest(r.id);
        });
        sitemapRequestsList.appendChild(item);
      });
    }
  };

  
  
  
  
  
  
  const InterceptController = {
    paused: new Map(), 

    renderState() {
      if (!interceptStateEl) return;
      const on = Boolean(captureState && captureState.interceptEnabled);
      if (chkInterceptEnabled) chkInterceptEnabled.checked = on;
      interceptStateEl.textContent = on
        ? `On — capturing ${this.paused.size} paused request(s)`
        : 'Off';
    },

    refresh() {
      this.renderState();
      if (window.api && window.api.listInterceptPaused) {
        window.api.listInterceptPaused().then((list) => {
          (list || []).forEach((item) => {
            if (item && item.requestId && !this.paused.has(item.requestId)) {
              this.paused.set(item.requestId, item);
            }
          });
          this.render();
        }).catch(() => {});
      }
    },

    addPaused(item) {
      if (!item || !item.requestId || this.paused.has(item.requestId)) return;
      this.paused.set(item.requestId, item);
      this.render();
    },

    removePaused(requestId) {
      if (this.paused.delete(requestId)) this.render();
    },

    async resolve(requestId, action, extra) {
      const payload = Object.assign({ requestId, action }, extra || {});
      try {
        await window.api.interceptResolve(payload);
        this.removePaused(requestId);
      } catch (e) {
        showToast('Intercept resolution failed: ' + (e?.message || e), 'error', 5000);
      }
    },

    forwardAll() {
      const ids = Array.from(this.paused.keys());
      ids.forEach((id) => this.resolve(id, 'forward', { interceptResponse: true }));
      if (ids.length) showToast(`Forwarded ${ids.length} request(s).`, 'info', 2500);
    },

    render() {
      if (!interceptQueueEl) return;
      this.renderState();
      if (this.paused.size === 0) {
        const on = Boolean(captureState && captureState.interceptEnabled);
        interceptQueueEl.innerHTML = `<div class="text-muted" style="padding:12px;">${on ? 'No requests paused yet. Browse the captured tab.' : 'Intercept is off. Enable the toggle; requests of the captured tab will pause here.'}</div>`;
        return;
      }
      interceptQueueEl.innerHTML = '';
      this.paused.forEach((item, requestId) => {
        const row = document.createElement('div');
        row.className = 'intercept-item';
        const isResponse = item.stage === 'Response';
        const editorFields = isResponse
          ? [
              '<div style="display:flex; gap:6px; align-items:center;">',
              '<span class="text-muted" style="font-size:10.5px;">Status:</span>',
              '<input type="number" class="custom-input icpt-status" style="width:90px;" value="' + escapeHtml(String(item.statusCode || 200)) + '">',
              '<span class="mock-status-chip ok" style="font-size:9px;">Response stage — body edit</span>',
              '</div>',
              '<textarea class="code-textarea icpt-body" style="min-height:96px;" placeholder="Response body" spellcheck="false">' + escapeHtml(item.responseBody || '') + '</textarea>',
              '<textarea class="code-textarea icpt-headers" style="min-height:56px;" placeholder="Header: value (one per line)" spellcheck="false">' + escapeHtml(Object.entries(item.responseHeaders || {}).map(([k, v]) => k + ': ' + v).join('\n')) + '</textarea>',
              '<div style="display:flex; gap:6px; justify-content:flex-end;">',
              '<button class="btn btn-xs btn-ghost icpt-cancel">Cancel</button>',
              '<button class="btn btn-xs btn-primary icpt-apply">Fulfill edited response</button>',
              '</div>'
            ].join('')
          : [
              '<input type="text" class="custom-input icpt-url" placeholder="URL" spellcheck="false">',
              '<textarea class="code-textarea icpt-headers" style="min-height:56px;" placeholder="Header: value (one per line)" spellcheck="false"></textarea>',
              '<div style="display:flex; gap:6px; justify-content:flex-end;">',
              '<button class="btn btn-xs btn-ghost icpt-cancel">Cancel</button>',
              '<button class="btn btn-xs btn-primary icpt-apply">Apply &amp; forward</button>',
              '</div>'
            ].join('');
        row.innerHTML =
          '<div class="intercept-item-main">' +
          '<div style="display:flex; gap:8px; align-items:center;">' +
          '<span class="method-chip ' + (item.method || 'GET').toLowerCase() + '">' + escapeHtml(item.method || 'GET') + '</span>' +
          '<span class="mock-status-chip" style="font-size:9px;">' + (isResponse ? 'Response' : 'Request') + '</span>' +
          '<span class="code-font" style="font-size:11px; word-break:break-all;" title="' + escapeHtml(item.url || '') + '">' + escapeHtml(item.url || '') + '</span>' +
          '</div>' +
          '<div class="intercept-editor" style="display:none; flex-direction:column; gap:6px; margin-top:8px;">' + editorFields + '</div>' +
          '</div>' +
          '<div class="intercept-item-actions">' +
          '<button class="btn btn-xs btn-secondary icpt-forward">Forward</button>' +
          '<button class="btn btn-xs btn-ghost icpt-edit">Edit</button>' +
          '<button class="btn btn-xs btn-danger icpt-drop">Drop</button>' +
          '</div>';
        row.querySelector('.icpt-forward').addEventListener('click', () => this.resolve(requestId, 'forward', { interceptResponse: true }));
        row.querySelector('.icpt-drop').addEventListener('click', () => this.resolve(requestId, 'drop'));
        const editor = row.querySelector('.intercept-editor');
        row.querySelector('.icpt-edit').addEventListener('click', () => {
          editor.style.display = editor.style.display === 'flex' ? 'none' : 'flex';
          if (!isResponse) {
            const urlInput = editor.querySelector('.icpt-url');
            if (urlInput && !urlInput.value) {
              urlInput.value = item.url || '';
              editor.querySelector('.icpt-headers').value = Object.entries(item.headers || {})
                .map(([k, v]) => k + ': ' + v).join('\n');
            }
          }
        });
        editor.querySelector('.icpt-cancel').addEventListener('click', () => { editor.style.display = 'none'; });
        editor.querySelector('.icpt-apply').addEventListener('click', () => {
          const headers = {};
          editor.querySelectorAll('.icpt-headers').forEach((ta) => {
            ta.value.split('\n').forEach((line) => {
              const idx = line.indexOf(':');
              if (idx > 0) { const k = line.substring(0, idx).trim(); const v = line.substring(idx + 1).trim(); if (k) headers[k] = v; }
            });
          });
          if (isResponse) {
            const status = Number(editor.querySelector('.icpt-status').value) || 200;
            const body = editor.querySelector('.icpt-body').value;
            this.resolve(requestId, 'fulfill', { status, headers, body });
          } else {
            this.resolve(requestId, 'forward-edited', { url: editor.querySelector('.icpt-url').value.trim(), headers });
          }
        });
        interceptQueueEl.appendChild(row);
      });
    }
  };

  const SessionsController = {
    sessions: [],

    async refresh() {
      try {
        this.sessions = (await window.api.listSessions()) || [];
      } catch (e) {
        this.sessions = [];
      }
      this.currentDir = currentOutputDir;
      this.render();
      this.renderTrash();
      this.renderTokens();
    },

    async searchAll(query) {
      const box = document.getElementById('searchAllResults');
      const list = document.getElementById('searchAllList');
      const title = document.getElementById('searchAllTitle');
      if (!box || !list) return;
      const q = (query || '').trim();
      if (q.length < 2) { box.style.display = 'none'; return; }
      box.style.display = 'flex';
      title.textContent = 'Searching "' + q + '"...';
      list.innerHTML = '<div class="text-muted" style="padding:10px;">Scanning sessions...</div>';
      try {
        const res = await window.api.searchSessions(q);
        title.textContent = '"' + q + '" — ' + res.results.length + ' match(es) in ' + res.scannedSessions + ' session(s)' + (res.truncated ? ' (truncated)' : '');
        if (res.results.length === 0) {
          list.innerHTML = '<div class="text-muted" style="padding:10px;">Nothing found in saved sessions.</div>';
          return;
        }
        list.innerHTML = res.results.slice(0, 100).map((h) =>
          '<div class="search-hit" data-session="' + escapeHtml(h.session) + '" data-url="' + escapeHtml(h.url) + '">' +
          '<span class="method-chip ' + (h.method || 'get').toLowerCase() + '">' + escapeHtml(h.method || 'GET') + '</span>' +
          '<span class="status-pill status-' + String(h.status || 0).charAt(0) + 'xx" style="font-size:9.5px;">' + (h.status || '-') + '</span>' +
          '<span class="code-font grow" style="font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + escapeHtml(h.snippet) + '">' + escapeHtml(h.snippet) + '</span>' +
          '<span class="text-muted" style="font-size:9.5px;">' + escapeHtml((h.timestamp || '').slice(0, 10)) + '</span>' +
          '</div>').join('');
        list.querySelectorAll('.search-hit').forEach((el) => {
          el.addEventListener('click', async () => {
            try {
              await window.api.openSession(el.getAttribute('data-session'));
              const url = el.getAttribute('data-url') || '';
              searchFilterInput.value = url;
              searchText = url.toLowerCase();
              btnClearSearch.style.display = 'block';
              renderAllRows();
              switchWorkspaceView('traffic');
              showToast('Opened matching session, filtered to the hit.', 'info', 4000);
            } catch (e) { showToast('Open failed: ' + (e && e.message || e), 'error', 4000); }
          });
        });
      } catch (e) {
        list.innerHTML = '<div class="text-muted" style="padding:10px;">Search failed: ' + escapeHtml(String(e && e.message || e)) + '</div>';
      }
    },

    renderTokens() {
      const listEl = document.getElementById('tokensList');
      if (!listEl) return;
      const seen = new Map(); 
      requests.forEach((r) => {
        const h = (r.headers && r.headers.request) || {};
        let raw = null, source = null;
        for (const [k, v] of Object.entries(h)) {
          if (/^(authorization|x-access-token|x-auth-token|token)$/i.test(k)) { raw = String(v); source = k; break; }
        }
        if (!raw) return;
        let token = raw.replace(/^bearer\s+/i, '').trim();
        const parts = token.split('.');
        if (parts.length !== 3 || seen.has(token)) return;
        let claims = null, alg = null;
        try {
          const header = JSON.parse(b64UrlDecode(parts[0]));
          claims = JSON.parse(b64UrlDecode(parts[1]));
          alg = header && header.alg;
        } catch (e) { claims = null; }
        seen.set(token, { claims, alg, source, host: (() => { try { return new URL(r.url).host; } catch (e) { return r.url; } })() });
      });
      if (seen.size === 0) {
        listEl.innerHTML = '<div class="text-muted" style="padding:10px;">No JWT/token found in the loaded session.</div>';
        return;
      }
      const rows = [];
      const now = Date.now();
      seen.forEach((info, token) => {
        let expiry = '<span class="text-muted" style="font-size:10px;">no exp claim</span>';
        if (info.claims && typeof info.claims.exp === 'number') {
          const d = new Date(info.claims.exp * 1000);
          const diff = d.getTime() - now;
          const abs = Math.abs(diff);
          const human = abs > 86400000 ? (abs / 86400000).toFixed(1) + 'd' : abs > 3600000 ? (abs / 3600000).toFixed(1) + 'h' : Math.round(abs / 60000) + 'm';
          expiry = diff > 0
            ? `<span class="token-validity-badge valid">Valid (${human} left)</span>`
            : `<span class="token-validity-badge expired">Expired (${human} ago)</span>`;
        }
        rows.push(
          '<div class="token-row">' +
          '<span class="mock-status-chip" style="font-size:9px;">' + escapeHtml(token.slice(0, 12)) + '…</span>' +
          '<span class="text-muted" style="font-size:10px;">' + escapeHtml(info.alg || '?') + ' · ' + escapeHtml(info.source) + '</span>' +
          '<span class="code-font" style="font-size:10.5px; flex:1; overflow:hidden; text-overflow:ellipsis;" title="' + escapeHtml(info.host) + '">' + escapeHtml(info.host) + '</span>' +
          '<span class="text-muted" style="font-size:10px;">' + escapeHtml(String(info.claims && (info.claims.sub || info.claims.id || '—'))) + '</span>' +
          expiry +
          '</div>');
      });
      listEl.innerHTML = rows.join('');
    },

    async renderTrash() {
      if (!trashBlock) return;
      try {
        const items = (await window.api.listTrash()) || [];
        const n = items.length;
        if (n === 0) {
          trashBlock.innerHTML = '<div class="text-muted" style="padding:6px 0;">Trash is empty. Deleted sessions rest here for 7 days.</div>';
          return;
        }
        trashBlock.innerHTML = '<div class="text-muted" style="padding:6px 0;">Trash: ' + n +
          ' session(s). Auto-purged after 7 days.</div>';
      } catch (e) {
        trashBlock.innerHTML = '<div class="text-muted" style="padding:6px 0;">Trash unavailable.</div>';
      }
    },

    render() {
      if (!sessionsListEl) return;
      sessionsListEl.innerHTML = '';
      if (sessCompareA && sessCompareB) {
        sessCompareA.innerHTML = '';
        sessCompareB.innerHTML = '';
      }
      if (this.sessions.length === 0) {
        sessionsListEl.innerHTML = '<div class="text-muted" style="padding:12px;">No sessions found in the logs folder yet.</div>';
        return;
      }
      const currentName = (this.currentDir || '').split(/[\\/]/).filter(Boolean).pop();
      this.sessions.forEach((sess) => {
        const isCurrent = currentName && sess.name === currentName;
        const row = document.createElement('div');
        row.className = 'session-row' + (isCurrent ? ' current' : '');
        const badge = sess.isImported
          ? ' <span class="mock-status-chip ok">imported</span>'
          : (isCurrent ? ' <span class="mock-status-chip">current</span>' : '');
        const site = sess.site || 'unknown site';
        const tab = sess.tabTitle ? ' — ' + sess.tabTitle : '';
        row.innerHTML =
          '<div class="session-row-main">' +
          '<div class="session-line1" title="' + escapeHtml(site + tab) + '">' +
          '<span class="session-site">' + escapeHtml(site) + '</span>' +
          '<span class="session-tab">' + escapeHtml(tab) + '</span>' + badge +
          '</div>' +
          '<div class="session-date">Parsed: ' + escapeHtml(sess.parsedAt || '') + '</div>' +
          '<span class="session-meta">' + (sess.totalRequests || 0) + ' req · ' + formatBytes(sess.totalBytes || 0) + '</span>' +
          '</div>' +
          '<div class="session-actions">' +
          (isCurrent ? '' :
            '<button class="btn btn-xs btn-secondary session-open">Open</button>' +
            '<button class="btn btn-xs btn-danger session-delete" title="Move to .trash (reversible)">Delete</button>') +
          '</div>';
        const openBtn = row.querySelector('.session-open');
        if (openBtn) openBtn.addEventListener('click', () => this.open(sess.name));
        const delBtn = row.querySelector('.session-delete');
        if (delBtn) delBtn.addEventListener('click', async () => {
          if (!window.confirm(`Move session "${sess.name}" to .trash? It is reversible.`)) return;
          try {
            const target = await window.api.deleteSession(sess.name);
            showToast('Session moved to trash: ' + target, 'success', 4000);
            this.refresh();
          } catch (e) {
            showToast('Delete failed: ' + (e?.message || e), 'error', 5000);
          }
        });
        sessionsListEl.appendChild(row);
        if (sessCompareA && sessCompareB) {
          for (const sel of [sessCompareA, sessCompareB]) {
            const opt = document.createElement('option');
            opt.value = sess.name;
            opt.textContent = sess.name;
            sel.appendChild(opt);
          }
        }
      });
      if (sessCompareA && sessCompareB && this.sessions.length > 1) {
        sessCompareB.value = this.sessions[1].name;
      }
    },

    async open(name) {
      try {
        const dir = await window.api.openSession(name);
        if (dir) updateDirectoryDisplay(dir);
        showToast('Session opened (read-only view): ' + name, 'success', 3500);
        this.refresh();
      } catch (e) {
        showToast('Opening session failed: ' + (e && e.message ? e.message : e), 'error', 5000);
      }
    },

    async compare() {
      if (!sessCompareA || !sessCompareB || !sessionsCompareResults) return;
      const a = sessCompareA.value, b = sessCompareB.value;
      if (!a || !b || a === b) {
        showToast('Pick two different sessions to compare.', 'warning');
        return;
      }
      sessionsCompareResults.innerHTML = '<div class="text-muted" style="padding:12px;">Comparing...</div>';
      try {
        const res = await window.api.compareSessions(a, b);
        const fmt = (list, sessionName) => list.length === 0
          ? '<div class="text-muted" style="padding:6px;">none</div>'
          : list.map((s, idx) => {
              const key = sessionName + '|' + idx;
              const samples = (s.samples || []).map((sm) =>
                '<div class="compare-sample"><span class="status-pill status-' + String(sm.status || 0).charAt(0) + 'xx" style="font-size:9px;">' + (sm.status || '-') + '</span>' +
                '<span class="text-muted" style="font-size:9.5px;">' + escapeHtml((sm.timestamp || '').replace('T', ' ').slice(0, 19)) + '</span>' +
                '<span class="text-muted" style="font-size:9.5px;">' + formatBytes(sm.sizeBytes || 0) + '</span></div>').join('');
              return '<div class="compare-row-wrap">' +
                '<div class="compare-row compare-row-click" data-key="' + escapeHtml(key) + '">' +
                '<span class="method-chip ' + (s.method || 'get').toLowerCase() + '">' + escapeHtml(s.method) + '</span>' +
                ' <span class="code-font">' + escapeHtml(s.host) + escapeHtml(s.template) + '</span>' +
                ' <span class="tab-badge">' + s.count + '</span>' +
                (s.status5xx ? ' <span class="mock-status-chip err">' + s.status5xx + '×5xx</span>' : '') +
                '</div>' +
                '<div class="compare-samples" style="display:none;">' + samples +
                (s.samples && s.samples.length ? '<button class="btn btn-xs btn-primary compare-inspect" data-session="' + escapeHtml(sessionName) + '" data-url="' + escapeHtml(s.exampleUrl || '') + '">Inspect in Traffic</button>' : '') +
                '</div></div>';
            }).join('');
        const sec = (title, list, sessionName) =>
          '<div class="compare-section"><div class="compare-title">' + title + ' (' + list.length + ')</div>' + fmt(list, sessionName) + '</div>';
        sessionsCompareResults.innerHTML =
          sec('Only in ' + res.sessionA, res.onlyInA, res.sessionA) +
          sec('Only in ' + res.sessionB, res.onlyInB, res.sessionB) +
          sec('Count changed', res.changed, res.sessionB);
        
        
        sessionsCompareResults.querySelectorAll('.compare-row-click').forEach((el) => {
          el.addEventListener('click', () => {
            const box = el.nextElementSibling;
            if (box) box.style.display = box.style.display === 'block' ? 'none' : 'block';
          });
        });
        sessionsCompareResults.querySelectorAll('.compare-inspect').forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sessionName = btn.getAttribute('data-session');
            const url = btn.getAttribute('data-url') || '';
            try {
              await window.api.openSession(sessionName);
              searchFilterInput.value = url;
              searchText = url.toLowerCase();
              btnClearSearch.style.display = 'block';
              renderAllRows();
              switchWorkspaceView('traffic');
              showToast('Session opened, filtered to the endpoint. Pick a row for full details.', 'info', 4000);
            } catch (err) {
              showToast('Inspect failed: ' + (err?.message || err), 'error', 5000);
            }
          });
        });
      } catch (e) {
        sessionsCompareResults.innerHTML = '<div class="text-muted" style="padding:12px;">Compare failed: ' +
          escapeHtml(String(e && e.message ? e.message : e)) + '</div>';
      }
    }
  };

  const DiffController = {
    open(selectedId) {
      if (!diffModal) return;
      diffSelectA.innerHTML = '';
      diffSelectB.innerHTML = '';

      const allReqs = Array.from(requests.values());
      if (allReqs.length === 0) {
        if (diffResultsContainer) {
          diffResultsContainer.innerHTML = '<div class="text-muted" style="padding: 32px; text-align: center; font-size: 13px;">No network requests captured yet.<br><br>Browse websites in <strong>Google Chrome</strong> or click <strong>"Launch Chrome"</strong> to capture requests first.</div>';
        }
        diffModal.style.display = 'flex';
        return;
      }

      allReqs.forEach((r) => {
        let label = `#${r.id} [${(r.method || 'GET').toUpperCase()}] ${r.status || '...'} ${r.url}`;
        if (label.length > 85) label = label.substring(0, 85) + '...';

        const optA = document.createElement('option');
        optA.value = r.id;
        optA.textContent = label;
        diffSelectA.appendChild(optA);

        const optB = document.createElement('option');
        optB.value = r.id;
        optB.textContent = label;
        diffSelectB.appendChild(optB);
      });

      if (selectedId && requests.has(selectedId)) {
        diffSelectA.value = selectedId;
        const other = allReqs.find((r) => r.id !== selectedId);
        if (other) diffSelectB.value = other.id;
      } else {
        if (allReqs.length > 1) {
          diffSelectB.value = allReqs[1].id;
        }
      }

      diffModal.style.display = 'flex';
      this.renderDiff();
    },

    renderDiff() {
      const idA = diffSelectA.value;
      const idB = diffSelectB.value;
      const reqA = requests.get(idA);
      const reqB = requests.get(idB);

      if (!reqA || !reqB) {
        diffResultsContainer.innerHTML = '<div class="text-muted">Select two requests above to compare.</div>';
        return;
      }

      
      const statusA = reqA.status || 0;
      const statusB = reqB.status || 0;

      const durA = reqA.timing && reqA.timing.durationMs !== undefined ? reqA.timing.durationMs : 0;
      const durB = reqB.timing && reqB.timing.durationMs !== undefined ? reqB.timing.durationMs : 0;

      const sizeA = (reqA.response && reqA.response.sizeBytes) || 0;
      const sizeB = (reqB.response && reqB.response.sizeBytes) || 0;

      let html = `
        <div class="diff-summary-card">
          <div class="diff-metric-box">
            <div class="diff-metric-title">Request A Status &amp; Performance</div>
            <div class="diff-metric-val" style="color: ${statusA >= 200 && statusA < 300 ? 'var(--accent-green)' : 'var(--accent-red)'}">
              ${statusA} ${reqA.statusText || ''} (${durA} ms, ${formatBytes(sizeA)})
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); word-break: break-all; margin-top: 4px;">
              <strong>${escapeHtml(reqA.method || 'GET')}</strong> ${escapeHtml(reqA.url)}
            </div>
          </div>
          <div class="diff-metric-box">
            <div class="diff-metric-title">Request B Status &amp; Performance</div>
            <div class="diff-metric-val" style="color: ${statusB >= 200 && statusB < 300 ? 'var(--accent-green)' : 'var(--accent-red)'}">
              ${statusB} ${reqB.statusText || ''} (${durB} ms, ${formatBytes(sizeB)})
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); word-break: break-all; margin-top: 4px;">
              <strong>${escapeHtml(reqB.method || 'GET')}</strong> ${escapeHtml(reqB.url)}
            </div>
          </div>
        </div>
      `;

      
      const headersA = (reqA.headers && reqA.headers.request) || {};
      const headersB = (reqB.headers && reqB.headers.request) || {};
      const allKeys = Array.from(new Set([...Object.keys(headersA), ...Object.keys(headersB)])).sort();

      let headersDiffLeft = '';
      let headersDiffRight = '';

      allKeys.forEach((key) => {
        const valA = headersA[key];
        const valB = headersB[key];

        if (valA !== undefined && valB === undefined) {
          headersDiffLeft += `<div class="diff-item diff-removed"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(valA))}</div>`;
          headersDiffRight += `<div class="diff-item diff-same" style="opacity: 0.3;">(missing)</div>`;
        } else if (valA === undefined && valB !== undefined) {
          headersDiffLeft += `<div class="diff-item diff-same" style="opacity: 0.3;">(missing)</div>`;
          headersDiffRight += `<div class="diff-item diff-added"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(valB))}</div>`;
        } else if (String(valA) !== String(valB)) {
          headersDiffLeft += `<div class="diff-item diff-changed"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(valA))}</div>`;
          headersDiffRight += `<div class="diff-item diff-changed"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(valB))}</div>`;
        } else {
          headersDiffLeft += `<div class="diff-item diff-same"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(valA))}</div>`;
          headersDiffRight += `<div class="diff-item diff-same"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(valB))}</div>`;
        }
      });

      html += `
        <div class="diff-section">
          <div class="diff-section-title">
            <span>Request Headers Diff</span>
            <span class="diff-legend"><span class="legend-dot added"></span>Added in B <span class="legend-dot removed"></span>Removed in B <span class="legend-dot changed"></span>Value Difference</span>
          </div>
          <div class="diff-grid">
            <div class="diff-col">${headersDiffLeft || '<div class="text-muted">No headers</div>'}</div>
            <div class="diff-col">${headersDiffRight || '<div class="text-muted">No headers</div>'}</div>
          </div>
        </div>
      `;

      
      const bodyA = reqA.response && reqA.response.body ? (typeof reqA.response.body === 'object' ? JSON.stringify(reqA.response.body, null, 2) : String(reqA.response.body)) : '';
      const bodyB = reqB.response && reqB.response.body ? (typeof reqB.response.body === 'object' ? JSON.stringify(reqB.response.body, null, 2) : String(reqB.response.body)) : '';

      html += `
        <div class="diff-section">
          <div class="diff-section-title">
            <span>Response Body Comparison</span>
            <span style="font-size: 10px; color: var(--text-muted);">${bodyA.length} chars vs ${bodyB.length} chars</span>
          </div>
          <div class="diff-grid">
            <div class="diff-col"><pre class="code-block" style="max-height: 320px; overflow: auto; margin:0;">${escapeHtml(bodyA || '(Empty body)')}</pre></div>
            <div class="diff-col"><pre class="code-block" style="max-height: 320px; overflow: auto; margin:0;">${escapeHtml(bodyB || '(Empty body)')}</pre></div>
          </div>
        </div>
      `;

      diffResultsContainer.innerHTML = html;
    }
  };

  
  
  
  const MockController = {
    rules: [],
    selectedRuleId: null,

    async init() {
      if (window.api && window.api.getMockRules) {
        try {
          this.rules = (await window.api.getMockRules()) || [];
          this.updateBadge();
        } catch (e) {
          this.rules = [];
        }
      }
      if (window.api && window.api.onMockRulesUpdated) {
        window.api.onMockRulesUpdated((rules) => {
          this.rules = rules || [];
          this.updateBadge();
          if (mockModal && mockModal.style.display !== 'none') {
            this.renderList();
          }
        });
      }
    },

    updateBadge() {
      const activeCount = this.rules.filter((r) => r && r.enabled).length;
      if (mockRulesBadge) {
        mockRulesBadge.textContent = activeCount;
        mockRulesBadge.style.display = activeCount > 0 ? 'inline-block' : 'none';
      }
      if (mockRulesCount) {
        mockRulesCount.textContent = this.rules.length;
      }
    },

    open() {
      if (!mockModal) return;
      this.renderList();
      if (this.rules.length > 0 && !this.selectedRuleId) {
        this.selectRule(this.rules[0].id);
      } else if (this.selectedRuleId) {
        this.selectRule(this.selectedRuleId);
      } else {
        if (mockEditorEmpty) mockEditorEmpty.style.display = 'flex';
        if (mockEditorForm) mockEditorForm.style.display = 'none';
      }
      mockModal.style.display = 'flex';
    },

    close() {
      if (mockModal) mockModal.style.display = 'none';
    },

    renderList() {
      if (!mockRulesList) return;
      mockRulesList.innerHTML = '';
      this.updateBadge();

      if (this.rules.length === 0) {
        mockRulesList.innerHTML = '<div class="text-muted" style="padding: 12px 6px; font-size: 11.5px;">No mock rules configured yet. Click "+ New Rule" to create one.</div>';
        if (mockEditorEmpty) mockEditorEmpty.style.display = 'flex';
        if (mockEditorForm) mockEditorForm.style.display = 'none';
        return;
      }

      this.rules.forEach((rule) => {
        const item = document.createElement('div');
        item.className = `mock-rule-item ${rule.id === this.selectedRuleId ? 'active' : ''}`;
        item.id = `mock-rule-item-${rule.id}`;

        let methodClass = 'method-get';
        const m = (rule.method || 'ALL').toUpperCase();
        if (m === 'POST') methodClass = 'method-post';
        else if (m === 'PUT') methodClass = 'method-put';
        else if (m === 'DELETE') methodClass = 'method-delete';
        else if (m === 'ALL') methodClass = 'method-all';

        let statusChip = '';
        if (rule.last_status) {
          const st = rule.last_status;
          const tip = st.ok ? 'Applied by the extension' : 'Last application failed: ' + (st.error || 'unknown error');
          statusChip = `<span class="mock-status-chip ${st.ok ? 'ok' : 'err'}" title="${escapeHtml(tip)}">${st.ok ? 'applied' : 'error'}</span>`;
        }
        item.innerHTML = `
          <div class="mock-rule-item-top">
            <span class="mock-rule-item-title" title="${escapeHtml(rule.name)}">${escapeHtml(rule.name || 'Untitled Rule')}</span>
            <input type="checkbox" class="mock-item-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''} title="Toggle Rule" />
          </div>
          <div class="mock-rule-item-pattern" title="${escapeHtml(rule.urlPattern)}">${escapeHtml(rule.urlPattern || '*')}</div>
          <div class="mock-rule-item-badges">
            <span class="method-badge ${methodClass}" style="font-size: 9.5px; padding: 1px 4px;">${escapeHtml(m)}</span>
            <span class="status-pill ${rule.statusCode < 400 ? 'status-2xx' : 'status-4xx'}" style="font-size: 9.5px; padding: 1px 6px;">
              ${rule.statusCode || 200}
            </span>
            ${statusChip}
          </div>
        `;

        item.addEventListener('click', (e) => {
          if (e.target && e.target.classList.contains('mock-item-toggle')) return;
          this.selectRule(rule.id);
        });

        const toggle = item.querySelector('.mock-item-toggle');
        if (toggle) {
          toggle.addEventListener('change', (e) => {
            e.stopPropagation();
            rule.enabled = toggle.checked;
            this.saveAll();
            if (this.selectedRuleId === rule.id && mockRuleEnabled) {
              mockRuleEnabled.checked = rule.enabled;
            }
          });
        }

        mockRulesList.appendChild(item);
      });
    },

    selectRule(id) {
      this.selectedRuleId = id;
      document.querySelectorAll('.mock-rule-item').forEach((el) => el.classList.remove('active'));
      const activeEl = document.getElementById(`mock-rule-item-${id}`);
      if (activeEl) activeEl.classList.add('active');

      const rule = this.rules.find((r) => r.id === id);
      if (!rule) {
        if (mockEditorEmpty) mockEditorEmpty.style.display = 'flex';
        if (mockEditorForm) mockEditorForm.style.display = 'none';
        return;
      }

      if (mockEditorEmpty) mockEditorEmpty.style.display = 'none';
      if (mockEditorForm) mockEditorForm.style.display = 'flex';

      if (mockRuleName) mockRuleName.value = rule.name || '';
      if (mockRuleEnabled) mockRuleEnabled.checked = Boolean(rule.enabled);
      if (mockRuleMethod) mockRuleMethod.value = (rule.method || 'ALL').toUpperCase();
      if (mockRuleUrlPattern) mockRuleUrlPattern.value = rule.urlPattern || '*';
      if (mockRuleStatus) mockRuleStatus.value = rule.statusCode || 200;
      if (mockRuleContentType) mockRuleContentType.value = rule.contentType || 'application/json; charset=utf-8';
      if (mockRuleHeaders) mockRuleHeaders.value = Object.entries(rule.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
      if (mockRuleBody) mockRuleBody.value = rule.responseBody || '';
    },

    createRule(prefill) {
      const id = 'mock-' + Date.now();
      const newRule = {
        id,
        name: (prefill && prefill.name) || `Mock Rule ${this.rules.length + 1}`,
        urlPattern: (prefill && prefill.urlPattern) || '*',
        method: (prefill && prefill.method) || 'ALL',
        statusCode: (prefill && prefill.statusCode) || 200,
        contentType: (prefill && prefill.contentType) || 'application/json; charset=utf-8',
        headers: {},
        responseBody: (prefill && prefill.responseBody) || '{\n  "status": "ok",\n  "mocked": true\n}',
        enabled: true
      };

      this.rules.push(newRule);
      this.selectedRuleId = id;
      this.saveAll();
      this.open();
      this.selectRule(id);
    },

    duplicateRule() {
      if (!this.selectedRuleId) return;
      const current = this.rules.find((r) => r.id === this.selectedRuleId);
      if (!current) return;

      this.createRule({
        name: `${current.name} (Copy)`,
        urlPattern: current.urlPattern,
        method: current.method,
        statusCode: current.statusCode,
        contentType: current.contentType,
        responseBody: current.responseBody
      });
    },

    deleteRule() {
      if (!this.selectedRuleId) return;
      this.rules = this.rules.filter((r) => r.id !== this.selectedRuleId);
      this.selectedRuleId = this.rules.length > 0 ? this.rules[0].id : null;
      this.saveAll();
      this.renderList();
      if (this.selectedRuleId) {
        this.selectRule(this.selectedRuleId);
      } else {
        if (mockEditorEmpty) mockEditorEmpty.style.display = 'flex';
        if (mockEditorForm) mockEditorForm.style.display = 'none';
      }
    },

    saveCurrentForm() {
      if (!this.selectedRuleId) return;
      const rule = this.rules.find((r) => r.id === this.selectedRuleId);
      if (!rule) return;

      if (mockRuleName) rule.name = mockRuleName.value.trim() || 'Untitled Rule';
      if (mockRuleEnabled) rule.enabled = mockRuleEnabled.checked;
      if (mockRuleMethod) rule.method = mockRuleMethod.value.trim().toUpperCase();
      if (mockRuleUrlPattern) rule.urlPattern = mockRuleUrlPattern.value.trim() || '*';
      if (mockRuleStatus) rule.statusCode = Number(mockRuleStatus.value) || 200;
      if (mockRuleContentType) rule.contentType = mockRuleContentType.value.trim() || 'application/json';
      if (mockRuleHeaders) {
        const headers = {};
        mockRuleHeaders.value.split('\n').forEach((line) => {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.substring(0, idx).trim();
            const v = line.substring(idx + 1).trim();
            if (k) headers[k] = v;
          }
        });
        rule.headers = headers;
      }
      if (mockRuleBody) rule.responseBody = mockRuleBody.value;

      this.saveAll();
      this.renderList();
      this.selectRule(rule.id);
      if (btnSaveMockRule) copyToClipboard('', btnSaveMockRule, 'Saved!');
    },

    async saveAll() {
      this.updateBadge();
      if (window.api && window.api.saveMockRules) {
        try {
          await window.api.saveMockRules(this.rules);
        } catch (e) {
          console.error('Failed to save mock rules:', e);
        }
      }
    }
  };

  function openMockForCurrentRequest() {
    if (!selectedRequestId || !requests.has(selectedRequestId)) {
      if (btnMockThisRequest) copyToClipboard('', btnMockThisRequest, 'Select request first');
      return;
    }
    const record = requests.get(selectedRequestId);
    const u = record.url || '';
    let pattern = '*';
    try {
      const parsed = new URL(u);
      pattern = `*${parsed.pathname}*`;
    } catch (e) {
      pattern = `*${u.slice(-30)}*`;
    }

    let bodyStr = '{\n  "status": "mocked"\n}';
    if (record.response && record.response.body) {
      bodyStr = typeof record.response.body === 'object'
        ? JSON.stringify(record.response.body, null, 2)
        : String(record.response.body);
    }

    const mime = (record.response && record.response.mimeType) || 'application/json; charset=utf-8';

    MockController.createRule({
      name: `Mock ${record.method || 'GET'} ${(record.url || '').split('?')[0].split('/').pop() || 'endpoint'}`,
      urlPattern: pattern,
      method: (record.method || 'GET').toUpperCase(),
      statusCode: record.status || 200,
      contentType: mime,
      responseBody: bodyStr
    });
    switchWorkspaceView('mock');
  }

  
  document.addEventListener('DOMContentLoaded', init);
})();
