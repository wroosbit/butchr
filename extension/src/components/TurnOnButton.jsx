import React from 'react';

import { BoardControlNote } from './BoardControlNote.jsx';

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
 *
 * ON HAS THE MIRROR-IMAGE PROBLEM, AND IT IS ANSWERED HERE (KAN-222)
 *
 * KAN-222 asked whether the board makes On dishonest the way it makes Off
 * dishonest. It does, exactly symmetrically: under `converge`, starting an
 * agent whose ticket is not In Progress or In Review buys about a minute of
 * work before the reconciler stands it down again, and the conversation ends
 * wherever the stand-down caught it. Fixing one direction and not the other
 * would have left half a lie on the same page, so both are fixed together.
 *
 * It belongs in *this* file rather than in each of the three lists for the
 * reason the header already gives: one button, so one place for the sentence
 * about what pressing it achieves. The note is null in `report` and `off`,
 * where On is already the whole truth.
 */
export function TurnOnButton({ candidate, pending, onTurnOn, label = 'Turn on', board }) {
  if (pending === 'on') {
    return (
      <span style={{ fontSize: '12px', color: '#7dd3fc', fontWeight: 600, whiteSpace: 'nowrap' }}>
        Starting…
      </span>
    );
  }

  const note = board?.onNote;

  const button = (
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

  // Unwrapped when there is nothing to say, so that every row on a daemon
  // without a reconciler — and every row in report and off mode — keeps the
  // exact layout it had before this ticket. A wrapper that was always there
  // would change the three lists' spacing to no purpose.
  if (!note) return button;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
      {button}
      <BoardControlNote note={note} reversible style={{ maxWidth: '340px', textAlign: 'left' }} />
    </div>
  );
}
