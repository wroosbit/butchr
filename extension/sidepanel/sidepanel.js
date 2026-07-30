const daemonBadge = document.getElementById('daemon-badge');
const pageUrlEl = document.getElementById('page-url');
const workspaceInfo = document.getElementById('workspace-info');
const wsTypeEl = document.getElementById('ws-type');
const wsKeyEl = document.getElementById('ws-key');
const unsupportedBox = document.getElementById('unsupported-box');
const activateBtn = document.getElementById('activate-btn');
const agentStatusCard = document.getElementById('agent-status-card');
const agentSessionIdEl = document.getElementById('agent-session-id');

// Tabs & Views
const navActiveBtn = document.getElementById('nav-active');
const navAgentsBtn = document.getElementById('nav-agents');
const viewActivePage = document.getElementById('view-active-page');
const viewAgents = document.getElementById('view-agents');
const agentCountBadge = document.getElementById('agent-count-badge');
const agentsListEl = document.getElementById('agents-list');

let currentTab = null;

// Tab Switcher
navActiveBtn.addEventListener('click', () => {
  navActiveBtn.classList.add('active');
  navAgentsBtn.classList.remove('active');
  viewActivePage.classList.remove('hidden');
  viewAgents.classList.add('hidden');
});

navAgentsBtn.addEventListener('click', () => {
  navAgentsBtn.classList.add('active');
  navActiveBtn.classList.remove('active');
  viewAgents.classList.remove('hidden');
  viewActivePage.classList.add('hidden');
  fetchRunningAgents();
});

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

function fetchRunningAgents() {
  chrome.runtime.sendMessage({ type: 'FETCH_AGENTS' });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DAEMON_STATUS') {
    if (message.connected) {
      daemonBadge.textContent = 'Daemon Online';
      daemonBadge.className = 'badge badge-connected';
      if (currentTab) {
        chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: currentTab.url });
      }
      fetchRunningAgents();
    } else {
      daemonBadge.textContent = 'Daemon Offline';
      daemonBadge.className = 'badge badge-disconnected';
      activateBtn.disabled = true;
    }
  } else if (message.type === 'DAEMON_RESPONSE') {
    const payload = message.payload;
    
    if (payload.action === 'status_response' || payload.supported !== undefined) {
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
    } else if (payload.action === 'activate_response' && payload.sessionId) {
      agentStatusCard.classList.remove('hidden');
      agentSessionIdEl.textContent = `Session: ${payload.sessionId}`;
      activateBtn.textContent = '⚡ Herdr Agent Active';
      fetchRunningAgents();
    } else if (payload.action === 'list_agents_response') {
      renderAgentsList(payload.agents || []);
    }
  }
});

function renderAgentsList(agents) {
  agentCountBadge.textContent = agents.length;

  if (agents.length === 0) {
    agentsListEl.innerHTML = '<div class="empty-state">No agents currently running.</div>';
    return;
  }

  agentsListEl.innerHTML = '';
  agents.forEach((agent) => {
    const item = document.createElement('div');
    item.className = 'agent-item';

    item.innerHTML = `
      <div class="agent-header">
        <span class="agent-key">🔑 ${agent.key}</span>
        <span class="agent-type-tag">${agent.type}</span>
      </div>
      <a class="agent-link" data-url="${agent.url}">
        🔗 <span>${agent.url}</span>
      </a>
      <div class="agent-meta">
        <span>Session: ${agent.sessionId}</span>
        <span class="status-indicator">
          <span class="dot dot-active"></span> ${agent.status}
        </span>
      </div>
    `;

    // Click handler to open target page in browser
    item.querySelector('.agent-link').addEventListener('click', (e) => {
      e.preventDefault();
      const targetUrl = e.currentTarget.getAttribute('data-url');
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: targetUrl });
    });

    agentsListEl.appendChild(item);
  });
}

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
fetchRunningAgents();
