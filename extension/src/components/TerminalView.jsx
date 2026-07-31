import React from 'react';

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

export function TerminalView({ active, attached, detachReason, containerRef, onReconnect }) {
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
        <div ref={containerRef} className="xterm-wrapper"></div>
      )}
    </div>
  );
}
