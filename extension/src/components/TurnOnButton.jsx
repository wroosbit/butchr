import React from 'react';

/**
 * The On half of the fleet switch, on a row for an agent that is not running.
 *
 * One component for all three of the daemon's not-running lists — missing,
 * preempted, and stood down — because the *reason* an agent is off changes the
 * words around it and changes nothing about starting it. Three buttons that
 * did the same thing by three routes would be three places for the behaviour
 * to drift apart.
 *
 * Like its Off counterpart, "Starting…" is not a disabled button: it is the
 * row reporting a decision already made, and it stays until the agent appears
 * in the census rather than until the daemon acknowledges the request.
 */
export function TurnOnButton({ candidate, pending, onTurnOn, label = 'Turn on' }) {
  if (pending === 'on') {
    return (
      <span style={{ fontSize: '12px', color: '#7dd3fc', fontWeight: 600, whiteSpace: 'nowrap' }}>
        Starting…
      </span>
    );
  }

  return (
    <button
      style={{
        border: '1px solid #166534',
        borderRadius: '6px',
        padding: '5px 10px',
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
        backgroundColor: '#052e16',
        color: '#86efac',
        whiteSpace: 'nowrap'
      }}
      onClick={() => onTurnOn(candidate)}
      title={`Start ${candidate.type}/${candidate.key}`}
    >
      {label}
    </button>
  );
}
