


const $ = (id) => document.getElementById(id);

function render(st) {
  const btn = $('btnCapture');
  const note = $('txtState');
  btn.className = '';
  if (!st.isServerOnline) {
    btn.disabled = true;
    btn.textContent = 'Start capture on this tab';
    note.textContent = 'Desktop app is not running';
  } else if (st.isCapturing && st.stage === 'recording') {
    btn.disabled = false;
    btn.className = 'stop';
    btn.textContent = 'Stop capture';
    const host = st.targetUrl ? String(st.targetUrl).replace(/^https?:\/\//, '').split('/')[0] : '';
    note.textContent = 'Recording the active tab' + (host ? ' · ' + host : '');
  } else if (st.isCapturing) {
    btn.disabled = false;
    btn.className = 'stop';
    btn.textContent = 'Stop capture';
    note.textContent = 'Waiting for tab attach…';
  } else {
    btn.disabled = false;
    btn.className = 'start';
    btn.textContent = 'Start capture on this tab';
    note.textContent = '';
  }

  
  $('stSent').textContent = String(st.delivery && st.delivery.sent || 0);
  $('stDropped').textContent = String(st.delivery && st.delivery.dropped || 0);
  $('stDropped').style.color = (st.delivery && st.delivery.dropped) ? '#ff9d97' : '';
  $('stError').textContent = st.lastError ? ('Last safety event: ' + st.lastError) : '';
}

async function queryStatus() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'np-status' });
    if (st) render(st);
  } catch (e) {  }
}

$('btnCapture').addEventListener('click', async () => {
  $('btnCapture').disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const st = await chrome.runtime.sendMessage({ type: 'np-toggle-capture', tabId: tab && tab.id });
    if (st) render(st);
  } catch (e) {
    $('stError').textContent = String(e && e.message || e);
  } finally { $('btnCapture').disabled = false; }
});

queryStatus();
setInterval(queryStatus, 1000);
