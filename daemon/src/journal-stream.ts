/**
 * KAN-598: making `StandardOutput=journal` true rather than nominal.
 *
 * `butchr-daemon.service` runs with `StandardOutput=journal`, so every operator
 * instrument — and every page of documentation systemd has ever shipped — says
 * that `journalctl --user -u butchr-daemon.service` is where the daemon's
 * output goes. It was not. `daemon.ts` assigns `console.log` and `console.error`
 * to a file appender, so the whole of the daemon's decision log went to
 * `~/.local/share/butchr/daemon.log` and **nothing at all** reached fd 1.
 *
 * ⚠ **The failure was not an error and not an empty result.** journald still
 * held systemd's own lifecycle records — `Started`, `Stopping`, `Stopped`,
 * `Consumed CPU time` — so the obvious command returned real, well-formed,
 * timestamped output, and a reader concluded from it that the daemon was
 * running and quiet. Measured on 2026-08-21: 72 lines in 24 hours, every one of
 * them systemd's, and `[board]` records in journald **ever: 0** against 246 in
 * `daemon.log` over the same 68 minutes. An operator diagnosing a stand-down
 * ran `journalctl … | grep -i kan-577`, matched nothing, and was one sentence
 * from publishing *"no stand-down was attempted"* — while `daemon.log` recorded
 * 65 attempts, one per minute.
 *
 * This module holds the daemon's half: {@link journalStreamVerdict} — *is this
 * process's fd 1 actually the journal?* — asked before mirroring anything,
 * because the answer decides whether writing is free or harmful.
 *
 * The other half is the operator's, and it lives in
 * `daemon/scripts/lib/journal-reading.mjs`: *does this journal transcript carry
 * the daemon's decisions, or only systemd's lifecycle?* That is the
 * discriminator the defect needed and nobody had. It is **not** here because
 * the daemon never reads its own journal and `butchr-doctor.mjs` — which does —
 * must run against a clone that has not been built.
 */

import * as fs from 'fs';

/**
 * The variable systemd sets when it has connected a service's stdout or stderr
 * to the journal. Its value is `DEVICE:INODE` of the journal socket, in
 * decimal, and it exists precisely so that a program can find out whether it is
 * talking to journald.
 */
export const JOURNAL_STREAM_ENV = 'JOURNAL_STREAM';

/**
 * Whether fd 1 is the journal — and, when it is not, why not.
 *
 * **Two constructors rather than a boolean**, for the same reason
 * `queryDaemonUnit` has three: "there is no journal here" and "I could not find
 * out" lead a caller to the same action but leave an operator with very
 * different questions, and a `false` that cannot say which is the shape this
 * whole ticket is about. `because` is carried so the daemon can say it out loud
 * rather than mirror silently into nothing.
 */
export type JournalStreamVerdict =
  | { readonly kind: 'journal'; readonly dev: number; readonly ino: number }
  | { readonly kind: 'not-journal'; readonly because: string };

/** What {@link journalStreamVerdict} needs to know about a file descriptor. */
export interface FdIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Reads the identity of a live descriptor. Injected so the decision is testable. */
export type FdStat = (fd: number) => FdIdentity;

const realFdStat: FdStat = (fd) => {
  const s = fs.fstatSync(fd);
  return { dev: s.dev, ino: s.ino };
};

/**
 * Is `fd` (fd 1, in every real call) the systemd journal?
 *
 * ⚠ **The presence of `JOURNAL_STREAM` is NOT the test, and reading it as one
 * rebuilds a bug this repository has already paid for.** The variable is
 * ordinary environment, so **every descendant of the unit inherits it** —
 * including a daemon that a verify script or a shell spawned with its stdout on
 * a pipe. `daemon-provenance.ts` records the identical trap at `INVOCATION_ID`:
 * a first draft of KAN-550 read that variable's presence as *"systemd started
 * me"* and so reported a hand-started unconfigured daemon as healthy — the
 * false green rebuilt inside its own cure.
 *
 * So the value is compared against the descriptor: systemd publishes the
 * journal socket's `dev:ino` exactly so a program can ask *"is the thing I am
 * about to write to the thing systemd named?"*. An inherited variable whose
 * numbers do not match the fd answers **no**, which is the correct answer and
 * the one a presence check cannot give.
 */
export function journalStreamVerdict(
  env: NodeJS.ProcessEnv,
  fd = 1,
  fdStat: FdStat = realFdStat
): JournalStreamVerdict {
  const raw = env[JOURNAL_STREAM_ENV];
  if (raw === undefined || raw === '') {
    return {
      kind: 'not-journal',
      because: `${JOURNAL_STREAM_ENV} is not set — systemd has not connected this process to the journal`
    };
  }

  const m = /^(\d+):(\d+)$/.exec(raw.trim());
  if (!m) {
    return {
      kind: 'not-journal',
      because: `${JOURNAL_STREAM_ENV}=${raw} is not the DEVICE:INODE systemd documents`
    };
  }
  const dev = Number(m[1]);
  const ino = Number(m[2]);

  let actual: FdIdentity;
  try {
    actual = fdStat(fd);
  } catch (e) {
    return {
      kind: 'not-journal',
      because: `fd ${fd} could not be stat'd (${e instanceof Error ? e.message : String(e)})`
    };
  }

  if (actual.dev !== dev || actual.ino !== ino) {
    return {
      kind: 'not-journal',
      because:
        `${JOURNAL_STREAM_ENV}=${dev}:${ino} but fd ${fd} is ${actual.dev}:${actual.ino} — ` +
        'the variable was inherited from a unit, and this descriptor is not that journal'
    };
  }

  return { kind: 'journal', dev, ino };
}

/**
 * The signpost the daemon prints once, when it starts, on the descriptor
 * systemd is reading.
 *
 * It is **not** the fix — a startup-only line does nothing for
 * `journalctl --since -60min` against a daemon that started six hours ago,
 * which is the exact command the defect was found with. The mirror is the fix.
 * This names the file that holds the history the journal's retention window
 * does not.
 */
export function journalSignpost(logFile: string): string {
  return (
    `butchr-daemon: this unit's decision log is mirrored here and kept in full at ${logFile} ` +
    '(KAN-598: before this, journald carried systemd lifecycle records only).'
  );
}
