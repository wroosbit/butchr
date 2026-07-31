// Bench for KAN-17 — see terminal-usability-harness.html for how to run it.
//
// The stub below is a daemon, not a terminal: it answers PTY_INIT with a
// buffer and records PTY_INPUT. Everything the buffer then does to xterm — alt
// screen, mouse tracking, wrapping — is real, which is the point.

import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Sequences a full-screen TUI emits on startup. Captured from herdr
// (`herdr --no-session` in a PTY): alternate screen, then every mouse tracking
// mode it asks for. 1002/1003 are the ones that break drag-select; 1006 is the
// SGR encoding for the reports.
const ALT_SCREEN = '\x1b[?1049h';
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h';

const SHORT_URL = 'https://example.com/short-link';
// Long enough to soft-wrap in a panel this narrow, which is the case the
// addon has to stitch back together across buffer lines.
const WRAPPED_URL =
  'https://github.com/wroosbit/butchr/blob/main/extension/src/hooks/useTerminal.js#L1-L200?ref=kan-17-wrapped-link-case';

const SCENARIO =
  ALT_SCREEN +
  MOUSE_ON +
  '\x1b[2J\x1b[H' +
  '\x1b[1m herdr — mouse tracking is ON\x1b[0m\r\n' +
  '\r\n' +
  ' selectable words: alpha bravo charlie delta echo\r\n' +
  '\r\n' +
  ' short link:   ' + SHORT_URL + '\r\n' +
  '\r\n' +
  ' wrapped link: ' + WRAPPED_URL + '\r\n';

// Stubbed extension APIs. Installed before useTerminal is imported so the hook
// sees them exactly as it would in the side panel.
const listeners = new Set();
const record = { ptyInput: [], ptyResize: [], openedTabs: [] };

const deliver = (message) => {
  // Async, like chrome.runtime: a listener that runs inside sendMessage would
  // reenter the hook mid-dispatch and hide ordering bugs.
  setTimeout(() => listeners.forEach((fn) => fn(message)), 0);
};

globalThis.chrome = {
  runtime: {
    sendMessage(message) {
      if (message.type === 'PTY_INIT') {
        deliver({ type: 'DAEMON_RESPONSE', payload: { action: 'pty_init_response', sessionId: message.sessionId, buffer: SCENARIO } });
      } else if (message.type === 'PTY_INPUT') {
        record.ptyInput.push(message.data);
      } else if (message.type === 'PTY_RESIZE') {
        record.ptyResize.push([message.cols, message.rows]);
      }
    },
    onMessage: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn)
    }
  },
  tabs: {
    create: ({ url }) => record.openedTabs.push(url)
  }
};

// After the stub, never before: both pull chrome in through the hook.
const { useTerminal } = await import('../src/hooks/useTerminal.js');
const { TerminalView } = await import('../src/components/TerminalView.jsx');

const SESSION = { sessionId: 'harness-session' };

function Harness() {
  const termRef = useRef(null);
  const containerRef = useRef(null);
  const [, forceRender] = useState(0);

  const { copyNotice } = useTerminal('terminal', true, true, SESSION, termRef, containerRef);

  // Everything a driver script needs to assert against, and everything a human
  // needs to see that the gesture did what it claimed.
  globalThis.__harness = {
    record,
    urls: { short: SHORT_URL, wrapped: WRAPPED_URL },
    term: () => termRef.current,
    getSelection: () => termRef.current?.getSelection() ?? '',
    mouseReportsSeen: () => record.ptyInput.filter((d) => d.startsWith('\x1b[<')).length,

    // Every row currently on screen, with the wrap flag. A URL that wrapped is
    // two buffer lines the addon has to stitch back together, and this is how
    // you tell whether the pane is actually narrow enough to have wrapped it.
    rows: () => {
      const buf = termRef.current.buffer.active;
      return Array.from({ length: termRef.current.rows }, (_, i) => {
        const line = buf.getLine(buf.viewportY + i);
        return { row: i, wrapped: !!line?.isWrapped, text: line?.translateToString(true) ?? '' };
      });
    },

    // Viewport pixel centre of one cell — what a driver script needs to aim a
    // real mouse gesture at a specific character.
    cellBox: (row, col) => {
      const rowEl = containerRef.current.querySelector('.xterm-rows').children[row];
      const box = rowEl.getBoundingClientRect();
      const cellWidth = box.width / termRef.current.cols;
      return { x: box.left + cellWidth * (col + 0.5), y: box.top + box.height / 2 };
    },

    reset: () => {
      record.ptyInput.length = 0;
      record.openedTabs.length = 0;
    }
  };

  return (
    <>
      <TerminalView
        active
        attached
        detachReason={null}
        containerRef={containerRef}
        onReconnect={() => {}}
        copyNotice={copyNotice}
      />
      <div style={{ padding: '6px 8px', fontSize: '11px', color: '#94a3b8', borderTop: '1px solid #1e293b' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => forceRender((n) => n + 1)}>
          Refresh counters
        </button>
        <div style={{ marginTop: '6px' }}>mouse reports sent to the TUI: {record.ptyInput.filter((d) => d.startsWith('\x1b[<')).length}</div>
        <div>tabs opened: {record.openedTabs.length ? record.openedTabs.join(', ') : '—'}</div>
        <div style={{ wordBreak: 'break-all' }}>current selection: {termRef.current?.getSelection() || '—'}</div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
