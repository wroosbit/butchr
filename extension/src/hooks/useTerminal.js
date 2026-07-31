import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { copyToClipboard, forcesSelection } from '../lib/terminalSelection.js';

// Gap between the two halves of the resize nudge. Long enough for the PTY to
// see two distinct SIGWINCHes, short enough to be invisible to the user.
const REPAINT_NUDGE_MS = 50;

// How long the hint line is replaced by the copy result before it goes back to
// advertising the gesture.
const COPY_NOTICE_MS = 2000;

/**
 * Opens a URL printed into the terminal.
 *
 * The addon's default handler calls window.open(), which has nothing sensible
 * to do from a side panel — it is an extension page with no tab of its own.
 * chrome.tabs.create puts the URL in a real foreground tab in the user's
 * window instead.
 *
 * The scheme check is redundant against the addon's regex, which only matches
 * http(s). It is here so that widening that regex later cannot quietly turn a
 * printed `javascript:` string into something a click will execute.
 */
function openLinkInNewTab(_event, uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  chrome.tabs.create({ url: parsed.href, active: true });
}

export function useTerminal(activeTabView, supported, active, sessionData, termRef, containerRef) {

  // Set while a PTY_INIT sent after a reconnect is still in flight, so only a
  // re-attach pays for the repaint nudge — the first init doesn't need it.
  const reinitPendingRef = useRef(false);
  const nudgeTimerRef = useRef(null);

  // Result of the last copy, shown in the pane's hint line. Null while there is
  // nothing to report, which is most of the time.
  const [copyNotice, setCopyNotice] = useState(null);
  const noticeTimerRef = useRef(null);

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
        // macOS is the one platform where xterm does not accept Shift as the
        // force-selection modifier; without this the Mac gesture does not
        // exist at all. See src/lib/terminalSelection.js.
        macOptionClickForcesSelection: true,
        theme: {
          background: '#090d16',
          foreground: '#f8fafc',
          cursor: '#38bdf8'
        }
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      // Link activation runs off mouseup and is not gated on mouse tracking, so
      // printed URLs stay clickable inside a full-screen TUI.
      term.loadAddon(new WebLinksAddon(openLinkInNewTab));
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

      const notify = (text) => {
        setCopyNotice(text);
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setCopyNotice(null), COPY_NOTICE_MS);
      };

      const copySelection = async (selection) => {
        const copied = await copyToClipboard(selection);
        notify(copied ? 'Copied to clipboard' : 'Copy failed — try right-click → Copy');
      };

      // Copying happens when the drag ends, not on a key. Ctrl+C inside a TUI
      // is the interrupt and has to stay the interrupt, and the modifier that
      // makes selection possible in the first place is already held — asking
      // for a second gesture after it is one gesture too many.
      //
      // Only modifier-held drags are ours. Every other press is the TUI's, and
      // this code must not come near it.
      let dragging = false;

      const handleMouseDown = (event) => {
        dragging = event.button === 0 && forcesSelection(event);
      };

      const finishDrag = () => {
        dragging = false;
        const selection = term.getSelection();
        if (selection) copySelection(selection);
      };

      // xterm declines to report the *press* of a modifier-held drag — that is
      // what makes selection possible — but its mouseup binding on the terminal
      // element reports the *release* regardless. That report is user input,
      // and xterm clears the selection on user input, so the text you just
      // highlighted vanishes at the moment you let go. Catching the release
      // above the terminal element keeps the selection alive, and leaves the
      // program with a coherent view of the mouse: no press was delivered, so
      // no release should be either.
      const handleMouseUpCapture = (event) => {
        if (!dragging) return;
        event.stopPropagation();
        // xterm's SelectionService listens for the release on the document,
        // which the stopped event no longer reaches, and it has drag listeners
        // to tear down. Hand it an equivalent release directly — dispatching on
        // the document keeps this out of the terminal element's path, so the
        // report we just suppressed does not come back through the side door.
        document.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          clientX: event.clientX,
          clientY: event.clientY
        }));
        finishDrag();
      };

      // Both in the capture phase. xterm stops the press from propagating in
      // exactly the case we care about — it does that to claim the modifier
      // drag for selection — so a bubble-phase listener up here would never
      // hear the one press it needs to hear.
      containerRef.current.addEventListener('mousedown', handleMouseDown, true);
      containerRef.current.addEventListener('mouseup', handleMouseUpCapture, true);
      // Also on the document: in a panel this narrow a drag routinely ends past
      // the pane's edge, and that release still has to copy. Nothing to suppress
      // there — the release never reached the terminal element either.
      document.addEventListener('mouseup', finishDrag);

      // For people who reach for a shortcut instead. Plain Ctrl+C is left
      // alone; requiring Shift is what keeps the interrupt intact.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const isCopyChord = (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC';
        if (isCopyChord && term.hasSelection()) {
          copySelection(term.getSelection());
          return false;
        }
        return true;
      });

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
      const detachedContainer = containerRef.current;
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(settleTimer);
        clearTimeout(noticeTimerRef.current);
        window.removeEventListener('resize', safeFit);
        detachedContainer.removeEventListener('mousedown', handleMouseDown, true);
        detachedContainer.removeEventListener('mouseup', handleMouseUpCapture, true);
        document.removeEventListener('mouseup', finishDrag);
        resizeObserver.disconnect();
        term.dispose();
        termRef.current = null;
        setCopyNotice(null);
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

  return { copyNotice };
}
