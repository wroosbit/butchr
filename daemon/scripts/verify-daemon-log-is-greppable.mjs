// daemon.log has to look like text to `grep`, because that is the only way
// anybody reads it. KAN-422.
//
// WHAT FAILURE THIS WOULD CATCH: a non-text byte in daemon.log making every
// `grep` of that file answer "no matches" for lines that are present — the
// failure that had `task/KAN-417`, `task/KAN-435` and `epic/KAN-39` each one
// step from recording an absence that was not there. Concretely it catches
// (a) the startup repair ceasing to fire, so damage left by an unclean
// shutdown stays in the file, and (b) the logger's sanitiser ceasing to fire,
// so a future caller logging a captured buffer poisons the log. It equally
// catches the repair firing but corrupting the file: §3 requires the repaired
// bytes to be identical outside the damaged runs and the line count to be
// unchanged, so a repair that "fixes" the log by rewriting it fails as loudly
// as one that does nothing.
//
// CI-RUNNABLE: yes — builds its fixtures in a temp directory and asserts
// against the built daemon modules in process. No live daemon, no herdr, no
// credential, no peer, no terminal, no network.
//
// ⚠ THIS SCRIPT SUPPLIES ITS OWN INPUT, and that leaves a real hole. §1–§4
// construct a damaged log and repair it; none of them exercises an unclean
// shutdown actually producing the damage, and none of them proves the running
// daemon calls the repair at all. The second half of that is covered here, by
// §5, which reads `daemon/src/daemon.ts` as text and asserts the wiring. The
// first half is not covered by any script and is not cheaply coverable — a
// power cut is not a fixture. It is covered instead by an observation of the
// real 5 MB log pasted into the PR body, and by the five real NUL runs the
// ticket's investigation found in it, each sitting immediately before a
// daemon startup line.
//
// ⚠ MIXED SOURCE, so read the section and not the exit code after a failed
// build: §1–§4 and §6 import from `dist/`, §5 reads `src/` as text. After a
// build failure the dist sections silently test the previous build while §5
// still tests what you wrote.
//
// Usage: node daemon/scripts/verify-daemon-log-is-greppable.mjs [distDir]

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');
const srcDir = path.join(scriptDir, '..', 'src');

const { repairLogFile, sanitizeLogText, hasNonTextBytes, DaemonLog } = await import(
  path.join(distDir, 'log-file.js')
);

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan422-'));
const NEEDLE = 'Client connected';

/** Write one fixture log into the temp directory and hand back its path. */
function fixture(name, bytes) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * A log that looks like the real one: many ordinary lines, one of which is the
 * line a reader will search for.
 */
function buildLog(lines = 400) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(`[2026-08-14T12:00:${String(i % 60).padStart(2, '0')}.000Z] routine line ${i}`);
    if (i === 200) out.push(`[2026-08-14T12:03:31.743Z] ${NEEDLE} (1 total)`);
  }
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}

/**
 * What an agent's search actually returns. Both grep implementations on this
 * fleet hide matches in a binary file; they differ only in how loudly. GNU
 * grep prints `binary file matches` on **stderr** and exits 0; the agent-facing
 * wrapper runs bundled ugrep with `-I` and prints nothing at all, exit 1. The
 * property they share — and the one that misleads a reader — is that **stdout
 * carries no matching lines**, so that is what is asserted.
 */
function grepStdoutLines(file, needle) {
  const r = spawnSync('grep', ['-F', needle, file], { encoding: 'utf8' });
  if (r.error) return { unavailable: true, lines: 0, status: null, stderr: String(r.error) };
  const lines = r.stdout ? r.stdout.split('\n').filter((l) => l.length > 0).length : 0;
  return { unavailable: false, lines, status: r.status, stderr: (r.stderr || '').trim() };
}

console.log('§1 positive control: the instrument can find the line when the file is clean');
const cleanPath = fixture('clean.log', buildLog());
const cleanGrep = grepStdoutLines(cleanPath, NEEDLE);
if (cleanGrep.unavailable) {
  ok('grep is available to this script', false, cleanGrep.stderr);
} else {
  ok('grep finds the needle in a clean log', cleanGrep.lines === 1, `stdout lines=${cleanGrep.lines}`);
  ok(
    'and reports success',
    cleanGrep.status === 0,
    `exit=${cleanGrep.status}`
  );
}
ok('clean log holds no non-text bytes', !hasNonTextBytes(fs.readFileSync(cleanPath)));

console.log('');
console.log('§2 reproduce the defect: the tail of an append lost to an unclean shutdown');
// This is what ext4 delayed allocation leaves behind: the inode size is
// durable, the data is not, and the difference reads back as NUL. In the real
// log every one of the five runs sits immediately before the daemon's first
// line of the next boot, which is exactly where this puts it.
const base = buildLog();
const splice = base.indexOf(Buffer.from('routine line 300'));
const damaged = Buffer.concat([
  base.subarray(0, splice),
  Buffer.alloc(354, 0),
  base.subarray(splice)
]);
const damagedPath = fixture('damaged.log', damaged);
ok('damaged log holds non-text bytes', hasNonTextBytes(damaged));
const damagedGrep = grepStdoutLines(damagedPath, NEEDLE);
const defectReproduced = !damagedGrep.unavailable && damagedGrep.lines === 0;
ok(
  'grep now returns NO matching lines for a line that is present',
  defectReproduced,
  `stdout lines=${damagedGrep.lines}, exit=${damagedGrep.status}` +
    (damagedGrep.stderr ? `, stderr=${JSON.stringify(damagedGrep.stderr)}` : ', stderr empty')
);
ok(
  'the needle is genuinely still in the file (read as bytes)',
  fs.readFileSync(damagedPath).includes(NEEDLE),
  'so the zero above is the instrument, not the world'
);

console.log('');
console.log('§3 the repair heals it, and does not damage anything else');
const repairedPath = fixture('repaired.log', damaged);
const result = repairLogFile(repairedPath);
const repairedBuf = fs.readFileSync(repairedPath);
ok('repair reports it acted', result.repaired === true, JSON.stringify(result));
ok('and counts the damage', result.runs === 1 && result.bytes === 354, JSON.stringify(result));
ok('repaired log holds no non-text bytes', !hasNonTextBytes(repairedBuf));
const repairedGrep = grepStdoutLines(repairedPath, NEEDLE);
ok(
  'grep finds the line again',
  !repairedGrep.unavailable && repairedGrep.lines === 1,
  `stdout lines=${repairedGrep.lines}, exit=${repairedGrep.status}`
);
const countNewlines = (b) => {
  let n = 0;
  for (const byte of b) if (byte === 0x0a) n++;
  return n;
};
ok(
  'line numbering is unchanged',
  countNewlines(repairedBuf) === countNewlines(damaged),
  `${countNewlines(damaged)} -> ${countNewlines(repairedBuf)}`
);
ok('the damage is described in the file', repairedBuf.includes('[log-repair:'));
ok(
  'and the marker says how much was lost',
  repairedBuf.includes('354 bytes lost'),
  'a marker that does not say the size hides the size of the hole'
);
ok(
  'the file is exactly the same length as before',
  repairedBuf.length === damaged.length,
  `${damaged.length} -> ${repairedBuf.length}; equal length is what lets the repair skip the ` +
    'rename that would orphan another daemon\'s open handle (§7)'
);
// Everything outside the damaged run must survive byte-for-byte. Compare the
// two halves either side of the splice against the undamaged original.
const head = repairedBuf.subarray(0, splice);
ok('bytes before the damage are identical', head.equals(base.subarray(0, splice)));
const tailLen = base.length - splice;
ok(
  'bytes after the damage are identical',
  repairedBuf.subarray(repairedBuf.length - tailLen).equals(base.subarray(splice)),
  'a repair that rewrites the log is as bad as one that does nothing'
);
ok(
  'and they are at the same offsets they were at before',
  repairedBuf.subarray(splice + 354).equals(damaged.subarray(splice + 354)),
  'byte offsets into this file stay meaningful, not just line numbers'
);

console.log('');
console.log('§4 the write path cannot introduce the byte in the first place');
const writtenPath = path.join(workDir, 'written.log');
const dlog = DaemonLog.open(writtenPath);
// Real control characters, spelled as escapes so this file itself stays text —
// a source file with a raw NUL in it is the same defect one level up, and it
// makes every grep of the script skip it. `\x00` and `\x1b` below ARE the
// bytes; the assertions further down look for the two-character escape the
// sanitiser is expected to emit in their place.
dlog.append(`[2026-08-14T12:00:00.000Z] pane bytes: \x00\x1b[31mred\x1b[0m\tkept\n`);
dlog.append(`[2026-08-14T12:00:01.000Z] ${NEEDLE} (2 total)\n`);
await new Promise((r) => setTimeout(r, 50));
const written = fs.readFileSync(writtenPath);
ok('a log written through DaemonLog holds no non-text bytes', !hasNonTextBytes(written));
ok(
  'the escape is visible rather than the byte silently dropped',
  written.includes('\\x00') && written.includes('\\x1b'),
  'positive control: the sanitiser fired, it did not merely receive nothing'
);
ok('tab is kept verbatim', written.includes('\tkept'), 'stack traces align with tabs');
ok('newline is kept verbatim', countNewlines(written) === 2);
const writtenGrep = grepStdoutLines(writtenPath, NEEDLE);
ok(
  'grep finds a line in a log that carried a NUL on the way in',
  !writtenGrep.unavailable && writtenGrep.lines === 1,
  `stdout lines=${writtenGrep.lines}`
);
ok(
  'sanitizeLogText leaves clean text untouched',
  sanitizeLogText('[ts] ordinary line\n') === '[ts] ordinary line\n'
);

console.log('');
console.log('§5 STATIC (reads src, unaffected by a failed build): the daemon is wired to it');
const daemonSrc = fs.readFileSync(path.join(srcDir, 'daemon.ts'), 'utf8');
ok(
  "daemon.ts opens the log through DaemonLog.open",
  /DaemonLog\.open\(\s*path\.join\(BUTCHR_DIR,\s*'daemon\.log'\)\s*\)/.test(daemonSrc),
  'repair runs only if this is how the log is opened'
);
ok(
  'and no longer opens daemon.log as a bare write stream',
  !/createWriteStream\([^)]*daemon\.log/.test(daemonSrc),
  'a second, unsanitised handle would reintroduce the hazard'
);
ok(
  "the logger appends through DaemonLog rather than to a raw stream",
  /daemonLog\.append\(/.test(daemonSrc) && !/logStream\.write\(/.test(daemonSrc)
);
ok(
  'positive control for this section',
  /console\.log = log;/.test(daemonSrc),
  'a pattern known to be in daemon.ts — if this fails, the section read the wrong file'
);

console.log('');
console.log('§7 a repair does not orphan another daemon\'s already-open append handle');
// Raised by epic/KAN-39 reviewing #193. `daemon.ts` opens this log at module
// load; it discovers that another daemon is already running ~1900 lines later,
// on EADDRINUSE. `connectToDaemon` documents a spawn race where two daemons
// briefly coexist. So BOTH repair, and both repair before either knows the
// other exists — and a repair that renames a new inode into place swaps it
// under the other daemon's open handle, sending every line it logs afterwards
// to an orphaned inode. That is this ticket's own failure mode, inverted.
//
// This section reproduces exactly that shape: hold an append handle across a
// repair, then write through it. It FAILS against a rename-based repair and
// passes against the in-place one.
const racePath = fixture('race.log', damaged);
const holder = fs.openSync(racePath, 'a');
const raceResult = repairLogFile(racePath);
fs.writeSync(holder, Buffer.from(`[2026-08-14T12:09:00.000Z] ${NEEDLE} (after repair)\n`, 'utf8'));
fs.closeSync(holder);
const raceBuf = fs.readFileSync(racePath);
ok('the repair acted', raceResult.repaired === true, JSON.stringify(raceResult));
ok(
  'a line written through the pre-existing handle is IN the file on disk',
  raceBuf.includes('(after repair)'),
  'under a rename-based repair this line goes to an orphaned inode and vanishes silently'
);
ok('and the repaired region is still repaired', !hasNonTextBytes(raceBuf));
ok(
  'positive control: the handle really was opened before the repair ran',
  raceResult.runs === 1,
  'if the repair had found nothing, this section would prove nothing'
);
// Two daemons repairing the same damage concurrently must be idempotent, not
// racy — same bytes, same offsets, no new inode.
const twicePath = fixture('twice.log', damaged);
const first = repairLogFile(twicePath);
const afterFirst = fs.readFileSync(twicePath);
const second = repairLogFile(twicePath);
const afterSecond = fs.readFileSync(twicePath);
ok('a second repair finds nothing left to do', second.repaired === false, JSON.stringify(second));
ok('and the file is unchanged by it', afterFirst.equals(afterSecond), `first=${JSON.stringify(first)}`);

console.log('');
console.log('§6 red drive: the §3 assertions can be false');
// A check that cannot fail is not a check. Run §3's two decisive assertions
// against the file as it was BEFORE the repair and require both to fail.
const unrepaired = fs.readFileSync(damagedPath);
const wouldPassOnDamaged =
  !hasNonTextBytes(unrepaired) && grepStdoutLines(damagedPath, NEEDLE).lines === 1;
ok(
  'the same assertions applied to the unrepaired file FAIL',
  wouldPassOnDamaged === false,
  'so §3 going green means the repair acted, not that the assertions are vacuous'
);

fs.rmSync(workDir, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL (${failures} assertion(s))`);
process.exit(failures ? 1 : 0);
