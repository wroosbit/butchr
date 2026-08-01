import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchpad-ui/components/style.css';
import './sidepanel.css'; // Reuse basic styles if needed

import { HerdrStateChip } from './src/components/HerdrStateChip.jsx';
import { StalenessBanner } from './src/components/StalenessBanner.jsx';

function Agents() {
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [agents, setAgents] = useState([]);
  const [staleness, setStaleness] = useState(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_DAEMON_STATUS' }, (res) => {
      if (res && res.connected) {
        setDaemonConnected(true);
      } else {
        setDaemonConnected(false);
      }
    });

    const handleMessage = (message) => {
      if (message.type === 'DAEMON_STATUS') {
        setDaemonConnected(message.connected);
      } else if (message.type === 'DAEMON_RESPONSE') {
        const payload = message.payload;
        if (payload.action === 'list_agents_response') {
          setAgents(payload.agents || []);
          // Rides along on the poll rather than being fetched separately. An
          // older daemon simply omits it, and the banner then renders nothing.
          if (payload.staleness) setStaleness(payload.staleness);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  useEffect(() => {
    let intervalId;
    if (daemonConnected) {
      chrome.runtime.sendMessage({ type: 'FETCH_AGENTS' });
      intervalId = setInterval(() => {
        chrome.runtime.sendMessage({ type: 'FETCH_AGENTS' });
      }, 2000);
    }
    return () => clearInterval(intervalId);
  }, [daemonConnected]);

  const openTab = (url) => {
    chrome.runtime.sendMessage({ type: 'OPEN_TAB', url });
  };

  return (
    <div className="container" style={{ maxWidth: '800px', margin: '40px auto', padding: '20px', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      <div className="header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '30px', paddingBottom: '20px', borderBottom: '1px solid #334155' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '24px' }}>👥</span>
          <div className="title" style={{ fontSize: '24px', fontWeight: 700 }}>Active Agents</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: daemonConnected ? '#10b981' : '#ef4444' }}></div>
          <span>{daemonConnected ? 'Daemon Online' : 'Daemon Offline'}</span>
        </div>
      </div>

      {/* Above the agent list, not below it: a warning that what is running is
          not what was merged changes how you should read everything under it. */}
      <StalenessBanner staleness={staleness} />

      {!daemonConnected ? (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px' }}>Daemon is offline.</div>
      ) : agents.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px' }}>No agents currently running.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {agents.map((agent, i) => (
            <div key={i} className="card" style={{ backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #334155', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '4px' }}>
                  🔑 {agent.key} <span style={{ backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', marginLeft: '8px' }}>{agent.type}</span>
                </div>
                {/* Agents activated by key may have no page to link to; an
                    empty clickable row is worse than no row at all. */}
                {agent.url ? (
                  <div style={{ fontSize: '12px', color: '#60a5fa', cursor: 'pointer', marginBottom: '4px' }} onClick={() => openTab(agent.url)}>
                    🔗 {agent.url}
                  </div>
                ) : null}
                {/* A surviving agent has no session to name after a daemon
                    restart. Say that, rather than printing "Session: null". */}
                <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                  {agent.sessionless ? `Not attached — ${agent.agentName}` : `Session: ${agent.sessionId}`}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <HerdrStateChip state={agent.herdrStatus} />
                {/* herdrStatus above is the agent's own state and is known
                    either way; this dot is only about our attach, so it goes
                    grey rather than green when there is no session behind it. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: agent.sessionless ? '#94a3b8' : '#10b981' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: agent.sessionless ? '#64748b' : '#10b981' }}></span>
                  {agent.sessionless ? 'detached' : agent.status}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Agents />);
