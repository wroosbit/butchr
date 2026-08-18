import * as fs from 'fs';
/**
 * Bytes that make a file "binary" to grep: the C0 controls and DEL, less the
 * two that are ordinary in a log. `\n` terminates a line and `\t` is used for
 * alignment inside stack traces, so both are kept verbatim.
 */
// eslint-disable-next-line no-control-regex
const NON_TEXT = /[\x00-\x08\x0b-\x1f\x7f]/g;
const escapeByte = (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
/**
 * Render `text` so that every byte in it is safe to append to the log.
 *
 * Escaping rather than stripping, because the whole reason this file exists is
 * that a reader was told something was absent when it was present. A dropped
 * byte is a smaller lie of the same kind; `\x00` is visible, greppable, and
 * says what was there.
 */
export function sanitizeLogText(text) {
    return text.replace(NON_TEXT, escapeByte);
}
/** True when `buf` holds a byte that would make grep treat the file as binary. */
export function hasNonTextBytes(buf) {
    for (const b of buf) {
        if (b === 0x0a || b === 0x09)
            continue;
        if (b < 0x20 || b === 0x7f)
            return true;
    }
    return false;
}
const CLEAN = { repaired: false, runs: 0, bytes: 0 };
/**
 * The marker written over a run of `length` non-text bytes.
 *
 * **It is exactly `length` bytes long, and that is a correctness requirement
 * rather than a nicety** — see {@link repairLogFile}. Padded with dots when
 * the sentence is shorter than the damage and shortened when it is longer; the
 * daemon's own startup line carries the full count either way, so a marker
 * truncated by a very short run loses nothing that is recorded only here.
 */
function repairMarker(length) {
    const full = `[log-repair: ${length} bytes lost to an unclean shutdown]`;
    const short = `[lost ${length}B]`;
    const text = full.length <= length
        ? full.padEnd(length, '.')
        : short.length <= length
            ? short.padEnd(length, '.')
            : '.'.repeat(length);
    const buf = Buffer.from(text, 'ascii');
    // Guaranteed by the ladder above; asserted because the whole design rests on
    // it and a silent off-by-one here would change the file's length.
    if (buf.length !== length)
        throw new Error(`marker is ${buf.length} bytes, needed ${length}`);
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
export function repairLogFile(file) {
    let buf;
    try {
        buf = fs.readFileSync(file);
    }
    catch (e) {
        // No log yet is the ordinary first-run case, and not a problem.
        if (e?.code === 'ENOENT')
            return CLEAN;
        return { ...CLEAN, error: `could not read ${file}: ${e?.message ?? String(e)}` };
    }
    if (!hasNonTextBytes(buf))
        return CLEAN;
    const offending = (b) => b !== 0x0a && b !== 0x09 && (b < 0x20 || b === 0x7f);
    // Locate every run first, and only then write. Nothing touches the file
    // until each patch has been built and checked.
    const patches = [];
    let bytes = 0;
    let i = 0;
    while (i < buf.length) {
        if (!offending(buf[i])) {
            i++;
            continue;
        }
        const start = i;
        while (i < buf.length && offending(buf[i]))
            i++;
        const length = i - start;
        let marker;
        try {
            marker = repairMarker(length);
        }
        catch (e) {
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
    let fd;
    try {
        fd = fs.openSync(file, 'r+');
    }
    catch (e) {
        return { repaired: false, runs: 0, bytes: 0, error: `could not open ${file}: ${e?.message ?? String(e)}` };
    }
    try {
        for (const p of patches) {
            fs.writeSync(fd, p.marker, 0, p.marker.length, p.offset);
        }
    }
    catch (e) {
        return { repaired: false, runs: 0, bytes: 0, error: `could not repair ${file}: ${e?.message ?? String(e)}` };
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch {
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
    file;
    repair;
    stream;
    constructor(file, repair) {
        this.file = file;
        this.repair = repair;
        this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
    /**
     * Heal any damage left behind since last time, then open for append. Repair
     * happens before the stream exists, so nothing is appended to a file that is
     * about to be rewritten underneath it.
     */
    static open(file) {
        return new DaemonLog(file, repairLogFile(file));
    }
    /** The single place bytes reach the log. */
    writeSafeLine(line) {
        this.stream.write(line);
    }
    /** Append `text` as one log entry, escaped so the file stays greppable. */
    append(text) {
        this.writeSafeLine(sanitizeLogText(text));
    }
}
