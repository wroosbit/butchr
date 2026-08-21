//
// KAN-571: reading `daemon.log` the moment a call returns is a race, and losing
// it produces a *finding about the daemon* rather than a finding about the read.
//
// THE DEFECT THIS EXISTS TO REMOVE. `DaemonLog` holds the log open with
// `fs.createWriteStream(file, { flags: 'a' })` — daemon/src/log-file.ts — so
// `append()` returns when the bytes are in a buffer, not when they are on disk.
// The daemon's audit line is written *before* it answers the caller
// (`handleLaunchDarklyProxyCall` logs, then `respond`s), so a proof that reads
// the file the instant its MCP call comes back is reading ahead of the flush by
// construction. Two things can be on disk at that moment, and neither is what
// the assertion wanted:
//
//   * the line is simply not there yet — the assertion reports "the audit line
//     is missing", which sends the reader to the proxy; or
//   * the tail of the file is **half a line**, because the reader landed inside
//     the stream's write. `verify-launchdarkly-proxy-failure-is-loud` printed
//     exactly that as its evidence on run 32433221528:
//
//         …launchdarkly_get_feature_flag REFUSED — "
//
//     ending at an opening quote with the reason absent. An assertion cannot
//     produce that string; only a read racing a write can.
//
// MEASURED, NOT INFERRED (KAN-571, 2026-08-21). A writer process using the real
// `DaemonLog` against a real file, and a reader process doing the one-shot
// `readFileSync` the proofs do: of 1372 reads, 1188 found no file at all, 183
// found a complete file and **1 found a truncated tail**, cut mid-line at
// `[credential fault ` — the same shape as the CI evidence. The truncation is
// rare, which is precisely why it survived as a flake rather than being fixed:
// it is invisible until a loaded runner makes it likely.
//
// WHAT THIS MODULE DOES ABOUT IT, AND THE PART THAT IS NOT JUST A LONGER SLEEP.
// A longer fixed sleep moves the race; it does not remove one. Two changes:
//
//   1. **Wait for the line, with a bounded deadline.** Polling until the
//      predicate holds turns a race into a wait, and a wait that expires is
//      still a failure — so a daemon that genuinely never logs still goes red,
//      just later. This half follows KAN-251, which already established the
//      pattern in `verify-staleness-over-socket.mjs`; that script is the prior
//      art and this module is its generalisation.
//   2. **Refuse a partial line rather than matching against it.** KAN-251's
//      version does not do this, and it is the half KAN-571 adds. For a
//      line-oriented append log there is an exact test: a trailing fragment is
//      the bytes after the final `\n`, and a file that does not end in `\n` is
//      one the writer is still inside. Those bytes are held apart and never
//      offered to a predicate, so "the log was still being written" becomes an
//      outcome the script can *say* — distinct from "the audit line is
//      missing", which is what it said before and which named the wrong
//      suspect.
//
// WHY THE PARTIAL TAIL IS STILL HANDED BACK. It is excluded from `settled`, the
// text predicates match on — but it is kept on `raw`, because a *negative*
// assertion must see it. "the log carries no token, in any encoding" has to
// search every byte that reached the disk; dropping the fragment there would
// make that check weaker exactly where a secret could be hiding. Positive
// assertions read `settled`; negative ones read `raw`. That asymmetry is the
// point of returning both, and callers that collapse them have lost one of the
// two guarantees.
//

import fs from 'fs';

/**
 * One read of a line-oriented append log, with the unfinished tail held apart.
 *
 * Returns `{ raw, settled, partial, complete, missing }`:
 *
 *   * `raw`     — every byte that was on disk. For negative assertions.
 *   * `settled` — only whole lines, i.e. everything up to and including the
 *                 final newline. For positive assertions.
 *   * `partial` — the trailing fragment, `''` when there is none.
 *   * `complete`— true when `partial` is empty. A file the writer is not
 *                 currently inside.
 *   * `missing` — the file could not be read at all. `createWriteStream` opens
 *                 asynchronously, so this is an ordinary early state and not an
 *                 error: 1188 of the 1372 measured reads above were this.
 *
 * An empty file counts as `complete` — there is no fragment — but callers that
 * need "the log was actually read" must still assert on content, exactly as
 * they did before. This function makes truncation visible; it does not make a
 * vacuous check non-vacuous.
 */
export function readSettledLog(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { raw: '', settled: '', partial: '', complete: false, missing: true };
  }
  const lastNewline = raw.lastIndexOf('\n');
  const settled = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
  const partial = raw.slice(lastNewline + 1);
  return { raw, settled, partial, complete: partial.length === 0, missing: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `file` until `predicate(settled)` holds, or the deadline expires.
 *
 * `predicate` is called with the **settled** text only, so it can never match
 * against half a line. The returned record carries the reading the caller
 * should assert on plus enough to say *why* a failure failed:
 *
 *   * `satisfied`      — the predicate held on settled text before the deadline.
 *   * `outcome`        — one of:
 *       `'settled'`             the predicate held.
 *       `'still-being-written'` the deadline expired while the file was
 *                               absent, or ended mid-line, or was still
 *                               growing. The read lost the race; this is not a
 *                               finding about the daemon.
 *       `'missing-line'`        the deadline expired on a file that was
 *                               complete and had stopped growing, and the line
 *                               was still not in it. THIS is a finding about
 *                               the daemon.
 *   * `waitedMs`       — how long it actually took.
 *   * `firstReadSatisfied` — whether the one-shot read at entry would have been
 *      enough. Kept and reported for KAN-251's reason: a fix for an
 *      intermittent fault that leaves no trace when it fires cannot be
 *      confirmed by anyone who did not already believe in it. When this is
 *      false and `satisfied` is true, the run has just observed the race.
 *
 * `quietReads` is what separates the two expired outcomes. After the deadline
 * the file must have been complete AND unchanged in size for this many
 * consecutive polls before a missing line is blamed on the daemon; otherwise
 * the writer was demonstrably still working and the honest answer is that the
 * read ran out of time. Defaulting to 3 at a 50 ms interval means ~150 ms of
 * quiet, which is many orders of magnitude more than a flush needs.
 */
export async function awaitSettledLog(file, predicate, options = {}) {
  const { timeoutMs = 15_000, intervalMs = 50, quietReads = 3 } = options;
  const startedAt = Date.now();

  let reading = readSettledLog(file);
  const firstReadSatisfied = !reading.missing && reading.complete && predicate(reading.settled);
  let quiet = 0;
  let lastSize = -1;

  for (;;) {
    if (!reading.missing) {
      if (reading.raw.length === lastSize && reading.complete) quiet++;
      else quiet = 0;
      lastSize = reading.raw.length;
      if (reading.complete && predicate(reading.settled)) {
        return {
          ...reading,
          satisfied: true,
          outcome: 'settled',
          waitedMs: Date.now() - startedAt,
          firstReadSatisfied,
        };
      }
    } else {
      quiet = 0;
      lastSize = -1;
    }

    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
    reading = readSettledLog(file);
  }

  // The deadline expired. Which of the two failures it was is decided by what
  // the file was doing when time ran out, never by what the predicate wanted.
  const stillWriting = reading.missing || !reading.complete || quiet < quietReads;
  return {
    ...reading,
    satisfied: false,
    outcome: stillWriting ? 'still-being-written' : 'missing-line',
    waitedMs: Date.now() - startedAt,
    firstReadSatisfied,
  };
}

/**
 * The sentence a caller should print about an {@link awaitSettledLog} result.
 *
 * Centralised so that the distinction KAN-571 asks for is made in the same
 * words everywhere, rather than re-derived by each script that reads a log.
 */
export function describeSettledLog(result, file) {
  const waited = `${result.waitedMs}ms`;
  if (result.outcome === 'settled') {
    return result.firstReadSatisfied
      ? `the log had already flushed when it was first read (waited ${waited})`
      : `RACE OBSERVED: the line was not on disk at the first read; it arrived ${waited} later. ` +
          `A one-shot read would have called the daemon silent here.`;
  }
  if (result.outcome === 'still-being-written') {
    const why = result.missing
      ? `${file} could not be read at all`
      : result.complete
        ? `${file} was still growing`
        : `${file} ended mid-line, after ${result.settled.length} settled bytes, ` +
          `with a ${result.partial.length}-byte fragment: ${JSON.stringify(result.partial.slice(0, 120))}`;
    return (
      `THE LOG WAS STILL BEING WRITTEN after ${waited} — ${why}. ` +
      `This is a finding about the read, not about the daemon: nothing here says the ` +
      `audit line is absent, only that it was not finished being written.`
    );
  }
  return (
    `the audit line is genuinely MISSING: ${file} was complete and had stopped ` +
    `growing, and after ${waited} the line was still not in its ${result.settled.length} ` +
    `settled bytes. This is a finding about the daemon.`
  );
}
