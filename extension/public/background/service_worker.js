const HOST_NAME = 'com.butchr.daemon';
let nativePort = null;
let isConnected = false;

function connectNativeHost() {
  if (isConnected && nativePort) {
    return;
  }

  try {
    console.log(`[Butchr Ext] Connecting to Native Messaging Host: ${HOST_NAME}`);
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    isConnected = true;

    chrome.runtime.sendMessage({ type: 'DAEMON_STATUS', connected: true }).catch(() => {});

    nativePort.onMessage.addListener((msg) => {
      console.log('[Butchr Ext] Native message received:', msg);
      chrome.runtime.sendMessage({ type: 'DAEMON_RESPONSE', payload: msg }).catch(() => {});
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.warn('[Butchr Ext] Native port disconnected:', err ? err.message : 'Unknown reason');
      isConnected = false;
      nativePort = null;
      chrome.runtime.sendMessage({ type: 'DAEMON_STATUS', connected: false }).catch(() => {});
    });
  } catch (e) {
    console.error('[Butchr Ext] Failed to connect native host:', e);
    isConnected = false;
    nativePort = null;
    chrome.runtime.sendMessage({ type: 'DAEMON_STATUS', connected: false }).catch(() => {});
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_DAEMON_STATUS') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    sendResponse({ connected: isConnected });
  } else if (message.type === 'ACTIVATE_BUTCHR') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      chrome.storage.sync.get(['defaultAgent'], (result) => {
        nativePort.postMessage({
          action: 'activate',
          url: message.url,
          tabId: message.tabId,
          defaultAgent: result.defaultAgent || 'shell'
        });
        sendResponse({ status: 'sent' });
      });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'DEACTIVATE_BUTCHR') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'deactivate',
        sessionId: message.sessionId
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'DEACTIVATE_BUTCHR_BY_KEY') {
    // For an agent this daemon never attached to: it has no sessionId here,
    // but herdr still knows it by key and can tear it down.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'deactivate_by_key',
        type: message.workspaceType,
        key: message.key
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'RESET_BUTCHR') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'reset',
        url: message.url
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'CHECK_STATUS') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'status',
        url: message.url
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'FETCH_AGENTS') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'list_agents'
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'EXEC_TERMINAL') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'terminal_exec',
        sessionId: message.sessionId,
        command: message.command
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'FETCH_TERMINAL_HISTORY') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'terminal_history',
        sessionId: message.sessionId
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'PTY_INIT') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'pty_init',
        sessionId: message.sessionId
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'PTY_INPUT') {
    if (nativePort) {
      nativePort.postMessage({
        action: 'pty_input',
        sessionId: message.sessionId,
        data: message.data
      });
    }
    sendResponse({ status: 'sent' });
  } else if (message.type === 'PTY_RESIZE') {
    if (nativePort) {
      nativePort.postMessage({
        action: 'pty_resize',
        sessionId: message.sessionId,
        cols: message.cols,
        rows: message.rows
      });
    }
    sendResponse({ status: 'sent' });
  } else if (message.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: message.url });
    sendResponse({ status: 'opened' });
  }
  return true;
});

// Initial connection
connectNativeHost();
