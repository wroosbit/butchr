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

  return (
    <div className="status-box status-error activation-refusal" role="alert">
      <div className="status-title">⚠️ Can’t start this agent</div>
      <div className="status-detail">
        {isCapacity ? `This machine is at capacity — ${reason}.` : reason}
      </div>

      {isCapacity && (
        <>
          <div className="capacity-figures">
            <span><b>{capacity.running}</b> of <b>{capacity.cap}</b> task agents</span>
            <span>room for <b>{capacity.headroom}</b></span>
            <span>load <b>{capacity.load1}</b> / {capacity.cores} cores</span>
            <span><b>{gib(capacity.availableMb)}</b> free</span>
          </div>

          {capacity.supervisors > 0 && (
            <div className="status-hint">
              The board manager is running as well. It is not one of the {capacity.cap} —
              its share of the machine is reserved before the cap is worked out.
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
