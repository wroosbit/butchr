import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchpad-ui/components/style.css';
import './sidepanel.css'; // Reuse basic styles if needed

import { HerdrStateChip } from './src/components/HerdrStateChip.jsx';
import { StalenessBanner } from './src/components/StalenessBanner.jsx';
import { MissingAgentsBanner } from './src/components/MissingAgentsBanner.jsx';
import { PreemptedAgentsBanner } from './src/components/PreemptedAgentsBanner.jsx';
import { StandbyAgents } from './src/components/StandbyAgents.jsx';
import { AgentOffControl } from './src/components/AgentOffControl.jsx';
import { ActivationRefusal } from './src/components/ActivationRefusal.jsx';
import { useFleetControls } from './src/hooks/useFleetControls.js';

function Agents() {
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [agents, setAgents] = useState([]);
  const [staleness, setStaleness] = useState(null);
  const [missingAgents, setMissingAgents] = useState([]);
  const [preemptedAgents, setPreemptedAgents] = useState([]);
  // Agents a person switched off, from KAN-21's registry. This is where the On
  // button gets its candidates: the page lists what is running, so something
  // that is off is by definition not in that list and has to come from the
  // durable record of activation intent instead. See StandbyAgents.jsx.
  const [standbyAgents, setStandbyAgents] = useState([]);
  const [standbyTotal, setStandbyTotal] = useState(0);
  // What each running agent is worth, keyed by agent name. Rendered on the row
  // rather than in a banner: priority is a standing property of every agent,
  // not an alarm, and it is what tells the reader which of these could be
  // stood down for which.
  const [priorities, setPriorities] = useState({});

  // Everything a person has asked for and not yet got. Deliberately not part of
  // the poll's state above: the poll owns what is running, this owns what was
  // requested, and neither writes to the other. See useFleetControls.js.
  const controls = useFleetControls(agents);

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
          // Assigned unconditionally where staleness is not: the daemon always
          // sends this field, and an agent that has *stopped* being missing —
          // because it was restored — must clear the banner rather than leave a
          // stale alarm on screen.
          setMissingAgents(payload.missingAgents || []);
          // Assigned unconditionally for the same reason: an agent that has
          // been put back must leave the banner rather than linger on it.
          setPreemptedAgents(payload.preemptedAgents || []);
          // And again: an agent switched back on must leave the stood-down
          // list on the very next poll, or the page would offer to start
          // something it is already showing as running.
          setStandbyAgents(payload.standbyAgents || []);
          setStandbyTotal(payload.standbyTotal ?? (payload.standbyAgents || []).length);
          setPriorities(
            Object.fromEntries((payload.priorities || []).map((p) => [p.agentName, p.priority]))
          );
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

  /**
   * The refusal that stopped an agent starting, rendered under the row whose
   * button was pressed — the same component the sidepanel uses, with the same
   * fields, so a capacity refusal reads identically wherever it is met. KAN-36
   * exists because one surface threw this away; a second surface throwing it
   * away differently would be the same defect twice.
   *
   * Override and preempt are both offered, and neither decides anything: they
   * are the two answers the daemon itself names in the refusal, each behind a
   * button that states its cost. Preemption remains a human naming a victim.
   */
  const renderRefusal = (agentName) => {
    const refusal = controls.refusals[agentName];
    if (!refusal) return null;
    const candidate = { agentName, type: refusal.type, key: refusal.key };
    return (
      <div style={{ marginTop: '12px' }}>
        <ActivationRefusal
          refusal={refusal}
          onOverride={() => controls.turnOn(candidate, { override: true })}
          onPreempt={() => controls.turnOn(candidate, { preempt: true })}
          onDismiss={() => controls.dismissRefusal(agentName)}
        />
      </div>
    );
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

      {/* Above the list for the same reason: three running agents read
          differently when a fourth should be there and is not. */}
      <MissingAgentsBanner
        missingAgents={missingAgents}
        pending={controls.pending}
        onTurnOn={controls.turnOn}
        renderRefusal={renderRefusal}
      />

      {/* Below the losses and above the list: work that is stopped on purpose
          is less urgent than work that stopped by itself, and both change how
          the list beneath them reads. */}
      <PreemptedAgentsBanner
        preemptedAgents={preemptedAgents}
        pending={controls.pending}
        onTurnOn={controls.turnOn}
        renderRefusal={renderRefusal}
      />

      {!daemonConnected ? (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px' }}>Daemon is offline.</div>
      ) : agents.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px' }}>No agents currently running.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {agents.map((agent) => (
            /*
              Keyed by agent name, not by array index. The index was harmless
              while the page was read-only, and stops being harmless the moment
              a row holds state: `agents` is replaced wholesale every 2s, so an
              agent leaving the list shifts every index after it, and React
              would carry an open confirmation — or a "Stopping…" — onto
              whichever agent inherited that position. That is the flicker this
              ticket asked about, and index keys are where it comes from.
            */
            <div key={agent.agentName} className="card" style={{ backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #334155', padding: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '4px' }}>
                    🔑 {agent.key} <span style={{ backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', marginLeft: '8px' }}>{agent.type}</span>
                    {/* Absent on a daemon that predates priorities, rather than
                        rendered as "priority undefined". */}
                    {priorities[agent.agentName] !== undefined ? (
                      <span title="Higher priority can stand this agent down when the machine is full" style={{ backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', marginLeft: '6px', color: '#94a3b8' }}>P{priorities[agent.agentName]}</span>
                    ) : null}
                    {/* Named on the row as well as in its confirmation: the
                        reader should know which of these rows hand work out
                        before they reach for an Off. The type chip to the left
                        already says epic or story; this badge only carries what
                        that type does. */}
                    {agent.supervisor ? (
                      <span title="Hands out work and merges what comes back" style={{ backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', marginLeft: '6px', color: '#fbbf24' }}>supervisor</span>
                    ) : null}
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
                  {/* Only when the confirmation is closed. An open one is wide
                      and belongs under the row rather than crushed into it. */}
                  {controls.confirming !== agent.agentName ? (
                    <AgentOffControl
                      agent={agent}
                      pending={controls.pending[agent.agentName]}
                      confirming={false}
                      error={controls.errors[agent.agentName]}
                      onRequestOff={controls.requestOff}
                      onCancelOff={controls.cancelOff}
                      onConfirmOff={controls.confirmOff}
                    />
                  ) : null}
                </div>
              </div>

              {controls.confirming === agent.agentName ? (
                <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                  <AgentOffControl
                    agent={agent}
                    pending={controls.pending[agent.agentName]}
                    confirming
                    workState={controls.workState[agent.agentName]}
                    error={controls.errors[agent.agentName]}
                    onRequestOff={controls.requestOff}
                    onCancelOff={controls.cancelOff}
                    onConfirmOff={controls.confirmOff}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Last, because it is the quietest thing on the page: agents that are
          off because somebody switched them off are the system doing as it was
          told. It is also the way back from the Off button above — without it
          this page could remove agents from its own list and never restore
          them. */}
      <StandbyAgents
        standbyAgents={standbyAgents}
        standbyTotal={standbyTotal}
        pending={controls.pending}
        onTurnOn={controls.turnOn}
        renderRefusal={renderRefusal}
      />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Agents />);
