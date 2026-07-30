import React from 'react';

// herdr's per-agent state. 'blocked' means the agent is waiting on a human,
// so it is styled to be the one chip you notice across a full page of agents.
export const HERDR_STATES = {
  blocked: { fg: '#fef2f2', bg: '#b91c1c', border: '#f87171', dot: '#fecaca', weight: 700 },
  working: { fg: '#bfdbfe', bg: 'rgba(59, 130, 246, 0.15)', border: '#3b82f6', dot: '#60a5fa', weight: 600 },
  idle: { fg: '#a7f3d0', bg: 'rgba(16, 185, 129, 0.15)', border: '#10b981', dot: '#10b981', weight: 600 },
  done: { fg: '#6ee7b7', bg: 'rgba(16, 185, 129, 0.07)', border: '#065f46', dot: '#059669', weight: 500 },
  unknown: { fg: '#cbd5e1', bg: '#1e293b', border: '#475569', dot: '#94a3b8', weight: 500 }
};

export function HerdrStateChip({ state }) {
  // Anything the daemon could not resolve — missing, null, or a state this
  // build does not know — reads as 'unknown' rather than rendering empty.
  // hasOwn, not a truthiness check: 'toString' would otherwise resolve to a
  // function off the prototype and render a chip with no colours at all.
  const name = Object.hasOwn(HERDR_STATES, state) ? state : 'unknown';
  const style = HERDR_STATES[name];

  return (
    <span
      title={`Herdr state: ${name}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 10px',
        borderRadius: '999px',
        fontSize: '12px',
        fontWeight: style.weight,
        color: style.fg,
        backgroundColor: style.bg,
        border: `1px solid ${style.border}`
      }}
    >
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: style.dot }}></span>
      {name}
    </span>
  );
}
