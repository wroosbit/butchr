import React from 'react';

import { TurnOnButton } from './TurnOnButton.jsx';

// "Something that should be running is not", said where someone will see it.
//
// This is the detectability half of KAN-21. On the outage that produced that
// ticket, two agents were destroyed by a power cut and the board read healthy
// for twenty minutes afterwards — the loss surfaced only because a human
// thought to ask whether the board was accurate. A log line would have been
// equally silent, which is why the ticket rules one out explicitly.
//
// The surface is the Agents page for the reason StalenessBanner gives: it is
// the one view that is about the installation as a whole rather than about one
// agent, and it already polls the daemon every 2s, so this needs no request of
// its own. It sits above the agent list because a list of three running agents
// means something different when a fourth is missing from it.
//
// Loudness is bounded the same way: an empty `missingAgents` renders nothing at
// all. A banner that appears when nothing is wrong is ignored by the following
// afternoon.

const PALETTE = {
  bg: 'rgba(185, 28, 28, 0.15)',
  border: '#f87171',
  fg: '#fecaca',
  title: '#fef2f2'
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

// `onTurnOn` is optional, and this banner renders without it exactly as it did
// before KAN-38. That is not defensiveness — the sidepanel does not pass one,
// and a banner that broke when nobody could act on it would be a banner that
// stopped reporting losses on the surface that only reports them.
export function MissingAgentsBanner({ missingAgents, pending, onTurnOn, renderRefusal }) {
  if (!Array.isArray(missingAgents) || missingAgents.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        backgroundColor: PALETTE.bg,
        border: `1px solid ${PALETTE.border}`,
        borderRadius: '8px',
        padding: '14px 16px',
        marginBottom: '20px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <span style={{ fontSize: '18px', lineHeight: 1.2 }}>🛑</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '14px', color: PALETTE.title }}>
            {missingAgents.length === 1
              ? '1 agent is missing'
              : `${missingAgents.length} agents are missing`}
          </div>
          {/* The consequence, not just the fact. A ticket left In Progress with
              nothing behind it is the expensive part of this failure. */}
          <div style={{ color: PALETTE.fg, fontSize: '12px', marginTop: '4px', lineHeight: 1.45 }}>
            These were activated and are recorded as active, but no agent is running for them.
            Whatever they were working on has stopped, and their tickets will still read as though
            it had not.
          </div>

          <ul style={{ margin: '12px 0 0', padding: 0 }}>
            {missingAgents.map((agent) => {
              const ago = since(agent.since);
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
                          {agent.type}
                        </span>
                      </div>
                      <div style={{ color: PALETTE.fg, fontSize: '12px', marginTop: '2px' }}>
                        {agent.agentName}
                        {ago ? ` · activated ${ago}` : null}
                      </div>
                      {agent.workDir ? (
                        <div
                          style={{
                            color: '#94a3b8',
                            fontSize: '11px',
                            marginTop: '2px',
                            wordBreak: 'break-all'
                          }}
                        >
                          {agent.workDir}
                        </div>
                      ) : null}
                    </div>
                    {/* The banner already told the reader to re-activate it.
                        Before KAN-38 that was advice with nowhere to follow it
                        — the agent is not on any list that has a switch, which
                        is what being missing means. */}
                    {onTurnOn ? (
                      <TurnOnButton
                        candidate={agent}
                        pending={pending?.[agent.agentName]}
                        onTurnOn={onTurnOn}
                        label="Restore"
                      />
                    ) : null}
                  </div>
                  {renderRefusal ? renderRefusal(agent.agentName) : null}
                </li>
              );
            })}
            <li style={{ listStyle: 'none', color: '#94a3b8', fontSize: '11px', marginTop: '4px' }}>
              Agents are restored automatically when the daemon starts. One listed here was lost
              after that, or could not be restored — re-activate it, or reset the workspace if the
              work is finished with.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
