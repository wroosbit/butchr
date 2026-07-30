import React from 'react';

export function TerminalView({ active, containerRef }) {
  return (
    <div className="terminal-container" style={{flex: 1}}>
      {active ? (
        <div ref={containerRef} className="xterm-wrapper" style={{height: '100%'}}></div>
      ) : (
        <div style={{height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8'}}>
          Agent is currently inactive. Toggle the switch to start.
        </div>
      )}
    </div>
  );
}
