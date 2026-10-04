





(function () {
  'use strict';

  const tauriObj = window.__TAURI__ || {};
  const coreObj = tauriObj.core || window.__TAURI_INTERNALS__;
  const eventObj = tauriObj.event || window.__TAURI_INTERNALS__;

  const invoke = (coreObj && typeof coreObj.invoke === 'function')
    ? coreObj.invoke.bind(coreObj)
    : (typeof tauriObj.invoke === 'function')
    ? tauriObj.invoke.bind(tauriObj)
    : null;

  const listen = (eventObj && typeof eventObj.listen === 'function')
    ? eventObj.listen.bind(eventObj)
    : (typeof tauriObj.listen === 'function')
    ? tauriObj.listen.bind(tauriObj)
    : null;

  const isTauri = Boolean(invoke && listen);
  
  const unsupported = (what, hint) => {
    const error = new Error(what + ' is unavailable in browser preview. ' + (hint || 'Run the desktop app instead.'));
    error.code = 'UNSUPPORTED_CAPABILITY';
    throw error;
  };
  const unsupportedWebSocketSend = async () => unsupported('WebSocket sending', 'Only observed frames are supported.');

  if (isTauri) {

    window.api = {
      
      getCaptureState: () => invoke('get_capture_state'),
      setCaptureState: (enabled, tabId) => invoke('set_capture_state', {enabled, tabId}),
      onCaptureState: (callback) => { const p = listen('capture-state', event => callback(event.payload)); return () => p.then(fn => fn()); },
      getInitialState: () => invoke('get_initial_state'),
      checkConnection: () => invoke('check_connection'),
      startNewSession: () => invoke('start_new_session'),
      launchChrome: (targetUrl) => invoke('launch_chrome_app', { targetUrl: targetUrl || '' }),
      reconnectChrome: () => invoke('reconnect_chrome'),
      disconnectChrome: () => invoke('disconnect_chrome'),

      
      setSiteFilter: (filter) => invoke('set_site_filter', { filter: filter || '' }),
      setExcludeTrackers: (enabled) => invoke('set_exclude_trackers', { enabled: Boolean(enabled) }),
      openExtensionFolder: () => invoke('open_extension_folder'),

      
      selectFolder: () => invoke('select_folder'),
      openFolder: (folderPath) => invoke('open_folder', { folderPath: folderPath || null }),

      
      clearLogs: () => invoke('clear_logs'),
      exportSummary: () => invoke('export_summary'),
      importHar: (json) => invoke('import_har', { json }),
      saveExportFile: (filename, content) => invoke('save_export_file', { filename, content }),

      
      sendRepeaterRequest: (request) => invoke('send_repeater_request', { request }),

      
      readFulfillFile: (path) => invoke('read_fulfill_file', { path }),
      startCdpDirect: (targetUrl) => invoke('start_cdp_direct', { targetUrl: targetUrl || '' }),
      stopCdpDirect: () => invoke('stop_cdp_direct'),
      setIntercept: (enabled) => invoke('set_intercept', { enabled: Boolean(enabled) }),
      interceptResolve: (request) => invoke('intercept_resolve', { request }),
      listInterceptPaused: () => invoke('list_intercept_paused'),
      onInterceptPaused: (callback) => {
        let unlistenPromise = listen('intercept-paused', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onInterceptResolved: (callback) => {
        let unlistenPromise = listen('intercept-resolved', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },

      
      listSessions: () => invoke('list_sessions'),
      openSession: (name) => invoke('open_session', { name }),
      deleteSession: (name) => invoke('delete_session', { name }),
      listTrash: () => invoke('list_trash'),
      searchSessions: (query) => invoke('search_sessions', { query }),
      emptyTrash: () => invoke('empty_trash'),
      compareSessions: (sessionA, sessionB) => invoke('compare_sessions', { sessionA, sessionB }),

      
      getMockRules: () => invoke('get_mock_rules'),
      saveMockRules: (rules) => invoke('save_mock_rules', { rules }),

      
      sendWebSocketMessage: unsupportedWebSocketSend,

      
      onLoadSavedRequests: (callback) => {
        let unlistenPromise = listen('load-saved-requests', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onChromeStatus: (callback) => {
        let unlistenPromise = listen('chrome-status', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onTabsUpdated: (callback) => {
        let unlistenPromise = listen('tabs-updated', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onRequestStarted: (callback) => {
        let unlistenPromise = listen('request-started', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onRequestFinished: (callback) => {
        let unlistenPromise = listen('request-finished', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onSocketEvent: (callback) => {
        let unlistenPromise = listen('socket-event', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onMockRulesUpdated: (callback) => {
        let unlistenPromise = listen('mock-rules-updated', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      },
      onSummaryUpdated: (callback) => {
        let unlistenPromise = listen('summary-updated', (event) => callback(event.payload));
        return () => { unlistenPromise.then((unlisten) => unlisten()); };
      }
    };
  } else {
    
    console.info('[Network-path] Running in Browser fallback mode (HTTP :8765)');
    const BRIDGE = 'http://127.0.0.1:8765';

    window.api = {
      getInitialState: async () => {
        const res = await fetch(`${BRIDGE}/api/status`);
        const status = await res.json();
        return {
          isConnected: status.isConnected,
          isExtensionConnected: status.isExtensionConnected,
          isPortConnected: false,
          chromePort: 9222,
          currentOutputDir: 'logs',
          targetSiteFilter: status.targetSiteFilter || '',
          excludeTrackers: true,
          openTabs: status.tabs || [],
          chromeFound: true,
          savedRequests: [],
          sessionStats: null
        };
      },
      checkConnection: async () => {
        const res = await fetch(`${BRIDGE}/api/status`);
        return await res.json();
      },
      launchChrome: async (targetUrl) => {
        try {
          const res = await fetch(`${BRIDGE}/api/launch-chrome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUrl: targetUrl || '' })
          });
          const data = await res.json();
          return Boolean(data && data.ok);
        } catch (e) {
          return false;
        }
      },
      getCaptureState: async () => { const res = await fetch(`${BRIDGE}/api/capture`); if (!res.ok) throw new Error('Capture state unavailable'); return res.json(); },
      setCaptureState: async () => unsupported('Capture control'),
      onCaptureState: () => () => {},
      reconnectChrome: async () => unsupported('Reconnect'),
      disconnectChrome: async () => unsupported('Disconnect'),
      setSiteFilter: async () => unsupported('Site filter', 'The View field filters display locally; the desktop app owns the capture target.'),
      setExcludeTrackers: async () => unsupported('Tracker filter', 'Tracker filtering is a display option of the desktop app.'),
      openExtensionFolder: async () => {
        try {
          const res = await fetch(`${BRIDGE}/api/open-extension-folder`, { method: 'POST' });
          return res.ok;
        } catch (e) {
          return false;
        }
      },
      selectFolder: async () => unsupported('Folder selection'),
      openFolder: async () => {
        try {
          const res = await fetch(`${BRIDGE}/api/open-folder`, { method: 'POST' });
          return res.ok;
        } catch (e) {
          return false;
        }
      },
      clearLogs: async () => unsupported('Deleting saved sessions', 'It is disabled by design; use Clear view, which keeps files.'),
      startNewSession: async () => unsupported('New Session', 'Session creation requires the desktop backend.'),
      exportSummary: async () => unsupported('Session summary export'),
      importHar: async () => unsupported('HAR import'),
      saveExportFile: async () => unsupported('Saving export files'),
      readFulfillFile: async () => unsupported('Map Local'),
      startCdpDirect: async () => unsupported('CDP-direct capture', 'Requires the desktop app.'),
      stopCdpDirect: async () => unsupported('CDP-direct capture'),
      setIntercept: async () => unsupported('Intercept'),
      interceptResolve: async () => unsupported('Intercept resolution'),
      listInterceptPaused: async () => [],
      onInterceptPaused: () => () => {},
      onInterceptResolved: () => () => {},
      listSessions: async () => [],
      openSession: async () => unsupported('Opening a session', 'Session switching requires the desktop backend.'),
      deleteSession: async () => unsupported('Deleting a session', 'Session deletion requires the desktop backend.'),
      listTrash: async () => [],
      searchSessions: async () => ({ query: '', scannedSessions: 0, scannedLines: 0, truncated: false, results: [] }),
      emptyTrash: async () => unsupported('Emptying the trash', 'Trash lifecycle requires the desktop backend.'),
      compareSessions: async () => unsupported('Session comparison', 'Session comparison requires the desktop backend.'),
      sendRepeaterRequest: async () => ({
        status: 0,
        statusText: 'Browser fallback',
        durationMs: 0,
        sizeBytes: 0,
        headers: {},
        body: '',
        isJson: false,
        error: 'Tauri backend required'
      }),
      getMockRules: async () => {
        try {
          const res = await fetch(`${BRIDGE}/api/mock-rules`);
          return res.ok ? await res.json() : [];
        } catch (e) {
          return [];
        }
      },
      saveMockRules: async (rules) => {
        try {
          const res = await fetch(`${BRIDGE}/api/mock-rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rules)
          });
          return res.ok;
        } catch (e) {
          return false;
        }
      },
      sendWebSocketMessage: unsupportedWebSocketSend,

      onLoadSavedRequests: () => () => {},
      onChromeStatus: () => () => {},
      onTabsUpdated: () => () => {},
      onRequestStarted: () => () => {},
      onRequestFinished: () => () => {},
      onSocketEvent: () => () => {},
      onMockRulesUpdated: () => () => {},
      onSummaryUpdated: () => () => {}
    };
  }
  window.api.capabilities = Object.freeze({ liveIntercept: false, webSocketSend: false, tlsFingerprint: false });
})();
