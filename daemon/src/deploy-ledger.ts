import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR } from './ipc.js';

/**
 * What code this daemon came up on, how it got there, and whether anybody
 * announced putting it there.
 *
 * ## The gap this closes (KAN-647)
 *
 * Merging is not deploying. The fleet says so constantly, and **the step
 * between them had no owner and no witness**. Both halves of that were measured
 * on 2026-08-21 and they point in opposite directions:
 *
 * - **Merged and inert.** Nine tickets, filed one at a time, each correctly
 *   reporting that a merged fix was not running and each closed by performing
 *   the one deploy it named. KAN-511's own title reads *"THIRD undeployed-commit
 *   gap TODAY"* — the fleet had counted the recurrence *inside* an instance and
 *   still filed it as an instance.
 * - **Deployed without the gate.** Twice in one day. At 16:23Z the daemon was
 *   restarted and `dist` rebuilt; at 22:03Z the checkout was moved to `67f4adc`
 *   and the daemon restarted. Neither left a record anywhere.
 *
 * The second one is the reason this module is in the daemon rather than in the
 * deploy script. `epic/KAN-39` performed the 22:03Z deploy, was not hiding
 * anything, and described it as *"I deployed 67f4adc and ran the proof"* — a
 * sentence about proving a ticket, in which the bypass is invisible. Its own
 * words: **"An actor who simply says less is not identified at all."** KAN-646
 * reports a fleet-visible behaviour change correlating with that same restart,
 * which nobody was looking for because nothing said a restart had happened.
 *
 * ## Why the daemon writes this and the deploy script does not
 *
 * ⚠ **A log the gate writes is exactly what a bypass skips.** KAN-647's second
 * acceptance criterion is that a deploy leave a trace *"whether or not the
 * script was used"*, and only one participant is present on both paths: the
 * daemon itself. Restarting it **is** the terminal act of a deploy, gated or
 * not, so a record written here cannot be routed around by not running
 * something.
 *
 * That also answers `epic/KAN-203`'s objection to the ownership ruling — *"the
 * detector and the actor should not be the same role; if I deploy, the next
 * bypass is MINE"*. Under this module the detector is not a role at all. The
 * guardian can own the act without owning the audit of it, because the audit is
 * written by the process it restarted.
 *
 * ## The direction every unknown fails in
 *
 * **Ungated.** An absent intent, an unparseable one, a stale one, one that
 * pins nothing, and one that pins something other than what came up are five
 * different sentences and one verdict. This is `incumbentIsConfigured`'s
 * discipline in a second domain: the comfortable reading of each of those is
 * the one that let 2026-08-21 pass unnoticed twice.
 *
 * ⚠ **`unpinned-intent` is the one worth stating out loud.** An intent file
 * carrying only `by` and `at` would gate every deploy it was dropped beside,
 * including ones it did not perform — a check whose failing branch the world
 * cannot reach, which is not a weak check but a check that does not exist while
 * appearing to. So an intent that pins neither the head nor the build is
 * refused rather than believed.
 */

/** Where a deploy announces itself, immediately before restarting the daemon. */
export const DEPLOY_INTENT_FILE = path.join(BUTCHR_DIR, 'deploy-intent.json');

/**
 * Where a consumed intent goes, rather than being deleted.
 *
 * Deleting it would make "the gate wrote an intent that did not match" and "the
 * gate wrote nothing" the same absence afterwards, and those want different
 * repairs — a broken gate against a bypass.
 */
export const DEPLOY_INTENT_CONSUMED_FILE = path.join(BUTCHR_DIR, 'deploy-intent.consumed.json');

/** Append-only, one JSON object per line, one line per daemon start. */
export const DEPLOY_LEDGER_FILE = path.join(BUTCHR_DIR, 'deploys.jsonl');

/**
 * How long before a daemon start an intent may have been written.
 *
 * A gate writes the intent and restarts the unit in the same breath, so the
 * real gap is a second or two. Ten minutes is slack for a slow restart and a
 * clock that is not quite the daemon's; it is not slack for an intent left
 * lying around from an earlier deploy, which is the case this bound exists to
 * refuse.
 */
export const INTENT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * How far in the *future* an intent's timestamp may sit before it is refused.
 *
 * Not zero: the gate stamps the file and the daemon reads its own clock a
 * moment later, and on a machine whose clock steps between those two reads a
 * strictly-past rule would refuse a perfectly good gate.
 */
export const INTENT_FUTURE_TOLERANCE_MS = 60 * 1000;

const GIT_TIMEOUT_MS = 5_000;

/** Keep the file bounded on a daemon that is restarted for months. */
export const LEDGER_MAX_LINES = 2_000;

// ── what is running ─────────────────────────────────────────────────────────

/**
 * The built tree this process is executing, by content.
 *
 * **Content, not mtime, and the distinction is what makes the record readable.**
 * `mcp-build.ts` compares mtimes because it is asking *"is this process behind
 * the tree on disk"*, where a timestamp is the whole question. Here the question
 * is *"is the fleet running different code than it was"*, and a rebuild that
 * emits byte-identical output has changed no behaviour while moving every
 * mtime. Hashing the bytes lets {@link classifyStart} say `rebuild-no-change`
 * where a timestamp would have to say `deploy` and be wrong.
 *
 * `newestMs` is kept beside the digest rather than folded into it, so a reader
 * still gets the timestamp for free.
 */
export interface DistFingerprint {
  /** sha256 over every file's relative path and bytes, in sorted path order. */
  digest: string | null;
  fileCount: number;
  newestMs: number | null;
  /** Non-null when the tree could not be read. `digest` is then null. */
  error: string | null;
}

/**
 * Hash a built tree.
 *
 * The path goes into the hash beside the bytes so that moving a file changes
 * the digest. A digest over concatenated contents alone would be blind to a
 * rename, which is a real code change with an unchanged byte multiset.
 */
export function fingerprintDist(distDir: string): DistFingerprint {
  const files: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(at, entry.name), nextRel);
      else if (entry.isFile()) files.push(nextRel);
    }
  };

  try {
    walk(distDir, '');
  } catch (err) {
    return {
      digest: null,
      fileCount: 0,
      newestMs: null,
      error: `could not read ${distDir}: ${(err as Error)?.message ?? String(err)}`
    };
  }

  files.sort();
  const hash = createHash('sha256');
  let newestMs: number | null = null;
  for (const rel of files) {
    const abs = path.join(distDir, rel);
    try {
      const stat = fs.statSync(abs);
      if (newestMs === null || stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
      hash.update(rel);
      hash.update('\0');
      hash.update(fs.readFileSync(abs));
      hash.update('\0');
    } catch (err) {
      // A file that vanished between readdir and read makes the digest a claim
      // about a tree that no longer exists. Refuse rather than hash the rest:
      // a digest missing one file is a *different valid-looking digest*, which
      // would read as a deploy that never happened.
      return {
        digest: null,
        fileCount: files.length,
        newestMs,
        error: `${rel} vanished or was unreadable mid-scan: ${(err as Error)?.message ?? String(err)}`
      };
    }
  }

  return { digest: hash.digest('hex'), fileCount: files.length, newestMs, error: null };
}

/** What the checkout under the running build says about itself. */
export interface BuildIdentity {
  /** The `dist` directory this process is executing out of. */
  distDir: string;
  /** The repository root above it, or null when it is not inside a checkout. */
  repoRoot: string | null;
  /** `git rev-parse HEAD`, or null. */
  head: string | null;
  /**
   * `origin/main` **as of this clone's last fetch**, which this daemon does not
   * perform. Recorded rather than acted on: it is what makes a later reader
   * able to see the *other* direction of KAN-647 — a fleet running code that a
   * merge has already superseded — without this module ever touching the
   * network at startup.
   */
  originMain: string | null;
  /** How many commits `origin/main` is ahead of `HEAD`, as of that same fetch. */
  behindOriginMain: number | null;
  dist: DistFingerprint;
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Describe the build this process is running.
 *
 * `distDir` is passed in rather than derived from `import.meta.url` so that a
 * proof can point this at a fixture tree without relocating anything, and so
 * the daemon's call site says out loud which directory it means.
 */
export function readBuildIdentity(distDir: string): BuildIdentity {
  const dist = fingerprintDist(distDir);
  // dist -> daemon -> repo root. Two levels, and it is checked rather than
  // assumed: a build laid out any other way reports `repoRoot: null` instead of
  // a plausible wrong directory whose git answers would be somebody else's.
  const candidate = path.resolve(distDir, '..', '..');
  const inside = git(candidate, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!inside) {
    return { distDir, repoRoot: null, head: null, originMain: null, behindOriginMain: null, dist };
  }
  const head = git(candidate, ['rev-parse', 'HEAD']);
  const originMain = git(candidate, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  let behind: number | null = null;
  if (head && originMain) {
    const counted = Number(git(candidate, ['rev-list', '--count', `${head}..${originMain}`]));
    behind = Number.isFinite(counted) ? counted : null;
  }
  return { distDir, repoRoot: candidate, head, originMain, behindOriginMain: behind, dist };
}

// ── what the gate said, if anything ─────────────────────────────────────────

/**
 * A deploy announcing itself, written by the gate immediately before it
 * restarts the daemon.
 *
 * Both pins are optional *individually* and one of them is required — see
 * {@link judgeGate}. `intendedDist` exists so that a machine whose daemon runs
 * outside a git checkout can still be gated: the gate builds first, so it can
 * name the digest it produced.
 */
export interface DeployIntent {
  /** `type/KEY` of the agent, or a human's name. Free text; it is a claim. */
  by: string;
  /** ISO 8601, written by the gate. */
  at: string;
  intendedHead: string | null;
  intendedDist: string | null;
  note: string | null;
}

/**
 * Parse an intent, strictly.
 *
 * Strict for `buildFromAnnouncement`'s reason: this file is written by another
 * process and is a claim rather than a measurement. A half-filled record must
 * not read as a stamp, so anything missing `by` or `at` is `null` and lands as
 * `unreadable-intent` — a sentence a reader can act on — rather than as a
 * partially-trusted gate.
 */
export function parseIntent(raw: unknown): DeployIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  const by = str(o.by);
  const at = str(o.at);
  if (by === null || at === null) return null;
  return {
    by,
    at,
    intendedHead: str(o.intendedHead),
    intendedDist: str(o.intendedDist),
    note: str(o.note)
  };
}

/** Why a start was not gated. Five sentences, one verdict. @see judgeGate */
export type UngatedBecause =
  /** Nothing announced this start. The ordinary bypass. */
  | 'no-intent'
  /** A file was there and was not an intent, or carried no `by`/`at`. */
  | 'unreadable-intent'
  /** An intent from an earlier deploy, or from a clock this daemon cannot use. */
  | 'stale-intent'
  /** An intent naming neither a head nor a build — nothing to check it against. */
  | 'unpinned-intent'
  /** The gate named one build and a different one came up. */
  | 'mismatched-intent';

export type GateVerdict =
  | { kind: 'gated'; by: string; at: string; pinned: string[]; note: string | null }
  | { kind: 'ungated'; because: UngatedBecause; detail: string };

/**
 * Decide whether an intent gates the build that actually came up.
 *
 * Pure, and separate from the file read, so that the whole input space can be
 * asserted without a filesystem — which is what
 * `verify-deploy-ledger-is-unbypassable.mjs` §2 does.
 *
 * ⚠ **A mismatch is not gated, and that is the sharp end.** *"The gate ran"* and
 * *"the gate landed what it promised"* are different claims, and it is the
 * second one an auditor needs. A gate that checked out `abc` and left the
 * daemon running `def` has produced precisely the state KAN-647 exists to make
 * visible, and it would be worse than a bypass for the record to call it clean.
 */
export function judgeGate(
  intent: DeployIntent | null,
  build: BuildIdentity,
  nowMs: number
): GateVerdict {
  if (intent === null) {
    return {
      kind: 'ungated',
      because: 'no-intent',
      detail: `no readable ${path.basename(DEPLOY_INTENT_FILE)} accompanied this start`
    };
  }

  const atMs = Date.parse(intent.at);
  if (!Number.isFinite(atMs)) {
    return {
      kind: 'ungated',
      because: 'unreadable-intent',
      detail: `intent carried an unparseable timestamp ${JSON.stringify(intent.at)}`
    };
  }

  const ageMs = nowMs - atMs;
  if (ageMs > INTENT_MAX_AGE_MS) {
    return {
      kind: 'ungated',
      because: 'stale-intent',
      detail:
        `intent was written ${Math.round(ageMs / 1000)}s before this start, past the ` +
        `${Math.round(INTENT_MAX_AGE_MS / 1000)}s bound — it belongs to an earlier deploy`
    };
  }
  if (ageMs < -INTENT_FUTURE_TOLERANCE_MS) {
    return {
      kind: 'ungated',
      because: 'stale-intent',
      detail: `intent is dated ${Math.round(-ageMs / 1000)}s in this daemon's future`
    };
  }

  const pinned: string[] = [];
  const mismatched: string[] = [];
  if (intent.intendedHead !== null) {
    if (build.head !== null && build.head === intent.intendedHead) pinned.push('head');
    else mismatched.push(`head: gate named ${intent.intendedHead}, came up on ${build.head ?? '(no checkout)'}`);
  }
  if (intent.intendedDist !== null) {
    if (build.dist.digest !== null && build.dist.digest === intent.intendedDist) pinned.push('dist');
    else
      mismatched.push(
        `dist: gate named ${intent.intendedDist}, came up on ${build.dist.digest ?? '(unreadable)'}`
      );
  }

  if (pinned.length === 0 && mismatched.length === 0) {
    return {
      kind: 'ungated',
      because: 'unpinned-intent',
      detail:
        `intent from ${intent.by} named neither a head nor a build digest, so there is ` +
        `nothing it could have failed to match — it gates every start it is left beside`
    };
  }
  if (mismatched.length > 0) {
    return {
      kind: 'ungated',
      because: 'mismatched-intent',
      detail: `intent from ${intent.by} does not describe this build — ${mismatched.join('; ')}`
    };
  }

  return { kind: 'gated', by: intent.by, at: intent.at, pinned, note: intent.note };
}

// ── what changed since the last start ───────────────────────────────────────

export type StartKind =
  /** No previous record. Baseline, judged against nothing, and says so. */
  | { kind: 'first-record' }
  /** Same build, same checkout. A plain restart changes no code. */
  | { kind: 'restart' }
  /** The bytes are identical and the tree was rebuilt. No behaviour moved. */
  | { kind: 'rebuild-no-change' }
  /** Different running code. This is a deploy. */
  | { kind: 'deploy'; from: string | null; to: string | null }
  /**
   * The checkout moved and the build did not follow.
   *
   * KAN-647's *first* direction, caught at the moment it is created rather than
   * nine tickets later: `HEAD` now names commits whose code is not running.
   */
  | { kind: 'checkout-moved'; from: string | null; to: string | null; behind: number | null }
  /** Something could not be read, so nothing here is a claim about the fleet. */
  | { kind: 'indeterminate'; detail: string };

/**
 * Classify this start against the previous one.
 *
 * ⚠ **`indeterminate` is not a tidy-up branch.** An unreadable digest makes
 * every comparison below unavailable, and the available readings are "nothing
 * changed" and "we do not know" — the first of which is the comfortable one and
 * is how this whole class survives. {@link changesTheRunningFleet} treats it as
 * fleet-changing for that reason.
 */
export function classifyStart(previous: BuildIdentity | null, current: BuildIdentity): StartKind {
  if (current.dist.error !== null || current.dist.digest === null) {
    return { kind: 'indeterminate', detail: current.dist.error ?? 'this build has no digest' };
  }
  if (previous === null) return { kind: 'first-record' };
  if (previous.dist.digest === null) {
    return { kind: 'indeterminate', detail: 'the previous record carried no digest to compare against' };
  }

  if (previous.dist.digest !== current.dist.digest) {
    return { kind: 'deploy', from: previous.dist.digest, to: current.dist.digest };
  }
  if (previous.head !== current.head) {
    return {
      kind: 'checkout-moved',
      from: previous.head,
      to: current.head,
      behind: current.behindOriginMain
    };
  }
  const rebuilt =
    previous.dist.newestMs !== null &&
    current.dist.newestMs !== null &&
    current.dist.newestMs > previous.dist.newestMs;
  return rebuilt ? { kind: 'rebuild-no-change' } : { kind: 'restart' };
}

/**
 * Whether this start altered what the fleet is running, and therefore whether
 * the absence of a gate is worth shouting about.
 *
 * `first-record` is deliberately **not** fleet-changing. The ledger's first
 * line is written by the first daemon to carry this module, and there is
 * nothing behind it to compare against — announcing it as an ungated deploy
 * would fire an alarm on the act of installing the alarm. The record still
 * carries `first-record`, so a reader sees that this one was not judged rather
 * than seeing a clean verdict it did not earn.
 */
export function changesTheRunningFleet(start: StartKind): boolean {
  return start.kind === 'deploy' || start.kind === 'checkout-moved' || start.kind === 'indeterminate';
}

// ── the record ──────────────────────────────────────────────────────────────

export interface DeployRecord {
  at: string;
  pid: number;
  start: StartKind;
  gate: GateVerdict;
  build: BuildIdentity;
  /** Who to ask. `null` is the honest answer for an ungated start. */
  by: string | null;
  /** The `at` of the record this one was compared against. */
  previousAt: string | null;
  /** Non-null when the intent file could not be moved out of the way. */
  consumeError: string | null;
}

/**
 * The lines an operator reads in the journal when nobody announced a deploy.
 *
 * `announceToJournal` rather than `log` at the call site, for the reason its
 * own docblock gives: `daemon.log` is a file nobody opens unprompted, and the
 * whole criterion here is that an unattributed change to the running fleet is
 * *findable by someone who was not there*.
 */
export function describeUngatedStart(record: DeployRecord): string[] {
  if (record.gate.kind !== 'ungated') return [];
  const what =
    record.start.kind === 'deploy'
      ? 'the running code CHANGED'
      : record.start.kind === 'checkout-moved'
        ? 'the CHECKOUT moved and the build did not follow'
        : 'this start could not be classified';
  return [
    `butchr: UNGATED DEPLOY — ${what}, and nothing announced it.`,
    `  why not gated: ${record.gate.because} — ${record.gate.detail}`,
    `  head ${record.build.head ?? '(no checkout)'}, dist ${record.build.dist.digest?.slice(0, 12) ?? '(unreadable)'}` +
      (record.build.behindOriginMain === null
        ? ''
        : `, ${record.build.behindOriginMain} commit(s) behind origin/main as of this clone's last fetch`),
    `  attributable to: nobody. Recorded in ${DEPLOY_LEDGER_FILE}.`,
    `  A gated deploy writes ${DEPLOY_INTENT_FILE} before restarting this unit.`
  ];
}

/** The most recent record in the ledger, or null when there is none. */
export function readLastRecord(ledgerFile = DEPLOY_LEDGER_FILE): DeployRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(ledgerFile, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && parsed.build) return parsed as DeployRecord;
    } catch {
      // A torn last line — the tail of an append lost to an unclean shutdown,
      // exactly as `log-file.ts` documents for daemon.log. Walk back to the
      // last whole record rather than treating the file as absent, because
      // "absent" would silently reclassify the next start as `first-record`
      // and skip judging it.
    }
  }
  return null;
}

/** Every record, oldest first. Torn lines are reported, never skipped silently. */
export function readLedger(ledgerFile = DEPLOY_LEDGER_FILE): {
  records: DeployRecord[];
  unreadableLines: number;
  exists: boolean;
} {
  let text: string;
  try {
    text = fs.readFileSync(ledgerFile, 'utf8');
  } catch {
    return { records: [], unreadableLines: 0, exists: false };
  }
  const records: DeployRecord[] = [];
  let unreadableLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as DeployRecord);
    } catch {
      unreadableLines += 1;
    }
  }
  return { records, unreadableLines, exists: true };
}

/**
 * Take the intent out of the way, whatever the verdict was.
 *
 * ⚠ **Unconditional, and that is load-bearing.** An intent left in place gates
 * the *next* start too, which is a gate that reports what it was told once and
 * then agrees with everything — the shape `unpinned-intent` refuses above,
 * arriving through time instead of through content. Renaming rather than
 * deleting keeps "the gate wrote something wrong" distinguishable from "the
 * gate wrote nothing", which want different repairs.
 */
function consumeIntent(intentFile: string, consumedFile: string): string | null {
  try {
    fs.renameSync(intentFile, consumedFile);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    try {
      fs.unlinkSync(intentFile);
      return null;
    } catch (err2) {
      return `could not consume ${intentFile}: ${(err2 as Error)?.message ?? String(err2)}`;
    }
  }
}

function appendBounded(ledgerFile: string, line: string, maxLines: number): void {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${line}\n`);
  let text: string;
  try {
    text = fs.readFileSync(ledgerFile, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= maxLines) return;
  fs.writeFileSync(ledgerFile, `${lines.slice(lines.length - maxLines).join('\n')}\n`);
}

export interface RecordStartOptions {
  distDir: string;
  now?: Date;
  pid?: number;
  ledgerFile?: string;
  intentFile?: string;
  consumedFile?: string;
  maxLines?: number;
}

/**
 * Read the world, judge it, append one line, and hand the record back.
 *
 * The whole of the I/O lives here and every decision lives in the pure
 * functions above, so a proof can assert the decisions exhaustively and then
 * separately watch a real daemon produce a real line.
 *
 * ⚠ **Nothing here throws to the caller.** This runs before the socket in
 * `daemon.ts`, and a daemon that refuses to start because it could not write
 * its own audit line would have turned an audit trail into an outage. A write
 * that fails leaves `consumeError` or nothing at all, and the *next* start sees
 * a missing predecessor and classifies itself `first-record` — visible, and not
 * a false clean.
 */
export function recordDaemonStart(opts: RecordStartOptions): DeployRecord {
  const now = opts.now ?? new Date();
  const ledgerFile = opts.ledgerFile ?? DEPLOY_LEDGER_FILE;
  const intentFile = opts.intentFile ?? DEPLOY_INTENT_FILE;
  const consumedFile = opts.consumedFile ?? DEPLOY_INTENT_CONSUMED_FILE;

  const build = readBuildIdentity(opts.distDir);

  let intent: DeployIntent | null = null;
  try {
    intent = parseIntent(JSON.parse(fs.readFileSync(intentFile, 'utf8')));
    if (intent === null) {
      // A file that IS there and is not an intent must not read as absence.
      intent = { by: '(unreadable)', at: '(unreadable)', intendedHead: null, intendedDist: null, note: null };
    }
  } catch (err) {
    intent = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : {
      by: '(unreadable)',
      at: '(unreadable)',
      intendedHead: null,
      intendedDist: null,
      note: null
    };
  }
  const consumeError = consumeIntent(intentFile, consumedFile);

  const previous = readLastRecord(ledgerFile);
  const record: DeployRecord = {
    at: now.toISOString(),
    pid: opts.pid ?? process.pid,
    start: classifyStart(previous?.build ?? null, build),
    gate: judgeGate(intent, build, now.getTime()),
    build,
    by: null,
    previousAt: previous?.at ?? null,
    consumeError
  };
  record.by = record.gate.kind === 'gated' ? record.gate.by : null;

  try {
    appendBounded(ledgerFile, JSON.stringify(record), opts.maxLines ?? LEDGER_MAX_LINES);
  } catch {
    // See the docblock: an unwritable ledger must not be an unstartable daemon.
  }
  return record;
}

/** One line for `daemon.log`, whatever the verdict. */
export function summariseRecord(record: DeployRecord): string {
  const gate =
    record.gate.kind === 'gated'
      ? `gated by ${record.gate.by} (pinned ${record.gate.pinned.join('+')})`
      : `UNGATED (${record.gate.because})`;
  return (
    `deploy ledger: start classified ${record.start.kind}, ${gate}; ` +
    `head ${record.build.head?.slice(0, 12) ?? '(none)'}, ` +
    `dist ${record.build.dist.digest?.slice(0, 12) ?? '(unreadable)'} ` +
    `(${record.build.dist.fileCount} files)`
  );
}
