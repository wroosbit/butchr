import * as fs from 'fs';

/**
 * `daemon.log` is the fleet's primary diagnostic artifact, and almost nothing
 * reads it as bytes — agents shell out to `grep`, sent there by three briefs,
 * four documents and the extension's own error copy. That makes one property
 * of the file load-bearing in a way its format never was: **it has to look
 * like text to `grep`.**
 *
 * A single NUL byte anywhere in a 5 MB file is enough to lose that. What
 * follows is measured on this machine's real log (KAN-422), not reasoned:
 *
 * ```
 * grep -F  'Client connected' daemon.log   ->  nothing, exit 1
 * grep -aF 'Client connected' daemon.log   ->  2082 lines
 * ```
 *
 * The agent-facing `grep` is worse than the classic "Binary file … matches":
 * it is a wrapper around bundled ugrep carrying `-I` (*ignore binary files*),
 * so the file is skipped in silence and the search exits 1. Exit 1 is *no
 * matches found*. There is no message, on stdout or stderr, that a reader
 * could notice. GNU grep at least prints `binary file matches` on **stderr**
 * and exits 0 — which is invisible to `$(...)` capture and to any pipeline
 * reading stdout.
 *
 * So the failure direction is always the comfortable one, **absence**: an
 * agent asking "did this ever happen?" is told no. Three agents (KAN-417,
 * KAN-435, KAN-39) reached that answer and caught it by hand. This module is
 * the mechanism that means the fourth does not have to.
 *
 * There are two ways a non-text byte gets into the file, and they need
 * different answers:
 *
 * 1. **The writer emits one.** Nothing in the daemon does this today —
 *    measured: across 36,271 lines of the real log there is not one ESC byte
 *    and not one C0 control character. The comment in
 *    `verify-crabcast-claude-launcher-live.mjs` attributing the zero to "raw
 *    pane bytes" is an inference from the symptom, and it is wrong; no pane
 *    bytes reach this file. But `console.log` is redirected here for the whole
 *    daemon, so *any* future code that logs a captured buffer would poison it.
 *    {@link sanitizeLogText} closes that, and the {@link TextSafeLogLine}
 *    brand is what stops a new write path from skipping the call: the
 *    unsanitised string is not something {@link DaemonLog.writeSafeLine} can
 *    be handed.
 *
 * 2. **Something outside the writer puts one there.** This is what actually
 *    happened, five times. Every NUL run in the real log sits immediately
 *    before a `PATH resolved to:` line — the daemon's first line at startup —
 *    and the most recent one falls exactly in the gap between two boots
 *    (`boot -1` ended 05:00:57 PDT, `boot 0` began 05:01:50; the log's own
 *    gap is 05:00:14 → 05:02:07) with no `shutdown` record between them. That
 *    is ext4 delayed allocation losing the tail of an appended file across an
 *    unclean shutdown: the inode size is durable, the data is not, and the
 *    difference reads back as NUL. The file is not sparse, so the zeros are
 *    really on disk.
 *
 *    No write-path guard can prevent that, because the daemon was not running
 *    when it happened. {@link repairLogFile} is the answer instead: heal the
 *    damage at startup, which is the first moment anything can, and say in the
 *    file itself that bytes were lost rather than papering over it.
 */

/**
 * A string that has been through {@link sanitizeLogText} and therefore cannot
 * make `grep` classify the log as binary.
 *
 * The brand is the point. An assertion that the logger sanitises can be
 * deleted by a later author and everything still compiles; a write path that
 * skips {@link sanitizeLogText} **cannot be written at all**, because
 * {@link DaemonLog.writeSafeLine} accepts nothing else.
 */
export type TextSafeLogLine = string & { readonly __textSafe: unique symbol };

/**
 * Bytes that make a file "binary" to grep: the C0 controls and DEL, less the
 * two that are ordinary in a log. `\n` terminates a line and `\t` is used for
 * alignment inside stack traces, so both are kept verbatim.
 */
// eslint-disable-next-line no-control-regex
const NON_TEXT = /[\x00-\x08\x0b-\x1f\x7f]/g;

const escapeByte = (c: string) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;

/**
 * Render `text` so that every byte in it is safe to append to the log.
 *
 * Escaping rather than stripping, because the whole reason this file exists is
 * that a reader was told something was absent when it was present. A dropped
 * byte is a smaller lie of the same kind; `\x00` is visible, greppable, and
 * says what was there.
 */
export function sanitizeLogText(text: string): TextSafeLogLine {
  return text.replace(NON_TEXT, escapeByte) as TextSafeLogLine;
}

/** True when `buf` holds a byte that would make grep treat the file as binary. */
export function hasNonTextBytes(buf: Buffer): boolean {
  for (const b of buf) {
    if (b === 0x0a || b === 0x09) continue;
    if (b < 0x20 || b === 0x7f) return true;
  }
  return false;
}

export interface LogRepairResult {
  /** Whether anything was rewritten. */
  repaired: boolean;
  /** Number of contiguous runs of non-text bytes that were replaced. */
  runs: number;
  /** Total non-text bytes replaced. */
  bytes: number;
  /** Set when repair was needed but could not be done; the daemon logs it and carries on. */
  error?: string;
}

const CLEAN: LogRepairResult = { repaired: false, runs: 0, bytes: 0 };

/**
 * The marker written over a run of `length` non-text bytes.
 *
 * **It is exactly `length` bytes long, and that is a correctness requirement
 * rather than a nicety** — see {@link repairLogFile}. Padded with dots when
 * the sentence is shorter than the damage and shortened when it is longer; the
 * daemon's own startup line carries the full count either way, so a marker
 * truncated by a very short run loses nothing that is recorded only here.
 */
function repairMarker(length: number): Buffer {
  const full = `[log-repair: ${length} bytes lost to an unclean shutdown]`;
  const short = `[lost ${length}B]`;
  const text =
    full.length <= length
      ? full.padEnd(length, '.')
      : short.length <= length
        ? short.padEnd(length, '.')
        : '.'.repeat(length);
  const buf = Buffer.from(text, 'ascii');
  // Guaranteed by the ladder above; asserted because the whole design rests on
  // it and a silent off-by-one here would change the file's length.
  if (buf.length !== length) throw new Error(`marker is ${buf.length} bytes, needed ${length}`);
  return buf;
}

/**
 * Overwrite every run of non-text bytes in `file` with a visible marker of the
 * **same length**, in place, and report what was done.
 *
 * ## Why in place, and why the same length
 *
 * The obvious implementation writes a new file and renames it over the old
 * one. That is wrong here, and the way it is wrong is this ticket's own
 * failure mode arriving from the other side.
 *
 * `daemon.ts` opens this log at module load, long before it discovers whether
 * another daemon is already running — that check is an `EADDRINUSE` on
 * `server.listen`, some two thousand lines later. `connectToDaemon` documents
 * a spawn race in which two daemons briefly coexist and the loser exits on
 * finding the winner's socket. **So both of them repair, and both of them
 * repair before either knows the other exists.** With a rename, the second
 * one to finish swaps a new inode under the first one's already-open append
 * handle, and every line the first daemon logs from then on goes to an
 * orphaned inode and is silently lost. If the winner is the one holding the
 * stale handle, that is the entire log for the life of that daemon —
 * fabricated absence, produced by the thing meant to prevent it.
 *
 * Writing the same number of bytes back over the same offsets removes the
 * class rather than narrowing it: there is no new inode, so no handle can be
 * orphaned; appends land at an unchanged EOF; and two daemons repairing the
 * same damage concurrently write identical bytes to identical offsets, which
 * is idempotent rather than racy. It needs no lock and no temporary file.
 *
 * ## What is preserved
 *
 * Stronger than the rename version managed, and worth stating because several
 * scripts cite this file by position:
 *
 * - **Byte offsets are unchanged** — the file's length is identical, so every
 *   offset into it still means what it meant.
 * - **Line numbering is unchanged** — the bytes replaced never include `\n`,
 *   and no marker contains one.
 * - **Everything outside the damaged runs is byte-for-byte identical.**
 */
export function repairLogFile(file: string): LogRepairResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e: any) {
    // No log yet is the ordinary first-run case, and not a problem.
    if (e?.code === 'ENOENT') return CLEAN;
    return { ...CLEAN, error: `could not read ${file}: ${e?.message ?? String(e)}` };
  }

  if (!hasNonTextBytes(buf)) return CLEAN;

  const offending = (b: number) => b !== 0x0a && b !== 0x09 && (b < 0x20 || b === 0x7f);

  // Locate every run first, and only then write. Nothing touches the file
  // until each patch has been built and checked.
  const patches: { offset: number; marker: Buffer }[] = [];
  let bytes = 0;
  let i = 0;
  while (i < buf.length) {
    if (!offending(buf[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < buf.length && offending(buf[i])) i++;
    const length = i - start;
    let marker: Buffer;
    try {
      marker = repairMarker(length);
    } catch (e: any) {
      return { repaired: false, runs: 0, bytes: 0, error: `${e?.message ?? String(e)}; file untouched` };
    }
    patches.push({ offset: start, marker });
    bytes += length;
  }

  // Guaranteed by construction. Asserted anyway, because the cost of being
  // wrong is a corrupted diagnostic log, and because a repair that declines to
  // act is strictly better than one that acts badly.
  for (const p of patches) {
    if (hasNonTextBytes(p.marker)) {
      return { repaired: false, runs: 0, bytes: 0, error: 'marker holds non-text bytes; file untouched' };
    }
    if (p.marker.includes(0x0a)) {
      return { repaired: false, runs: 0, bytes: 0, error: 'marker holds a newline; file untouched' };
    }
  }

  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch (e: any) {
    return { repaired: false, runs: 0, bytes: 0, error: `could not open ${file}: ${e?.message ?? String(e)}` };
  }
  try {
    for (const p of patches) {
      fs.writeSync(fd, p.marker, 0, p.marker.length, p.offset);
    }
  } catch (e: any) {
    return { repaired: false, runs: 0, bytes: 0, error: `could not repair ${file}: ${e?.message ?? String(e)}` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* closing a descriptor we are done with is best-effort */
    }
  }

  return { repaired: true, runs: patches.length, bytes };
}

/**
 * The daemon's append-only handle on `daemon.log`.
 *
 * Its only write method takes a {@link TextSafeLogLine}, so the sanitising
 * step is not something a caller can forget: skipping it is a type error
 * rather than a silently poisoned log.
 */
export class DaemonLog {
  private readonly stream: fs.WriteStream;

  private constructor(
    readonly file: string,
    readonly repair: LogRepairResult
  ) {
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  /**
   * Heal any damage left behind since last time, then open for append. Repair
   * happens before the stream exists, so nothing is appended to a file that is
   * about to be rewritten underneath it.
   */
  static open(file: string): DaemonLog {
    return new DaemonLog(file, repairLogFile(file));
  }

  /** The single place bytes reach the log. */
  private writeSafeLine(line: TextSafeLogLine): void {
    this.stream.write(line);
  }

  /** Append `text` as one log entry, escaped so the file stays greppable. */
  append(text: string): void {
    this.writeSafeLine(sanitizeLogText(text));
  }
}
