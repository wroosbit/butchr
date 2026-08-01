import React, { useState } from 'react';

// "Is what I am looking at the code that was merged?", answered where someone
// will actually see it.
//
// The surface is the Agents page rather than a log line, because a log line is
// what KAN-24 was explicitly not allowed to call a fix, and rather than the
// sidepanel because the sidepanel is per-page and terminal-shaped: it is where
// you watch one agent work, not where you ask what state this machine is in.
// The Agents page is the one view that is already about the installation as a
// whole, and it is already polling the daemon every 2s, so the banner needs no
// request of its own.
//
// Loudness is deliberate and bounded: only demonstrable staleness gets the red
// treatment. Unknowns get one muted line, and a fully fresh installation
// renders nothing at all — a warning that appears when nothing is wrong is
// ignored by the following afternoon, which is worse than no warning.

const STALE = {
  bg: 'rgba(185, 28, 28, 0.15)',
  border: '#f87171',
  fg: '#fecaca',
  title: '#fef2f2'
};

const UNKNOWN = {
  bg: 'rgba(217, 119, 6, 0.10)',
  border: '#78350f',
  fg: '#fcd34d',
  title: '#fde68a'
};

function Row({ item, palette }) {
  return (
    <li style={{ marginBottom: '10px', listStyle: 'none' }}>
      <div style={{ fontWeight: 600, color: palette.title, fontSize: '13px' }}>
        {item.label}: {item.headline}
      </div>
      <div style={{ color: palette.fg, fontSize: '12px', marginTop: '2px', lineHeight: 1.45 }}>
        {item.detail}
      </div>
      {item.remedy ? (
        <div style={{ marginTop: '4px' }}>
          <code
            style={{
              fontSize: '11px',
              color: '#e2e8f0',
              backgroundColor: '#0b1220',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '2px 6px',
              display: 'inline-block',
              wordBreak: 'break-all'
            }}
          >
            {item.remedy}
          </code>
        </div>
      ) : null}
      {item.note ? (
        <div style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px', fontStyle: 'italic' }}>
          {item.note}
        </div>
      ) : null}
    </li>
  );
}

// `defaultExpanded` exists so the details state can be rendered without a click
// — scripts/render-staleness-banner.mjs uses it to show both states. The page
// never passes it.
export function StalenessBanner({ staleness, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!staleness || !Array.isArray(staleness.items)) return null;

  const stale = staleness.items.filter((i) => i.state === 'stale');
  const unknown = staleness.items.filter((i) => i.state === 'unknown');

  // Everything current: say nothing. Freshness is the default expectation, and
  // a green "all good" bar teaches the eye to skip the space the red one uses.
  if (!stale.length && !unknown.length) return null;

  if (!stale.length) {
    return (
      <div
        style={{
          backgroundColor: UNKNOWN.bg,
          border: `1px solid ${UNKNOWN.border}`,
          borderRadius: '8px',
          padding: '10px 14px',
          marginBottom: '16px',
          color: UNKNOWN.fg,
          fontSize: '12px'
        }}
      >
        {unknown.map((i) => `${i.label}: ${i.headline}`).join(' · ')}
      </div>
    );
  }

  return (
    <div
      role="alert"
      style={{
        backgroundColor: STALE.bg,
        border: `1px solid ${STALE.border}`,
        borderRadius: '8px',
        padding: '14px 16px',
        marginBottom: '20px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <span style={{ fontSize: '18px', lineHeight: 1.2 }}>⚠️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '14px', color: STALE.title }}>
            {staleness.summary}
          </div>
          {/* The consequence, not just the fact. The fact alone is what got
              read as trivia for a day and a half. */}
          <div style={{ color: STALE.fg, fontSize: '12px', marginTop: '4px', lineHeight: 1.45 }}>
            What is running here is not what was merged. Anything you or an agent observes from this
            daemon or this extension right now is evidence about the old build.
          </div>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              marginTop: '10px',
              background: 'transparent',
              border: `1px solid ${STALE.border}`,
              color: STALE.title,
              borderRadius: '6px',
              padding: '4px 10px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            {expanded ? 'Hide details' : `Show details (${stale.length + unknown.length})`}
          </button>

          {expanded ? (
            <ul style={{ margin: '12px 0 0', padding: 0 }}>
              {stale.map((item) => (
                <Row key={item.id} item={item} palette={STALE} />
              ))}
              {unknown.map((item) => (
                <Row key={item.id} item={item} palette={UNKNOWN} />
              ))}
              <li style={{ listStyle: 'none', color: '#94a3b8', fontSize: '11px', marginTop: '4px' }}>
                Checked {staleness.checkedAt} against {staleness.repoRoot}. This check only reports —
                it never pulls, rebuilds or restarts anything. See docs/staleness.md.
              </li>
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
