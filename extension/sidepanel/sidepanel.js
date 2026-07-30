const daemonBadge = document.getElementById('daemon-badge');
const pageUrlEl = document.getElementById('page-url');
const workspaceInfo = document.getElementById('workspace-info');
const wsTypeEl = document.getElementById('ws-type');
const wsKeyEl = document.getElementById('ws-key');
const unsupportedBox = document.getElementById('unsupported-box');
const activateBtn = document.getElementById('activate-btn');
const agentStatusCard = document.getElementById('agent-status-card');
const agentSessionIdEl = document.getElementById('agent-session-id');

let currentTab = null;

async function updateTabContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      currentTab = tab;
      pageUrlEl.textContent = tab.url;
      chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: tab.url });
    }
  } catch (e) {
    console.error('Error fetching tab:', e);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DAEMON_STATUS') {
    if (message.connected) {
      daemonBadge.textContent = 'Daemon Online';
      daemonBadge.className = 'badge badge-connected';
      if (currentTab) {
        chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: currentTab.url });
      }
    } else {
      daemonBadge.textContent = 'Daemon Offline';
      daemonBadge.className = 'badge badge-disconnected';
      activateBtn.disabled = true;
    }
  } else if (message.type === 'DAEMON_RESPONSE') {
    const payload = message.payload;
    if (payload.action === 'status' || payload.supported !== undefined) {
      if (payload.supported) {
        workspaceInfo.classList.remove('hidden');
        unsupportedBox.classList.add('hidden');
        wsTypeEl.textContent = payload.type;
        wsKeyEl.textContent = payload.key;
        activateBtn.disabled = false;

        if (payload.active) {
          agentStatusCard.classList.remove('hidden');
          agentSessionIdEl.textContent = `Active Session: ${payload.sessionId}`;
        }
      } else {
        workspaceInfo.classList.add('hidden');
        unsupportedBox.classList.remove('hidden');
        activateBtn.disabled = true;
      }
    } else if (payload.sessionId) {
      agentStatusCard.classList.remove('hidden');
      agentSessionIdEl.textContent = `Session: ${payload.sessionId}`;
      activateBtn.textContent = '⚡ Herdr Agent Active';
    }
  }
});

activateBtn.addEventListener('click', () => {
  if (currentTab) {
    chrome.runtime.sendMessage({
      type: 'ACTIVATE_BUTCHR',
      url: currentTab.url,
      tabId: currentTab.id
    });
  }
});

updateTabContext();
