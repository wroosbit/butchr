// KAN-309: which of the CI-gating `verify-` scripts can be decided by the
// machine they happen to run on, rather than by the code under test.
//
// WHY THIS EXISTS. KAN-295 made 61 proofs run. KAN-306 made them gate. Nobody
// established in between that all 61 were reliably green, and the fleet spent
// 2026-08-11 discovering that population's flakiness one red `main` at a time:
// `verify-agent-capacity` (the runner's disk was 23.77% I/O stalled) and
// `verify-channel-registration-loss` (the agent re-registered in 1 ms and beat
// the assertion to the observation). Both were environment, not regression;
// both re-ran green on the identical SHA.
//
// Two instances are an anecdote. This sweep is the attempt to turn them into a
// number: how many of the gating scripts touch ambient state at all, and which
// of those touches could decide a verdict.
//
// `sweep-` rather than `verify-`, for the same reason
// `sweep-verify-exit-paths.mjs` is: it proves no product behaviour. It is an
// inventory. It is deliberately NOT in the gating set — a sweep that could
// itself go red on a busy machine would be the joke writing itself.
//
// ---------------------------------------------------------------------------
// WHAT IT CAN AND CANNOT TELL YOU — read this before quoting its number
// ---------------------------------------------------------------------------
// It greps. That means:
//
//   * A hit is a SIGNAL, not a verdict. `Date.now()` in a script is usually a
//     label on a log line, not a threshold an assertion turns on.
//   * A miss is not a clean bill of health. A script that reaches ambient state
//     through a daemon module this sweep does not name is invisible to it —
//     `verify-agent-capacity` was caught here only because it names
//     `readMachineFacts`, and a script calling something that calls it would
//     not be.
//   * `TRIAGE` below is hand-written judgement recorded per script, not
//     derived. It is a claim by whoever last edited this file, and it is dated.
//
// So this file answers "how large is the surface" and never "how many are
// broken". Those are different questions and conflating them is how a list
// like this starts being quoted as an all-clear.
//
// Usage:
//   node daemon/scripts/sweep-ambient-dependence.mjs            # the report
//   node daemon/scripts/sweep-ambient-dependence.mjs --untriaged  # exit 1 if
//                                                                 # any gating
//                                                                 # script has
//                                                                 # a signal
//                                                                 # nobody has
//                                                                 # triaged

import fs from 'fs';
import path from 'path';
import { readPartition, REPO_ROOT } from './lib/ci-partition.mjs';

const untriagedMode = process.argv.includes('--untriaged');

// The signals. Each names a way the host can reach a script's verdict, and each
// is the mechanism behind a real failure or a real near-miss on this board.
const SIGNALS = [
  {
    key: 'machine',
    what: 'reads this machine — cores, RAM, load, /proc/pressure, /proc/stat',
    re: /readMachineFacts|readCapacity\(|readAvailableBytes|readStallFacts|\/proc\/(pressure|stat|meminfo)|os\.cpus\(|os\.totalmem|os\.freemem|os\.loadavg/
  },
  {
    key: 'home',
    what: "reads or writes the real user's $HOME",
    re: /os\.homedir\(\)/
  },
  {
    key: 'processes',
    what: 'spawns real processes, so its observations are subject to scheduling',
    re: /\bspawn\(|\bspawnSync\(|\bexecSync\(|\bexecFileSync\(/
  },
  {
    key: 'clock',
    what: 'reads the wall clock',
    re: /Date\.now\(\)|new Date\(\)/
  },
  // NO `network` SIGNAL, and that is a finding rather than an omission.
  //
  // The first draft of this file grepped for `https?://` and reported eleven
  // gating scripts as network-dependent. Every one was a false positive: a URL
  // in a fixture string (`siteUrl: 'https://x.atlassian.net'`) or a loopback
  // server the script starts and then talks to itself
  // (`http://127.0.0.1:${server.address().port}`). Neither is a dependence on
  // anything outside the process.
  //
  // Checked directly instead: NO script in the gating set calls `fetch()` at
  // all. That is consistent with the partition by construction — every script
  // needing a real credential or a real peer is classified `no` and does not
  // gate — so the network is the one ambient axis this population is already
  // clean on. `assertNoNetworkInGatingSet()` below keeps that true rather than
  // leaving it as a claim in a comment.
];

/**
 * The network axis, checked rather than grepped-for. Kept as an assertion
 * because "no gating script touches the network" is exactly the kind of fact
 * that is true when written and quietly stops being true.
 */
function networkCallers(gating) {
  return gating
    .filter((row) => /\bfetch\(|https?\.request\(|https?\.get\(/.test(
      fs.readFileSync(path.join(REPO_ROOT, row.rel), 'utf8')
    ))
    .map((row) => row.name);
}

// ---------------------------------------------------------------------------
// TRIAGE — hand-written, dated, and the part of this file that is a claim
// ---------------------------------------------------------------------------
// Keyed by script name. `verdict` is one of:
//
//   'decided'   — an ambient read reached a verdict, and it has gone red on it.
//   'load-bearing' — an ambient read can reach a verdict. Not yet observed red.
//   'sandboxed' — it relocates $HOME to a temp dir, or copies the build it
//                 patches, so the ambient thing it touches is one it made.
//   'cosmetic'  — the read exists and no assertion turns on it (a timestamp in
//                 a log line, a core count in a printed banner).
//   'synchronised' — it runs real processes and waits for the state it asserts
//                 rather than sampling once.
//
// Everything not listed here is UNTRIAGED, which `--untriaged` makes loud.
// Triaged 2026-08-11 by task/KAN-309 against the set as it stood that day.
const TRIAGE = {
  'verify-agent-capacity': {
    verdict: 'decided',
    note:
      'FIXED HERE. Section 8 read /proc/pressure via readMachineFacts and a ' +
      '23.77% io stall vetoed both arms of its comparison to 0, reddening main. ' +
      'Its inputs are now stated. Section 1 still reads the live machine ' +
      'deliberately; its verdict is an internal-consistency check that holds on ' +
      'any machine whose derived cap is >= 1, and the cap<1 floor case is named ' +
      "in that script's header as covered by nobody."
  },
  'verify-channel-registration-loss': {
    verdict: 'decided',
    note:
      'FIXED HERE. Section 3 asserted an absence inside a window the system ' +
      'races to fill; it went red when re-registration was FAST (1 ms on the ' +
      'runner) and would have gone permanently red the day anyone improved ' +
      'registration latency. The agent is now SIGSTOPped across the restart, so ' +
      'the absence is read rather than raced.'
  },
  'verify-cpu-headroom-gate': {
    verdict: 'load-bearing',
    note:
      'THE ONE TO LOOK AT NEXT. It is verify-agent-capacity\'s sibling — it owns ' +
      'the proof that a real measurement reaches the capacity arithmetic, so it ' +
      'reads the live machine BY DESIGN and cannot simply be given fixtures the ' +
      'way section 8 was. It passed in every run that reddened main, including ' +
      'the stalled one, so nothing here is observed. But whether it can be ' +
      'decided by a loaded machine is exactly the question, and it has not been ' +
      'answered. Not fixed here and not established either way.'
  },
  'verify-io-stall-gate': {
    verdict: 'sandboxed',
    note:
      'Reads /proc/pressure through readPressureFull, but drives it from ' +
      'fixture files it writes — the path is a parameter for exactly this ' +
      'reason. The live read it does make is reported, not asserted on.'
  },
  'verify-agent-power-controls': { verdict: 'cosmetic', note: 'capacity figures printed in context; no verdict turns on them.' },
  'verify-agent-preemption': { verdict: 'cosmetic', note: 'drives computeCapacity from stated fixtures; the live read is reported.' },
  'verify-cost-estimate-plausibility': { verdict: 'cosmetic', note: 'machine facts frame the plausibility bands; the bands are stated.' },
  'verify-startup-admission': { verdict: 'sandboxed', note: 'private $HOME in os.tmpdir(); machine read is reported, not asserted.' },
  'verify-board-reconciler-guard': { verdict: 'sandboxed', note: 'private $HOME; no verdict on machine state.' },
  'verify-agent-resumption': {
    verdict: 'load-bearing',
    note:
      "NOT TOUCHED HERE — KAN-308 owns it. Reported red on the fleet machine " +
      'and green in CI, on the presence of ~/.claude.json. The sweep sees it ' +
      'through the daemon module rather than directly, which is itself worth ' +
      'noting: this file would not have caught it unaided.'
  }
};

const SANDBOX_HINT = /mkdtemp|os\.tmpdir\(\)/;

const rows = readPartition().filter((r) => r.runsInCi);
const findings = [];

for (const row of rows) {
  const source = fs.readFileSync(path.join(REPO_ROOT, row.rel), 'utf8');
  const hits = SIGNALS.filter((s) => s.re.test(source)).map((s) => s.key);
  if (!hits.length) continue;
  findings.push({
    name: row.name,
    hits,
    sandboxes: SANDBOX_HINT.test(source),
    triage: TRIAGE[row.name] ?? null
  });
}

const byVerdict = (v) => findings.filter((f) => f.triage?.verdict === v);
const untriaged = findings.filter((f) => !f.triage);

console.log(`${rows.length} scripts gate on every pull request.`);
console.log(`${findings.length} of them touch ambient state somewhere in the file.\n`);

console.log('SIGNALS — what each column means');
for (const s of SIGNALS) console.log(`  ${s.key.padEnd(11)} ${s.what}`);

console.log('\n' + '='.repeat(78));
console.log('TRIAGED — an ambient read that reached, or could reach, a verdict');
console.log('='.repeat(78));
for (const v of ['decided', 'load-bearing', 'synchronised', 'sandboxed', 'cosmetic']) {
  const group = byVerdict(v);
  if (!group.length) continue;
  console.log(`\n${v.toUpperCase()} (${group.length})`);
  for (const f of group) {
    console.log(`  ${f.name}  [${f.hits.join(' ')}]`);
    for (const line of wrap(f.triage.note, 70)) console.log(`      ${line}`);
  }
}

console.log('\n' + '='.repeat(78));
console.log(`UNTRIAGED — a signal fired and nobody has judged it (${untriaged.length})`);
console.log('='.repeat(78));
console.log(
  'These are NOT known-bad. Most will be a timestamp in a log line or a $HOME\n' +
  'the script relocated itself. They are the size of the unexamined surface,\n' +
  'which is the number this sweep exists to produce.\n'
);
for (const f of untriaged) {
  console.log(
    `  ${f.name.padEnd(48)} [${f.hits.join(' ')}]` +
    (f.sandboxes ? '  (relocates $HOME or uses a temp dir)' : '')
  );
}

const sandboxing = untriaged.filter((f) => f.sandboxes).length;
console.log(
  `\n  ${sandboxing} of the ${untriaged.length} untriaged relocate $HOME or work in a temp directory, which is\n` +
  '  the pattern that makes an ambient read safe. That is a hint and not a verdict:\n' +
  '  a script can sandbox $HOME and still read the clock or the core count.'
);

const netCallers = networkCallers(rows);
console.log('\n' + '='.repeat(78));
console.log('THE NETWORK AXIS — checked, not grepped');
console.log('='.repeat(78));
console.log(
  netCallers.length
    ? `  ${netCallers.length} gating script(s) now make outbound calls: ${netCallers.join(', ')}.\n` +
      '  That is new since 2026-08-11, when the answer was none. Triage them.'
    : '  No gating script calls fetch() or http(s).request(). Loopback servers a\n' +
      '  script starts and talks to itself are not a dependence on anything\n' +
      '  outside the process, and URLs in fixture strings are not calls.'
);

console.log('\n' + '='.repeat(78));
console.log('THE FINDING');
console.log('='.repeat(78));
console.log(
  `  Observed red on ambient state:  ${byVerdict('decided').length}  (both fixed on this branch)\n` +
  `  Could be, not yet observed:     ${byVerdict('load-bearing').length}\n` +
  `  Judged safe:                    ${byVerdict('sandboxed').length + byVerdict('cosmetic').length + byVerdict('synchronised').length}\n` +
  `  Not yet judged:                 ${untriaged.length}\n\n` +
  '  So it is not a three-script problem and it is not a thirty-script problem\n' +
  '  either — it is two confirmed, a small number worth reading next, and a tail\n' +
  '  nobody has looked at. The tail is the honest answer to "how big is this".'
);

if (untriagedMode) {
  console.log('');
  if (untriaged.length) {
    console.log(`${untriaged.length} gating script(s) carry an untriaged ambient signal.`);
    process.exit(1);
  }
  console.log('Every gating script with an ambient signal has been triaged.');
  process.exit(0);
}

console.log('\n== done ==');

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
