import React from 'react';

/**
 * Why the toggle did not turn on.
 *
 * KAN-36: the daemon had refused these activations correctly since KAN-34 —
 * with a reason, the figures, and the whole derivation — and the sidepanel
 * rendered none of it. The user met a switch that flipped back and said
 * nothing, and diagnosing that cost an agent. Everything here already existed
 * on the wire; this is where it becomes visible.
 *
 * The shape follows KAN-24's rule for the same failure class: the sentence
 * first, the numbers that produced it next, and the full derivation behind a
 * disclosure for whoever wants to check the arithmetic rather than trust it.
 */
/** `task/KAN-37`, or whichever half of the address the daemon gave us. */
function address(type, key) {
  if (type && key) return `${type}/${key}`;
  return key || type || 'this agent';
}

export function ActivationRefusal({ refusal, onOverride, onPreempt, onDismiss }) {
  if (!refusal) return null;

  const { refusedBy, reason, derivation, capacity, preemption, priority } = refusal;
  const isCapacity = refusedBy === 'capacity' && capacity;

  const gib = (mb) => `${(mb / 1024).toFixed(1)} GiB`;

  // What the victim is named. `type/KEY` when both are known, because that is
  // how the agent is addressed everywhere else and a bare key is ambiguous
  // between workspace types.
  const victim = preemption ? address(preemption.type, preemption.key) : null;

  // The headline names the binding constraint (KAN-60). This panel used to
  // open every capacity refusal with "at capacity" — false by the figures
  // shown right below it whenever what actually bound was load or memory,
  // and pointing the reader at the wrong lever. `headroomBoundBy` is on
  // every capacity payload; render from it, the same rule the daemon's own
  // refusal string follows.
  //
  // KAN-201 renamed the live CPU term: it divides cores actually in use, read
  // from /proc/stat, instead of a 1-minute load average that counted I/O waits
  // as CPU demand. The headline follows the arithmetic, because a refusal that
  // blames a term the daemon no longer computes is worse than none.
  const headline =
    isCapacity && capacity.headroomBoundBy === 'cpu'
      ? 'Not enough CPU'
      : isCapacity && capacity.headroomBoundBy === 'memory'
        ? 'Not enough memory'
        : 'This machine is at capacity';

  return (
    <div className="status-box status-error activation-refusal" role="alert">
      <div className="status-title">⚠️ Can’t start this agent</div>
      <div className="status-detail">
        {isCapacity ? `${headline} — ${reason}.` : reason}
      </div>

      {isCapacity && (
        <>
          <div className="capacity-figures">
            {/*
              KAN-517: `N of M task agents` invites a subtraction the gate does
              not honour. `cap` is not consulted at admission — the gate is
              live headroom — so on a machine whose memory or CPU binds first,
              M is a number that cannot be reached and M − N is a count of
              slots that do not exist. Measured on the human's machine at a
              configured cap of 10, the ceiling was about 8.

              `shortfall` is 0 whenever the cap IS reachable, which is when the
              old wording was right, so that case renders exactly as before.
              Where it is not, the reachable figure leads and the configured
              one is still shown — moved out of the fraction rather than
              dropped, because a reader who set the cap needs to see what
              became of it.
            */}
            {capacity.effectiveCeiling?.shortfall > 0 ? (
              <span>
                <b>{capacity.running}</b> running, <b>{capacity.effectiveCeiling.ceiling}</b> reachable
                {' '}on this machine, <b>{capacity.cap}</b> configured
              </span>
            ) : (
              <span><b>{capacity.running}</b> of <b>{capacity.cap}</b> task agents</span>
            )}
            <span>room for <b>{capacity.headroom}</b></span>
            {/*
              Cores in use rather than the load average: this is the figure the
              gate divided, and showing a number nobody gated on next to a
              refusal is how a reader ends up looking for the wrong lever. The
              load average is still in the derivation below, alongside it.
            */}
            <span>cpu <b>{capacity.cpuBusyCores}</b> / {capacity.cores} cores in use</span>
            <span><b>{gib(capacity.availableMb)}</b> free</span>
          </div>

          {capacity.supervisors > 0 && (
            <div className="status-hint">
              {capacity.supervisors} epic/story agent{capacity.supervisors === 1 ? ' is' : 's are'} running
              as well. They are not counted against the {capacity.cap} — they supervise
              rather than do the work.
            </div>
          )}

          <div className="status-hint">
            Turn an agent off to make room, or start it anyway — the override is
            recorded along with these numbers.
          </div>
        </>
      )}

      {/*
        KAN-37's consent criterion, and the only reason preemption is allowed
        to exist here at all. The agent that would be stopped is named, its
        priority is shown against this one's, and what it is doing right now is
        stated — because "idle" and "working" are very different things to end.
        Nothing is killed until the button below is pressed. Silent preemption
        was ruled out by the ticket and is ruled out by this component.
      */}
      {victim && (
        <div className="preemption-offer">
          <div className="preemption-title">
            This agent outranks one that is running
          </div>
          <div className="status-detail">
            Starting <b>{address(refusal.type, refusal.key)}</b> (priority {priority ?? preemption.incomingPriority})
            can free a slot by standing down <b>{victim}</b> (priority {preemption.priority}),
            which is currently <b>{preemption.herdrStatus}</b>.
          </div>
          <div className="status-hint">
            That interrupts whatever {victim} has not committed. It is recorded as
            preempted, and switching it back on later resumes the conversation it
            was stopped in — but its ticket should not be left In Progress in the
            meantime.
          </div>
        </div>
      )}

      {derivation && (
        <details className="refusal-derivation">
          <summary>How this number was worked out</summary>
          <pre>{derivation}</pre>
        </details>
      )}

      <div className="refusal-actions">
        {/*
          The button says whose work it ends, in its own label. A generic
          "Preempt" would be a control whose consequence the user has to
          reconstruct from the paragraph above it, and this one is irreversible
          in the only way that matters — somebody else's uncommitted work.
        */}
        {victim && (
          <button className="btn btn-danger btn-sm" onClick={onPreempt}>
            Stand down {victim} and start
          </button>
        )}
        {isCapacity && (
          <button className="btn btn-secondary btn-sm" onClick={onOverride}>
            Start anyway
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
