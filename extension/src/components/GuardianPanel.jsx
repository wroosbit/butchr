import React from 'react';

import { describeGuardian } from '../lib/guardian.js';

/**
 * Who is watching the fleet, shown on the Jira board page.
 *
 * The human asked for this surface by name: *"on [the board] it should show
 * whatever the guardian agent is."* The board is where somebody looks to find
 * out what is in flight, and *"who is watching"* belongs in the same glance.
 *
 * This file decides only **how loud**, exactly as `BoardControlNote.jsx` does;
 * every word comes from `lib/guardian.js`, which owns the five states and the
 * reasoning for choosing between them.
 *
 * ---------------------------------------------------------------------------
 * THE PALETTE IS THE ACCEPTANCE CRITERION
 * ---------------------------------------------------------------------------
 *
 * *"Guardian: epic/KAN-203"* and *"Guardian: epic/KAN-203 — last poke landed 4
 * hours ago"* **must not render the same**. So the tone is driven by delivery,
 * never by whether a guardian is named, and the two loud states are:
 *
 *   * **no guardian set** — nothing is watching, and a fresh install is here;
 *   * **overdue** — a guardian is named and pokes are not landing.
 *
 * Red rather than amber for both, and that is a deliberate departure from
 * `BoardControlNote`'s argument for staying quiet. That note is about a button
 * the reader is *about to press*; this is about a fleet that has **already**
 * stopped being supervised, and the failure it exists to reveal is one nobody is
 * looking for. A page where everything is an alarm has no alarms — which is why
 * `landing` and `waiting` are grey, and why `slipping` gets amber rather than
 * red.
 *
 * ---------------------------------------------------------------------------
 * AND THE LIMIT IS ALWAYS ON SCREEN, INCLUDING IN THE CALM CASE
 * ---------------------------------------------------------------------------
 *
 * `proves` renders in **every** state, the calm one included, because the calm
 * one is where the overclaim would be made. A green-looking panel reading
 * "epic/KAN-203 is the guardian" invites the reader to conclude the fleet is
 * being supervised, and the record cannot support that: it knows a frame reached
 * a connection. `epic/KAN-39`'s sentence — *a heartbeat proves the loop turns;
 * it says nothing about whether its decisions are right* — arrives here from the
 * daemon as data, and this renders it rather than summarising it away.
 *
 * ---------------------------------------------------------------------------
 * THIS PANEL DOES NOT MAKE THE BOARD A WORKSPACE — INVARIANT 6
 * ---------------------------------------------------------------------------
 *
 * It renders **inside the unsupported branch** of the sidepanel, underneath the
 * page's existing "not a supported Workspace Type" notice, which is left exactly
 * as it was. The board still resolves to *not a workspace*, still offers no
 * terminal, and still has no On switch. Displaying is rendering, not binding —
 * and if this panel ever fails to appear, the fix is in `board-page.ts` or in
 * the daemon's status handler, **never** in making the board resolve to
 * something.
 */

const TONES = {
  alarm: {
    bg: 'rgba(220, 38, 38, 0.12)',
    border: '#ef4444',
    lead: '#fecaca',
    body: '#fca5a5',
    icon: '⚠️'
  },
  caution: {
    bg: 'rgba(217, 119, 6, 0.12)',
    border: '#f59e0b',
    lead: '#fde68a',
    body: '#fcd34d',
    icon: '⚠️'
  },
  neutral: {
    bg: 'rgba(148, 163, 184, 0.08)',
    border: '#334155',
    lead: '#cbd5e1',
    body: '#94a3b8',
    icon: '⏳'
  },
  calm: {
    bg: 'rgba(148, 163, 184, 0.08)',
    border: '#334155',
    lead: '#cbd5e1',
    body: '#94a3b8',
    icon: '👁️'
  }
};

export function GuardianPanel({ guardian, style }) {
  const described = describeGuardian(guardian);
  // Null is "there is nothing truthful to say here" — not a board page, or a
  // daemon with no guardian mechanism wired. Note that it is NOT how "no
  // guardian is set" arrives: that is a described state with its own alarm, for
  // the reason lib/guardian.js gives at length.
  if (!described) return null;

  const palette = TONES[described.tone] ?? TONES.neutral;

  return (
    <div
      style={{
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        padding: '10px 12px',
        fontSize: '11.5px',
        lineHeight: 1.5,
        ...style
      }}
    >
      <div style={{ color: palette.lead, fontWeight: 700, marginBottom: '4px' }}>
        {palette.icon} {described.headline}
      </div>
      <div style={{ color: palette.body }}>{described.detail}</div>
      {described.action ? (
        <div style={{ color: palette.lead, fontWeight: 600, marginTop: '6px' }}>
          {described.action}
        </div>
      ) : null}
      {/* The limit, in every state including the calm one. Dimmer than the body
          because it is a caveat rather than news — but present, because a panel
          that drops it in the reassuring case has dropped it in the only case
          where it changes what the reader concludes. */}
      <div
        style={{
          color: '#64748b',
          marginTop: '8px',
          paddingTop: '6px',
          borderTop: '1px solid rgba(100, 116, 139, 0.25)',
          fontSize: '10.5px'
        }}
      >
        {described.proves}
      </div>
    </div>
  );
}
