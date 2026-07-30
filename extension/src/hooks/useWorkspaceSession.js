import { useState, useEffect } from 'react';

export function useWorkspaceSession(currentTab, activeTabView, setActiveTabView, termRef) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [sessionData, setSessionData] = useState({});

  useEffect(() => {
    const handleMessage = (message) => {
      if (message.type === 'DAEMON_RESPONSE') {
        const payload = message.payload;
        if (payload.action === 'status_response' || payload.supported !== undefined) {
          setSupported(payload.supported);
          if (payload.supported) {
            setSessionData({
              type: payload.type,
              key: payload.key,
              sessionId: payload.sessionId,
              status: payload.status,
              createdAt: payload.createdAt,
              workDir: payload.workDir
            });
            setActive(!!payload.active);
          } else {
            if (activeTabView === 'info') setActiveTabView('terminal');
          }
        } else if (payload.action === 'activate_response' && payload.sessionId) {
          setActive(true);
          setSessionData((prev) => ({
            ...prev,
            sessionId: payload.sessionId,
            status: payload.status,
            createdAt: payload.createdAt,
            workDir: payload.workDir
          }));
          setActiveTabView('terminal');
        } else if (payload.action === 'deactivate_response' || payload.action === 'agent_deactivated_event' || payload.action === 'agent_reset_event') {
          // Check if the event is for the current session (if it has type/key)
          setSessionData((prev) => {
            if (payload.key && prev.key && payload.key !== prev.key) return prev;
            setActive(false);
            if (termRef.current && payload.action === 'agent_reset_event') {
              termRef.current.write('\r\n\x1b[31m[Workspace Reset by Agent]\x1b[0m\r\n');
            }
            return { ...prev, sessionId: null };
          });
        } else if (payload.action === 'agent_activated_event') {
          setSessionData((prev) => {
            if (payload.key && prev.key && payload.key !== prev.key) return prev;
            setActive(true);
            setActiveTabView('terminal');
            return {
              ...prev,
              sessionId: payload.sessionId,
              status: payload.status,
              createdAt: payload.createdAt,
              workDir: payload.workDir
            };
          });
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [currentTab, activeTabView, termRef]);

  const handleToggle = (isChecked) => {
    if (!isChecked && sessionData.sessionId) {
      chrome.runtime.sendMessage({ type: 'DEACTIVATE_BUTCHR', sessionId: sessionData.sessionId });
    } else if (isChecked && currentTab) {
      chrome.runtime.sendMessage({ type: 'ACTIVATE_BUTCHR', url: currentTab.url, tabId: currentTab.id });
    }
  };

  const handleReset = () => {
    if (currentTab && confirm('Are you sure you want to reset this workspace? This will deactivate the agent and permanently delete all files in the workspace directory.')) {
      chrome.runtime.sendMessage({ type: 'RESET_BUTCHR', url: currentTab.url });
      setActive(false);
      setSessionData((prev) => ({ ...prev, sessionId: null }));
      if (termRef.current) {
        termRef.current.write('\r\n\x1b[31m[Workspace Reset]\x1b[0m\r\n');
      }
    }
  };

  return { supported, active, sessionData, handleToggle, handleReset };
}
