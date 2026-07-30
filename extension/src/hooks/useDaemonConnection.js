import { useState, useEffect } from 'react';

export function useDaemonConnection(currentTab) {
  const [daemonConnected, setDaemonConnected] = useState(false);

  useEffect(() => {
    // Check initial daemon status
    chrome.runtime.sendMessage({ type: 'GET_DAEMON_STATUS' }, (res) => {
      if (res && res.connected) {
        setDaemonConnected(true);
      } else {
        setDaemonConnected(false);
      }
    });

    const handleMessage = (message) => {
      if (message.type === 'DAEMON_STATUS') {
        setDaemonConnected(message.connected);
        if (message.connected && currentTab) {
          chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: currentTab.url });
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [currentTab]);

  return daemonConnected;
}
