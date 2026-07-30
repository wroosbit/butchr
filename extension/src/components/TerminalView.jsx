import React from 'react';

export function TerminalView({ active, attached, containerRef }) {
  const placeholder = (text) => (
    <div style={{flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8'}}>
      {text}
    </div>
  );

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
