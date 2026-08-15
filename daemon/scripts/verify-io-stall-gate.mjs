// Proof for KAN-218: a machine that is stalled — thrashing on swap, or blocked
// on a failing disk — is refused, and the refusal names which of the two.
//
// WHAT FAILURE THIS WOULD CATCH: a capacity gate that admits agents onto a
// machine which is making no forward progress. KAN-201 replaced the load-average
// term with cores actually in use, which was right, and in doing so removed a
// protection nobody had named: `load1` counted uninterruptible-sleep tasks, so a
// thrashing machine showed a high load with idle cores and the old gate refused
// there. `busyCores` deliberately counts iowait as *not* busy, so after KAN-201
// nothing bounded I/O saturation at all. Also caught: a stall term wired to the
// io pressure file only, which would miss the ticket's headline case because the
// kernel accounts swap-in as a *memory* stall; a `stallPercent` of null (no PSI
// on this machine) being treated as "healthy" rather than "no instrument"; a
// preemption that stands an agent down to relieve a stall it cannot relieve; and
// a derivation whose `headroom` no longer reproduces from the terms it prints.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Seven sections:
//
//   1. instrument     — a real /proc/pressure read on this machine, all the way
//                       into readMachineFacts(), so the field is shown arriving
//   2. iowait caveat  — a real I/O stall induced on this machine, with iowait
//                       and PSI sampled side by side. This is the section that
//                       answers "why not the obvious instrument" with a
//                       measurement instead of folklore
//   3. the parser     — readStallFacts() driven against fixture files: stalled,
//                       healthy, absent, malformed, and one file of each pair
//                       missing
//   4. the gate       — fixture-driven machines through computeCapacity and
//                       capacityRefusal: io-stalled refused, swap-thrashing
//                       refused and named as memory, no-PSI admitted (the hole,
//                       asserted so it stays deliberate), full board still
//                       bound by cap
//   5. hand-check     — the derivation's own printed figures re-derived, the
//                       veto included
//   6. live refusal   — this machine's real pressure figure, through the real
//                       MessageRouter, with the threshold moved to where this
//                       healthy machine's real reading crosses it. The figure is
//                       real; the threshold is the part that was changed, and
//                       the section says so. Also asserts no victim is offered
//   7. can it fail    — section 4's battery against a model with the veto
//                       removed. If the battery still passes, it proves nothing
//                       and this script exits red
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED:
// sections 4, 5 and 7 hand `computeCapacity` machine facts this file wrote. A
// gate that refuses correctly on invented figures has not been shown to receive
// real ones — that is how KAN-145's two scripts stayed green while `activatedBy`
// was null for every agent in production. Three things are done about it here:
//
//   - Section 3 drives the *real parser* against files on disk rather than
//     constructing a StallFacts, so the seam between "a file says this" and
//     "the arithmetic sees this" is exercised rather than assumed. Section 4's
//     machines are built by reading those same fixtures through readStallFacts.
//   - Section 1 asserts the field arrives in `readMachineFacts()` from this
//     machine's own /proc/pressure, which is the seam a fixture cannot cover.
//   - Section 6 refuses a real activation through the real router on this
//     machine's real reading.
//
// What none of that covers: **nobody has watched this gate fire on a genuinely
// sick machine**, because there has not been one. The threshold
// (STALL_REFUSE_PERCENT, 20%) is calibrated only from below — from what this
// machine reads when nothing is wrong — and section 2's induced load is a
// deliberate stress test, not an outage. So this script can show that the gate
// closes when the figure is high and that the figure is real; it cannot show
// that 20% is the right number. Nothing covers that yet, and no script can:
// only an incident can, and the honest thing is to say the number is a decision
// rather than to imply a calibration that does not exist. KAN-218's ticket
// records the same caveat.
//
// Section 2's numbers are hardware-dependent — an NVMe machine stalls
// differently from a spinning disk, and a machine with a fast disk and busy
// CPUs may not reproduce the divergence at all. It therefore asserts only the
// robust claim (PSI responded to a load that iowait under-reported or missed)
// and prints the table for the reader. On hardware where it cannot induce a
// stall it says so and does not pass.
//
// HOW TO WATCH IT GO RED (do this rather than trusting the green):
//   cd daemon && npm run build
//   # 1. delete the veto: in src/capacity.ts, replace
//   #      const headroom = stalled ? 0 : headroomBeforeStall;
//   #    with
//   #      const headroom = headroomBeforeStall;
//   #    npm run build && node scripts/verify-io-stall-gate.mjs
//   #    -> sections 4, 6 and 7 fail; exit 1.
//   # 2. narrow it to io only: in worstStall(), delete the memoryFullPercent
//   #    branch. npm run build && node scripts/verify-io-stall-gate.mjs
//   #    -> section 4's swap-thrash machine is admitted; exit 1.
//   # 3. make the missing instrument look healthy: in computeCapacity, use
//   #      const stalled = (worst?.percent ?? 100) >= stallRefusePercent;
//   #    -> section 4's no-PSI machine is refused; exit 1.
//   # Then `git checkout src/capacity.ts && npm run build` for green.
//
// Usage:
//   cd daemon && npm run build && node scripts/verify-io-stall-gate.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

const {
  computeCapacity,
  describeCapacity,
  readMachineFacts,
  readStallFacts,
  readPressureFull,
  worstStall,
  capacityRefusal,
  capacityHeadline,
  summarizeCapacity,
  STALL_REFUSE_PERCENT,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(path.join(distDir, 'integrations', 'enablement.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan218-stall-'));

// ---------------------------------------------------------- 1. instrument --
rule('1. THE INSTRUMENT — this machine\'s own /proc/pressure, into readMachineFacts()');

const hasPsi = fs.existsSync('/proc/pressure/io');
console.log(
  hasPsi
    ? `  /proc/pressure exists (kernel ${os.release()})\n\n` +
      fs
        .readFileSync('/proc/pressure/io', 'utf8')
        .trimEnd()
        .split('\n')
        .map((l) => `    io      ${l}`)
        .join('\n') +
      '\n' +
      fs
        .readFileSync('/proc/pressure/memory', 'utf8')
        .trimEnd()
        .split('\n')
        .map((l) => `    memory  ${l}`)
        .join('\n')
    : `  no /proc/pressure on this machine (kernel ${os.release()})`
);

const liveFacts = readMachineFacts();
const liveWorst = worstStall(liveFacts.stall);
console.log(
  `\n  readStallFacts()      ${JSON.stringify(readStallFacts())}\n` +
  `  readMachineFacts().stall ${JSON.stringify(liveFacts.stall)}\n` +
  `  worstStall()          ${JSON.stringify(liveWorst)}\n` +
  `  default threshold     ${STALL_REFUSE_PERCENT}%`
);

if (hasPsi) {
  verdict(
    liveFacts.stall !== null &&
      liveFacts.stall !== undefined &&
      typeof liveFacts.stall.ioFullPercent === 'number' &&
      typeof liveFacts.stall.memoryFullPercent === 'number' &&
      liveWorst !== null,
    'the figure the gate divides arrives from this machine\'s own /proc/pressure through\n' +
      '    readMachineFacts() — not from anything this script wrote. That is the seam a\n' +
      '    fixture cannot cover, and it is the one KAN-145 left open.',
    'readMachineFacts() produced no stall figure on a machine that has /proc/pressure: ' +
      `${JSON.stringify(liveFacts.stall)}. The term would be inert in production while ` +
      'looking installed, which is precisely the KAN-145 failure.'
  );
} else {
  verdict(
    liveFacts.stall?.ioFullPercent === null && liveFacts.stall?.memoryFullPercent === null,
    'no PSI on this machine and the reader says so with nulls rather than zeroes — the\n' +
      '    term is inert, which the derivation states in words. Sections 2 and 6 cannot run.',
    'no /proc/pressure, but the reader did not return nulls: ' +
      `${JSON.stringify(liveFacts.stall)}. A missing instrument reading as 0 would look like a ` +
      'healthy machine forever.'
  );
}

// ------------------------------------------------------- 2. iowait caveat --
rule('2. WHY NOT IOWAIT — a real stall induced on this machine, both instruments sampled');

// The claim being tested is not "iowait is imprecise". It is specific: iowait
// is a *per-CPU* bucket that only accrues on an **idle** CPU with a task blocked
// on I/O, so it collapses toward zero exactly when the CPUs have other work —
// which is when a fleet of agents is running. PSI measures wall-clock stall
// time machine-wide and does not.
function readIowaitTicks() {
  const v = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { iowait: v[4], total: v.reduce((s, n) => s + n, 0) };
}

let caveat = null;
if (!hasPsi) {
  console.log('  skipped: no /proc/pressure on this machine.');
} else {
  // 8 processes each doing synchronous, direct 4k writes. Each write is a round
  // trip to the device with a flush, so the process sits in D state spending
  // almost no CPU: this is I/O *stall*, not I/O bandwidth, and it is the shape
  // a thrashing machine has. 8 x 3000 x 4k = 96 MB written to a temp dir and
  // deleted; nothing else on the machine is touched.
  const samples = [];
  const sample = (label, prev) => {
    const t = readIowaitTicks();
    const dTot = prev ? t.total - prev.total : 0;
    const row = {
      label,
      ioFull: readPressureFull('/proc/pressure/io'),
      ioSome: Number(
        fs.readFileSync('/proc/pressure/io', 'utf8').match(/some avg10=([\d.]+)/)?.[1] ?? NaN
      ),
      memFull: readPressureFull('/proc/pressure/memory'),
      iowaitPct: prev && dTot > 0 ? (100 * (t.iowait - prev.iowait)) / dTot : null
    };
    samples.push(row);
    return t;
  };

  let prev = sample('before', null);
  await sleep(2000);
  prev = sample('before', prev);

  const writers = Array.from({ length: 8 }, (_, i) =>
    spawn(
      'dd',
      [
        'if=/dev/zero',
        `of=${path.join(tmp, `sync${i}.bin`)}`,
        'bs=4k',
        'count=3000',
        'oflag=direct,dsync',
        'status=none'
      ],
      { stdio: 'ignore' }
    )
  );
  console.log('  8 synchronous-direct writers started; sampling every 2s…\n');
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    prev = sample('load', prev);
  }
  await Promise.all(
    writers.map((w) => new Promise((r) => (w.exitCode !== null ? r() : w.on('exit', r))))
  );
  for (const w of writers) w.kill('SIGKILL');
  for (let i = 0; i < 8; i++) fs.rmSync(path.join(tmp, `sync${i}.bin`), { force: true });

  console.log(
    '    when       io some   io full   mem full   iowait%\n' +
      samples
        .map(
          (s) =>
            `    ${s.label.padEnd(9)}${String(s.ioSome.toFixed(2)).padStart(8)}` +
            `${String(s.ioFull.toFixed(2)).padStart(10)}${String(s.memFull.toFixed(2)).padStart(11)}` +
            `${(s.iowaitPct === null ? '—' : s.iowaitPct.toFixed(2)).padStart(10)}`
        )
        .join('\n')
  );

  const baseline = Math.max(...samples.filter((s) => s.label === 'before').map((s) => s.ioSome));
  const loaded = samples.filter((s) => s.label === 'load');
  const peakSome = Math.max(...loaded.map((s) => s.ioSome));
  // The interesting sample: PSI clearly elevated while iowait says almost
  // nothing. This is the caveat, if this hardware produces it.
  const divergent = loaded
    .filter((s) => s.iowaitPct !== null && s.ioSome > Math.max(5, baseline * 1.5))
    .sort((a, b) => a.iowaitPct - b.iowaitPct)[0];

  caveat = { baseline, peakSome, divergent };
  console.log(
    `\n  PSI responded: io some went ${baseline.toFixed(2)}% (before) → ${peakSome.toFixed(2)}% (peak under load).`
  );
  if (divergent) {
    console.log(
      `  The caveat, on this run: at one sample PSI reported ${divergent.ioSome.toFixed(2)}% of wall time\n` +
      `  with something stalled on I/O while iowait reported ${divergent.iowaitPct.toFixed(2)}%. Same disk,\n` +
      '  same work. iowait only accrues on an *idle* CPU, so as the CPUs found other work\n' +
      '  to do it stopped reporting a stall that was still happening. A gate on iowait\n' +
      '  would have seen a healthy machine; that is why this term reads /proc/pressure.'
    );
  }
  verdict(
    peakSome > Math.max(5, baseline * 1.5),
    `PSI moved with a real induced stall on real hardware (${baseline.toFixed(2)}% → ` +
      `${peakSome.toFixed(2)}%), so it is\n    measuring something and not a constant. ` +
      (divergent
        ? `And it reported ${divergent.ioSome.toFixed(2)}% where iowait reported ` +
          `${divergent.iowaitPct.toFixed(2)}%, which is the\n    caveat resolved by measurement rather than repeated.`
        : '(iowait did not visibly diverge on this run — see the table.)'),
    `PSI did not respond to a deliberate 8-way synchronous-direct-write load ` +
      `(before ${baseline.toFixed(2)}%, peak ${peakSome.toFixed(2)}%). Either this hardware absorbs it, ` +
      'or the instrument is not reading what it claims to.'
  );
}

// ----------------------------------------------------------- 3. the parser --
rule('3. THE PARSER — readStallFacts() against files on disk');

// Real /proc/pressure text, so the parse is exercised rather than a StallFacts
// being typed out. Every one of these is a way the file can arrive.
const FIXTURES = {
  // A machine making no progress: 34% of the last 10s with everything stalled.
  stalled: {
    io: 'some avg10=71.44 avg60=64.02 avg300=48.11 total=98374652\nfull avg10=34.10 avg60=29.88 avg300=21.06 total=61093887\n',
    memory: 'some avg10=2.11 avg60=1.90 avg300=1.44 total=63377188\nfull avg10=0.31 avg60=0.28 avg300=0.19 total=49864920\n'
  },
  // Swap thrash: the kernel files a task waiting on swap-in as a MEMORY stall,
  // so io looks unremarkable and only the memory file shows the emergency.
  // An io-only term misses this, which is the ticket's headline case.
  thrashing: {
    io: 'some avg10=9.20 avg60=8.71 avg300=6.02 total=98374652\nfull avg10=1.88 avg60=1.70 avg300=1.10 total=61093887\n',
    memory: 'some avg10=88.30 avg60=80.14 avg300=61.77 total=63377188\nfull avg10=52.60 avg60=47.31 avg300=35.02 total=49864920\n'
  },
  // This machine, on an ordinary busy day with a full agent fleet.
  healthy: {
    io: 'some avg10=2.27 avg60=2.32 avg300=1.98 total=537036752\nfull avg10=0.01 avg60=0.18 avg300=0.24 total=313582439\n',
    memory: 'some avg10=0.00 avg60=0.03 avg300=0.00 total=63377188\nfull avg10=0.00 avg60=0.02 avg300=0.00 total=49864920\n'
  },
  // /proc/pressure/cpu's shape: a `full` line the kernel does not define at
  // system level. Not gated on, but it must parse rather than throw.
  cpuShaped: {
    io: 'some avg10=49.87 avg60=41.80 avg300=36.16 total=5050091292\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    memory: 'some avg10=1.00 avg60=1.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'
  },
  // Truncated mid-write, which is what a read of a proc file can catch.
  malformed: { io: 'some avg10=71.44 avg60=64.02 avg3', memory: '' },
  // One file readable, the other not: a partial instrument must still answer
  // from the half it has rather than give up or invent the other half.
  ioOnly: { io: 'some avg10=71.44 avg60=64.02 avg300=48.11 total=1\nfull avg10=34.10 avg60=29.88 avg300=21.06 total=1\n' }
};

const fixtureDir = (name) => {
  const dir = path.join(tmp, `psi-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(FIXTURES[name])) {
    fs.writeFileSync(path.join(dir, file), body);
  }
  return dir;
};

const parsed = {};
for (const name of Object.keys(FIXTURES)) parsed[name] = readStallFacts(fixtureDir(name));
// A directory with no files at all: the pre-4.20 / no-CONFIG_PSI / not-Linux case.
const absentDir = path.join(tmp, 'psi-absent');
fs.mkdirSync(absentDir, { recursive: true });
parsed.absent = readStallFacts(absentDir);

const parseExpect = [
  ['stalled', { ioFullPercent: 34.1, memoryFullPercent: 0.31 }, { percent: 34.1, source: 'io' }],
  ['thrashing', { ioFullPercent: 1.88, memoryFullPercent: 52.6 }, { percent: 52.6, source: 'memory' }],
  ['healthy', { ioFullPercent: 0.01, memoryFullPercent: 0 }, { percent: 0.01, source: 'io' }],
  ['cpuShaped', { ioFullPercent: 0, memoryFullPercent: 0 }, { percent: 0, source: 'io' }],
  ['malformed', { ioFullPercent: null, memoryFullPercent: null }, null],
  ['ioOnly', { ioFullPercent: 34.1, memoryFullPercent: null }, { percent: 34.1, source: 'io' }],
  ['absent', { ioFullPercent: null, memoryFullPercent: null }, null]
];
const parseProblems = [];
for (const [name, facts, worst] of parseExpect) {
  const got = parsed[name];
  const gotWorst = worstStall(got);
  console.log(
    `  ${name.padEnd(11)} ${JSON.stringify(got).padEnd(56)} worst ${JSON.stringify(gotWorst)}`
  );
  if (JSON.stringify(got) !== JSON.stringify(facts)) {
    parseProblems.push(`${name}: parsed ${JSON.stringify(got)}, expected ${JSON.stringify(facts)}`);
  }
  if (JSON.stringify(gotWorst) !== JSON.stringify(worst)) {
    parseProblems.push(
      `${name}: worstStall ${JSON.stringify(gotWorst)}, expected ${JSON.stringify(worst)}`
    );
  }
}
verdict(
  parseProblems.length === 0,
  'the real parser reads real file text: `full avg10` off both files, the worse of the\n' +
    '    two, and null — never 0 — for every way the instrument can be missing. The\n' +
    '    malformed and absent cases matter most: a half-read file scoring 0 would read as\n' +
    '    a permanently healthy machine.',
  `the parser is wrong: ${parseProblems.join('; ')}`
);

// -------------------------------------------------------------- 4. the gate --
rule('4. THE GATE — fixture-driven machines, refused or admitted, each naming why');

// Deliberately generous CPU and memory on every machine below, so the only
// thing that can possibly refuse is the stall term. The facts are built by
// reading the section-3 fixture files through the real reader, so this is not
// a hand-written StallFacts.
const roomy = (stall) => ({
  cores: 16,
  totalBytes: 64 * GIB,
  availableBytes: 60 * GIB,
  load1: 0.2,
  busyCores: 0.5,
  busyWindowSeconds: 5,
  stall
});
const IO_STALLED = roomy(parsed.stalled);
const SWAP_THRASHING = roomy(parsed.thrashing);
const HEALTHY = roomy(parsed.healthy);
const NO_PSI = roomy(parsed.absent);

/**
 * The battery, factored out so section 7 can run the identical checks against a
 * model whose veto has been removed. A check only ever run against the passing
 * case has not been shown to be able to fail.
 */
function gateBattery(compute) {
  const problems = [];
  const opts = { measured: null };

  // (a) I/O-stalled with 16 idle cores and 60 GiB free. The whole point: every
  // counting term says there is plenty of room, and there is not.
  const io = compute(IO_STALLED, 0, opts);
  if (!io.atCapacity) {
    problems.push(
      `an I/O-stalled machine (${io.stallPercent}% full) admitted ${io.headroom} agent(s) — ` +
      'the stall gate does not close at all'
    );
  } else if (io.headroomBoundBy !== 'stall') {
    problems.push(`I/O-stalled machine reported bound by ${io.headroomBoundBy}`);
  } else if (io.stallSource !== 'io') {
    problems.push(`I/O-stalled machine blamed ${io.stallSource}`);
  } else if (!/stalled on i\/o/.test(capacityHeadline(io))) {
    problems.push(`the io refusal does not name I/O: "${capacityHeadline(io)}"`);
  } else if (!capacityRefusal(io, 'task/KAN-999').includes('34.10%')) {
    problems.push('the io refusal does not quote the figure it refused on');
  } else if (io.headroomBeforeStall < 1) {
    problems.push(
      'the io-stalled machine had no room before the veto either, so this case proves nothing'
    );
  }

  // (b) Swap thrash. io looks fine; memory pressure is the emergency. An
  // io-only term admits this machine, which is the ticket's headline case.
  const swap = compute(SWAP_THRASHING, 0, opts);
  if (!swap.atCapacity || swap.headroomBoundBy !== 'stall') {
    problems.push(
      `a machine thrashing on swap (memory full ${swap.stall?.memoryFullPercent}%, io only ` +
      `${swap.stall?.ioFullPercent}%) admitted ${swap.headroom} (bound by ${swap.headroomBoundBy})`
    );
  } else if (swap.stallSource !== 'memory') {
    problems.push(`swap thrash was blamed on ${swap.stallSource}, not memory`);
  } else if (!/thrashing on memory/.test(capacityHeadline(swap))) {
    problems.push(`the swap refusal does not name memory thrash: "${capacityHeadline(swap)}"`);
  } else if (/not enough memory/.test(capacityHeadline(swap))) {
    problems.push('the swap refusal reads as a memory shortage, which it is not');
  }

  // (c) A healthy machine is not refused. A gate that refuses everything is
  // indistinguishable from a gate that works, on the evidence of (a) alone.
  const ok = compute(HEALTHY, 0, opts);
  if (ok.atCapacity || ok.stalled || ok.headroom < 1) {
    problems.push(
      `a healthy machine (io ${ok.stall?.ioFullPercent}% full) was refused: headroom ` +
      `${ok.headroom}, bound by ${ok.headroomBoundBy}`
    );
  }

  // (d) No PSI: the named hole. This machine MUST be admitted — an absent
  // instrument refuses nothing — and the derivation must say the term is inert
  // rather than printing a figure. Asserted so the hole stays deliberate: if
  // someone later makes a missing file read as 0 or as 100, this fails.
  const blind = compute(NO_PSI, 0, opts);
  if (blind.stallPercent !== null) {
    problems.push(`a machine with no PSI reported stallPercent ${blind.stallPercent}, not null`);
  } else if (blind.stalled || blind.atCapacity) {
    problems.push('a machine with no PSI was refused — a missing instrument must refuse nothing');
  } else if (!/no \/proc\/pressure on this machine/.test(describeCapacity(blind))) {
    problems.push('the derivation does not disclose that the stall term is inert');
  } else if (!/bounds a machine thrashing|bounded by nothing|nothing here bounds/.test(describeCapacity(blind))) {
    problems.push('the derivation does not say what is left unprotected when PSI is absent');
  }

  // (e) The tie rule: a stalled machine whose board is ALSO full must still say
  // `cap`, because closing an agent is something the reader can act on and
  // hurrying a disk is not. `stall` names itself only when it is the reason.
  const capOfIdle = compute(IO_STALLED, 0, opts).cap;
  const full = compute(IO_STALLED, capOfIdle, opts);
  if (!full.atCapacity) {
    problems.push('a full board on a stalled machine admitted an agent');
  } else if (full.headroomBoundBy !== 'cap') {
    problems.push(
      `a full board on a stalled machine reported bound by ${full.headroomBoundBy}, not cap — ` +
      'the tie rule sends the reader to the lever they cannot pull'
    );
  }

  return { problems, io, swap, ok, blind, full };
}

const battery = gateBattery(computeCapacity);
console.log('(a) 34.10% io stall, 16 cores idle, 60 GiB free:\n');
console.log(capacityRefusal(battery.io, 'task/KAN-999'));
console.log('\n(b) 52.60% memory stall (swap thrash), io only 1.88%:\n');
console.log(`  ${capacityHeadline(battery.swap)}`);
console.log('\n(c) healthy machine:\n');
console.log(`  ${summarizeCapacity(battery.ok)}`);
console.log('\n(d) no /proc/pressure — the named hole:\n');
console.log(`  ${summarizeCapacity(battery.blind)}`);
console.log(
  `  ${describeCapacity(battery.blind).split('\n').find((l) => l.startsWith('io/memory stall:'))}`
);
console.log('\n(e) the same stalled machine with the board full:\n');
console.log(`  ${capacityHeadline(battery.full)}`);
verdict(
  battery.problems.length === 0,
  'a stalled machine is refused with room to spare on every other term; swap thrash is\n' +
    '    caught and named as memory rather than as I/O; a healthy machine is not refused;\n' +
    '    a machine with no instrument is admitted and the derivation says what that leaves\n' +
    '    unprotected; and the count still wins the tie.',
  `the gate is wrong: ${battery.problems.join('; ')}`
);

// -------------------------------------------------------------- 5. hand-check --
rule('5. HAND-CHECK — the veto\'s arithmetic re-derived from the figures it prints');

const derivation = describeCapacity(battery.io);
console.log(derivation);

const stallLine = derivation.split('\n').find((l) => l.startsWith('io/memory stall:'));
const headroomLine = derivation.split('\n').find((l) => l.startsWith('headroom:'));
const handChecks = [];
const printed = stallLine?.match(
  /([\d.]+)% io, ([\d.]+)% memory .* worst is ([\d.]+)% on (io|memory), against a (\d+)% threshold/
);
if (!printed) {
  handChecks.push('the stall line did not parse — its shape changed without this check');
} else {
  const [, io, mem, worst, source, threshold] = printed;
  const handWorst = Math.max(Number(io), Number(mem));
  const handSource = Number(io) >= Number(mem) ? 'io' : 'memory';
  const handStalled = handWorst >= Number(threshold);
  console.log(
    `\n  worst   : max(${io}, ${mem}) = ${handWorst} on ${handSource}  (printed ${worst} on ${source})\n` +
    `  stalled : ${handWorst} >= ${threshold} = ${handStalled}  (printed stalled ${battery.io.stalled})\n` +
    `  headroom: veto ⇒ 0, over the ${battery.io.headroomBeforeStall} the counting terms allowed  ` +
    `(printed headroom ${battery.io.headroom})`
  );
  if (handWorst !== Number(worst)) handChecks.push(`worst: hand ${handWorst} vs printed ${worst}`);
  if (handSource !== source) handChecks.push(`source: hand ${handSource} vs printed ${source}`);
  if (handStalled !== battery.io.stalled) handChecks.push('stalled does not follow from the printed figures');
  if (battery.io.headroom !== 0) handChecks.push(`headroom ${battery.io.headroom} is not 0 on a vetoed machine`);
}
// The promise the derivation makes is that `headroom` reproduces from what it
// prints. With a veto in play, min(three terms) alone no longer reproduces it,
// so the veto must be visible on the headroom line or the promise is broken.
if (!/vetoed to 0 by the/.test(headroomLine ?? '')) {
  handChecks.push(
    'the headroom line does not show the veto, so min() of its three printed terms does ' +
    `not reproduce headroom (${battery.io.headroomBeforeStall} vs ${battery.io.headroom})`
  );
}
// And the healthy machine must NOT carry veto language it did not apply.
if (/vetoed to 0/.test(describeCapacity(battery.ok))) {
  handChecks.push('a healthy machine\'s derivation claims a veto that did not fire');
}
verdict(
  handChecks.length === 0,
  'the veto reproduces by hand from the figures printed beside it, and the headroom\n' +
    '    line shows it acting — so min() of the three counting terms plus the veto is\n' +
    '    still the whole story, checkable with a calculator.',
  `the derivation does not reproduce by hand: ${handChecks.join('; ')}`
);

// ------------------------------------------------------------ 6. live refusal --
rule('6. LIVE REFUSAL — this machine\'s real figure, through the real router');

// Sections 3-5 are arithmetic over fixtures. This one uses no fixture at all:
// it reads THIS machine's /proc/pressure and refuses a real activation through
// the real MessageRouter.
//
// What is changed to make it fire is the *threshold*, not the figure. This
// machine is healthy, and deliberately stalling it hard enough to cross 20%
// would mean doing real harm to a machine with live agents on it. So
// BUTCHR_STALL_PERCENT is set just under whatever this machine's real reading
// is right now, and the refusal that comes back quotes that real reading. That
// tests everything except the constant: the read, the worst-of-two, the veto,
// the router, the refusal sentence, and the absence of a preemption offer.
// The constant is what nothing here covers, and the header says so.
if (!hasPsi) {
  console.log('  skipped: no /proc/pressure on this machine.');
} else {
  function stubBridge(runningAgentNames) {
    const agents = runningAgentNames.map((name) => ({
      name,
      agentRuntime: 'claude',
      workDir: '/tmp',
      herdrStatus: 'working'
    }));
    return {
      listHerdrAgents: () => agents,
      listHerdrAgentsChecked: () => ({ reachable: true, agents }),
      listActiveSessions: () => [],
      getSessionByAddress: () => undefined,
      // KAN-473 added this to the AgentRuntime seam, and it is DERIVED from the
      // stub's own `getSessionByAddress` rather than written twice, so a stub
      // cannot disagree with itself about what an address resolves to. The real
      // runtimes answer `ambiguous` here; no stub here holds two sessions on one
      // key, so none of them can reach that outcome — see
      // `verify-ambiguous-key-refusal.mjs` for the case that does.
      resolveSessionByAddress(key, type) {
        const session = this.getSessionByAddress(key, type);
        return session ? { outcome: 'one', session } : { outcome: 'none' };
      },
      spawnSession: () => {
        throw new Error('spawnSession must not be reached when capacity refuses');
      }
    };
  }
  const typeRegistry = new WorkspaceRegistry(
    new IntegrationStateStore(path.join(tmp, 'integrations.json'))
  );
  typeRegistry.registerIntegration(createAtlassianIntegration());
  typeRegistry.setEnabled('jira', true);
  const stubRegistry = {
    get: (type) => typeRegistry.get(type),
    resolve: async () => null,
    priorityFor: () => 1,
    disabledMatch: () => null,
    disabledIntegrationForType: () => null,
    mcpServerDefinitions: () => ({})
  };
  const stubPrompts = { loadAndRender: () => '# prompt' };

  async function activate(runningAgentNames, args) {
    let response;
    let reachedSpawn = false;
    const router = new MessageRouter(
      stubRegistry,
      stubPrompts,
      stubBridge(runningAgentNames),
      (msg) => { response = msg; },
      () => {}
    );
    try {
      await router.handleActivateByKey(args, (msg) => { response = msg; });
    } catch (e) {
      if (!String(e.message).includes('spawnSession')) throw e;
      reachedSpawn = true;
    }
    return { response, reachedSpawn };
  }

  // `headroomBoundBy` says `stall` only when the stall is the *reason* there is
  // no room — if CPU or memory had already run out, the tie rule names those,
  // because the reader can act on them. That rule is right and it makes this
  // section's timing matter: on a machine whose cores are already spent (this
  // one, often, with a full agent fleet on it) the strong assertion cannot be
  // exercised no matter how the veto behaves. So wait for a moment when the
  // counting terms have room, and say out loud which branch ran rather than
  // quietly weakening the check.
  // The seed divisor is 0.75 core/agent, measured in July 2026 before the fleet
  // was what it is. On this 4-core laptop with a full board that pins the CPU
  // term at 0 permanently, and a permanently-0 CPU term wins the tie and hides
  // the attribution. So set the documented operator override to the figure this
  // fleet actually costs (~0.05 core/tree — KAN-204's narrative, and what
  // measure-agent-cost.mjs reports here). That is a real knob with a real value,
  // not a thumb on the scale: it changes the *divisor*, and every reading the
  // veto acts on is still this machine's own.
  process.env.BUTCHR_AGENT_CORES = '0.05';
  console.log('  BUTCHR_AGENT_CORES=0.05 (this fleet\'s measured per-tree cost, not the July seed)\n');

  const deadline = Date.now() + 90_000;
  let roomy = null;
  let observed = null;
  for (;;) {
    const facts = readMachineFacts();
    const probe = computeCapacity(facts, 0, {
      measured: null,
      overrides: { cores: 0.05 }
    });
    observed = { facts, probe };
    if (probe.headroomBeforeStall > 0) {
      roomy = observed;
      break;
    }
    if (Date.now() > deadline) break;
    console.log(
      `  waiting for cpu/memory headroom (${probe.cpuBusyCores.toFixed(2)} of ${facts.cores} cores in ` +
      `use, counting terms allow ${probe.headroomBeforeStall})…`
    );
    await sleep(5000);
  }

  const real = worstStall((roomy ?? observed).facts.stall);
  // Just under the real reading, so the comparison is `real >= threshold` on a
  // number this machine produced.
  process.env.BUTCHR_STALL_PERCENT = String(
    Math.max(0.0001, Math.round((real.percent - 0.005) * 100) / 100)
  );
  console.log(
    `\n  this machine right now: ${real.percent.toFixed(2)}% ${real.source} stall (real, unmodified)\n` +
    `  BUTCHR_STALL_PERCENT=${process.env.BUTCHR_STALL_PERCENT} — the threshold is the part this\n` +
    `  section changed, and it is set below the machine's own reading rather than the\n` +
    '  reading being faked.\n'
  );

  if (real.percent <= 0) {
    // A dead-idle machine reads 0.00 and cannot cross any positive threshold.
    console.log('  reads 0.00% — nothing to cross; inducing a small real stall to sample against.');
    const w = spawn(
      'dd',
      ['if=/dev/zero', `of=${path.join(tmp, 'live.bin')}`, 'bs=4k', 'count=4000', 'oflag=direct,dsync', 'status=none'],
      { stdio: 'ignore' }
    );
    await sleep(6000);
    w.kill('SIGKILL');
    fs.rmSync(path.join(tmp, 'live.bin'), { force: true });
    const after = worstStall(readMachineFacts().stall);
    process.env.BUTCHR_STALL_PERCENT = String(Math.max(0.0001, after.percent - 0.005));
    console.log(`  after: ${after.percent.toFixed(2)}% ${after.source}`);
  }
  const live = await activate([], { type: 'task', key: 'KAN-999' });
  delete process.env.BUTCHR_STALL_PERCENT;
  delete process.env.BUTCHR_AGENT_CORES;

  const cap = live.response?.capacity;
  console.log('what the caller receives:\n');
  console.log(
    JSON.stringify(
      {
        success: live.response?.success,
        refusedBy: live.response?.refusedBy,
        reason: live.response?.reason,
        preemptable: live.response?.preemptable ?? null,
        capacity: cap && {
          headroom: cap.headroom,
          headroomBeforeStall: cap.headroomBeforeStall,
          headroomBoundBy: cap.headroomBoundBy,
          stalled: cap.stalled,
          stallPercent: cap.stallPercent,
          stallSource: cap.stallSource,
          stallIoPercent: cap.stallIoPercent,
          stallMemoryPercent: cap.stallMemoryPercent,
          stallRefusePercent: cap.stallRefusePercent
        }
      },
      null,
      2
    )
  );
  // Common to both branches: the real figure reached the router, the veto
  // fired on it, the activation was refused, and no victim was offered.
  const common =
    live.response?.success === false &&
    live.response?.refusedBy === 'capacity' &&
    live.reachedSpawn === false &&
    cap?.stalled === true &&
    typeof cap?.stallPercent === 'number' &&
    cap.stallPercent > 0 &&
    // The one that matters most for this ticket: no agent is offered up to
    // relieve a condition a stand-down cannot relieve.
    (live.response?.preemptable ?? null) === null;

  // WHICH BRANCH IS DECIDED BY THE REFUSAL, NOT BY THE PROBE ABOVE.
  //
  // The poll loop's `roomy` is a reading taken up to ~20 seconds before the
  // activation — and this section then spends some of those seconds *inducing*
  // a stall, which costs CPU. On 2026-08-09 that raced: the probe saw room for
  // 4, the induced load and the fleet together pushed `cpuBusyCores` to 3.46 by
  // the time the activation ran, the CPU term was legitimately 0, the tie rule
  // correctly named `cpu` — and this script called it a product failure.
  //
  // Nothing was wrong with the product; the verdict was reading a stale number.
  // So the branch is chosen from `headroomBeforeStall` **on the response that
  // came back**, which is by construction the capacity the refusal was actually
  // computed from. A race is then not possible: there is no second reading to
  // disagree with. `roomy` is kept only to improve the odds of landing in the
  // strong branch, never to decide that it did.
  const hadRoom = (cap?.headroomBeforeStall ?? 0) > 0;
  if (hadRoom) {
    console.log(
      `\n  the counting terms had room (${cap.headroomBeforeStall}) in the capacity this refusal was\n` +
      '  computed from, so the attribution is exercised too: `stall` must be what it names.'
    );
    verdict(
      common && cap?.headroomBoundBy === 'stall',
      'a real activation was refused through the real router on a figure this machine\n' +
        '    produced, bound by `stall` with cpu and memory to spare, and with no victim\n' +
        '    offered — a stand-down cannot un-stall a disk, so offering one would destroy an\n' +
        '    agent\'s work for nothing.',
      'the live refusal did not happen or did not name the stall: success=' +
        `${live.response?.success}, refusedBy=${live.response?.refusedBy}, ` +
        `boundBy=${cap?.headroomBoundBy}, stalled=${cap?.stalled}, ` +
        `stallPercent=${cap?.stallPercent}, ` +
        `preemptable=${JSON.stringify(live.response?.preemptable ?? null)}, ` +
        `reachedSpawn=${live.reachedSpawn}. Either the veto does not reach the router, or it ` +
        'offers a preemption that cannot help.'
    );
  } else {
    // Loud on purpose. A conditional assertion that quietly downgrades itself
    // is how a proof comes to mean less than its name, so the weaker branch
    // says what it did not test and who does.
    // Two very different situations reach here, and saying the wrong one would
    // be its own small dishonesty: either the activation was refused on a
    // machine whose counting terms were already exhausted (ordinary, and the
    // attribution simply is not exercisable), or it was not refused at all
    // (which is the failure this section exists to catch, and there is no
    // capacity payload to quote).
    console.log(
      cap
        ? `\n  NOTE: the counting terms were at 0 in the capacity this refusal was computed from\n` +
          `  (${cap.cpuBusyCores} of ${observed.facts.cores} cores in use, bound by ` +
          `${cap.headroomBoundBy}), so the tie rule correctly names cpu\n` +
          '  rather than stall and THE ATTRIBUTION WAS NOT EXERCISED HERE. What is still\n' +
          '  checked below is the part a fixture cannot cover: the real reading reaching the\n' +
          '  router and firing the veto, and no victim being offered. Section 4 covers the\n' +
          '  attribution on machines with room. Re-run when the fleet is quieter for the full check.'
        : '\n  NOTE: no capacity payload came back at all — this activation was NOT refused.\n' +
          '  That is not the cpu-bound case; it is the gate failing to close on a machine\n' +
          '  this script had just measured as stalled.'
    );
    verdict(
      common,
      'the real reading reached the real router and fired the veto, and no victim was\n' +
        '    offered — but see the note above: the machine was already cpu-bound, so `stall`\n' +
        '    naming itself was not exercised on this run.',
      'the live veto did not fire on this machine\'s real reading: success=' +
        `${live.response?.success}, refusedBy=${live.response?.refusedBy}, ` +
        `stalled=${cap?.stalled}, stallPercent=${cap?.stallPercent}, ` +
        `preemptable=${JSON.stringify(live.response?.preemptable ?? null)}, ` +
        `reachedSpawn=${live.reachedSpawn}.`
    );
  }
}

// ------------------------------------------------------------ 7. can it fail --
rule('7. CAN THE BATTERY FAIL — section 4 run against a model with no veto');

// The mutant is what "the protection was removed again" looks like from
// outside: the stall figure is still read, still reported, and no longer
// decides anything — which is precisely the state KAN-201 left the code in, and
// the reason this ticket exists. If section 4 still passes against it, section 4
// is decoration.
function noVeto(machine, running, opts) {
  const c = computeCapacity(machine, running, opts);
  return {
    ...c,
    stalled: false,
    headroom: c.headroomBeforeStall,
    headroomBoundBy:
      c.headroomByCap <= c.headroomByCpu && c.headroomByCap <= c.headroomByMemory
        ? 'cap'
        : c.headroomByCpu <= c.headroomByMemory
          ? 'cpu'
          : 'memory',
    atCapacity: c.headroomBeforeStall <= 0
  };
}
const mutant = gateBattery(noVeto);
console.log(
  `  with the veto removed, the 34.10%-stalled machine admits ` +
  `${noVeto(IO_STALLED, 0, { measured: null }).headroom} agents.\n\n` +
  `  section 4's battery reports ${mutant.problems.length} problem(s) against it:\n` +
  mutant.problems.map((p) => `    - ${p}`).join('\n')
);
verdict(
  mutant.problems.length > 0 &&
    mutant.problems.some((p) => /stall gate does not close|thrashing on swap/.test(p)),
  'the battery rejects a model with the veto removed, so its verdict on the real one is\n' +
    '    worth something. This is the check that stops section 4 being a green light wired\n' +
    '    to nothing.',
  'section 4\'s battery passed a capacity model with no stall veto at all — it cannot ' +
    'detect the failure this script exists to detect, and its green means nothing.'
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length
    ? `\n${failures.length} section(s) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS.'
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
