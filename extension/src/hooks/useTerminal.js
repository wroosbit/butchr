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

      // fit() throws if the element has no layout yet (side panel still
      // opening, or tab hidden); skip those frames rather than tearing down.
      const safeFit = () => {
        if (!termRef.current || !containerRef.current) return;
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth < 1 || clientHeight < 1) return;
        try {
          fitAddon.fit();
        } catch {
          // transient layout state; the ResizeObserver will fire again
        }
      };

      // Fit after the browser has laid the panel out, not on a guessed delay.
      const raf = requestAnimationFrame(safeFit);
      const settleTimer = setTimeout(safeFit, 50);

      const resizeObserver = new ResizeObserver(safeFit);
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

      window.addEventListener('resize', safeFit);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(settleTimer);
        window.removeEventListener('resize', safeFit);
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
