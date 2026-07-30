let ws = null;
let reconnectTimer = null;

function connectDaemon() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket('ws://127.0.0.1:9182');

    ws.onopen = () => {
      console.log('[Butchr Ext] Connected to Local Daemon (127.0.0.1:9182)');
      chrome.runtime.sendMessage({ type: 'DAEMON_STATUS', connected: true }).catch(() => {});
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('[Butchr Ext] Message from Daemon:', data);
      chrome.runtime.sendMessage({ type: 'DAEMON_RESPONSE', payload: data }).catch(() => {});
    };

    ws.onclose = () => {
      console.log('[Butchr Ext] Daemon WebSocket disconnected. Retrying in 3s...');
      chrome.runtime.sendMessage({ type: 'DAEMON_STATUS', connected: false }).catch(() => {});
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[Butchr Ext] WebSocket error:', err);
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectDaemon();
    }, 3000);
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ACTIVATE_BUTCHR') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        action: 'activate',
        url: message.url,
        tabId: message.tabId
      }));
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Daemon not connected' });
    }
  } else if (message.type === 'CHECK_STATUS') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        action: 'status',
        url: message.url
      }));
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Daemon not connected' });
    }
  } else if (message.type === 'FETCH_AGENTS') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        action: 'list_agents'
      }));
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Daemon not connected' });
    }
  } else if (message.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: message.url });
    sendResponse({ status: 'opened' });
  }
  return true;
});

connectDaemon();
