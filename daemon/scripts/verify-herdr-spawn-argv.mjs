#!/usr/bin/env node
// verify-herdr-spawn-argv.mjs — KAN-533
//
// WHAT FAILURE THIS WOULD CATCH: a spawn path that still speaks herdr 0.6's
// `agent start` — passing `--cwd`, `--tab`, `--no-focus` or a trailing
// `bash -c "<command>"` — which on the herdr the official installer hands a new
// user dies with `unknown option`, so EVERY activation fails and Butchr can
// start no agent at all. It also catches the same defect wearing the opposite
// costume: a version check that has silently gone back to pinning ONE herdr
// line, which is what made a working 0.8.0 install report itself broken.
//
// CI-RUNNABLE: yes — reads `daemon/src/*.ts` as TEXT and imports the built
// daemon's `herdr-health.js`. No herdr binary, no server, no pane, no PTY.
//
// ⚠ THIS SCRIPT'S EXIT CODE IS A BLEND — READ THE SECTION, NOT THE VERDICT,
// AFTER A FAILED BUILD. Sections 1-3 and 6 read `src/*.ts` and `docs/SETUP.md`
// as TEXT, so they test whatever is checked out and are unaffected by a build
// that did not run. Sections 4-5 import `dist/herdr-health.js`, so after a
// failed build they silently test the PREVIOUS build. A red from this script
// therefore does not by itself tell you which code it was about: confirm
// `npm run build` exited 0 first — and read that exit code unpiped, because
// `npm run build | tail` reports `tail`'s status and not the compiler's.
//
// ⚠ WHAT THIS SCRIPT DOES NOT COVER, NAMED BECAUSE THE GAP IS THE INTERESTING
// PART. Every assertion here is about what the daemon would SAY to herdr. None
// of them is evidence that herdr accepts it — this script supplies its own
// input, which is exactly the KAN-145 shape called out in `prompts/task.md`:
// "a proof that supplies its own input has not tested that the input arrives."
// The arrival half is covered by a live activation against a real 0.7 server,
// which cannot run in CI (it needs a herdr server, a workspace and a PTY); the
// transcript of that run is pasted in the KAN-533 PR body, and
// `daemon/scripts/probe-herdr-07-activation.mjs` is the harness that produced
// it. Neither half is sufficient alone and this header is the seam between them.

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const srcDir = path.join(daemonDir, 'src');
const dist = path.join(daemonDir, 'dist');
const verbose = process.argv.includes('--verbose');

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) say(`        ${detail}`);
  return ok;
};

const read = (file) => readFileSync(path.join(srcDir, file), 'utf8');

/**
 * The same source with its comments removed.
 *
 * ⚠ NOT COSMETIC — WITHOUT IT THIS SCRIPT REPORTS ITS OWN DOCUMENTATION AS A
 * DEFECT. Both files under test *describe* the 0.6 spelling they replaced —
 * `launchers.ts` quotes `claude … --continue || claude … '<prompt>'` in the
 * docblock explaining why the `||` is gone — so a text search for the old form
 * finds it in prose and calls the port incomplete. Caught by this script going
 * red on a correct tree, which is the cheap direction to find it in.
 *
 * Block comments go first so a `//` inside one cannot survive; only whole-line
 * `//` comments are stripped after that, because a trailing `//` is rare here
 * and a naive rule would eat the `//` in a URL inside a string literal.
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

// Setup guard, not a verdict: a missing build means this script cannot answer,
// which is a different thing from the answer being "no". See the exit at the end
// for where the real verdict comes from.
if (!existsSync(path.join(dist, 'herdr-health.js'))) {
  console.error('daemon/dist/herdr-health.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

say('== 1. the spawn path speaks 0.7, and none of the four dropped options survives ==');
say('');

const herdrSrc = stripComments(read('herdr.ts'));

// The `agent start` invocation, extracted rather than grepped for across the
// whole file: `--cwd` is a perfectly good flag on `tab create` and on
// `workspace create`, both of which this file still calls and must keep calling.
// A file-wide grep for `--cwd` would go red on correct code, which is the
// false-positive that makes a check get deleted.
const startCall = /'agent',\s*'start'[\s\S]{0,900}?\n\s*\]\);/.exec(herdrSrc);
check(startCall !== null, "an `agent start` invocation is present in herdr.ts");

if (startCall) {
  const call = startCall[0];
  if (verbose) say(`        ${call.replace(/\s+/g, ' ').slice(0, 220)}…`);

  check(/'--kind'/.test(call), '`agent start` passes --kind');
  check(/'--pane'/.test(call), '`agent start` passes --pane');

  for (const dropped of ['--cwd', '--tab', '--no-focus']) {
    check(
      !call.includes(`'${dropped}'`),
      `\`agent start\` no longer passes ${dropped}`,
      `still present in the agent-start call`
    );
  }

  // The trailing command specifically, which is the one that is NOT simply
  // absent — `--` survives in 0.7 and carries the agent's arguments. What must
  // be gone is the shell: `bash -c <string>` after the `--`.
  check(
    !/'bash'\s*,\s*'-c'/.test(call),
    '`agent start` no longer passes a `bash -c` command after `--`'
  );
  check(
    /launch\.argv\.slice\(1\)/.test(call),
    'only argv[1..] crosses `--`; the executable comes from --kind'
  );
}

say('');
say('== 2. the environment and the cwd moved to `tab create`, they were not dropped ==');
say('');

// Each dropped option needs an answer, not an absence (AC 5 of KAN-533). A port
// that deleted `--cwd` and never re-homed it would pass section 1 and start every
// agent in the wrong directory.
const tabCreate = /'tab',\s*'create'[\s\S]{0,900}?\n\s*\]\)/.exec(herdrSrc);
check(tabCreate !== null, 'a `tab create` invocation is present');
if (tabCreate) {
  const call = tabCreate[0];
  check(/'--cwd'/.test(call), '--cwd re-homed onto `tab create`');
  check(/'--no-focus'/.test(call), '--no-focus re-homed onto `tab create`');
  check(/'--env'/.test(call), "the `env KEY=VALUE` argv prefix re-homed onto `tab create --env`");
}

// PATH and the resume thresholds are what that prefix carried. A port that wired
// up `--env` and then passed it nothing would satisfy the check above.
check(
  /PATH:\s*process\.env\.PATH/.test(herdrSrc),
  'PATH is actually passed through the new env route'
);
check(
  /\.\.\.RESUME_ENV/.test(herdrSrc),
  'RESUME_ENV is actually passed through the new env route'
);

say('');
say('== 3. the `||` was replaced by a measurement, not by a guess ==');
say('');

const launchersSrc = stripComments(read('launchers.ts'));

check(
  !/--continue\s*\|\|/.test(launchersSrc),
  'the shell `||` is gone from the launcher'
);
check(
  /hasConversation\s*\?/.test(launchersSrc),
  'the resume arm is selected by `hasConversation`'
);
// ⚠ THE ASSERTION THAT MATTERS. `hasConversation` could be wired to anything —
// `false`, a config flag, `session.resume` — and every other check here would
// still pass while every resumed agent silently started a fresh conversation on
// top of live work. It has to come from the disk read.
check(
  /hasConversation:\s*hasRestorableConversation\(/.test(herdrSrc),
  '`hasConversation` is fed from hasRestorableConversation(), not from a guess',
  'the caller must pass the real on-disk answer'
);

// One splice, above the branch — the KAN-246 half-flagged-command invariant,
// restated for argv. Both arms must be suffixes of one `flags` array.
check(
  /const flags = \[\.\.\.channelFlags, \.\.\.CLAUDE_BASE_FLAGS\]/.test(launchersSrc),
  'the flags are spliced ONCE, above the arm choice, so no arm can be half-flagged'
);

say('');
say('== 4. the version check is a FLOOR, not a pin ==');
say('');

const health = await import(`file://${path.join(dist, 'herdr-health.js')}`);
const { checkHerdrVersion, MINIMUM_HERDR_MAJOR_MINOR, VERIFIED_HERDR_MAJOR_MINOR } = health;

check(MINIMUM_HERDR_MAJOR_MINOR === '0.7', `the floor is 0.7`, `got ${MINIMUM_HERDR_MAJOR_MINOR}`);

// The whole span between floor and verified must be silent. Written as a range
// rather than as the one version somebody happened to test, because an equality
// pin passes a single-version test by construction — that is precisely how the
// old check looked correct while failing every release after the one it named.
for (const v of ['herdr 0.7.0', 'herdr 0.7.5', 'herdr 0.8.0']) {
  check(checkHerdrVersion(v) === undefined, `${v} is accepted silently`);
}

// Below the floor: refused, and the message must name the VERSION problem. A
// refusal that just said "spawn failed" would leave the user exactly where
// herdr's own `unknown option` left them.
const tooOld = checkHerdrVersion('herdr 0.6.4');
check(typeof tooOld === 'string', '0.6.4 is refused');
if (typeof tooOld === 'string') {
  check(/0\.7/.test(tooOld), 'the refusal names the version needed');
  check(/--kind|--pane/.test(tooOld), 'the refusal names the API that is missing');
  check(
    /install\.sh|herdr\.dev/.test(tooOld),
    'the refusal says how to fix it, with the OFFICIAL installer'
  );
  // The pin is what this ticket removed. A refusal still pointing at a
  // hand-downloaded 0.6.4 URL would be the old world surviving in a string.
  check(
    !/releases\/download\/v0\.6/.test(tooOld),
    'the refusal does NOT point at the retired pinned download'
  );
}

// Above verified: a note, not an alarm, and it must not claim breakage it has
// not seen. This is the branch that was wrong before — it asserted every newer
// herdr would fail, and 0.8.0 does not.
const newer = checkHerdrVersion('herdr 0.9.0');
check(typeof newer === 'string', '0.9.0 produces a note');
if (typeof newer === 'string') {
  check(
    !/will fail|every activation/i.test(newer),
    'the note does not assert a failure it has not observed',
    newer
  );
  check(/verified/i.test(newer), 'the note says what is actually true: it is unverified');
}

// Unreadable stays silent — refusing to run on an unparseable version would
// break every future release, which is the reason this branch exists.
check(checkHerdrVersion('some other tool') === undefined, 'an unreadable version is not an alarm');

say('');
say('== 5. butchr-doctor agrees with the daemon ==');
say('');

// Two surfaces reporting the same fact is how they disagree. Doctor cannot
// import the constants (it must run against an unbuilt clone), so the only thing
// keeping them in step is this check.
const doctorSrc = readFileSync(path.join(scriptDir, 'butchr-doctor.mjs'), 'utf8');
const minMatch = /const MINIMUM_HERDR = \[(\d+), (\d+)\]/.exec(doctorSrc);
const verMatch = /const VERIFIED_HERDR = \[(\d+), (\d+)\]/.exec(doctorSrc);
check(minMatch !== null && verMatch !== null, 'doctor declares both bounds');
if (minMatch && verMatch) {
  check(
    `${minMatch[1]}.${minMatch[2]}` === MINIMUM_HERDR_MAJOR_MINOR,
    "doctor's floor matches the daemon's",
    `doctor ${minMatch[1]}.${minMatch[2]} vs daemon ${MINIMUM_HERDR_MAJOR_MINOR}`
  );
  check(
    `${verMatch[1]}.${verMatch[2]}` === VERIFIED_HERDR_MAJOR_MINOR,
    "doctor's verified line matches the daemon's",
    `doctor ${verMatch[1]}.${verMatch[2]} vs daemon ${VERIFIED_HERDR_MAJOR_MINOR}`
  );
}
check(
  !/releases\/download\/v0\.6/.test(doctorSrc),
  'doctor no longer hands out the pinned 0.6.4 download'
);

say('');
say('== 6. SETUP.md no longer tells the user to pin ==');
say('');

const setup = readFileSync(path.resolve(daemonDir, '..', 'docs', 'SETUP.md'), 'utf8');
check(
  !/releases\/download\/v0\.6\.4/.test(setup),
  'the pinned-download command is gone from SETUP.md'
);
check(
  !/do \*\*not\*\* run `herdr update`|Do \*\*not\*\* run `herdr update`/i.test(setup),
  'the "do not run herdr update" warning is gone from SETUP.md'
);
check(
  /install\.sh/.test(setup),
  'SETUP.md points at the official installer'
);

say('');
say('== 7. a spawn failure on an old herdr names the VERSION, not just a flag ==');
say('');

// AC 3 of KAN-533. Upstream's own message is a bare getopt error, and a user
// holding `unknown option: --env` has no way to know it is a version problem.
// The strings below are what herdr 0.6.4 ACTUALLY answered the ported daemon —
// `--env` from `tab create`, which is reached before `agent start`, so a
// diagnosis matching only `--kind` would miss the message really produced.
const { diagnoseSpawnFailure } = health;
for (const [flag, note] of [
  ['--env', 'the flag 0.6.4 actually rejects first, from `tab create`'],
  ['--kind', 'the flag `agent start` would reject next'],
  ['--pane', 'and its companion']
]) {
  const diagnosed = diagnoseSpawnFailure(`unknown option: ${flag}`);
  check(/VERSION mismatch/i.test(diagnosed), `\`unknown option: ${flag}\` is named a version mismatch`, note);
  check(/0\.7/.test(diagnosed), `  …and the message names 0.7`);
  check(/install\.sh/.test(diagnosed), `  …and says how to fix it`);
}

// The other direction, which is what stops this from being a rule that fires on
// everything: an unrelated spawn failure must NOT be relabelled a version
// problem. A diagnosis that explained every error would explain none.
const unrelated = diagnoseSpawnFailure('ghostty error -2');
check(
  !/VERSION mismatch/i.test(unrelated),
  'an unrelated spawn failure is NOT relabelled a version problem',
  'the geometry failure keeps its own diagnosis'
);
check(
  /pane-geometry/i.test(unrelated),
  '  …and still gets the diagnosis it always had'
);

say('');
say(failures === 0
  ? 'PASS: the spawn path speaks herdr 0.7+, every dropped option has a home, and the version check is a floor.'
  : `FAIL: ${failures} check(s) failed.`);

process.exit(failures ? 1 : 0);
