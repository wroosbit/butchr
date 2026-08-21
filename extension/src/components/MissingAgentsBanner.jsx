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
export function MissingAgentsBanner({
  missingAgents,
  pending,
  onTurnOn,
  renderRefusal,
  describeBoard
}) {
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
              nothing behind it is the expensive part of this failure.

              ⚠ KAN-579 narrowed this sentence, and the narrowing is the point.
              It used to read "no agent is running for them. Whatever they were
              working on has stopped" — a claim about the AGENTS, off a check
              that only ever compared NAMES. An agent restarted under a name the
              daemon did not derive lands in this list while working, and the
              banner then said it had stopped directly above a button that
              RESUMES ITS CONVERSATION. The row now says which of the three it
              is; this sentence is not allowed to overrule it. */}
          <div style={{ color: PALETTE.fg, fontSize: '12px', marginTop: '4px', lineHeight: 1.45 }}>
            These were activated and are recorded as active, but the daemon has no agent under the
            name it expects. Read each row before restoring one — where something is running in the
            agent's own directory under another name, it is flagged below and restoring it would
            interrupt work that is still going on.
          </div>

          <ul style={{ margin: '12px 0 0', padding: 0 }}>
            {missingAgents.map((agent) => {
              const ago = since(agent.since);
              // KAN-579: the row's own disproof. Non-null means the daemon
              // found something LIVE in this agent's workDir under a name it
              // did not derive, so "missing" is a fact about the name only.
              //
              // An older daemon omits the key entirely, and that reads as
              // `undefined` — not as an occupant, which is the safe direction:
              // such a row renders exactly as it did before this change rather
              // than growing a warning nobody can substantiate.
              //
              // The `length` test is for the SAME reason and is not redundant
              // with it: today's daemon never sends `[]` — null is the one
              // spelling of "nothing found", which `MissingAgent.occupiedBy`
              // states and the proof's §5 asserts — but this component reads a
              // wire format, not that type, and a bare `[]` is truthy. Without
              // it a daemon that ever sent one would suppress Restore and
              // render "occupied by" followed by nothing.
              const occupied = Array.isArray(agent.occupiedBy) && agent.occupiedBy.length > 0;
              const occupants = occupied ? agent.occupiedBy : null;
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
                        is what being missing means.

                        ⚠ KAN-579: not offered where something is live in the
                        agent's own directory. Restore RESUMES A CONVERSATION,
                        so on an occupied row it is not a recovery, it is an
                        interruption of work in progress — and the button was
                        being offered for exactly that case with a red banner
                        above it agreeing. The occupant is named instead, which
                        is what a person needs in order to go and look. */}
                    {onTurnOn && !occupants ? (
                      <TurnOnButton
                        candidate={agent}
                        pending={pending?.[agent.agentName]}
                        onTurnOn={onTurnOn}
                        label="Restore"
                        board={describeBoard?.(agent)}
                      />
                    ) : null}
                  </div>
                  {occupants ? (
                    <div
                      style={{
                        color: '#fde68a',
                        backgroundColor: 'rgba(120, 53, 15, 0.35)',
                        border: '1px solid #f59e0b',
                        borderRadius: '6px',
                        padding: '6px 8px',
                        fontSize: '11px',
                        marginTop: '6px',
                        lineHeight: 1.45
                      }}
                    >
                      ⚠ Probably still running. This directory is occupied by{' '}
                      {occupants.map((o) => o.agentName).join(', ')} — a name Butchr did not derive,
                      so it is absent from the agent list without being gone. Restoring it would
                      resume a conversation that is still going, so it is not offered here; look at
                      that pane before doing anything to this row.
                    </div>
                  ) : null}
                  {renderRefusal ? renderRefusal(agent.agentName) : null}
                </li>
              );
            })}
            <li style={{ listStyle: 'none', color: '#94a3b8', fontSize: '11px', marginTop: '4px' }}>
              Agents are restored automatically when the daemon starts. An unflagged row here was
              lost after that, or could not be restored — re-activate it, or reset the workspace if
              the work is finished with. A flagged one has not been shown to be lost at all.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
