




const BRIDGE_PORT = 8765;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

let currentConfig = {
  targetSiteFilter: '',
  excludeTrackers: true,
  isCapturing: false,
  selectedTabId: null,
  captureRevision: -1,
  mockRules: [],
  pendingWsCommands: []
};

function hasActiveMockRules() {
  return Array.isArray(currentConfig.mockRules) && currentConfig.mockRules.some((r) => r && r.enabled);
}

const CONFIG_TIMEOUT_MS = 3000;
const CDP_TIMEOUT_MS = 2000;
let configSyncRunning = false;
let captureGeneration = 0;
let lastSafetyError = '';


setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 20000);

const fetchTabs = new Set();
const fetchTabsMode = new Map(); 
const attachingTabs = new Set();
let controlInFlight = false;
let localStop = false;
const detachingTabs = new Set();

function reportSafetyError(message) {
  lastSafetyError = message;
  console.warn('[Network-path] ' + message);
  updateBadge();
}





const pendingPauses = new Map(); 
const INTERCEPT_DEADLINE_MS = 10000;
function holdPausedRequest(source, params) {
  const requestId = params.requestId;
  if (pendingPauses.has(requestId)) return;
  const isResponse = params.responseStatusCode !== undefined;
  const entry = {
    tabId: source.tabId,
    url: params.url || (params.request && params.request.url) || '',
    method: (params.request && params.request.method) || 'GET',
    stage: isResponse ? 'Response' : 'Request',
    at: Date.now()
  };
  pendingPauses.set(requestId, entry);
  const post = (extra) => bridgePost(`${BRIDGE_URL}/api/intercept-paused`, Object.assign({
    requestId, tabId: source.tabId, url: entry.url, method: entry.method, stage: entry.stage
  }, extra || {})).catch(() => {});
  if (isResponse) {
    const headers = {};
    (params.responseHeaders || []).forEach((h) => { if (h && h.name) headers[h.name] = h.value; });
    const deliver = (body, bodyError) => post({
      stage: 'Response',
      statusCode: params.responseStatusCode,
      responseHeaders: headers,
      responseBody: body,
      bodyError: bodyError || null
    });
    
    
    
    safetyCommand(source, 'Network.getResponseBody', { requestId }, (res) => {
      const err = chrome.runtime.lastError;
      if (err || !res || typeof res.body !== 'string') {
        deliver('', 'body unavailable for editing (' + (err ? err.message : 'no body') + ') — provide your own');
        return;
      }
      deliver(res.body.slice(0, 48000), null);
    });
  } else {
    post({});
  }
}
function releaseAllPauses(reason) {
  pendingPauses.forEach((entry, requestId) => {
    pendingPauses.delete(requestId);
    safetyCommand({ tabId: entry.tabId }, 'Fetch.continueRequest', { requestId }, () => {});
  });
  if (reason && pendingPauses.size === 0) reportSafetyError(reason);
}
function applyInterceptResolution(cmd) {
  const entry = pendingPauses.get(cmd.requestId);
  if (!entry) return;
  pendingPauses.delete(cmd.requestId);
  const source = { tabId: entry.tabId };
  if (cmd.action === 'drop' || cmd.action === 'fail') {
    const reason = cmd.action === 'fail' ? (cmd.errorReason || 'TimedOut') : 'Aborted';
    safetyCommand(source, 'Fetch.failRequest', { requestId: cmd.requestId, errorReason: reason }, (error) => {
      if (error) { reportSafetyError('Intercept fail failed: ' + error.message); safetyCommand(source, 'Fetch.continueRequest', { requestId: cmd.requestId }, () => {}); }
    });
    return;
  }
  if (cmd.action === 'fulfill') {
    const headers = Object.entries(cmd.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
    let b64 = '';
    if (cmd.bodyBase64) { b64 = cmd.body || ''; }
    else { try { b64 = btoa(unescape(encodeURIComponent(cmd.body || ''))); } catch (e) { b64 = btoa(cmd.body || ''); } }
    safetyCommand(source, 'Fetch.fulfillRequest', { requestId: cmd.requestId, responseCode: Number(cmd.status) || 200, responseHeaders: headers, body: b64 }, (error) => {
      if (error) { reportSafetyError('Intercept fulfill failed: ' + error.message); safetyCommand(source, 'Fetch.continueRequest', { requestId: cmd.requestId }, () => {}); }
    });
    return;
  }
  
  const params = { requestId: cmd.requestId };
  
  
  if (cmd.interceptResponse) params.interceptResponse = true;
  if (cmd.url) params.url = cmd.url;
  if (cmd.headers && Object.keys(cmd.headers).length) {
    params.headers = Object.entries(cmd.headers).map(([name, value]) => ({ name, value: String(value) }));
  }
  if (cmd.body) params.postData = cmd.body;
  safetyCommand(source, 'Fetch.continueRequest', params, (error) => {
    if (error) reportSafetyError('Intercept forward failed: ' + error.message);
  });
}

function postMockStatus(ruleId, ok, error) {
  if (!ruleId) return;
  bridgePost(`${BRIDGE_URL}/api/mock-status`, { ruleId, ok, error: error || null }).catch(() => {});
}

const progressLog = []; 
let lastRecordingAckAt = 0;
function postCaptureProgress(tabId, attached, networkEnabled, error) {
  progressLog.push({ t: Date.now() % 1000000, tabId, attached, networkEnabled, error });
  if (progressLog.length > 8) progressLog.shift();
  if (attached && networkEnabled && !error) lastRecordingAckAt = Date.now();
  bridgePost(`${BRIDGE_URL}/api/capture-progress`, { tabId, attached, networkEnabled, error: error || null }).catch(() => {});
}



function safetyCommand(source, method, params, done) {
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(error);
  };
  const timer = setTimeout(() => finish(new Error(method + ' timed out')), CDP_TIMEOUT_MS);
  try {
    chrome.debugger.sendCommand(source, method, params, () => {
      const error = chrome.runtime.lastError;
      finish(error ? new Error(error.message || method + ' failed') : null);
    });
  } catch (error) { finish(error); }
}

function isSelectedTarget(tabId) {
  return !controlInFlight && !localStop && isServerOnline && currentConfig.isCapturing
    && Number.isInteger(currentConfig.selectedTabId) && tabId === currentConfig.selectedTabId;
}

function wantsFetch(tabId) {
  return isSelectedTarget(tabId) && (hasActiveMockRules() || Boolean(currentConfig.interceptEnabled))
    && attachedTabs.has(tabId) && !detachingTabs.has(tabId);
}

function enableFetchInterception(tabId) {
  const wantMode = Boolean(currentConfig.interceptEnabled) ? 'intercept' : 'mocks';
  if (!wantsFetch(tabId) || (fetchTabs.has(tabId) && fetchTabsMode.get(tabId) === wantMode)) return;
  if (fetchTabs.has(tabId)) { disableFetchInterception(tabId); }
  const generation = captureGeneration;
  fetchTabs.add(tabId);
  fetchTabsMode.set(tabId, wantMode);
  const patterns = Boolean(currentConfig.interceptEnabled)
    ? [{urlPattern: '*', requestStage: 'Request'}, {urlPattern: '*', responseStage: 'Response'}]
    : [{urlPattern: '*', requestStage: 'Request'}];
  safetyCommand({tabId}, 'Fetch.enable', {
    patterns
  }, (error) => {
    if (error) reportSafetyError('Fetch.enable: ' + error.message);
    if (error || generation !== captureGeneration || !wantsFetch(tabId)) {
      disableFetchInterception(tabId);
    }
  });
}

function disableFetchInterception(tabId) {
  fetchTabs.delete(tabId);
  safetyCommand({tabId}, 'Fetch.disable', {}, (error) => {
    if (error) {
      reportSafetyError('Fetch.disable failed; detaching target: ' + error.message);
      detachDebugger(tabId);
    }
  });
}

function continuePausedRequest(source, requestId) {
  safetyCommand(source, 'Fetch.continueRequest', {requestId}, (error) => {
    if (error) {
      reportSafetyError('Could not release paused request: ' + error.message);
      disableFetchInterception(source.tabId);
    }
  });
}

function goOffline(reason) {
  isServerOnline = false;
  captureGeneration++;
  releaseAllPauses('Bridge offline: all held requests released');
  
  attachedTabs.forEach((tabId) => disableFetchInterception(tabId));
  reportSafetyError(reason);
}

function matchesMockPattern(url, pattern) {
  if (!url) return false;
  if (!pattern || pattern.trim() === '' || pattern.trim() === '*' || pattern.trim() === '.*') return true;
  const pat = pattern.trim();
  try {
    const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i').test(url);
  } catch (e) {
    return url.toLowerCase().includes(pat.toLowerCase());
  }
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

const attachedTabs = new Set();
const tabUrls = new Map(); 
let isServerOnline = false;
let bridgeToken = ''; 
let eventQueue = [];

function bridgePost(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': bridgeToken },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}


function statusSnapshot() {
  return {
    isServerOnline,
    isCapturing: Boolean(currentConfig.isCapturing),
    selectedTabId: currentConfig.selectedTabId,
    stage: lastRecordingAckAt && isCapturingLive() ? 'recording' : (currentConfig.isCapturing ? 'requested' : 'idle'),
    targetUrl: currentConfig.selectedTabId != null ? (tabUrls.get(currentConfig.selectedTabId) || '') : '',
    attached: Array.from(attachedTabs),
    delivery: deliveryStats(),
    lastError: lastSafetyError || null
  };
}
function isCapturingLive() {
  return Boolean(currentConfig.isCapturing) && attachedTabs.size > 0 && !lastSafetyError;
}
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'np-status') { sendResponse(statusSnapshot()); return; }
    if (msg.type === 'np-toggle-capture') {
      const tabId = msg.tabId;
      if (!tabId) { sendResponse({ error: 'no tab' }); return; }
      const enabled = !(currentConfig.isCapturing && currentConfig.selectedTabId === tabId && !localStop);
      controlInFlight = true;
      localStop = !enabled;
      captureGeneration++;
      if (!enabled) {
        attachedTabs.forEach((id) => { disableFetchInterception(id); detachDebugger(id); });
      } else {
        currentConfig.selectedTabId = tabId;
        checkAndAttachEligibleTabs([{ id: tabId, url: tabUrls.get(tabId) || 'https://unknown' }]);
      }
      fetch(`${BRIDGE_URL}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': bridgeToken },
        body: JSON.stringify({ enabled, selectedTabId: tabId })
      }).then((r) => r.json()).then((state) => {
        if (typeof state.enabled === 'boolean') {
          currentConfig.isCapturing = state.enabled;
          currentConfig.selectedTabId = state.selectedTabId;
          currentConfig.captureRevision = state.revision;
        }
        sendResponse(statusSnapshot());
      }).catch(() => sendResponse(statusSnapshot()))
      
      
      .finally(() => { controlInFlight = false; syncConfigAndTabs(); });
      return true; 
    }
  });
}
let flushTimer = null;






const MAX_BATCH_BYTES = 512 * 1024;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 60;
const RETRY_INTERVAL_MS = 1000;
let backlogBytes = 0;
let droppedEvents = 0;
let flushInFlight = false;
let sentEvents = 0;
let eventSeq = 0;              
let lastAckedSeq = 0;          

function estimateEventBytes(eventData) {
  const bodyLen = eventData && typeof eventData.responseBody === 'string' ? eventData.responseBody.length : 0;
  return bodyLen + 512;
}

function deliveryStats() {
  return { queued: eventQueue.length, backlogBytes, dropped: droppedEvents, sent: sentEvents, lastSeq: eventSeq, lastAckedSeq };
}




function reconcileAttached(callback) {
  if (!chrome.debugger || typeof chrome.debugger.getTargets !== 'function') {
    callback();
    return;
  }
  chrome.debugger.getTargets((targets) => {
    if (!chrome.runtime.lastError && Array.isArray(targets)) {
      const live = new Set(targets.filter((t) => t && t.attached && typeof t.tabId === 'number').map((t) => t.tabId));
      let changed = false;
      Array.from(attachedTabs).forEach((id) => { if (!live.has(id)) { attachedTabs.delete(id); changed = true; } });
      if (changed) persistState();
    }
    callback();
  });
}


if (chrome.storage && chrome.storage.session) {
  chrome.storage.session.get(['attachedTabs', 'tabUrls', 'localStop', 'captureRevision', 'captureEpoch'], (data) => {
    if (data && data.localStop) { localStop = true; currentConfig.captureRevision = data.captureRevision ?? -1; currentConfig.captureEpoch = data.captureEpoch; }
    if (data && Array.isArray(data.attachedTabs)) {
      data.attachedTabs.forEach((id) => attachedTabs.add(id));
    }
    if (data && data.tabUrls) {
      Object.entries(data.tabUrls).forEach(([k, v]) => tabUrls.set(Number(k), v));
    }
    
    reconcileAttached(() => {
      if (!isServerOnline) attachedTabs.forEach(disableFetchInterception);
      updateBadge();
    });
  });
}

function persistState() {
  if (chrome.storage && chrome.storage.session) {
    const urlsObj = {};
    tabUrls.forEach((v, k) => { urlsObj[k] = v; });
    chrome.storage.session.set({
      attachedTabs: Array.from(attachedTabs),
      tabUrls: urlsObj
    });
  }
}





async function syncConfigAndTabs() {
  if (configSyncRunning) return;
  configSyncRunning = true;
  const controller = new AbortController();
  let deadline;
  try {
    const config = await Promise.race([
      (async () => {
        const res = await fetch(`${BRIDGE_URL}/api/config`, {
          method: 'GET', cache: 'no-store', signal: controller.signal
        });
        if (!res.ok) throw new Error('Config HTTP ' + res.status);
        return res.json();
      })(),
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new Error('Config heartbeat timed out'));
        }, CONFIG_TIMEOUT_MS);
      })
    ]);
    if (!config || typeof config.isCapturing !== 'boolean' || !Array.isArray(config.mockRules)) {
      throw new Error('Invalid bridge configuration');
    }
    if (controlInFlight || (config.captureEpoch === currentConfig.captureEpoch && config.captureRevision < currentConfig.captureRevision)) return;
    const wasActive = isServerOnline && currentConfig.isCapturing && (hasActiveMockRules() || Boolean(currentConfig.interceptEnabled));
    const epochChanged = config.captureEpoch !== currentConfig.captureEpoch;
    const targetChanged = epochChanged || config.selectedTabId !== currentConfig.selectedTabId;
    const captureChanged = config.isCapturing !== currentConfig.isCapturing;
    if (epochChanged || config.captureRevision > currentConfig.captureRevision) localStop = false;
    currentConfig = config;
    if (typeof config.bridgeToken === 'string' && config.bridgeToken) bridgeToken = config.bridgeToken;
    
    (config.pendingInterceptCommands || []).forEach(applyInterceptResolution);
    
    if (config.pendingThrottleCommand) {
      const th = config.pendingThrottleCommand;
      const throttleAck = (ok, error) => fetch(`${BRIDGE_URL}/api/throttle-ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok, error: error || null })
      }).catch(() => {});
      if ((th.enabled || !th.enabled) && attachedTabs.has(th.tabId)) {
        chrome.debugger.sendCommand({ tabId: th.tabId }, 'Network.emulateNetworkConditions', {
          offline: false,
          latency: th.enabled ? (Number(th.latency) || 0) : 0,
          downloadThroughput: th.enabled ? (Number(th.downloadThroughput) || -1) : -1,
          uploadThroughput: th.enabled ? (Number(th.uploadThroughput) || -1) : -1
        }, () => {
          const err = chrome.runtime.lastError;
          throttleAck(!err, err ? err.message : null);
          if (err) reportSafetyError('Throttle: ' + err.message);
        });
      } else {
        throttleAck(false, 'target not attached');
      }
    }
    
    const nowMs = Date.now();
    pendingPauses.forEach((entry, requestId) => {
      if (nowMs - entry.at > INTERCEPT_DEADLINE_MS) {
        pendingPauses.delete(requestId);
        reportSafetyError('Intercept pause timed out; request released: ' + entry.url);
        safetyCommand({ tabId: entry.tabId }, 'Fetch.continueRequest', { requestId }, () => {});
      }
    });
    if (targetChanged || captureChanged) captureGeneration++;
    isServerOnline = true;
    
    if (lastSafetyError && lastSafetyError.startsWith('Bridge offline')) lastSafetyError = '';
    const nowActive = currentConfig.isCapturing && !localStop && (hasActiveMockRules() || Boolean(currentConfig.interceptEnabled));
    if (wasActive && !nowActive) captureGeneration++;
    attachedTabs.forEach((tabId) => {
      if (!isSelectedTarget(tabId)) { disableFetchInterception(tabId); detachDebugger(tabId); }
      else if (nowActive) enableFetchInterception(tabId);
      else if (fetchTabs.has(tabId) || wasActive) disableFetchInterception(tabId);
    });
    updateBadge();

      const runTabPipeline = () => chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) return;

        const tabSummaries = [];
        (tabs || []).forEach((t) => {
          if (!t.url) return;
          tabUrls.set(t.id, t.url);

          if (!t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')) {
            tabSummaries.push({
              id: t.id,
              title: t.title || 'Untitled',
              url: t.url,
              active: Boolean(t.active),
              isAttached: attachedTabs.has(t.id)
            });
          }
        });

        persistState();

        
        sendTabsToBridge(tabSummaries);

        
        checkAndAttachEligibleTabs(tabs || []);
      });
      
      
      const selfHealTarget = currentConfig.selectedTabId;
      if (currentConfig.isCapturing && !localStop && !controlInFlight
          && typeof selfHealTarget === 'number' && attachedTabs.has(selfHealTarget)
          && !fetchTabs.has(selfHealTarget)
          && Date.now() - lastRecordingAckAt > 5000) {
        postCaptureProgress(selfHealTarget, true, false, null);
        chrome.debugger.sendCommand({ tabId: selfHealTarget }, 'Network.enable', {
          maxTotalBufferSize: 50000000, maxResourceBufferSize: 25000000, maxPostDataSize: 10000000
        }, () => {
          if (chrome.runtime.lastError) {
            postCaptureProgress(selfHealTarget, true, false, 'Network.enable: ' + chrome.runtime.lastError.message);
          } else {
            postCaptureProgress(selfHealTarget, true, true, null);
          }
        });
      }

      
      
      if (captureChanged && config.isCapturing) {
        reconcileAttached(() => {
          const target = currentConfig.selectedTabId;
          if (typeof target === 'number' && attachedTabs.has(target)) {
            
            
            
            postCaptureProgress(target, true, false, null);
            chrome.debugger.sendCommand({ tabId: target }, 'Network.enable', {
              maxTotalBufferSize: 50000000, maxResourceBufferSize: 25000000, maxPostDataSize: 10000000
            }, () => {
              if (chrome.runtime.lastError) {
                postCaptureProgress(target, true, false, 'Network.enable: ' + chrome.runtime.lastError.message);
              } else {
                postCaptureProgress(target, true, true, null);
              }
            });
          }
          runTabPipeline();
        });
      } else {
        runTabPipeline();
      }
  } catch (err) {
    goOffline('Bridge offline: ' + err.message);
  } finally {
    clearTimeout(deadline);
    configSyncRunning = false;
  }
}

async function sendTabsToBridge(tabs) {
  try {
    await bridgePost(`${BRIDGE_URL}/api/tabs`, { tabs, delivery: deliveryStats() });
  } catch (e) {}
}

setInterval(syncConfigAndTabs, 1200);

if (chrome.alarms) {
  chrome.alarms.create('bridgeKeepAlive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'bridgeKeepAlive') {
      syncConfigAndTabs();
    }
  });
}

syncConfigAndTabs();

function updateBadge() {
  if (lastSafetyError) {
    chrome.action.setBadgeText({text: 'ERR'});
    chrome.action.setBadgeBackgroundColor({color: '#e5534b'});
    chrome.action.setTitle({title: 'Network-path: ' + lastSafetyError + ' (last safety error; see extension console)'});
    return;
  }
  if (!isServerOnline) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#e5534b' }); 
    chrome.action.setTitle({ title: 'Network-path Bridge: Server offline (Start Network-path app)' });
  } else if (attachedTabs.size > 0) {
    chrome.action.setBadgeText({ text: String(attachedTabs.size) });
    chrome.action.setBadgeBackgroundColor({ color: '#2ea043' }); 
    chrome.action.setTitle({ title: `Network-path Bridge: Active on ${attachedTabs.size} tab(s)` });
  } else {
    chrome.action.setBadgeText({ text: 'IDLE' });
    chrome.action.setBadgeBackgroundColor({ color: '#388bfd' }); 
    chrome.action.setTitle({ title: 'Network-path Bridge: Connected, waiting for active tab' });
  }
}





function checkAndAttachEligibleTabs(tabs) {
  attachedTabs.forEach((id) => { if (!isSelectedTarget(id)) detachDebugger(id); });
  if (!isServerOnline || !currentConfig.isCapturing || localStop || controlInFlight) return;
  const target = tabs.find(tab => tab.id === currentConfig.selectedTabId);
  if (target && target.url && /^https?:/.test(target.url)) {
    tabUrls.set(target.id, target.url);
    attachDebugger(target.id);
  }
}

function attachDebugger(tabId) {
  if (!isSelectedTarget(tabId) || attachedTabs.has(tabId)
      || attachingTabs.has(tabId) || detachingTabs.has(tabId)) return;
  const generation = captureGeneration;
  attachingTabs.add(tabId);
  
  
  let settled = false;
  const attachTimer = setTimeout(() => {
    if (settled) return;
    attachingTabs.delete(tabId);
    reportSafetyError('Debugger attach timed out; target ' + tabId + ' can be retried');
  }, CDP_TIMEOUT_MS);
  chrome.debugger.attach({ tabId }, '1.3', () => {
    settled = true;
    clearTimeout(attachTimer);
    attachingTabs.delete(tabId);
    if (chrome.runtime.lastError) {
      postCaptureProgress(tabId, false, false, 'Debugger attach: ' + chrome.runtime.lastError.message);
      return;
    }

    attachedTabs.add(tabId);
    persistState();
    if (generation !== captureGeneration || !isSelectedTarget(tabId)) {
      detachDebugger(tabId);
      return;
    }
    updateBadge();
    postCaptureProgress(tabId, true, false, null);

    chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 50000000,
      maxResourceBufferSize: 25000000,
      maxPostDataSize: 10000000
    }, () => {
      if (chrome.runtime.lastError) {
        postCaptureProgress(tabId, true, false, 'Network.enable: ' + chrome.runtime.lastError.message);
      } else if (generation === captureGeneration && isSelectedTarget(tabId)) {
        postCaptureProgress(tabId, true, true, null);
      }
    });

    chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () => {
      if (chrome.runtime.lastError) {}
    });

    if (hasActiveMockRules()) {
      enableFetchInterception(tabId);
    }
  });
}

function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId) || detachingTabs.has(tabId)) return;
  detachingTabs.add(tabId);
  fetchTabs.delete(tabId);
  let completed = false;
  const timer = setTimeout(() => {
    if (!completed) {
      
      reportSafetyError('Debugger detach timed out; forcing local reset for target ' + tabId);
      detachingTabs.delete(tabId);
      attachedTabs.delete(tabId);
      fetchTabs.delete(tabId);
      persistState();
      updateBadge();
      postCaptureProgress(tabId, false, false, 'detach timed out');
    }
  }, CDP_TIMEOUT_MS);
  const finish = (error) => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    detachingTabs.delete(tabId);
    pendingPauses.forEach((entry, requestId) => { if (entry.tabId === tabId) { pendingPauses.delete(requestId); safetyCommand({ tabId }, 'Fetch.continueRequest', { requestId }, () => {}); } });
    if (error) reportSafetyError('Debugger detach failed: ' + error.message);
    else attachedTabs.delete(tabId);
    persistState();
    updateBadge();
    postCaptureProgress(tabId, false, false, error ? error.message : null);
  };
  try {
    chrome.debugger.detach({tabId}, () => finish(chrome.runtime.lastError));
  } catch (error) { finish(error); }
}



chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || controlInFlight) return;
  const enabled = !(currentConfig.isCapturing && currentConfig.selectedTabId === tab.id && !localStop);
  controlInFlight = true;
  localStop = true;
  captureGeneration++;
  attachedTabs.forEach(id => { disableFetchInterception(id); detachDebugger(id); });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
  try {
    const res = await fetch(`${BRIDGE_URL}/api/capture`, {
      method: 'POST', headers: {'Content-Type':'application/json','X-Bridge-Token':bridgeToken},
      body: JSON.stringify({enabled, selectedTabId:tab.id}), signal: controller.signal
    });
    if (!res.ok) throw new Error('Capture command HTTP ' + res.status);
    const state = await res.json();
    if (typeof state.enabled !== 'boolean' || !Number.isInteger(state.revision)) throw new Error('Invalid capture acknowledgment');
    currentConfig = {...currentConfig, isCapturing:state.enabled, selectedTabId:state.selectedTabId, captureRevision:state.revision,captureEpoch:state.epoch};
    localStop = false;
    if (chrome.storage && chrome.storage.session) chrome.storage.session.set({localStop:false});
  } catch (error) {
    if (chrome.storage && chrome.storage.session) chrome.storage.session.set({localStop:true,captureRevision:currentConfig.captureRevision,captureEpoch:currentConfig.captureEpoch});
    reportSafetyError('Capture command failed; locally stopped: ' + error.message);
  } finally {
    clearTimeout(timer); controlInFlight = false;
  }
  syncConfigAndTabs();
});




chrome.tabs.onActivated.addListener((info) => {
  if (!isServerOnline || localStop || controlInFlight) return;
  if (!currentConfig.isCapturing || info.tabId === currentConfig.selectedTabId) return;
  chrome.tabs.get(info.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    const url = tab.url || tabUrls.get(tab.id) || '';
    if (!/^https?:/.test(url)) return; 
    if (!currentConfig.isCapturing || !isServerOnline || localStop || controlInFlight) return;
    if (tab.id === currentConfig.selectedTabId) return;
    tabUrls.set(tab.id, url);
    const previous = currentConfig.selectedTabId;
    currentConfig.selectedTabId = tab.id;
    captureGeneration++;
    if (typeof previous === 'number' && attachedTabs.has(previous)) {
      disableFetchInterception(previous);
      detachDebugger(previous);
    }
    attachDebugger(tab.id);
    
    fetch(`${BRIDGE_URL}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': bridgeToken },
      body: JSON.stringify({ enabled: true, selectedTabId: tab.id })
    }).then((r) => r.json()).then((state) => {
      if (typeof state.enabled === 'boolean') {
        currentConfig.isCapturing = state.enabled;
        currentConfig.selectedTabId = state.selectedTabId;
        currentConfig.captureRevision = state.revision;
      }
    }).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (tab && tab.url);
  if (url) tabUrls.set(tabId, url);
  if (url && /^https?:/.test(url) && isSelectedTarget(tabId)) attachDebugger(tabId);
  else if (attachedTabs.has(tabId)) detachDebugger(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  fetchTabs.delete(tabId);
  detachingTabs.delete(tabId);
  tabUrls.delete(tabId);
  persistState();
  updateBadge();
  postCaptureProgress(tabId, false, false, 'Tab closed');
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    fetchTabs.delete(source.tabId);
    detachingTabs.delete(source.tabId);
    persistState();
    updateBadge();
    postCaptureProgress(source.tabId, false, false, 'Debugger detached externally');
  }
});





chrome.debugger.onEvent.addListener((source, method, params) => {
  
  
  
  
  
  if (method === 'Fetch.requestPaused' && !isServerOnline && isSelectedTarget(source.tabId)) {
    continuePausedRequest(source, params.requestId);
    return;
  }
  if (method === 'Fetch.requestPaused' && !wantsFetch(source.tabId)) {
    continuePausedRequest(source, params.requestId);
    return;
  }
  if (method === 'Fetch.requestPaused' && Boolean(currentConfig.interceptEnabled)
      && isSelectedTarget(source.tabId) && fetchTabs.has(source.tabId)
      && !(currentConfig.mockRules || []).some((r) => r && r.enabled && matchesMockPattern(
        (params.request && params.request.url) || '', r.urlPattern))) {
    holdPausedRequest(source, params);
    return;
  }
  if (!isSelectedTarget(source.tabId)) return;

  const tabUrl = tabUrls.get(source.tabId) || '';
  const filter = currentConfig.targetSiteFilter ? currentConfig.targetSiteFilter.trim() : '';

  
  if (method === 'Fetch.requestPaused') {
    const reqUrl = (params.request && params.request.url) || '';
    const reqMethod = (params.request && params.request.method) || 'GET';

    const activeRule = (currentConfig.mockRules || []).find((r) => {
      if (!r || !r.enabled) return false;
      if (r.method && r.method !== 'ALL' && r.method.toUpperCase() !== reqMethod.toUpperCase()) return false;
      return matchesMockPattern(reqUrl, r.urlPattern);
    });

    if (activeRule) {
      let b64 = '';
      try {
        b64 = btoa(unescape(encodeURIComponent(activeRule.responseBody || '')));
      } catch (e) {
        b64 = btoa(activeRule.responseBody || '');
      }

      const responseHeaders = [
        { name: 'Content-Type', value: activeRule.contentType || 'application/json' }
      ];
      
      const customHeaders = (activeRule.headers && typeof activeRule.headers === 'object') ? activeRule.headers : {};
      for (const [hk, hv] of Object.entries(customHeaders)) {
        if (hk && hv != null) {
          const idx = responseHeaders.findIndex((h) => h.name.toLowerCase() === hk.toLowerCase());
          if (idx >= 0) responseHeaders[idx] = { name: hk, value: String(hv) };
          else responseHeaders.push({ name: hk, value: String(hv) });
        }
      }
      if (!Object.keys(customHeaders).some((k) => k.toLowerCase() === 'access-control-allow-origin')) {
        responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      }
      if (!Object.keys(customHeaders).some((k) => k.toLowerCase() === 'x-mocked-by')) {
        responseHeaders.push({ name: 'X-Mocked-By', value: 'network-path-tauri' });
      }

      safetyCommand(source, 'Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: Number(activeRule.statusCode) || 200,
        responseHeaders,
        body: b64
      }, (error) => {
        postMockStatus(activeRule.id, !error, error ? error.message : null);
        if (error) {
          reportSafetyError('Mock fulfillment failed: ' + error.message);
          continuePausedRequest(source, params.requestId);
          return;
        }
        if (!isServerOnline) return;

      const mockReqId = `mock-${params.networkId || params.requestId || Date.now()}`;
      queueEvent({
        method: 'Network.requestWillBeSent',
        params: {
          requestId: mockReqId,
          request: {
            url: reqUrl,
            method: reqMethod,
            headers: (params.request && params.request.headers) || {}
          },
          type: params.resourceType || 'Other',
          wallTime: Date.now() / 1000
        },
        tabId: source.tabId,
        tabUrl
      });

      queueEvent({
        method: 'Network.responseReceived',
        params: {
          requestId: mockReqId,
          response: {
            url: reqUrl,
            status: Number(activeRule.statusCode) || 200,
            statusText: 'OK (Mocked)',
            headers: {
              'content-type': activeRule.contentType || 'application/json',
              'x-mocked-by': 'network-path-tauri'
            },
            mimeType: activeRule.contentType || 'application/json',
            protocol: 'mock/cdp'
          },
          type: params.resourceType || 'Other'
        },
        tabId: source.tabId,
        tabUrl
      });

      queueEvent({
        method: 'Network.loadingFinished',
        params: {
          requestId: mockReqId,
          encodedDataLength: (activeRule.responseBody || '').length
        },
        tabId: source.tabId,
        tabUrl,
        responseBody: activeRule.responseBody || '',
        base64Encoded: false
      });
      });
    } else if (currentConfig.interceptEnabled) {
      
      holdPausedRequest(source, params);
      return;
    } else {
      continuePausedRequest(source, params.requestId);
    }
    return;
  }

  
  if (currentConfig.excludeTrackers && params) {
    const reqUrl = (params.request && params.request.url) || params.url || '';
    if (reqUrl && isTrackerUrl(reqUrl)) {
      if (!filter || !reqUrl.toLowerCase().includes(filter)) {
        return;
      }
    }
  }

  
  if (method === 'Network.loadingFinished') {
    chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId: params.requestId }, (bodyRes) => {
      const err = chrome.runtime.lastError;
      const payload = {
        method,
        params,
        tabId: source.tabId,
        tabUrl,
        responseBody: (!err && bodyRes && typeof bodyRes.body === 'string') ? bodyRes.body : null,
        base64Encoded: Boolean(!err && bodyRes && bodyRes.base64Encoded)
      };
      queueEvent(payload);
    });
    return;
  }

  
  queueEvent({
    method,
    params,
    tabId: source.tabId,
    tabUrl
  });
});

function queueEvent(eventData) {
  eventData._seq = ++eventSeq;
  eventQueue.push(eventData);
  backlogBytes += estimateEventBytes(eventData);

  
  
  
  while (backlogBytes > MAX_QUEUE_BYTES && eventQueue.length > 0) {
    let strippedSomething = false;
    for (const ev of eventQueue) {
      if (!ev._stripped && typeof ev.responseBody === 'string' && ev.responseBody.length > 0) {
        backlogBytes -= estimateEventBytes(ev);
        ev.responseBody = null;
        ev.base64Encoded = false;
        ev._truncated = true;
        backlogBytes += estimateEventBytes(ev);
        strippedSomething = true;
      }
      if (backlogBytes <= MAX_QUEUE_BYTES) break;
    }
    if (!strippedSomething && backlogBytes > MAX_QUEUE_BYTES) {
      const dropped = eventQueue.shift();
      backlogBytes -= estimateEventBytes(dropped);
      droppedEvents++;
    }
    if (!strippedSomething) break;
  }

  if (backlogBytes >= MAX_BATCH_BYTES || eventQueue.length >= 25) {
    flushEventQueue();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushEventQueue, FLUSH_INTERVAL_MS);
  }
}

async function flushEventQueue() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushInFlight || eventQueue.length === 0) return;

  
  const batch = [];
  let batchBytes = 0;
  while (eventQueue.length > 0) {
    const next = eventQueue[0];
    const size = estimateEventBytes(next);
    if (batch.length > 0 && batchBytes + size > MAX_BATCH_BYTES) break;
    batch.push(eventQueue.shift());
    batchBytes += size;
    backlogBytes -= size;
    if (batchBytes >= MAX_BATCH_BYTES) break;
  }

  flushInFlight = true;
  try {
    const res = await bridgePost(`${BRIDGE_URL}/api/traffic`, batch);
    if (!res.ok) throw new Error('traffic HTTP ' + res.status);
    sentEvents += batch.length;
    const ack = await res.json().catch(() => null);
    if (ack && typeof ack.ackSeq === 'number') lastAckedSeq = Math.max(lastAckedSeq, ack.ackSeq);
  } catch (err) {
    
    eventQueue = batch.concat(eventQueue);
    backlogBytes += batchBytes;
    
    while (backlogBytes > MAX_QUEUE_BYTES && eventQueue.length > 1) {
      const dropped = eventQueue.pop();
      backlogBytes -= estimateEventBytes(dropped);
      droppedEvents++;
    }
  } finally {
    flushInFlight = false;
    if (eventQueue.length > 0 && !flushTimer) {
      flushTimer = setTimeout(flushEventQueue, RETRY_INTERVAL_MS);
    }
  }
}
