import React from 'react';

import { SELECT_MODIFIER_LABEL, SELECT_MODIFIER_SYMBOL } from '../lib/terminalSelection.js';

// The gesture is the whole feature. A modifier nobody can discover has not
// fixed the complaint, and there is nothing else in the pane to hover for a
// tooltip, so the hint is a permanent line rather than a hidden one. Short
// enough to survive a 320px panel; the full sentence is the title attribute.
const HINT_SHORT = `${SELECT_MODIFIER_SYMBOL} ${SELECT_MODIFIER_LABEL}-drag to select · click a URL to open`;
const HINT_FULL =
  `Hold ${SELECT_MODIFIER_LABEL} and drag to select terminal text — it is copied to the clipboard when you ` +
  `release, or with Ctrl/Cmd+Shift+C. Without the modifier the mouse belongs to the program running in the ` +
  `terminal. Clicking a printed http(s) URL opens it in a new tab.`;

// What each detach reason means to the person looking at the panel. The
// takeover case names the cause outright: it is the one failure where the
// terminal looks perfectly healthy — the last frame is still on screen — and
// the user has no other way to tell a dead pane from a thinking one.
const DETACH_COPY = {
  'taken-over': {
    title: 'Terminal disconnected',
    detail: 'Something else attached to this agent’s terminal and took it over. The agent itself may still be running — this panel just lost its view of it.'
  },
  exited: {
    title: 'Terminal disconnected',
    detail: 'The terminal attach ended. The agent itself may still be running — this panel just lost its view of it.'
  }
};

export function TerminalView({ active, attached, detachReason, containerRef, onReconnect, copyNotice }) {
  const placeholder = (text) => (
    <div style={{flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8'}}>
      {text}
    </div>
  );

  // Ordered before the !attached branch: a terminal that died under us is a
  // failure to report, not the ordinary "haven't attached yet" wait.
  if (active && detachReason) {
    const copy = DETACH_COPY[detachReason] ?? DETACH_COPY.exited;
    return (
      <div className="terminal-container">
        <div className="status-box status-error" role="alert">
          <div className="status-title">⚠️ {copy.title}</div>
          <div className="status-detail">{copy.detail}</div>
          <button className="btn btn-secondary btn-sm mt-10" onClick={onReconnect}>
            Reconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-container">
      {!active ? (
        placeholder('Agent is off. Flip the switch to start.')
      ) : !attached ? (
        // The agent is running; we just have no PTY to render yet. Saying it
        // is off here would contradict the toggle, which correctly reads On.
        placeholder('Reattaching to the running agent…')
      ) : (
        // Sizing is owned by flex (.xterm-wrapper is flex: 1; min-height: 0);
        // an explicit height here would fight the fit addon's measurement.
        <>
          <div ref={containerRef} className="xterm-wrapper"></div>
          <div
            className={`terminal-hint ${copyNotice ? 'terminal-hint-notice' : ''}`}
            title={HINT_FULL}
            // Announced only when it turns into a copy result: the standing
            // hint is already in the title, and re-reading it is noise.
            aria-live="polite"
          >
            {copyNotice ?? HINT_SHORT}
          </div>
        </>
      )}
    </div>
  );
}
