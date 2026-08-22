// Live proof for KAN-544: the agent cap can be lowered while the daemon runs,
// takes effect on the next admission, survives a restart, and never degrades
// into a cap of 0.
//
// WHAT FAILURE THIS WOULD CATCH: the cap being changeable only by editing a
// systemd drop-in and running `systemctl --user restart butchr-daemon` — so the
// one moment an operator needs to scale the fleet down is the moment the fix
// costs every channel registration and every session on the machine. Sessions
// are made by activation and do not re-form by themselves, so a restart under
// load is how a struggling machine becomes an unaddressable one.
//
// Secondarily, and this is the direction that would hurt more: a malformed
// override file being read as a cap of 0. A cap of 0 admits nothing, so a
// truncated write — the likeliest kind, since the edit happens under load —
// would take the whole fleet down by way of a typo.
//
// CI-RUNNABLE: partial — sections 2 to 8 need nothing but a build and a temp
// directory, so they run anywhere. Section 1, the unfixed baseline that makes
// the rest mean anything, needs a second dist built from origin/main's
// capacity.ts and is SKIPPED with a note when one is not supplied. A skipped
// section is reported as skipped and never counted as a pass, so a CI run
// cannot read as though the red had been demonstrated. The red itself is in the
// PR body, run by hand with the commands in the Usage block below.
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// This script writes the override file it then asserts on. That is faithful
// rather than circular for the interface under test — an operator writing that
// file by hand IS the supported path, and the ticket's argument for a file over
// an in-memory setter is precisely that `echo '{"maxAgents":2}' > file` works
// when an MCP round-trip may not. So the input this supplies is the real input.
//
// What it therefore does NOT cover, named rather than left to inference:
//
//   - That `butchr_set_capacity` reaches this file across a real daemon
//     socket. The MCP tool definition, the router's dispatch entry and the
//     socket round-trip are untested here. What IS covered is the substantive
//     half of that path: the writer this script exercises
//     (`setCapacityOverride` / `clearCapacityOverride`) is the exact function
//     the router handler calls, and section 6 asserts the handler's refusal
//     predicate agrees with the reader to the digit — a writer that accepts
//     what the reader will later discard is a control that reports success and
//     changes nothing. WHO COVERS THE REMAINDER: nobody yet. It cannot be
//     demonstrated against the daemon running on this machine, which is an
//     older build with no such tool, and it is named in the PR body as an
//     uncovered edge rather than implied to be tested.
//   - Eviction. There is none, deliberately and by the ticket's own words.
//     Section 4 asserts the cap binds ADMISSION; nothing here claims a running
//     agent is stopped, because nothing stops one.
//   - CrabCast's independent CRABCAST_MAX_AGENTS gate, which lives in another
//     process and another repository and can refuse a start Butchr admits.
//
// Isolation is by $HOME. The override path derives from os.homedir() at module
// load, so a temp HOME set before the first dist import keeps every write in
// this run out of ~/.local/share/butchr entirely — the operator's real override
// file, if they have one, is never read and never touched.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-capacity-runtime-override.mjs
//
//   # with the unfixed baseline for section 1 — origin/main's capacity.ts,
//   # everything else current, built where node_modules still resolves.
//   # tsc has no noEmitOnError here, so the type errors router.ts raises
//   # against the older Capacity shape do not stop capacity.js being emitted,
//   # which is the only file section 1 imports.
//   cp src/capacity.ts /tmp/kan544-capacity-fixed.ts
//   git show "$(git merge-base HEAD origin/main):daemon/src/capacity.ts" > src/capacity.ts
//   npx tsc --outDir dist-unfixed
//   cp /tmp/kan544-capacity-fixed.ts src/capacity.ts
//   npm run build
//   node scripts/verify-capacity-runtime-override.mjs dist dist-unfixed

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, process.argv[2] ?? 'dist');
const unfixedArg = process.argv[3] ?? null;
const unfixedDir = unfixedArg ? path.resolve(daemonDir, unfixedArg) : null;

// $HOME first, before anything from dist is loaded: BUTCHR_DIR is computed at
// module load from os.homedir(), so this is the only moment the isolation can
// be established.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan544-home-'));
process.env.HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.local', 'share', 'butchr'), { recursive: true });

let failures = 0;
let passes = 0;
const skipped = [];

function check(label, condition, detail) {
  if (condition) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==\n`);
}

if (!fs.existsSync(path.join(distDir, 'capacity.js'))) {
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

const { optionsFromEnv, computeCapacity, readCapacity, describeCapacity, summarizeCapacity } =
  await import(path.join(distDir, 'capacity.js'));
const {
  CAPACITY_OVERRIDE_PATH,
  MAX_OVERRIDE_AGENTS,
  loadCapacityOverride,
  setCapacityOverride,
  clearCapacityOverride,
  isUsableCap
} = await import(path.join(distDir, 'capacity-override.js'));

console.log(`isolated HOME:   ${tmpHome}`);
console.log(`override file:   ${CAPACITY_OVERRIDE_PATH}`);
check(
  'the override path is inside the isolated HOME, so nothing here can touch a real one',
  CAPACITY_OVERRIDE_PATH.startsWith(tmpHome),
  `path was ${CAPACITY_OVERRIDE_PATH}, expected it under ${tmpHome}`
);

/** Roomy synthetic hardware, so the count term is the only one that can bind. */
const ROOMY = {
  cores: 64,
  totalBytes: 512 * 1024 * 1024 * 1024,
  availableBytes: 480 * 1024 * 1024 * 1024,
  load1: 0,
  busyCores: 0,
  busyWindowSeconds: 10,
  stall: { io: { state: 'measured', fullAvg10Percent: 0 }, memory: { state: 'measured', fullAvg10Percent: 0 } }
};

const writeRaw = (body) => fs.writeFileSync(CAPACITY_OVERRIDE_PATH, body);
const removeFile = () => {
  try {
    fs.unlinkSync(CAPACITY_OVERRIDE_PATH);
  } catch {}
};

// ---------------------------------------------------------------------------
section('1. unfixed: the cap does NOT move, which is the defect');
// ---------------------------------------------------------------------------
if (!unfixedDir) {
  const note =
    'no unfixed dist supplied, so the pre-fix baseline was not run. ' +
    'Section 1 is the RED for this proof; without it sections 2-7 show the ' +
    'fixed behaviour and show nothing about what it fixed. Build one with the ' +
    'commands in this file\'s header.';
  skipped.push(`section 1 — ${note}`);
  console.log(`  SKIP  ${note}`);
} else if (!fs.existsSync(path.join(unfixedDir, 'capacity.js'))) {
  const note = `no capacity.js at ${unfixedDir}`;
  skipped.push(`section 1 — ${note}`);
  console.log(`  SKIP  ${note}`);
} else {
  const unfixed = await import(path.join(unfixedDir, 'capacity.js'));
  process.env.BUTCHR_MAX_AGENTS = '9';
  removeFile();
  const before = unfixed.optionsFromEnv().configuredCap;
  // The operator's emergency action, against the old build.
  writeRaw(JSON.stringify({ maxAgents: 2 }));
  const after = unfixed.optionsFromEnv().configuredCap;
  console.log(`  BUTCHR_MAX_AGENTS=9, no override file  -> configuredCap ${before}`);
  console.log(`  override file written {"maxAgents":2}  -> configuredCap ${after}`);
  check(
    'unfixed: writing the override file changes nothing — the cap is still 9',
    before === 9 && after === 9,
    `before=${before} after=${after}; expected 9 and 9`
  );
  check(
    'unfixed: the file the operator wrote is on disk, so the no-op is the code and not the write',
    fs.existsSync(CAPACITY_OVERRIDE_PATH),
    'the override file was not written at all, so this section measured nothing'
  );
  console.log(
    '\n  -> On this build the ONLY way to move the cap is to edit the systemd\n' +
    '     drop-in and restart the daemon, which drops every session on the machine.'
  );
  removeFile();
}

// ---------------------------------------------------------------------------
section('2. fixed: the cap moves in ONE running process, with no restart');
// ---------------------------------------------------------------------------
process.env.BUTCHR_MAX_AGENTS = '9';
removeFile();
const envOnly = optionsFromEnv();
check(
  'with no override file the env var answers, exactly as before this change',
  envOnly.configuredCap === 9,
  `configuredCap=${envOnly.configuredCap}, expected 9`
);
check(
  'and it says so: origin names the variable',
  envOnly.configuredCapOrigin?.source === 'env' &&
    envOnly.configuredCapOrigin.variable === 'BUTCHR_MAX_AGENTS',
  JSON.stringify(envOnly.configuredCapOrigin)
);

const pidBefore = process.pid;
check('the operator writes the override file', setCapacityOverride(2));
const afterWrite = optionsFromEnv();
check(
  'the SAME process now reads cap 2 — no restart, no re-import, no re-read of the env',
  afterWrite.configuredCap === 2 && process.pid === pidBefore,
  `configuredCap=${afterWrite.configuredCap} pid=${process.pid} (was ${pidBefore})`
);
check(
  'and process.env.BUTCHR_MAX_AGENTS is untouched, so the file is what moved and not the environment',
  process.env.BUTCHR_MAX_AGENTS === '9',
  `BUTCHR_MAX_AGENTS=${process.env.BUTCHR_MAX_AGENTS}`
);
check(
  'the origin names the file rather than the variable',
  afterWrite.configuredCapOrigin?.source === 'override-file' &&
    afterWrite.configuredCapOrigin.path === CAPACITY_OVERRIDE_PATH &&
    afterWrite.configuredCapOrigin.overrides === 9,
  JSON.stringify(afterWrite.configuredCapOrigin)
);

// Two more writes in the same process, to show it is a live control rather
// than a one-shot that happened to be read once.
setCapacityOverride(5);
const five = optionsFromEnv().configuredCap;
setCapacityOverride(1);
const one = optionsFromEnv().configuredCap;
check(
  'it keeps tracking: 2 -> 5 -> 1 across three writes in one process',
  five === 5 && one === 1,
  `read back ${five} then ${one}`
);

// The cap and its provenance must never disagree, whatever is on disk. A
// report naming the override file beside a cap the env var set is worse than a
// report with no provenance at all, because the origin is the field a reader
// consults to decide whether a restart is needed. Driven across every state
// this function has rather than the one that happens to be set up.
let pairingHeld = true;
let pairingDetail = '';
for (const [label, prepare] of [
  ['override in force', () => setCapacityOverride(4)],
  ['env only', () => removeFile()],
  ['malformed file, env behind it', () => writeRaw('{"maxAgents":')],
  ['zero in the file, env behind it', () => writeRaw('{"maxAgents":0}')]
]) {
  prepare();
  const o = optionsFromEnv();
  const onDisk = loadCapacityOverride();
  const expectedCap = onDisk ? onDisk.maxAgents : 9;
  const expectedSource = onDisk ? 'override-file' : 'env';
  if (o.configuredCap !== expectedCap || o.configuredCapOrigin?.source !== expectedSource) {
    pairingHeld = false;
    pairingDetail =
      `${label}: cap=${o.configuredCap} origin=${JSON.stringify(o.configuredCapOrigin)}, ` +
      `expected cap=${expectedCap} source=${expectedSource}`;
    break;
  }
}
check(
  'the cap and the origin never disagree — the reported source is always the one that set the number',
  pairingHeld,
  pairingDetail
);

// One link closer to the gate than optionsFromEnv: readCapacity is what the
// daemon's admission path actually calls, and it calls optionsFromEnv fresh.
setCapacityOverride(3);
const live = readCapacity(0, 0);
check(
  'readCapacity() — the daemon\'s own entry point — reports the overridden cap',
  live.cap === 3 && live.capBoundBy === 'configured',
  `cap=${live.cap} capBoundBy=${live.capBoundBy}`
);

// ---------------------------------------------------------------------------
section('3. it binds admission: cap -> headroomByCap -> headroom -> atCapacity');
// ---------------------------------------------------------------------------
// Synthetic roomy hardware so the count term is the only one that can bind,
// which is what makes the flip attributable to the cap and to nothing else.
const at2 = computeCapacity(ROOMY, 2, { configuredCap: 2 });
const at9 = computeCapacity(ROOMY, 2, { configuredCap: 9 });
console.log(`  cap 2, running 2 -> headroom ${at2.headroom}, atCapacity ${at2.atCapacity}`);
console.log(`  cap 9, running 2 -> headroom ${at9.headroom}, atCapacity ${at9.atCapacity}`);
check(
  'a cap of 2 with 2 running refuses the next start',
  at2.headroom === 0 && at2.atCapacity === true && at2.headroomBoundBy === 'cap',
  `headroom=${at2.headroom} atCapacity=${at2.atCapacity} boundBy=${at2.headroomBoundBy}`
);
check(
  'changing ONLY the cap flips the gate, so the gate is reading it',
  at9.atCapacity === false && at9.headroom === 7,
  `headroom=${at9.headroom} atCapacity=${at9.atCapacity}`
);

// And the same flip driven by the file rather than by a literal option, which
// is the whole claim: an operator's write reaches the gate.
setCapacityOverride(2);
const gateLow = computeCapacity(ROOMY, 2, optionsFromEnv());
setCapacityOverride(9);
const gateHigh = computeCapacity(ROOMY, 2, optionsFromEnv());
check(
  'driven from the file: 2 refuses, 9 admits, same process, same env',
  gateLow.atCapacity === true && gateHigh.atCapacity === false,
  `low.atCapacity=${gateLow.atCapacity} high.atCapacity=${gateHigh.atCapacity}`
);
console.log(
  '\n  -> NOTE what this does NOT show, because the ticket is explicit about it:\n' +
  '     nothing above evicts anything. Lowering the cap stops new starts; the two\n' +
  '     agents already running keep running until they finish on their own.'
);

// ---------------------------------------------------------------------------
section('4. a malformed file falls through — and NEVER yields cap 0');
// ---------------------------------------------------------------------------
process.env.BUTCHR_MAX_AGENTS = '7';
const badFiles = [
  ['empty file', ''],
  ['whitespace only', '   \n'],
  ['truncated json — the likeliest bad write under load', '{"maxAgents":'],
  ['not json at all', 'maxAgents=2'],
  ['json but not an object', '"2"'],
  ['an array', '[2]'],
  ['null', 'null'],
  ['object without the key', '{"max_agents":2}'],
  ['zero — the one that would stop the fleet', '{"maxAgents":0}'],
  ['negative', '{"maxAgents":-3}'],
  ['fractional', '{"maxAgents":2.5}'],
  ['a string that looks like a number', '{"maxAgents":"2"}'],
  ['NaN via a non-number', '{"maxAgents":true}'],
  ['absurdly large', `{"maxAgents":${MAX_OVERRIDE_AGENTS + 1}}`],
  ['Infinity, which JSON cannot hold but a hand-edit can attempt', '{"maxAgents":1e999}']
];
for (const [label, body] of badFiles) {
  writeRaw(body);
  const opts = optionsFromEnv();
  const cap = computeCapacity(ROOMY, 0, opts).cap;
  check(
    `${label}: falls through to BUTCHR_MAX_AGENTS=7, and cap is ${cap}`,
    opts.configuredCap === 7 && cap === 7 && cap !== 0,
    `configuredCap=${opts.configuredCap} cap=${cap} — expected 7, and never 0`
  );
}

// The same table with no env var either: the derivation must answer, and it
// must not answer 0. This is the arm that would catch a fall-through that fell
// all the way to a cap of nothing.
delete process.env.BUTCHR_MAX_AGENTS;
let derivedFloorHeld = true;
let derivedDetail = '';
for (const [label, body] of badFiles) {
  writeRaw(body);
  const opts = optionsFromEnv();
  const c = computeCapacity(ROOMY, 0, opts);
  if (opts.configuredCap !== null || c.cap < 1 || c.capBoundBy === 'configured') {
    derivedFloorHeld = false;
    derivedDetail = `${label}: configuredCap=${opts.configuredCap} cap=${c.cap} boundBy=${c.capBoundBy}`;
    break;
  }
}
check(
  'with no env var either, every malformed file falls through to the derivation and cap stays >= 1',
  derivedFloorHeld,
  derivedDetail
);

// A missing file is not an error state, it is the ordinary one.
removeFile();
check(
  'an absent file is silent: no override, no origin, derivation answers',
  loadCapacityOverride() === null && optionsFromEnv().configuredCapOrigin === null,
  JSON.stringify(optionsFromEnv().configuredCapOrigin)
);

// ---------------------------------------------------------------------------
section('5. it survives a daemon restart — measured in a FRESH process');
// ---------------------------------------------------------------------------
// A restart is a new process reading the same disk. So this is a new process
// reading the same disk: nothing is carried over in memory, and the assertion
// is made by code that was not running when the file was written.
process.env.BUTCHR_MAX_AGENTS = '9';
setCapacityOverride(2);
const probe = `
  const { optionsFromEnv } = await import(${JSON.stringify(path.join(distDir, 'capacity.js'))});
  const o = optionsFromEnv();
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    configuredCap: o.configuredCap,
    origin: o.configuredCapOrigin
  }));
`;
const raw = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
  encoding: 'utf8',
  env: { ...process.env, HOME: tmpHome, BUTCHR_MAX_AGENTS: '9' }
});
const restarted = JSON.parse(raw);
console.log(`  fresh process pid ${restarted.pid} (this one is ${process.pid})`);
console.log(`  it reads configuredCap ${restarted.configuredCap}`);
check(
  'a process that was not running when the file was written reads cap 2',
  restarted.configuredCap === 2 && restarted.pid !== process.pid,
  `configuredCap=${restarted.configuredCap} pid=${restarted.pid}`
);
check(
  'and it names the same file, so the two processes agree on where the cap lives',
  restarted.origin?.source === 'override-file' &&
    restarted.origin.path === CAPACITY_OVERRIDE_PATH,
  JSON.stringify(restarted.origin)
);

// The positive control for the section above: with the file removed, the same
// fresh-process probe must come back with the env value. A probe that reported
// 2 whatever the disk held would have measured nothing.
removeFile();
const controlRaw = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
  encoding: 'utf8',
  env: { ...process.env, HOME: tmpHome, BUTCHR_MAX_AGENTS: '9' }
});
const control = JSON.parse(controlRaw);
check(
  'positive control: the same probe with the file deleted reads 9, so it is reading the disk',
  control.configuredCap === 9 && control.origin?.source === 'env',
  `configuredCap=${control.configuredCap} origin=${JSON.stringify(control.origin)}`
);

// ---------------------------------------------------------------------------
section('6. the writer and the reader agree, to the digit');
// ---------------------------------------------------------------------------
// A writer that accepts what the reader will discard is a control that reports
// success and changes nothing — the failure-as-success shape this repository
// keeps re-finding. The router's refusal uses isUsableCap; so does the writer;
// so does the reader. This asserts the three cannot drift.
const candidates = [
  -1, 0, 0.5, 1, 2, 1023, MAX_OVERRIDE_AGENTS, MAX_OVERRIDE_AGENTS + 1,
  Number.NaN, Number.POSITIVE_INFINITY, 1e12
];
let agreementHeld = true;
let agreementDetail = '';
for (const value of candidates) {
  removeFile();
  const accepted = setCapacityOverride(value);
  const readBack = loadCapacityOverride();
  const predicate = isUsableCap(value);
  if (accepted !== predicate) {
    agreementHeld = false;
    agreementDetail = `${value}: writer accepted=${accepted}, predicate said ${predicate}`;
    break;
  }
  if (accepted && readBack?.maxAgents !== value) {
    agreementHeld = false;
    agreementDetail = `${value}: written but read back as ${JSON.stringify(readBack)}`;
    break;
  }
  if (!accepted && readBack !== null) {
    agreementHeld = false;
    agreementDetail = `${value}: refused but a file was left behind: ${JSON.stringify(readBack)}`;
    break;
  }
}
check(
  'every value the writer accepts the reader returns, and every value it refuses leaves no file',
  agreementHeld,
  agreementDetail
);
check(
  'zero is refused by the writer, not merely ignored by the reader',
  setCapacityOverride(0) === false && loadCapacityOverride() === null,
  'a zero cap reached disk'
);

// ---------------------------------------------------------------------------
section('7. the report says the override is in force and names the file');
// ---------------------------------------------------------------------------
process.env.BUTCHR_MAX_AGENTS = '9';
setCapacityOverride(2);
const reported = computeCapacity(ROOMY, 0, optionsFromEnv());
const derivation = describeCapacity(reported);
const summary = summarizeCapacity(reported);
const capLine = derivation.split('\n').find((l) => l.startsWith('cap:'));
console.log(`  ${capLine}`);
console.log(`  summary: ${summary}`);
check(
  'the derivation names the override file by path',
  typeof capLine === 'string' && capLine.includes(CAPACITY_OVERRIDE_PATH),
  capLine
);
check(
  'it says a restart is not needed',
  typeof capLine === 'string' && capLine.includes('no daemon restart'),
  capLine
);
check(
  'it says what it overrode, so a drop-in that appears ignored is explained',
  typeof capLine === 'string' && capLine.includes('BUTCHR_MAX_AGENTS=9'),
  capLine
);
check(
  'it says it throttles admission and does not evict',
  typeof capLine === 'string' && capLine.includes('does not evict'),
  capLine
);
check(
  'the one-line summary says the cap is changeable without a restart',
  summary.includes('without a restart'),
  summary
);

// The other side of it: with no override, none of that is said. A report that
// mentioned the file whether or not it was in force would carry no information.
removeFile();
const plain = describeCapacity(computeCapacity(ROOMY, 0, optionsFromEnv()));
const plainSummary = summarizeCapacity(computeCapacity(ROOMY, 0, optionsFromEnv()));
check(
  'with no override in force the report is silent about the file',
  !plain.includes(CAPACITY_OVERRIDE_PATH) && !plainSummary.includes('without a restart'),
  plain.split('\n').find((l) => l.startsWith('cap:'))
);
check(
  'and it still names BUTCHR_MAX_AGENTS, which is what set the cap then',
  plain.includes('set by BUTCHR_MAX_AGENTS'),
  plain.split('\n').find((l) => l.startsWith('cap:'))
);

// ---------------------------------------------------------------------------
section('8. clearing hands the cap back');
// ---------------------------------------------------------------------------
setCapacityOverride(2);
check('precondition: the override is in force', optionsFromEnv().configuredCap === 2);
check('clear reports success', clearCapacityOverride() === true);
check(
  'the cap falls back to BUTCHR_MAX_AGENTS',
  optionsFromEnv().configuredCap === 9 && optionsFromEnv().configuredCapOrigin?.source === 'env',
  JSON.stringify(optionsFromEnv())
);
check(
  'clearing again is not an error — an absent file is the state the caller wanted',
  clearCapacityOverride() === true
);
delete process.env.BUTCHR_MAX_AGENTS;
check(
  'with the env var gone too, the derivation answers and nothing is configured',
  optionsFromEnv().configuredCap === null &&
    computeCapacity(ROOMY, 0, optionsFromEnv()).capBoundBy !== 'configured',
  JSON.stringify(optionsFromEnv())
);

// ---------------------------------------------------------------------------
try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {}

console.log('');
for (const note of skipped) console.log(`SKIPPED: ${note}`);
console.log(`\n${passes} passed, ${failures} failed, ${skipped.length} section(s) skipped`);
console.log(failures ? '\nFAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
