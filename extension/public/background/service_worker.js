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
          defaultAgent: result.defaultAgent || 'shell',
          // Only ever set by the "Start anyway" button on a capacity refusal.
          // Forwarded rather than defaulted so an ordinary activate carries no
          // override at all, and the daemon's record of one means a person
          // asked for it.
          ...(message.override ? { override: true } : {}),
          // Same rule, and it matters more here: this one ends another agent's
          // turn. It is set only by the "Stand down <agent> and start" button,
          // which exists only on a refusal that has already named the agent —
          // so a preempt reaching the daemon means a person read the name.
          ...(message.preempt ? { preempt: true } : {}),
          // Same rule again, inverted in whose favour it works: this one is set
          // only by the panel's automatic re-attach, and it *removes* a power
          // rather than granting one. Forwarded rather than defaulted so that
          // an activate arriving without it is one a person asked for — which
          // is the distinction the daemon refuses on. See KAN-196 and the
          // comment on the re-attach effect in useWorkspaceSession.js.
          ...(message.reattachOnly ? { reattachOnly: true } : {})
        });
        sendResponse({ status: 'sent' });
      });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'ACTIVATE_BUTCHR_BY_KEY') {
    // Starting an agent that has no page open — which is every agent the
    // Agents page can offer to switch back on, because it lists the fleet
    // rather than a tab. `activate` needs a URL to resolve a workspace type
    // from; this one is handed the type and key directly, which is how the
    // daemon and the MCP tool have always addressed agents and the one path
    // this service worker never exposed.
    //
    // `defaultAgent` comes from the registry's record of what the agent last
    // ran, not from extension storage: switching an agent back on must bring
    // back what was there, and the storage default describes what a *new*
    // agent would be. It falls back to the stored default only when the
    // registry has nothing, which is the pre-KAN-38 records.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      chrome.storage.sync.get(['defaultAgent'], (result) => {
        nativePort.postMessage({
          action: 'activate_by_key',
          type: message.workspaceType,
          key: message.key,
          ...(message.url ? { url: message.url } : {}),
          defaultAgent: message.defaultAgent || result.defaultAgent || 'shell',
          // Same rule as ACTIVATE_BUTCHR: forwarded rather than defaulted, so
          // that the daemon's record of one means a person pressed a button
          // that said what it would do.
          ...(message.override ? { override: true } : {}),
          ...(message.preempt ? { preempt: true } : {})
        });
        sendResponse({ status: 'sent' });
      });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'FETCH_AGENT_WORK_STATE') {
    // What an agent would lose if it were stopped. Asked once, when a human
    // clicks Off and before they confirm — never on the Agents page's 2s poll.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'agent_work_state',
        type: message.workspaceType,
        key: message.key
      });
      sendResponse({ status: 'sent' });
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
  } else if (message.type === 'GET_JIRA_CREDENTIAL_STATUS') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({ action: 'jira_credential_status' });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'SET_JIRA_CREDENTIAL') {
    // The one message that carries a secret. It is forwarded straight to the
    // daemon and nothing here keeps a copy: not in a variable, not in
    // chrome.storage, and — deliberately — not in a console.log. The daemon's
    // reply is a verdict plus non-secret status, never the token.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'set_jira_credential',
        siteUrl: message.siteUrl,
        email: message.email,
        token: message.token
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'CLEAR_JIRA_CREDENTIAL') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({ action: 'clear_jira_credential' });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'GET_INTEGRATIONS') {
    // What the settings page's Integrations section is drawn from: every
    // integration this daemon has, its provided workspace types, and a
    // non-secret credential summary. No token is in the answer.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({ action: 'list_integrations' });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'GET_INTEGRATION_CREDENTIAL_STATUS') {
    // The generalized form of GET_JIRA_CREDENTIAL_STATUS above. The three
    // Jira-named messages stay: they are what the relocated Jira card speaks,
    // and rewriting a working credential path to prove a point is not worth
    // the risk to the one credential people already have stored.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'integration_credential_status',
        integration: message.integration
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'SET_INTEGRATION_CREDENTIAL') {
    // The other message that carries a secret, under the same rule as
    // SET_JIRA_CREDENTIAL: forwarded straight through, and nothing here keeps
    // a copy — not in a variable, not in chrome.storage, and deliberately not
    // in a console.log. Fields are forwarded only when the caller sent them,
    // so a token-only integration posts a token and nothing else.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'set_integration_credential',
        integration: message.integration,
        ...(message.siteUrl !== undefined ? { siteUrl: message.siteUrl } : {}),
        ...(message.email !== undefined ? { email: message.email } : {}),
        ...(message.token !== undefined ? { token: message.token } : {})
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'CLEAR_INTEGRATION_CREDENTIAL') {
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'clear_integration_credential',
        integration: message.integration
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'SET_INTEGRATION_ENABLED') {
    // KAN-91's switch. One action carrying the state the toggle now shows,
    // rather than an enable/disable pair — a switch sends what it is, not what
    // it did. Nothing is decided here: whether disabling is allowed while
    // agents of that integration's types are running is the daemon's rule
    // (KAN-85 allows it and leaves those agents alone), and a relay that
    // second-guessed it would be a second copy of the rule.
    if (!isConnected || !nativePort) {
      connectNativeHost();
    }
    if (nativePort) {
      nativePort.postMessage({
        action: 'set_integration_enabled',
        integration: message.integration,
        enabled: message.enabled
      });
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'error', error: 'Native host not connected' });
    }
  } else if (message.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: message.url });
    sendResponse({ status: 'opened' });
  }
  return true;
});

// Initial connection
connectNativeHost();
