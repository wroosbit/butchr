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
export function ActivationRefusal({ refusal, onOverride, onDismiss }) {
  if (!refusal) return null;

  const { refusedBy, reason, derivation, capacity } = refusal;
  const isCapacity = refusedBy === 'capacity' && capacity;

  const gib = (mb) => `${(mb / 1024).toFixed(1)} GiB`;

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

      {derivation && (
        <details className="refusal-derivation">
          <summary>How this number was worked out</summary>
          <pre>{derivation}</pre>
        </details>
      )}

      <div className="refusal-actions">
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
