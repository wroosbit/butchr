import { useState, useEffect, useRef, useCallback } from 'react';

// How long to wait for the daemon's status_response before calling it a
// failure. The daemon answers a status check in milliseconds; anything
// approaching this means the native host or daemon is not healthy.
const STATUS_TIMEOUT_MS = 5000;

/**
 * pageStatus is an explicit state machine rather than a `supported` boolean,
 * so "we haven't heard back yet" and "the daemon says this page isn't
 * supported" cannot render as the same thing:
 *   'checking'    - status request in flight
 *   'supported'   - daemon resolved a workspace type for this URL
 *   'unsupported' - daemon answered: no workspace type matches
 *   'error'       - daemon unreachable, errored, or never answered
 */
export function useWorkspaceSession(currentTab, activeTabView, setActiveTabView, termRef) {
  const [pageStatus, setPageStatus] = useState('checking');
  const [statusError, setStatusError] = useState(null);
  const [active, setActive] = useState(false);
  const [sessionData, setSessionData] = useState({});

  const respondedRef = useRef(false);

  const retryStatus = useCallback(() => {
    if (!currentTab || !currentTab.url) return;
    respondedRef.current = false;
    setPageStatus('checking');
    setStatusError(null);
    chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: currentTab.url });
  }, [currentTab]);

  // Restart the check (and its timeout) whenever the tab or URL changes.
  useEffect(() => {
    if (!currentTab || !currentTab.url) return;
    respondedRef.current = false;
    setPageStatus('checking');
    setStatusError(null);

    const timer = setTimeout(() => {
      if (!respondedRef.current) {
        setStatusError('No response from the Butchr daemon.');
        setPageStatus('error');
      }
    }, STATUS_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [currentTab?.id, currentTab?.url]);

  useEffect(() => {
    const handleMessage = (message) => {
      if (message.type === 'DAEMON_STATUS' && message.connected === false) {
        respondedRef.current = true;
        setStatusError('The Butchr native host is not connected.');
        setPageStatus('error');
        return;
      }

      if (message.type !== 'DAEMON_RESPONSE') return;
      const payload = message.payload;

      // The native host reports it cannot reach the daemon at all.
      if (payload.action === 'daemon_error') {
        respondedRef.current = true;
        setStatusError(payload.error || 'The Butchr daemon is not reachable.');
        setPageStatus('error');
        return;
      }

      if (payload.action === 'status_response' || payload.supported !== undefined) {
        respondedRef.current = true;
        if (payload.supported) {
          setPageStatus('supported');
          setStatusError(null);
          setSessionData({
            type: payload.type,
            key: payload.key,
            sessionId: payload.sessionId,
            status: payload.status,
            createdAt: payload.createdAt,
            workDir: payload.workDir,
            herdrStatus: payload.herdrStatus
          });
          setActive(!!payload.active);
        } else {
          setPageStatus('unsupported');
          setStatusError(null);
          if (activeTabView === 'info') setActiveTabView('terminal');
        }
      } else if (payload.action === 'error_response') {
        respondedRef.current = true;
        setStatusError(payload.error || 'The daemon returned an error.');
        setPageStatus('error');
      } else if (payload.action === 'activate_response' && payload.sessionId) {
        setActive(true);
        setSessionData((prev) => ({
          ...prev,
          sessionId: payload.sessionId,
          status: payload.status,
          createdAt: payload.createdAt,
          workDir: payload.workDir,
          // A state carried over from the previous session would describe an
          // agent that no longer exists; the next status check fills this in.
          herdrStatus: undefined
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
          return { ...prev, sessionId: null, herdrStatus: undefined };
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
    if (currentTab && confirm('Are you sure you want to reset this workspace? This will turn the agent off and permanently delete all files in the workspace directory.')) {
      chrome.runtime.sendMessage({ type: 'RESET_BUTCHR', url: currentTab.url });
      setActive(false);
      setSessionData((prev) => ({ ...prev, sessionId: null }));
      if (termRef.current) {
        termRef.current.write('\r\n\x1b[31m[Workspace Reset]\x1b[0m\r\n');
      }
    }
  };

  return {
    pageStatus,
    statusError,
    supported: pageStatus === 'supported',
    active,
    sessionData,
    handleToggle,
    handleReset,
    retryStatus
  };
}
