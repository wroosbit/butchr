import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchpad-ui/components/style.css';

import { useDaemonConnection } from './src/hooks/useDaemonConnection.js';
import { useWorkspaceSession } from './src/hooks/useWorkspaceSession.js';
import { useTerminal } from './src/hooks/useTerminal.js';
import { Header } from './src/components/Header.jsx';
import { WorkspaceHeader } from './src/components/WorkspaceHeader.jsx';
import { TerminalView } from './src/components/TerminalView.jsx';

function SidePanel() {
  const [currentTab, setCurrentTab] = useState(null);
  const [activeTabView, setActiveTabView] = useState('terminal');

  const termRef = useRef(null);
  const containerRef = useRef(null);

  const daemonConnected = useDaemonConnection(currentTab);
  
  const { supported, active, sessionData, handleToggle, handleReset } = useWorkspaceSession(
    currentTab, 
    activeTabView, 
    setActiveTabView, 
    termRef
  );

  useTerminal(activeTabView, supported, active, sessionData, termRef, containerRef);

  useEffect(() => {
    // Listen to tab changes
    const updateTabContext = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          setCurrentTab(tab);
          chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: tab.url });
        }
      } catch (e) {
        console.error('Error fetching tab:', e);
      }
    };

    chrome.tabs.onActivated.addListener(updateTabContext);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (tab.active && changeInfo.url) {
        updateTabContext();
      }
    });

    updateTabContext();
  }, []);

  return (
    <>
      <Header daemonConnected={daemonConnected} />

      {!supported ? (
        <div id="view-terminal" className="view-panel">
          <div className="warning-box">
            Current page does not match a supported Workspace Type. Navigate to a valid workspace to open a terminal.
          </div>
        </div>
      ) : (
        <>
          <nav className="tabs-nav">
            <button className={`tab-btn ${activeTabView === 'terminal' ? 'active' : ''}`} onClick={() => setActiveTabView('terminal')}>Terminal 🖥️</button>
            <button className={`tab-btn ${activeTabView === 'info' ? 'active' : ''}`} onClick={() => setActiveTabView('info')}>Info ℹ️</button>
          </nav>

          {activeTabView === 'info' && (
            <div id="view-info" className="view-panel">
              <div className="card">
                <div className="card-title">Agent Session Details</div>
                <div className="info-row"><span className="label">Session ID:</span><span className="value">{sessionData.sessionId || '-'}</span></div>
                <div className="info-row"><span className="label">Status:</span><span className="value">{sessionData.status || '-'}</span></div>
                <div className="info-row"><span className="label">Created At:</span><span className="value">{sessionData.createdAt ? new Date(sessionData.createdAt).toLocaleString() : '-'}</span></div>
                <div className="info-row"><span className="label" style={{minWidth: '70px'}}>Work Dir:</span><span className="value" style={{wordBreak: 'break-all', fontSize: '11px'}}>{sessionData.workDir || '-'}</span></div>
              </div>
            </div>
          )}

          {activeTabView === 'terminal' && (
            <div id="view-terminal" className="view-panel">
              <div id="terminal-content" style={{flex: 1, display: 'flex', flexDirection: 'column'}}>
                <WorkspaceHeader 
                  sessionData={sessionData} 
                  active={active} 
                  handleToggle={handleToggle} 
                  handleReset={handleReset}
                  daemonConnected={daemonConnected} 
                />
                <TerminalView 
                  active={active} 
                  containerRef={containerRef} 
                />
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<SidePanel />);
