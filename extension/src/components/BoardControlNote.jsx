import React from 'react';

/**
 * What the board will do to this agent after the button is pressed.
 *
 * Renders a note from `describeBoardControl` (see lib/boardControl.js, which
 * owns every word of it and the reasoning for choosing between them). This file
 * decides only how loud it is, and that decision is the whole of its content:
 *
 * **Blue when the board will undo the button, grey when it will not.**
 *
 * The grey cases are not warnings and must not look like them. "Off will stick"
 * is a *reassurance* — it is the answer to a question the reader has only
 * because this page now talks about a board at all, and on a stock machine,
 * where the reconciler ships report-only, it is the case they will meet every
 * time. Dressing it in amber would teach the reader that this box means danger,
 * and then the one box that does mean danger would read as more of the same.
 * StandbyAgents.jsx makes the same argument for staying quiet, and it is right:
 * a page where everything is an alarm has no alarms.
 *
 * Blue rather than amber even when it *is* the reversible case, because nothing
 * here is a loss. Amber and red on this page already mean "you are about to
 * destroy work" — that is what AgentOffControl's own palettes are for, and this
 * note sits inside one of them. This is a different axis: not "this is
 * dangerous" but "this is temporary, and here is the thing that is not".
 */

const REVERSIBLE = {
  bg: 'rgba(37, 99, 235, 0.12)',
  border: '#3b82f6',
  lead: '#bfdbfe',
  body: '#93c5fd'
};

const SETTLED = {
  bg: 'rgba(148, 163, 184, 0.08)',
  border: '#334155',
  lead: '#cbd5e1',
  body: '#94a3b8'
};

export function BoardControlNote({ note, reversible, style }) {
  if (!note) return null;

  const palette = reversible ? REVERSIBLE : SETTLED;

  return (
    <div
      style={{
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        padding: '8px 10px',
        fontSize: '11.5px',
        lineHeight: 1.5,
        ...style
      }}
    >
      <span style={{ color: palette.lead, fontWeight: 700 }}>
        {reversible ? '🔄 ' : ''}
        {note.lead}
      </span>{' '}
      <span style={{ color: palette.body }}>{note.body}</span>
      {note.action ? (
        <div style={{ color: palette.lead, fontWeight: 600, marginTop: '5px' }}>{note.action}</div>
      ) : null}
    </div>
  );
}
