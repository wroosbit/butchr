import React from 'react';

export function Header({ daemonConnected }) {
  const openAgentsPage = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('agents.html') });
  };

  const openOptionsPage = () => {
    chrome.runtime.openOptionsPage();
  };

  return (
    <div className="header">
      <div className="logo">
        <img src="/icons/icon48.png" alt="Butchr" style={{ width: '20px', height: '20px', borderRadius: '4px' }} />
        <h1>Butchr</h1>
      </div>
      <div className="header-actions">
        <div id="daemon-badge" className={`badge ${daemonConnected ? 'badge-connected' : 'badge-disconnected'}`}>
          {daemonConnected ? 'Online' : 'Offline'}
        </div>
        <button onClick={openAgentsPage} className="icon-btn" title="View all active agents">👥</button>
        <button onClick={openOptionsPage} className="icon-btn" title="Options">⚙️</button>
      </div>
    </div>
  );
}
