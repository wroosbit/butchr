import React from 'react';

/**
 * The Off switch on an agent row, and the confirmation that guards it.
 *
 * WHY OFF IS NOT ONE CLICK
 *
 * The ticket that asked for this switch named the hazard: on 2026-07-31 three
 * agents were found idle with real unpushed changes in their worktrees.
 * "Idle" is what an agent with an hour of uncommitted work looks like from a
 * list, and this page is a list — a whole fleet of rows, none of them being
 * watched closely, every one of them a click away from losing that work.
 *
 * So Off asks. But it does not ask the way a browser `confirm()` asks, because
 * that dialog says the same words whether there is anything to lose or not,
 * and a warning that is always identical is one nobody finishes reading. It
 * asks by *going and looking*: the daemon runs git in the agent's workspace
 * and this renders what it found. "2 changed, 1 unpushed on butchr/KAN-38" is
 * a decision. "This may destroy uncommitted work" is a speed bump.
 *
 * And when it could not look — no repository, git unavailable, workspace gone —
 * it says that, and still warns. A check that renders its own failure as an
 * all-clear is worse than no check, because the all-clear is the one that gets
 * believed.
 *
 * WHY A SUPERVISOR'S CONFIRMATION IS DIFFERENT
 *
 * Because stopping one is different. A supervisor — an epic or story agent —
 * is what hands out the work under it and merges what comes back; stopping it
 * stops the thing that keeps its slice of the board moving, not just one
 * worker. Switching one off from a fleet list must stay possible — a
 * supervisor you cannot stop is worse than one you can stop by accident, and
 * supervisors are exactly the agents the human needs a way to stand down. But
 * it is allowed with a confirmation that says what stopping it stops, in a
 * different colour, over a button that names it. It is reversible from this
 * same page: a stood-down supervisor appears in the Stood down list below and
 * can be switched straight back on.
 */

const DANGER = {
  bg: 'rgba(185, 28, 28, 0.15)',
  border: '#f87171',
  fg: '#fecaca',
  title: '#fef2f2'
};

const CAUTION = {
  bg: 'rgba(245, 158, 11, 0.12)',
  border: '#f59e0b',
  fg: '#fde68a',
  title: '#fffbeb'
};

const button = (extra) => ({
  border: '1px solid #475569',
  borderRadius: '6px',
  padding: '5px 10px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  backgroundColor: '#1e293b',
  color: '#e2e8f0',
  ...extra
});

/** `task/KAN-38` — how an agent is addressed everywhere else in this system. */
function address(agent) {
  return `${agent.type}/${agent.key}`;
}

function WorkSummary({ state }) {
  if (!state) {
    return (
      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px' }}>
        Checking what this agent has not committed…
      </div>
    );
  }

  // Three outcomes, and they must not look alike: work found, nothing found,
  // and could-not-look. The third is the one that must never read as the
  // second.
  const palette = state.checked && state.hasUnsavedWork ? DANGER : CAUTION;
  const icon = state.checked ? (state.hasUnsavedWork ? '🚨' : '✅') : '❓';

  return (
    <div style={{ marginTop: '10px' }}>
      <div style={{ fontSize: '12px', color: state.checked && !state.hasUnsavedWork ? '#86efac' : palette.fg, lineHeight: 1.45 }}>
        {icon} {state.summary}
      </div>
      {state.checked && state.repos?.length ? (
        <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
          {state.repos.map((repo) => (
            <li
              key={repo.path}
              style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace', marginTop: '2px' }}
            >
              {repo.path === '.' ? '(workspace)' : repo.path}
              {repo.branch ? ` @ ${repo.branch}` : ''}
              {' — '}
              {repo.modifiedFiles} changed, {repo.untrackedFiles} untracked,{' '}
              {repo.noUpstream ? 'never pushed' : `${repo.unpushedCommits} unpushed`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AgentOffControl({
  agent,
  pending,
  confirming,
  workState,
  error,
  onRequestOff,
  onCancelOff,
  onConfirmOff
}) {
  if (pending === 'off') {
    // Not a disabled Off button: the row is no longer offering a choice, it is
    // reporting one that has been made. It stays this way until the agent
    // actually leaves the list — see useFleetControls for why the response is
    // not what ends it.
    return (
      <span style={{ fontSize: '12px', color: '#fbbf24', fontWeight: 600, whiteSpace: 'nowrap' }}>
        Stopping…
      </span>
    );
  }

  if (!confirming) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
        <button
          style={button({ borderColor: '#7f1d1d', color: '#fca5a5' })}
          onClick={() => onRequestOff(agent)}
          title={`Stop ${address(agent)}`}
        >
          Off
        </button>
        {error ? (
          <span style={{ fontSize: '11px', color: '#fca5a5', maxWidth: '220px', textAlign: 'right' }}>
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  const palette = agent.supervisor ? DANGER : CAUTION;

  return (
    <div
      role="alertdialog"
      aria-label={`Stop ${address(agent)}?`}
      style={{
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: '8px',
        padding: '12px 14px',
        maxWidth: '380px'
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '13px', color: palette.title }}>
        {agent.supervisor
          ? `Stop the supervisor ${address(agent)}?`
          : `Stop ${address(agent)}?`}
      </div>

      <div style={{ fontSize: '12px', color: palette.fg, marginTop: '4px', lineHeight: 1.45 }}>
        {agent.supervisor ? (
          <>
            This agent hands out the work under it and merges what comes back. While it is
            off, nothing it supervises will be assigned, reviewed or merged — including
            anything its agents finish. It can be switched back on from the <b>Stood down</b>{' '}
            list on this page.
          </>
        ) : (
          <>
            herdr reports it is <b>{agent.herdrStatus}</b>. Stopping it ends the conversation
            it is in; switching it back on later resumes that conversation, but anything it has
            not committed is gone for good.
          </>
        )}
      </div>

      <WorkSummary state={workState} />

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
        <button style={button()} onClick={onCancelOff}>
          Cancel
        </button>
        {/* The button names what it stops. A bare "Confirm" on a page of
            near-identical rows is a control whose target the reader has to
            reconstruct from which one they think they clicked. */}
        <button
          style={button({ backgroundColor: '#7f1d1d', borderColor: '#b91c1c', color: '#fee2e2' })}
          onClick={() => onConfirmOff(agent)}
        >
          Stop {address(agent)}
        </button>
      </div>
    </div>
  );
}
