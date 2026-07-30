import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

// Gap between the two halves of the resize nudge. Long enough for the PTY to
// see two distinct SIGWINCHes, short enough to be invisible to the user.
const REPAINT_NUDGE_MS = 50;

export function useTerminal(activeTabView, supported, active, sessionData, termRef, containerRef) {

  // Set while a PTY_INIT sent after a reconnect is still in flight, so only a
  // re-attach pays for the repaint nudge — the first init doesn't need it.
  const reinitPendingRef = useRef(false);
  const nudgeTimerRef = useRef(null);

  useEffect(() => {
    if (activeTabView === 'terminal' && supported && active && containerRef.current && !termRef.current) {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Fira Code', Consolas, Monaco, 'Courier New', monospace",
        fontSize: 12,
        lineHeight: 1.2,
        // Only applies to the normal buffer: a full-screen TUI (herdr, an
        // agent CLI) runs in the alternate screen, which by design keeps no
        // scrollback and owns the wheel itself. This is what gives plain
        // `shell` sessions usable history in a panel this small.
        scrollback: 10000,
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
    // A re-init still owed to a session we've since left is moot.
    reinitPendingRef.current = false;

    // The replayed buffer is a rolling window, so it may start mid-stream,
    // after the escape sequences that set the alternate screen up. Bracketing
    // the rows with a one-off shrink makes the PTY deliver two SIGWINCHes,
    // and a full-screen TUI redraws itself from scratch on the second.
    const nudgeRepaint = () => {
      const term = termRef.current;
      if (!term || term.rows < 2) return;
      const { cols, rows } = term;
      chrome.runtime.sendMessage({ type: 'PTY_RESIZE', sessionId: sessionData.sessionId, cols, rows: rows - 1 });
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = setTimeout(() => {
        if (!termRef.current) return;
        chrome.runtime.sendMessage({ type: 'PTY_RESIZE', sessionId: sessionData.sessionId, cols, rows });
      }, REPAINT_NUDGE_MS);
    };

    const handleMessage = (message) => {
      // A reconnect means a brand new daemon connection, which has no output
      // listener registered for this session — without a fresh pty_init the
      // PTY still takes input but nothing ever comes back.
      if (message.type === 'DAEMON_STATUS') {
        if (message.connected && termRef.current && sessionData.sessionId) {
          reinitPendingRef.current = true;
          chrome.runtime.sendMessage({ type: 'PTY_INIT', sessionId: sessionData.sessionId });
        }
        return;
      }

      if (message.type === 'DAEMON_RESPONSE') {
        const payload = message.payload;
        if (payload.action === 'pty_init_response') {
          if (termRef.current && payload.sessionId === sessionData.sessionId) {
            // Reset first: on a re-init the buffer repeats what is already on
            // screen, and writing it over the old contents would double it.
            termRef.current.reset();
            if (payload.buffer) termRef.current.write(payload.buffer);
            if (reinitPendingRef.current) {
              reinitPendingRef.current = false;
              nudgeRepaint();
            }
          }
        } else if (payload.action === 'pty_output') {
          if (termRef.current && payload.data && payload.sessionId === sessionData.sessionId) {
            termRef.current.write(payload.data);
          }
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      clearTimeout(nudgeTimerRef.current);
    };
  }, [sessionData.sessionId]);

}
