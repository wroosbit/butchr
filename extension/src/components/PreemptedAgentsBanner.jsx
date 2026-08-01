import React from 'react';

import { TurnOnButton } from './TurnOnButton.jsx';

// "Something was deliberately stopped, and nobody has decided what happens to
// it yet."
//
// The sibling of MissingAgentsBanner, and the difference between them is the
// point. A missing agent is a loss to investigate — nobody chose it, and the
// first question is what went wrong. A preempted agent is a decision that has
// already been made: someone read the name of this agent, pressed a button
// that said so, and took its slot for work they judged more important. What is
// outstanding is not a diagnosis but a consequence — its ticket says In
// Progress and nothing is progressing it.
//
// So it is amber rather than red, and it says what is owed rather than what is
// wrong. Restarting these is deliberately not offered: a preemption queue is a
// scheduler, which KAN-37 put out of scope, and the machine that was full an
// hour ago has no obligation to be free now.
//
// Same loudness rule as its sibling: an empty list renders nothing. The list
// empties itself — re-activating a preempted agent takes it off this banner,
// because the registry's last word on it becomes `activated` again.

const PALETTE = {
  bg: 'rgba(245, 158, 11, 0.12)',
  border: '#f59e0b',
  fg: '#fde68a',
  title: '#fffbeb'
};

function since(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

// `onTurnOn` is optional and its absence changes nothing else, for the reason
// MissingAgentsBanner gives. Note what is still true with it present: nothing
// here restarts anything by itself. A preemption queue is a scheduler, which
// KAN-37 ruled out and KAN-38 did not reopen — this is a person deciding, one
// agent at a time, exactly as the sidepanel toggle already let them.
export function PreemptedAgentsBanner({ preemptedAgents, pending, onTurnOn, renderRefusal }) {
  if (!Array.isArray(preemptedAgents) || preemptedAgents.length === 0) return null;

  return (
    <div
      role="status"
      style={{
        backgroundColor: PALETTE.bg,
        border: `1px solid ${PALETTE.border}`,
        borderRadius: '8px',
        padding: '14px 16px',
        marginBottom: '20px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <span style={{ fontSize: '18px', lineHeight: 1.2 }}>⏸️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '14px', color: PALETTE.title }}>
            {preemptedAgents.length === 1
              ? '1 agent was stood down to make room'
              : `${preemptedAgents.length} agents were stood down to make room`}
          </div>
          <div style={{ color: PALETTE.fg, fontSize: '12px', marginTop: '4px', lineHeight: 1.45 }}>
            Higher-priority work took their capacity. Their work was interrupted, not finished,
            so their tickets should be moved back to To Do until they are put back — leaving one
            In Progress with nothing behind it is the same lie a lost agent tells.
          </div>

          <ul style={{ margin: '12px 0 0', padding: 0 }}>
            {preemptedAgents.map((agent) => {
              const ago = since(agent.at);
              return (
                <li key={agent.agentName} style={{ marginBottom: '10px', listStyle: 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: PALETTE.title, fontSize: '13px' }}>
                        🔑 {agent.key}
                        <span
                          style={{
                            backgroundColor: '#1e293b',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            marginLeft: '8px',
                            color: '#e2e8f0'
                          }}
                        >
                          {agent.type} · priority {agent.priority}
                        </span>
                      </div>
                      {/* Who took it, by name. An agent stopped by an anonymous
                          "higher-priority activation" is one nobody can argue with. */}
                      <div style={{ color: PALETTE.fg, fontSize: '12px', marginTop: '2px' }}>
                        stood down for {agent.by?.type}/{agent.by?.key} (priority {agent.by?.priority})
                        {ago ? ` · ${ago}` : null}
                        {agent.herdrStatusWhenPreempted ? ` · was ${agent.herdrStatusWhenPreempted}` : null}
                      </div>
                    </div>
                    {onTurnOn ? (
                      <TurnOnButton
                        candidate={agent}
                        pending={pending?.[agent.agentName]}
                        onTurnOn={onTurnOn}
                        label="Put back"
                      />
                    ) : null}
                  </div>
                  {renderRefusal ? renderRefusal(agent.agentName) : null}
                </li>
              );
            })}
            <li style={{ listStyle: 'none', color: '#94a3b8', fontSize: '11px', marginTop: '4px' }}>
              Switching one back on resumes the conversation it was stopped in — it is told it was
              interrupted and continues from what it finds, rather than starting over. Nothing
              restarts them automatically, including a reboot: the machine that was full is not
              obliged to be free later, and a restart must not overturn the choice that was made.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
