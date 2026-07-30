import React from 'react';

export function WorkspaceHeader({ sessionData, active, attached, handleToggle, handleReset, daemonConnected }) {
  // The agent is running, we just don't hold a session for it yet. Worth
  // saying so — but quietly, and never as a third toggle state: as far as the
  // switch is concerned the agent is On, because it is.
  const reattaching = active && !attached;

  return (
    <div className="workspace-header">
      <div className="ws-header-left">
        <span className="ws-type">{sessionData.type}</span> / <span className="ws-key key-highlight">{sessionData.key}</span>
        {reattaching && <span className="ws-reattaching">reattaching…</span>}
      </div>
      <div className="toggle-container" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button 
          onClick={handleReset} 
          disabled={!daemonConnected}
          style={{ background: 'none', border: 'none', cursor: daemonConnected ? 'pointer' : 'not-allowed', color: daemonConnected ? '#ef4444' : '#64748b', fontSize: '18px', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="Reset Workspace"
        >
          🗑️
        </button>
        <span className="toggle-label">{active ? 'On' : 'Off'}</span>
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => handleToggle(e.target.checked)} disabled={!daemonConnected} />
          <span className="slider round"></span>
        </label>
      </div>
    </div>
  );
}
