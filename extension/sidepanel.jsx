import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchpad-ui/components/style.css';

import { useDaemonConnection } from './src/hooks/useDaemonConnection.js';
import { useWorkspaceSession } from './src/hooks/useWorkspaceSession.js';
import { useTerminal } from './src/hooks/useTerminal.js';
import { Header } from './src/components/Header.jsx';
import { WorkspaceHeader } from './src/components/WorkspaceHeader.jsx';
import { TerminalView } from './src/components/TerminalView.jsx';
import { ActivationRefusal } from './src/components/ActivationRefusal.jsx';

function SidePanel() {
  const [currentTab, setCurrentTab] = useState(null);
  const [activeTabView, setActiveTabView] = useState('terminal');

  const termRef = useRef(null);
  const containerRef = useRef(null);

  const daemonConnected = useDaemonConnection(currentTab);
  
  const {
    pageStatus, statusError, unsupportedReason, supported, active, attached, detachReason, activateError,
    sessionData, handleToggle, handleReset, handleReconnect, handleOverrideActivate,
    handlePreemptActivate, dismissActivateError, retryStatus
  } = useWorkspaceSession(
    currentTab,
    activeTabView,
    setActiveTabView,
    termRef
  );

  const { copyNotice } = useTerminal(activeTabView, supported, active && attached, sessionData, termRef, containerRef);

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

      {pageStatus === 'checking' ? (
        <div id="view-terminal" className="view-panel">
          <div className="status-box status-checking">
            <span className="spinner" aria-hidden="true"></span>
            <span>Checking this page…</span>
          </div>
        </div>
      ) : pageStatus === 'error' ? (
        <div id="view-terminal" className="view-panel">
          <div className="status-box status-error">
            <div className="status-title">⚠️ Can’t reach the Butchr daemon</div>
            <div className="status-detail">{statusError}</div>
            <div className="status-hint">
              This is a connection problem, not a problem with the page. Check
              <code>~/.local/share/butchr/daemon.log</code> and
              <code>/tmp/native-host-sh.log</code>.
            </div>
            <button className="btn btn-secondary btn-sm mt-10" onClick={retryStatus}>Retry</button>
          </div>
        </div>
      ) : !supported ? (
        <div id="view-terminal" className="view-panel">
          {unsupportedReason?.refusedBy === 'integration-disabled' ? (
            // The daemon's sentence, rendered as it wrote it. This page *is* a
            // workspace type's page — the integration that owns it is just
            // switched off — and the generic line below would tell the reader
            // to go find a valid workspace, which is advice that cannot work.
            // KAN-85 composes the reason so that one place decides the wording;
            // paraphrasing it here would be the second copy that goes stale.
            <div className="warning-box">
              <div className="status-title">⚠️ {unsupportedReason.integrationName || 'This integration'} is switched off</div>
              <div className="status-detail">{unsupportedReason.reason}</div>
              <button
                className="btn btn-secondary btn-sm mt-10"
                onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: chrome.runtime.getURL('options.html') })}
              >
                Open Butchr settings
              </button>
            </div>
          ) : (
            <div className="warning-box">
              Current page does not match a supported Workspace Type. Navigate to a valid workspace to open a terminal.
            </div>
          )}
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
                <div className="info-row"><span className="label">Herdr State:</span><span className="value">{sessionData.herdrStatus || '-'}</span></div>
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
                  attached={attached}
                  detachReason={detachReason}
                  handleToggle={handleToggle}
                  handleReset={handleReset}
                  daemonConnected={daemonConnected}
                />
                {/* Directly beneath the switch that refused, because that is
                    where the user is looking when nothing happens. */}
                <ActivationRefusal
                  refusal={activateError}
                  onOverride={handleOverrideActivate}
                  onPreempt={handlePreemptActivate}
                  onDismiss={dismissActivateError}
                />
                <TerminalView
                  active={active}
                  attached={attached}
                  detachReason={detachReason}
                  containerRef={containerRef}
                  onReconnect={handleReconnect}
                  copyNotice={copyNotice}
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
