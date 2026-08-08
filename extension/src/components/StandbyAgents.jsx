import React from 'react';

import { TurnOnButton } from './TurnOnButton.jsx';

/**
 * Agents somebody switched off, and the way back.
 *
 * WHY THIS LIST EXISTS AT ALL
 *
 * Because the Agents page lists what is *running*, and the moment it grew an
 * Off button it became a page that can remove things from its own list with no
 * way to put them back. KAN-38 named that as the hard half of the ticket: "the
 * Agents page lists what is running, and something that is off is not in that
 * list." This is the answer to where the On candidates come from.
 *
 * They come from KAN-21's registry, which is the only durable record of
 * activation intent this system has. Nothing new is written to produce this
 * list and no parallel registry exists: the daemon reduces the same append-only
 * log the boot-time restore reads, and reports the agents whose last word was
 * `deactivated`, that are not running, and whose workspace is still on disk.
 *
 * WHY IT IS QUIET
 *
 * Its two siblings are alarms — MissingAgentsBanner is a loss nobody chose,
 * PreemptedAgentsBanner is a debt somebody is owed. This is neither. An agent
 * that is off because a person switched it off is the system doing as it was
 * told, and dressing that up in a coloured box would teach the reader to
 * ignore the boxes that matter. It renders nothing at all when the list is
 * empty, by the same rule.
 */

const PALETTE = {
  border: '#334155',
  title: '#e2e8f0',
  fg: '#94a3b8'
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

export function StandbyAgents({
  standbyAgents,
  standbyTotal,
  pending,
  onTurnOn,
  renderRefusal,
  describeBoard
}) {
  if (!Array.isArray(standbyAgents) || standbyAgents.length === 0) return null;

  // The daemon caps what it sends so a 2s poll does not carry an unbounded
  // list. Saying so is the point: a list that silently stopped at its limit
  // would read as "that is all of them", which is the failure mode of every
  // truncated report.
  const hidden = Math.max(0, (standbyTotal ?? standbyAgents.length) - standbyAgents.length);

  return (
    <div style={{ marginTop: '28px', paddingTop: '20px', borderTop: `1px solid ${PALETTE.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: PALETTE.title }}>Stood down</div>
        <div style={{ fontSize: '12px', color: PALETTE.fg }}>
          switched off deliberately — workspace still on disk
        </div>
      </div>
      <div style={{ fontSize: '12px', color: PALETTE.fg, marginBottom: '14px', lineHeight: 1.45 }}>
        Switching one back on resumes the conversation it was stopped in. Agents whose workspace
        was reset are not listed: the deleted directory is the difference between “stopped” and
        “finished with”.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {standbyAgents.map((agent) => {
          const ago = since(agent.since);
          return (
            <div
              key={agent.agentName}
              className="card"
              style={{
                backgroundColor: '#0b1220',
                borderRadius: '8px',
                border: `1px solid ${PALETTE.border}`,
                padding: '14px 16px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: PALETTE.title }}>
                    🔑 {agent.key}
                    <span
                      style={{
                        backgroundColor: '#1e293b',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        marginLeft: '8px'
                      }}
                    >
                      {agent.type}
                    </span>
                    {/* What it will come back as. An agent whose launcher was
                        not recorded returns as a bare shell, and a row that
                        did not say so would be promising something else. */}
                    {agent.defaultAgent ? (
                      <span
                        style={{
                          backgroundColor: '#1e293b',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          marginLeft: '6px',
                          color: PALETTE.fg
                        }}
                      >
                        {agent.defaultAgent}
                      </span>
                    ) : (
                      <span
                        title="No launcher was recorded for this agent, so it will come back as a plain shell."
                        style={{
                          backgroundColor: '#1e293b',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          marginLeft: '6px',
                          color: '#fbbf24'
                        }}
                      >
                        shell
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: PALETTE.fg, marginTop: '3px' }}>
                    {agent.agentName}
                    {ago ? ` · stopped ${ago}` : null}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', wordBreak: 'break-all' }}>
                    {agent.workDir}
                  </div>
                </div>
                <TurnOnButton
                  candidate={agent}
                  pending={pending?.[agent.agentName]}
                  onTurnOn={onTurnOn}
                  board={describeBoard?.(agent)}
                />
              </div>
              {renderRefusal ? renderRefusal(agent.agentName) : null}
            </div>
          );
        })}
      </div>

      {hidden > 0 ? (
        <div style={{ fontSize: '11px', color: PALETTE.fg, marginTop: '10px' }}>
          {hidden} older stood-down {hidden === 1 ? 'agent is' : 'agents are'} not shown. The full
          record is <code>~/.local/share/butchr/agents.jsonl</code>.
        </div>
      ) : null}
    </div>
  );
}
