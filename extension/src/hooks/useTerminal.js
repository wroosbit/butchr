import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

export function useTerminal(activeTabView, supported, active, sessionData, termRef, containerRef) {

  useEffect(() => {
    if (activeTabView === 'terminal' && supported && active && containerRef.current && !termRef.current) {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Fira Code', Consolas, Monaco, 'Courier New', monospace",
        fontSize: 12,
        lineHeight: 1.2,
        theme: {
          background: '#090d16',
          foreground: '#f8fafc',
          cursor: '#38bdf8'
        }
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      
      setTimeout(() => {
        if (termRef.current) fitAddon.fit();
      }, 50);

      const resizeObserver = new ResizeObserver(() => {
        if (termRef.current) fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current);
      
      term.onData((data) => {
        chrome.runtime.sendMessage({
          type: 'PTY_INPUT',
          sessionId: sessionData.sessionId,
          data
        });
      });

      term.onResize(({ cols, rows }) => {
        chrome.runtime.sendMessage({
          type: 'PTY_RESIZE',
          sessionId: sessionData.sessionId,
          cols,
          rows
        });
      });

      termRef.current = term;

      // Ask for PTY init
      chrome.runtime.sendMessage({ type: 'PTY_INIT', sessionId: sessionData.sessionId });

      const onResize = () => fitAddon.fit();
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('resize', onResize);
        resizeObserver.disconnect();
        term.dispose();
        termRef.current = null;
      };
    }
  }, [activeTabView, supported, active, sessionData.sessionId]);

  // Terminal I/O listener
  useEffect(() => {
    const handleMessage = (message) => {
      if (message.type === 'DAEMON_RESPONSE') {
        const payload = message.payload;
        if (payload.action === 'pty_init_response') {
          if (termRef.current && payload.buffer && payload.sessionId === sessionData.sessionId) {
            termRef.current.write(payload.buffer);
          }
        } else if (payload.action === 'pty_output') {
          if (termRef.current && payload.data && payload.sessionId === sessionData.sessionId) {
            termRef.current.write(payload.data);
          }
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [sessionData.sessionId]);

}
