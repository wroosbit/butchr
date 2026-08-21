// KAN-598: the discriminator that tells a working journal from a plausible one.
//
// `journalctl --user -u butchr-daemon.service` never failed and never came back
// empty. It returned systemd's own lifecycle records — `Started`, `Stopping`,
// `Consumed CPU time` — and nothing else, for the whole life of the service,
// while the daemon's decisions went to `~/.local/share/butchr/daemon.log`. An
// operator who ran it concluded, reasonably, that the daemon was running and
// quiet. Measured 2026-08-21: 72 journal lines in 24 hours, `[board]` records
// in journald EVER 0, against 246 in `daemon.log` over 68 minutes.
//
// ⚠ SO "THE UNIT HAS JOURNAL OUTPUT" IS NOT THE QUESTION, AND ANY CHECK THAT
// ASKS IT WOULD HAVE BEEN GREEN ON THE DAY THIS WAS FILED. The question is
// whether a *decision record* is in there. That is what this file answers, and
// it is the whole reason the defect is now catchable.
//
// ── WHY IT IS HERE AND NOT IN `daemon/src` ────────────────────────────────
//
// Two consumers, one of which forbids a build. `butchr-doctor.mjs` states its
// own contract in its header — "no dependencies and no build step: it must run
// against a clone that has not been built yet, because 'you did not build it'
// is one of the answers" — so it cannot import from `daemon/dist`. Copying the
// predicate into it would leave two definitions of "a decision record" to drift
// apart, which is the failure this repository keeps paying for in other forms.
//
// The daemon's own half of KAN-598 — deciding whether fd 1 really is the
// journal before mirroring to it — is in `daemon/src/journal-stream.ts`, where
// the daemon can reach it. The daemon never reads its own journal, so nothing
// is split that belonged together.

/**
 * A line the daemon itself wrote, recognised by the ISO-8601 stamp its own
 * logger puts at the front of every entry. systemd never writes that shape, so
 * this separates the two authors on a page of `journalctl` output without
 * parsing journald's own framing.
 *
 * The stamp may be preceded by journald's prefix
 * (`Aug 21 12:39:48 host butchr-daemon[258438]: `), so it is searched for
 * rather than anchored.
 */
const DAEMON_STAMP = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/;

/**
 * A daemon line that records a *decision* — one of the subsystems whose records
 * are what an operator is looking for when they reach for the log at all:
 * `[board]`, `[jira-poll]`, `[pr-watch]`, `[notify]`, `[runtime]`, or a
 * `subsystem:` prefix such as `atlassian-proxy:`.
 *
 * **Deliberately stricter than "the daemon wrote something".** A journal that
 * carried only the daemon's PATH probe would satisfy the weaker reading and
 * would still fail the operator who came looking for a stand-down.
 */
const DECISION_MARK =
  /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\s+(\[[A-Za-z][\w-]*\]|[a-z][a-z0-9-]*:)/;

/**
 * What a page of `journalctl --user -u butchr-daemon.service` actually holds.
 *
 * **Four states, and the middle two are the point.** The defect this file
 * exists to close is a journal that returns plausible output about the wrong
 * thing, so `lifecycle-only` — real records, correct records, none of them the
 * daemon's — must be a state a caller can *name*, not a `false` it shares with
 * an empty read. `daemon-lines-without-decisions` is the same refusal applied
 * one level in: the daemon spoke, but said nothing anybody greps for, and
 * reporting that as healthy would be this bug at a smaller scale.
 *
 * @returns {{kind:'carries-decisions',lines:number,daemonLines:number,decisions:number,firstDecision:string}
 *          |{kind:'daemon-lines-without-decisions',lines:number,daemonLines:number}
 *          |{kind:'lifecycle-only',lines:number}
 *          |{kind:'empty'}}
 */
export function readJournal(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { kind: 'empty' };

  const daemonLines = lines.filter((l) => DAEMON_STAMP.test(l));
  if (daemonLines.length === 0) return { kind: 'lifecycle-only', lines: lines.length };

  const decisions = daemonLines.filter((l) => DECISION_MARK.test(l));
  if (decisions.length === 0) {
    return {
      kind: 'daemon-lines-without-decisions',
      lines: lines.length,
      daemonLines: daemonLines.length
    };
  }

  return {
    kind: 'carries-decisions',
    lines: lines.length,
    daemonLines: daemonLines.length,
    decisions: decisions.length,
    firstDecision: decisions[0].trim()
  };
}

/** One sentence an operator can read, for each of the four states. */
export function describeJournalReading(r) {
  switch (r.kind) {
    case 'carries-decisions':
      return `${r.decisions} decision record(s) in ${r.lines} journal line(s) — e.g. ${r.firstDecision}`;
    case 'daemon-lines-without-decisions':
      return (
        `${r.daemonLines} daemon line(s) in ${r.lines} journal line(s), but NONE of them a ` +
        'decision record ([board], [jira-poll], [pr-watch], ...). The daemon is reaching the ' +
        'journal and is not saying anything you would grep for.'
      );
    case 'lifecycle-only':
      return (
        `${r.lines} journal line(s), ALL of them systemd's own lifecycle records. The daemon's ` +
        'decisions are not here. This reads exactly like a quiet, healthy daemon and is not one.'
      );
    case 'empty':
      return 'nothing in the journal for this unit at all.';
    default:
      return `unrecognised reading: ${JSON.stringify(r)}`;
  }
}
