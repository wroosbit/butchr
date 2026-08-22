// Proof for KAN-267: the two ways a /proc/pressure reading can produce no
// figure are told apart, in the type and in the sentence an operator reads.
//
// WHAT FAILURE THIS WOULD CATCH: a machine whose /proc/pressure files are
// PRESENT and cannot be read being reported, in words, as a machine whose
// kernel has no PSI. That is what `main` did before this ticket: `readPressureFull`
// caught every failure and returned the same `null` for ENOENT and for EACCES,
// so the derivation printed "no /proc/pressure on this machine (needs Linux
// 4.20+ with CONFIG_PSI)" at somebody whose problem was a permission, a
// container namespace or a truncated read — sending them to rebuild a kernel
// that was never the matter.
//
// IT REFUSES NOTHING AND CHANGES NO NUMBER, which is why it needs a proof of
// its own. `headroom`, `stalled`, `atCapacity` and `stallPercent` are all
// IDENTICAL between the two cases and are all CORRECT in both — by decision,
// recorded on KAN-267: an unreadable pressure file is not evidence of the
// saturation this term measures (a /proc read fetches nothing from the block
// layer, measured 2026-08-22 over 200,000 reads), and refusing on one would
// wedge the whole fleet on a permissions problem. So every assertion about
// admission passes in both worlds, and the only thing that separates them is
// the account given. That is the assertion this file exists to make.
//
// CI-RUNNABLE: yes — fixture files in a temp directory driven through the real
// reader and the real `computeCapacity`, in process. No daemon, no herdr, no
// PTY, no credential, and nothing about this host's own /proc/pressure: a
// runner without PSI at all runs this section exactly as a developer machine
// does, because both fixtures are built rather than found.
//
// HOW TO WATCH IT GO RED — TWO WAYS, AND THE SECOND IS THE ONE THAT MATTERS:
//
//   1. Re-collapse the branch. In daemon/src/capacity.ts, delete the ENOENT arm
//      of readPressureFull's catch so every caught error returns
//        { state: 'absent', detail: ... }
//      cd daemon && npm run build && node scripts/verify-pressure-absence-is-told-apart.mjs
//      -> RED. Then `git checkout src/capacity.ts && npm run build`.
//
//   2. Point it at a build of the code as it was BEFORE this ticket, which is
//      the comparison the ticket asked for. This script takes the dist
//      directory as its first argument for exactly that:
//
//        git -C ~/code/<org>/<repo> worktree add --detach /tmp/psi-baseline <MERGE-BASE>
//        cd /tmp/psi-baseline && node ~/code/wroosbit/butchr/daemon/scripts/link-workspace-deps.mjs
//        cd daemon && npm run build
//        node <this-script> /tmp/psi-baseline/daemon/dist
//
//      Measured 2026-08-22 against origin/main at ee02130, on a machine whose
//      two pressure files existed and could not be read:
//
//        readStallFacts()  : {"ioFullPercent":null,"memoryFullPercent":null}
//        stallInstrument   : (no such field on that build)
//        io/memory stall: no /proc/pressure on this machine (needs Linux 4.20+
//        with CONFIG_PSI), so this term is inert ...
//
//      -> exit 1. The same command against this branch's dist exits 0. The
//      baseline arm is documented rather than run here because it needs a
//      second checkout and a second build, which is not a thing CI should do
//      on every push; section 7 of verify-io-stall-gate.mjs mechanises the
//      same collapse in-process, on every run, and needs no baseline at all.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED:
// both machines below are built here — this file writes the fixture directories
// and hands `computeCapacity` the facts read out of them. So it shows that the
// derivation SAYS the right thing about a reading, and it does NOT show that a
// real unreadable /proc/pressure produces that reading on a real machine. That
// seam is covered next door: verify-io-stall-gate.mjs §1 asserts the field
// arrives from this host's own /proc/pressure through readMachineFacts(). What
// is covered by NEITHER, and is named here rather than left to be inferred:
// nobody has observed a production machine whose /proc/pressure was present and
// unreadable. The EISDIR and EACCES fixtures are the shape of that fault, not
// an instance of it, and no script can supply one.
//
// Usage:
//   cd daemon && npm run build && node scripts/verify-pressure-absence-is-told-apart.mjs
//   node scripts/verify-pressure-absence-is-told-apart.mjs <other-dist-dir>

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(
  process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) ??
    path.join(scriptDir, '..', 'dist')
);

const { computeCapacity, describeCapacity, readStallFacts, GIB } = await import(
  path.join(distDir, 'capacity.js')
);
const { reportAndExit } = await import('./lib/verdict-exit.mjs');

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan267-'));
console.log(`dist under test: ${distDir}\n`);

// ── the two machines ───────────────────────────────────────────────────────
// Identical in every respect a counting term can see. They differ in one thing:
// whether the two pressure files are there.

// ABSENT: an empty directory. A pre-4.20 kernel, CONFIG_PSI off, or not Linux.
const absentRoot = path.join(tmp, 'absent');
fs.mkdirSync(absentRoot, { recursive: true });

// UNREADABLE: both paths exist and neither can be read. Directories rather than
// `chmod 000` on purpose — a 0o000 file is readable to root, and enough of this
// fleet's CI runs as uid 0 that an EACCES fixture would quietly degrade into a
// readable-file fixture on exactly the hosts nobody watches. EISDIR is refused
// to every uid there is.
const unreadableRoot = path.join(tmp, 'unreadable');
fs.mkdirSync(path.join(unreadableRoot, 'io'), { recursive: true });
fs.mkdirSync(path.join(unreadableRoot, 'memory'), { recursive: true });

const roomy = (stall) => ({
  cores: 16,
  totalBytes: 64 * GIB,
  availableBytes: 60 * GIB,
  load1: 0.2,
  busyCores: 0.5,
  busyWindowSeconds: 5,
  stall
});

const machines = {};
for (const [name, root] of [['absent', absentRoot], ['unreadable', unreadableRoot]]) {
  const stall = readStallFacts(root);
  const capacity = computeCapacity(roomy(stall), 0, { measured: null });
  const said = describeCapacity(capacity)
    .split('\n')
    .find((l) => l.startsWith('io/memory stall:'));
  machines[name] = { stall, capacity, said };
  console.log(`── ${name} ──`);
  console.log(`  readStallFacts()  ${JSON.stringify(stall)}`);
  console.log(`  stallInstrument   ${capacity.stallInstrument ?? '(no such field on this build)'}`);
  console.log(`  headroom          ${capacity.headroom} (stalled: ${capacity.stalled})`);
  console.log(`  says              ${said}\n`);
}

const { absent, unreadable } = machines;

// 1. THE DECISION IS THE SAME. Asserted first and deliberately, because it is
//    what makes the rest of this file necessary: if the two cases differed in
//    admission, an ordinary capacity assertion would already separate them and
//    nothing here would be load-bearing.
verdict(
  absent.capacity.headroom === unreadable.capacity.headroom &&
    absent.capacity.stalled === false &&
    unreadable.capacity.stalled === false &&
    absent.capacity.atCapacity === unreadable.capacity.atCapacity &&
    absent.capacity.stallPercent === null &&
    unreadable.capacity.stallPercent === null,
  'both machines are admitted, identically, and neither is refused — the KAN-267\n' +
    '    decision. An instrument that did not answer refuses nothing, whichever way it\n' +
    '    failed to answer, so refusing here could never wedge the fleet on a permission.',
  'the two cases reached different admission decisions, or one of them refused: ' +
    `absent headroom ${absent.capacity.headroom} stalled ${absent.capacity.stalled}, ` +
    `unreadable headroom ${unreadable.capacity.headroom} stalled ${unreadable.capacity.stalled}. ` +
    'Refusing on an unreadable pressure file wedges every agent on this machine behind a ' +
    'permissions problem, and it refuses on something KAN-267 measured is not evidence of ' +
    'saturation at all.'
);

// 2. THE ACCOUNT IS NOT. This is the whole ticket.
verdict(
  absent.said !== unreadable.said,
  'the two are told apart in the sentence an operator actually reads. Same numbers,\n' +
    '    different account — which is the only place the difference can live, given 1.',
  'a machine whose /proc/pressure is PRESENT and unreadable is given the identical ' +
    'sentence as one whose kernel has no PSI. That is the KAN-267 defect: the reading is ' +
    'a single null, and one null cannot tell a caller which of the two it is looking at.'
);

// 3. AND THE ACCOUNT IS NOT MERELY DIFFERENT — IT IS TRUE. A distinct sentence
//    that still claims the files are missing would pass 2 and help nobody.
verdict(
  unreadable.said !== undefined && !/no \/proc\/pressure on this machine/.test(unreadable.said),
  'and the unreadable machine is not told it has no /proc/pressure. It has one — that\n' +
    '    is the premise of the case — so the absent sentence would be a false statement\n' +
    '    about the machine, and it is the one that sends a reader to check CONFIG_PSI.',
  'the derivation told a machine that HAS /proc/pressure that it has none: ' +
    `"${unreadable.said}"`
);

// 4. Both must still name the hole. The distinction is not an excuse to soften
//    either sentence: whichever way the instrument went quiet, nothing is
//    bounding I/O saturation on that machine and the report says so.
const namesTheHole = (line) =>
  line !== undefined && /nothing here bounds|bounded by nothing/.test(line);
verdict(
  namesTheHole(absent.said) && namesTheHole(unreadable.said),
  'and BOTH still say what is left unprotected. Telling the two apart is not a licence\n' +
    '    to soften either: a mute instrument is the same hole whichever way it went mute,\n' +
    '    and a gate that is silent when it is inert is one a reader assumes is protecting\n' +
    '    them (KAN-218).',
  'a machine with no working stall instrument was not told that nothing bounds I/O ' +
    `saturation on it. absent: "${absent.said}" / unreadable: "${unreadable.said}"`
);

// 5. No unmeasured reading carries a figure. The type says this cannot happen;
//    this says it did not, on a real read of a real file, which is the half a
//    type cannot claim.
const carriesAFigure = (r) => r !== null && r !== undefined && 'fullAvg10Percent' in r;
verdict(
  !carriesAFigure(unreadable.stall?.io) &&
    !carriesAFigure(unreadable.stall?.memory) &&
    !carriesAFigure(absent.stall?.io) &&
    !carriesAFigure(absent.stall?.memory),
  'and no reading that was never taken carries a percentage. 0.00% from an instrument\n' +
    '    that measured nothing is an all-clear nobody checked, and it is the substitution\n' +
    '    this whole term exists to refuse.',
  'a reading with no measurement behind it carried a figure anyway: ' +
    JSON.stringify({ absent: absent.stall, unreadable: unreadable.stall })
);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.log(
    `\n${failures.length} assertion(s) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
  );
}
console.log('\n== done ==');

reportAndExit({ failures: failures.length, skipped: 0 });
