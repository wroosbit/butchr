import { useState, useEffect, useRef } from 'react';

// GET_DAEMON_STATUS is also the reconnect trigger: the service worker
// re-opens the native port whenever it handles one while disconnected. Poll
// on it after a drop so recovery doesn't wait for the user to do something.
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 15000;

export function useDaemonConnection(currentTab) {
  const [daemonConnected, setDaemonConnected] = useState(false);

  const retryTimerRef = useRef(null);
  const retryDelayRef = useRef(RECONNECT_BASE_MS);

  useEffect(() => {
    const requestStatus = () => {
      chrome.runtime.sendMessage({ type: 'GET_DAEMON_STATUS' }, (res) => {
        const connected = !!(res && res.connected);
        setDaemonConnected(connected);
        if (connected) {
          retryDelayRef.current = RECONNECT_BASE_MS;
        } else {
          scheduleRetry();
        }
      });
    };

    const scheduleRetry = () => {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(requestStatus, retryDelayRef.current);
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, RECONNECT_MAX_MS);
    };

    // Check initial daemon status
    requestStatus();

    const handleMessage = (message) => {
      if (message.type === 'DAEMON_STATUS') {
        setDaemonConnected(message.connected);
        if (message.connected) {
          clearTimeout(retryTimerRef.current);
          retryDelayRef.current = RECONNECT_BASE_MS;
          if (currentTab) {
            chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: currentTab.url });
          }
        } else {
          scheduleRetry();
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      clearTimeout(retryTimerRef.current);
    };
  }, [currentTab]);

  return daemonConnected;
}
