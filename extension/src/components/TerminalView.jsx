import React from 'react';

export function TerminalView({ active, containerRef }) {
  return (
    <div className="terminal-container">
      {active ? (
        // Sizing is owned by flex (.xterm-wrapper is flex: 1; min-height: 0);
        // an explicit height here would fight the fit addon's measurement.
        <div ref={containerRef} className="xterm-wrapper"></div>
      ) : (
        <div style={{flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8'}}>
          Agent is off. Flip the switch to start.
        </div>
      )}
    </div>
  );
}
