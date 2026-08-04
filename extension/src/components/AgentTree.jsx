import React from 'react';

import { MISSING, PREEMPTED, RUNNING, STANDBY } from '../lib/agentTree.js';

/**
 * The agent list, drawn as the org chart it has always been.
 *
 * The shape comes from `buildAgentTree` — see `src/lib/agentTree.js` for where
 * parentage comes from and why nothing here guesses at it. This file is only
 * about drawing it, and about the one rule that drawing it must not break.
 *
 * ONE SWITCH PER AGENT
 *
 * The daemon's three not-running lists are disjoint on purpose, so that "no
 * agent ever grows two switches" (`StandbyAgent`, daemon/src/router.ts). The
 * tree is the first thing that could break that from the client side: a
 * stood-down story nested under its live epic is a second place the same agent
 * appears, and putting a Turn on button on it would be the same switch drawn
 * twice — two controls that can disagree about whether they are pending, two
 * places a refusal could render, two things to press for one outcome.
 *
 * So the banners and the Stood down section keep their controls, and a
 * not-running agent in the tree is a **reference**: it says the agent is there,
 * what kind of not-running it is, and where its switch lives. It carries no
 * button and no refusal. Structure is what the tree adds; it does not take
 * anything over.
 *
 * A running row is the opposite: it is not a reference, it is the row, drawn by
 * the page's own `renderRunning` so the card, its priority chip, its supervisor
 * badge, its Off control and that control's confirmation are literally the same
 * markup at depth 3 as at depth 0.
 */

/**
 * What each kind of not-running row looks like, and where its switch is.
 *
 * The colours are the ones its banner already uses — red for a loss nobody
 * chose, amber for a debt somebody is owed, slate for a choice somebody made —
 * because a reference that did not carry its category's alarm would flatten
 * exactly the distinction the four lists exist to preserve.
 */
const REFERENCE = {
  [MISSING]: {
    border: '#f87171',
    bg: 'rgba(185, 28, 28, 0.10)',
    fg: '#fecaca',
    icon: '🛑',
    what: 'missing',
    where: 'Restore it from the banner above'
  },
  [PREEMPTED]: {
    border: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.08)',
    fg: '#fde68a',
    icon: '⏸️',
    what: 'stood down to make room',
    where: 'Put it back from the banner above'
  },
  [STANDBY]: {
    border: '#334155',
    bg: '#0b1220',
    fg: '#94a3b8',
    icon: '⏻',
    what: 'stood down',
    where: 'Turn it on from the Stood down list below'
  }
};

const chip = {
  backgroundColor: '#1e293b',
  padding: '2px 6px',
  borderRadius: '4px',
  fontSize: '12px',
  marginLeft: '8px'
};

function AgentReference({ agent, category }) {
  const style = REFERENCE[category];
  if (!style) return null;

  return (
    <div
      style={{
        backgroundColor: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: '8px',
        padding: '10px 14px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '13px' }}>{style.icon}</span>
        <span style={{ fontWeight: 600, fontSize: '13px', color: style.fg }}>
          🔑 {agent.key}
          <span style={{ ...chip, color: '#e2e8f0' }}>{agent.type}</span>
        </span>
        <span style={{ fontSize: '12px', color: style.fg }}>{style.what}</span>
      </div>
      {/* Where the one switch is. Without this the reader's next move after
          reading the row is to look for a button that is deliberately not on
          it, which is a worse failure than not drawing the row at all. */}
      <div style={{ fontSize: '11px', color: '#64748b', marginTop: '3px' }}>
        {agent.agentName} · {style.where}
      </div>
    </div>
  );
}

function AgentNode({ node, renderRunning }) {
  return (
    <div>
      {node.category === RUNNING ? (
        renderRunning(node.agent)
      ) : (
        <AgentReference agent={node.agent} category={node.category} />
      )}

      {node.children.length > 0 ? (
        /* The indent and the rule down its left are the whole of the visual
           claim: everything to the right of this line was activated by the row
           above it. */
        <div
          style={{
            marginTop: '12px',
            marginLeft: '16px',
            paddingLeft: '16px',
            borderLeft: '1px solid #334155',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}
        >
          {node.children.map((child) => (
            /* Keyed by agent name for the reason agents.jsx gives at its own
               map: `agents` is replaced wholesale every 2s, and an index key
               would hand an open Off confirmation to whichever agent inherited
               the row. Nesting does not change that — it multiplies the number
               of lists it has to hold for. */
            <AgentNode key={child.agent.agentName} node={child} renderRunning={renderRunning} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `roots` is `buildAgentTree(...).roots`; `renderRunning(agent)` draws one
 * running agent exactly as the page draws it — this component never builds a
 * running row itself, so there is no second version of it to drift.
 *
 * With no parentage on the wire every running agent is a root with no children,
 * and what this renders is the flat list, in the same order, with the same keys.
 */
export function AgentTree({ roots, renderRunning }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {roots.map((node) => (
        <AgentNode key={node.agent.agentName} node={node} renderRunning={renderRunning} />
      ))}
    </div>
  );
}
