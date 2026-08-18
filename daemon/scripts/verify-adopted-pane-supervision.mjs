// KAN-538 — every pane this daemon serves is announced once, whoever started
// it, and an adopted one that is parked at a startup dialog gets answered.
//
// WHAT FAILURE THIS WOULD CATCH: a live agent taken into the fleet by
// `adoptFromCensus` with nothing watching its pane, sitting at an unanswered
// development-channels dialog indefinitely while the board reports it as
// running. Measured on 2026-08-18: `story/KAN-117` and `epic/KAN-59` — both
// SUPERVISORS — sat at that dialog with zero child processes for 90 minutes,
// and nothing anywhere went red. The reconciler read them as `already running;
// leaving it alone`, which was true, and the channel-registration line reported
// that `the agents are fine`, which was not.
//
// ---------------------------------------------------------------------------
// THE DISCRIMINATOR THIS PROVES, AND THE ONE IT REPLACES
// ---------------------------------------------------------------------------
// KAN-538 was filed naming `restore` vs `provision` as the mechanism and THAT
// MECHANISM IS REFUTED. A restore sometimes provisions and sometimes does not,
// so `Restoring` separates nothing: it sits upstream of the branch that decides.
//
// The branch that decides is `provision()` vs `adoptFromCensus()`.
// `superviseChannelStartup` has exactly one call site, gated on the runtime's
// spawn listener, which fires from exactly one place — the tail of
// `provision()`. `adoptFromCensus()` is the only other way a live session enters
// `CrabCastRuntime.sessions`, and before this change it fired nothing.
//
// MEASURED, BOTH COLUMNS, over the 13 daemon runs since the CrabCast spawn
// listener went live (2026-08-18T04:34:53Z, the first
// `setAgentSpawnedListener: registered and LIVE` line in daemon.log):
//
//     watched but NOT provisioned : 0    <- in every run, both directions
//     provisioned but NOT watched : 0
//     adopted, never provisioned  : 76   <- of which watched: NONE
//
// The window starts there ON PURPOSE. `[CrabCastRuntime] activated` first
// appears 2026-08-15T17:22 and `adopted` 2026-08-16T00:51, so over any earlier
// window the absence of those lines is the absence of the INSTRUMENT and not of
// the event — the same trap this ticket's own standing rules name. The counts
// above are quoted with the window they were searched over for that reason.
//
// CI-RUNNABLE: yes — imports the built daemon modules and drives them in
// process, plus one source-text section; no live daemon, no herdr, no
// credential, no peer, no terminal, no real CrabCast socket (section 5 speaks
// CrabCast's wire protocol to a fake peer on a unix socket in a temp dir).
//
// ---------------------------------------------------------------------------
// WHAT THIS ASSERTS, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// It drives the SHIPPED loop and the SHIPPED runtime. It does not establish:
//
//   * **That a keystroke lands on a real pane.** Nothing here spawns a pty.
//     WHO COVERS IT: `probe-crabcast-dialog-answered.mjs`, which drives a real
//     flagged agent through the real runtime and reads the pane afterwards, and
//     the daemon log lines pasted in the PR body.
//   * **That an adopted agent's CHANNEL works.** Deliberately out of scope and
//     out of the product too — `runChannelSelfCheck` is chained onto the SPAWN
//     watcher, so an adopted agent still reads as `unchecked`. That is a state
//     the fleet already handles honestly, and it is named here rather than left
//     for a reader to infer a coverage that does not exist.
//   * **That `adoptFromCensus` adopts the RIGHT rows.** WHO COVERS IT:
//     `verify-crabcast-adopt-launcher-vocabulary.mjs`, whose whole subject that
//     is. This asserts only that whatever it adopts, it announces.
//
// SECTION 5 SUPPLIES ITS OWN CENSUS, so it proves the runtime announces what it
// adopts and NOT that a real CrabCast would have sent those rows. The fixture is
// a verbatim capture (`crabcast-owned-running-census.json`) rather than a
// hand-drawn frame, which is what keeps that gap narrow; it does not close it.
//
// ---------------------------------------------------------------------------
// MADE TO GO RED — each flag mutates a COPY of the build or the source in a temp
// dir and asserts against that, so a red run leaves the tree untouched:
//
//   node daemon/scripts/verify-adopted-pane-supervision.mjs --no-adopt-fire
//   node daemon/scripts/verify-adopted-pane-supervision.mjs --drop-foreign-guard
//   node daemon/scripts/verify-adopted-pane-supervision.mjs --reassert-fine
//
// `--no-adopt-fire` is THE DEFECT ITSELF, restored: it deletes the one call
// this ticket added, which is byte-for-byte the state the fleet was in when two
// supervisors parked for 90 minutes. Going GREEN under any flag is counted as a
// failure of its own — a mutation that does not move the verdict means the
// section was not testing what it claims to.
// ---------------------------------------------------------------------------

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const dist = path.join(daemonDir, 'dist');

const MUTATIONS = ['--no-adopt-fire', '--drop-foreign-guard', '--reassert-fine'];
const mutation = process.argv.find((a) => MUTATIONS.includes(a)) ?? null;

if (!fs.existsSync(path.join(dist, 'channel-startup.js'))) {
  // A SETUP GUARD, NOT A VERDICT. Exits 2 so it cannot be mistaken for a
  // finding about the product.
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan538-'));
const cleanups = [() => fs.rmSync(TMP, { recursive: true, force: true })];

// The build the sections import. Replaced by a patched copy under a mutation, so
// the tree on disk is never written to.
let distUnderTest = dist;

function patchBuild(file, find, replace, label) {
  distUnderTest = path.join(TMP, 'dist');
  if (!fs.existsSync(distUnderTest)) {
    fs.cpSync(dist, distUnderTest, { recursive: true });
    // THE COPY NEEDS THE REAL `node_modules` AND WILL NOT SAY SO USEFULLY.
    // `herdr.js` imports `node-pty`, and node resolves a bare specifier by
    // walking up from the importing FILE — so a build copied to a temp dir
    // resolves against `/tmp` and dies with ERR_MODULE_NOT_FOUND before a
    // single check runs. That is a broken harness reported as a crash, not a
    // red, which would have made this red drive prove nothing at all.
    fs.symlinkSync(path.join(daemonDir, 'node_modules'), path.join(TMP, 'node_modules'), 'dir');
  }
  const target = path.join(distUnderTest, file);
  const before = fs.readFileSync(target, 'utf8');
  const after = before.replace(find, replace);
  if (after === before) {
    // NOT a fallback to the unpatched text. A mutation that cannot find its
    // site would leave every section green and read as a pass.
    console.error(`${label}: could not find the site to patch in ${file}; the build has moved.`);
    process.exit(2);
  }
  fs.writeFileSync(target, after);
  console.log(`${label}: patched a COPY of the build at ${target}\n`);
}

if (mutation === '--no-adopt-fire') {
  patchBuild(
    'crabcast-runtime.js',
    /this\.agentAdoptedListener\?\.\(session, Date\.now\(\)\);/,
    '/* KAN-538 defect restored: adoption announces nothing */',
    '--no-adopt-fire'
  );
}
if (mutation === '--drop-foreign-guard') {
  // Delete the branch that refuses a dialog which is not ours. The adopted path
  // must not become a second, weaker door to the keystroke KAN-340 built a type
  // to guard, and this is the edit a later author could plausibly make.
  //
  // Both supervisors carry the same condition and both are patched: the point
  // is that section 3 goes red when the guard is gone, not which copy it read.
  patchBuild(
    'channel-startup.js',
    /dialog\.kind === 'foreign' \|\| dialog\.kind === 'ambiguous'/g,
    'false',
    '--drop-foreign-guard'
  );
}

const { superviseAdoptedStartup, MAX_DIALOG_ANSWERS } = await import(
  `file://${path.join(distUnderTest, 'channel-startup.js')}`
);

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${detail}`);
  return ok;
};

const ADDRESS = { type: 'story', key: 'KAN-9999' };
const ADOPTED_AT = 1_700_000_000_000;

// ───────────────────────────────────────────────────────────────────────────
// THE FRAMES. Two dev-channels captures, deliberately, because they are the two
// shapes this ticket actually met.
// ───────────────────────────────────────────────────────────────────────────

// THE INCIDENT PANE, as `butchr_tail_agent` returned it for BOTH parked agents
// on 2026-08-18 and as KAN-538 quotes it. Short, because that is all the pane
// held. It is here rather than only the full capture below because a classifier
// that needed the surrounding chrome would have passed the pretty fixture and
// failed the real one.
const INCIDENT_PANE = [
  'WARNING: Loading development channels',
  '  1. I am using this for local development',
  '  2. Exit',
  'Enter to confirm - Esc to cancel'
].join('\n');

// THE FULL DIALOG, verbatim off a real wedged pane — captured by
// `probe-channel-launch.mjs --only=3` on 2026-08-10 against Claude Code 2.1.226
// and carried here from `verify-channel-startup-supervision.mjs` rather than
// re-drawn, so the two proofs cannot drift apart about what the dialog looks
// like.
const DIALOG_FRAME = [
  '────────────────────────────────────────────────────────────────────────────────',
  '  WARNING: Loading development channels',
  '',
  '  --dangerously-load-development-channels is for local channel development',
  '  only. Do not use this option to run channels you have downloaded off the',
  '  internet.',
  '',
  '  Please use --channels to run a list of approved channels.',
  '',
  '  Channels: server:butchr',
  '',
  '  ❯ 1. I am using this for local development',
  '    2. Exit',
  '',
  '  Enter to confirm · Esc to cancel'
].join('\n');

// A REAL session at its prompt, likewise verbatim from the same probe run.
const PROMPT_FRAME = [
  ' ▎ Channels (experimental) messages from server:butchr inject directly in this',
  ' ▎ session · restart without --dangerously-load-development-channels to stop',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
].join('\n');

// THE WORKSPACE-TRUST DIALOG, the one that must never be answered — same
// affordance, same confirm line, materially different question. Captured under a
// real PTY on 2.1.228 for `verify-startup-dialog-discrimination.mjs`.
const TRUST_FRAME = [
  '────────────────────────────────────────────────────────────────────────────────',
  '  Quick safety check',
  '',
  '  Accessing workspace: /home/brooswit/.local/share/butchr/workspaces/story/kan-117',
  '',
  '  ❯ 1. Yes, I trust this folder',
  '    2. No, exit',
  '',
  '  Enter to confirm · Esc to cancel'
].join('\n');

/**
 * A world the shipped loop can be driven through, on a clock that costs nothing.
 *
 * `sleep` advances the clock instead of waiting, so the loop's own 180-second
 * deadline is exercised for real in microseconds — the arithmetic that decides
 * when it gives up is the product's, not a shortened constant passed in here.
 */
function makeWorld({ pane, enterThrows = false }) {
  const lines = [];
  const state = { clock: ADOPTED_AT, enters: 0, reads: 0, sends: 0 };
  return {
    state,
    lines,
    world: {
      readPane: async () => {
        state.reads += 1;
        return pane(state);
      },
      pressEnter: () => {
        state.sends += 1;
        if (enterThrows) throw new Error("Agent 'butchr-story-kan-9999' has no pane to send keys to");
        state.enters += 1;
      },
      now: () => state.clock,
      sleep: async (ms) => {
        state.clock += ms;
      },
      log: (message) => lines.push(message)
    }
  };
}

const run = (spec) => {
  const w = makeWorld(spec);
  return superviseAdoptedStartup({ address: ADDRESS, adoptedAt: ADOPTED_AT, world: w.world }).then(
    (result) => ({ result, ...w })
  );
};

say(`build under test : ${distUnderTest}`);
say(`mutation         : ${mutation === null ? 'none' : mutation}`);
say('');

// ───────────────────────────────────────────────────────────────────────────
say('== 1. the incident pane: an adopted agent parked at the dialog is ANSWERED ==');
say('');
{
  // Exactly what the two parked supervisors were showing. One Enter clears it
  // and the client proceeds to its prompt.
  const { result, state, lines } = await run({
    pane: (s) => (s.enters < 1 ? INCIDENT_PANE : PROMPT_FRAME)
  });
  check(
    result.outcome === 'dialog-answered',
    `outcome is 'dialog-answered'`,
    `got '${result.outcome}' — ${result.detail}`
  );
  check(state.enters === 1, 'exactly one Enter was sent', `sent ${state.enters}`);
  check(result.atPrompt, 'the pane is reported at its prompt');
  check(
    lines.some((l) => l.includes('ADOPTED pane')),
    'the log says the pane was adopted, so a reader knows why nothing else watched it'
  );
  check(
    lines.some((l) => l.includes('[AdoptedStartup]')),
    'the log is greppable as [AdoptedStartup]'
  );
}

say('');
say('== 1b. the same, on the full captured frame ==');
say('');
{
  const { result, state } = await run({
    pane: (s) => (s.enters < 1 ? DIALOG_FRAME : PROMPT_FRAME)
  });
  check(result.outcome === 'dialog-answered', `outcome is 'dialog-answered'`, result.detail);
  check(state.enters === 1, 'exactly one Enter was sent', `sent ${state.enters}`);
}

// ───────────────────────────────────────────────────────────────────────────
say('');
say('== 2. a HEALTHY adopted pane costs one read and presses nothing ==');
say('');
{
  // This is the population that matters for noise: 76 adoptions over 13 runs.
  // A watcher that alarmed on them would be worse than the silence it replaced.
  const { result, state } = await run({ pane: () => PROMPT_FRAME });
  check(result.outcome === 'at-prompt', `outcome is 'at-prompt'`, result.detail);
  check(state.enters === 0, 'no key was pressed', `sent ${state.enters}`);
  check(state.reads === 1, 'the pane was read exactly once', `read ${state.reads} time(s)`);
  check(result.atPrompt, 'atPrompt is true');
}

// ───────────────────────────────────────────────────────────────────────────
say('');
say('== 3. a workspace-trust dialog on an adopted pane is REFUSED ==');
say('');
{
  // The adopted path must not become a second, weaker door to the keystroke
  // KAN-340 built a type to guard. It reaches the same classifier.
  const { result, state, lines } = await run({ pane: () => TRUST_FRAME });
  check(
    result.outcome === 'foreign-dialog',
    `outcome is 'foreign-dialog'`,
    `got '${result.outcome}' — ${result.detail}`
  );
  check(state.sends === 0, 'pressEnter was not even CALLED', `called ${state.sends} time(s)`);
  check(
    lines.some((l) => l.includes('REFUSING TO ANSWER') && l.includes('workspace-trust')),
    'the log names which dialog it refused'
  );
}

// ───────────────────────────────────────────────────────────────────────────
say('');
say('== 4. a dialog that never clears is REPORTED, not silently abandoned ==');
say('');
{
  // The failure mode of the whole ticket is silence. If the Enter does not take,
  // the one thing standing between that and an operator is the log line.
  const { result, state, lines } = await run({ pane: () => DIALOG_FRAME });
  check(
    result.outcome === 'dialog-unanswered',
    `outcome is 'dialog-unanswered'`,
    `got '${result.outcome}' — ${result.detail}`
  );
  check(
    state.enters === MAX_DIALOG_ANSWERS,
    `the cap of ${MAX_DIALOG_ANSWERS} Enters is respected`,
    `sent ${state.enters}`
  );
  check(!result.atPrompt, 'it does NOT claim the pane reached a prompt');
  check(
    lines.some((l) => l.includes('GIVING UP')),
    'it says out loud that it gave up'
  );
  check(
    lines.some((l) => l.includes('REVERT')),
    'the revert instruction is in the log beside the symptom'
  );
}

say('');
say('== 4b. a herdr outage does not eat the cap ==');
say('');
{
  // An Enter that never left is not one of the four this is allowed to send.
  const { result, state } = await run({ pane: () => DIALOG_FRAME, enterThrows: true });
  check(result.dialogsAnswered === 0, 'no Enter is COUNTED when the send threw');
  check(
    state.sends > MAX_DIALOG_ANSWERS,
    'it kept retrying rather than exhausting a cap on sends that failed',
    `attempted ${state.sends} send(s)`
  );
  check(result.outcome === 'dialog-unanswered', `still ends in 'dialog-unanswered'`);
}

say('');
say('== 4c. an unreadable pane reports the question it could not answer ==');
say('');
{
  const { result } = await run({ pane: () => null });
  check(
    result.outcome === 'unreadable-pane',
    `outcome is 'unreadable-pane'`,
    `got '${result.outcome}'`
  );
  check(
    !result.atPrompt && result.detail.includes('not an answer'),
    'it reports a question it could not answer rather than a finding'
  );
}

// ───────────────────────────────────────────────────────────────────────────
say('');
say('== 5. EVERY path into the runtime session map announces itself  [drives the runtime] ==');
say('');
{
  const { CrabCastRuntime } = await import(
    `file://${path.join(distUnderTest, 'crabcast-runtime.js')}`
  );
  const { CrabCastLink } = await import(`file://${path.join(distUnderTest, 'crabcast-link.js')}`);
  const { workspacesRoot } = await import(`file://${path.join(distUnderTest, 'herdr.js')}`);

  const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-owned-running-census.json'), 'utf8')
  );
  const localise = (value) =>
    JSON.parse(
      JSON.stringify(value).split(FIXTURE.capturedWorkspacesRoot).join(workspacesRoot())
    );
  const CENSUS = localise(FIXTURE.list_agents);
  const STATUS = FIXTURE.daemon_status;

  const socketPath = path.join(TMP, 'peer.sock');
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const frame =
          req.action === 'daemon_status'
            ? STATUS
            : req.action === 'list_agents'
              ? CENSUS
              : null;
        if (frame) socket.write(JSON.stringify({ ...frame, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  cleanups.push(() => server.close());

  const link = new CrabCastLink({ socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 150, log: () => {} });
  cleanups.push(() => runtime.dispose());

  // Installed BEFORE the census can tick, exactly as daemon.ts installs it
  // before anything is served.
  const announced = [];
  runtime.setAgentAdoptedListener((session, adoptedAt) => {
    announced.push({ type: session.type, key: session.key, adoptedAt, adopted: session.adopted });
  });

  const deadline = Date.now() + 5_000;
  while (!runtime.herdrReachable() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 500)); // let adoption run

  // WHAT THE RUNTIME SHOULD HAVE ADOPTED, derived from the fixture rather than
  // written down: only `state: running` rows are sessions at all, which is
  // `adoptFromCensus`'s own first condition. `listHerdrAgents()` is the WHOLE
  // census — running rows, unstarted agents and foreign panes together — so it
  // is not the population this section is about, and counting it would have
  // measured the fixture's size instead of the runtime's behaviour.
  const runningRows = CENSUS.agents.filter((r) => r.state === 'running');
  const expectedAddresses = runningRows
    .map((r) => {
      const rel = path.relative(workspacesRoot(), r.workDir ?? r.path).split(path.sep);
      return `${rel[0]}/${rel[1]}`;
    })
    .sort();

  const held = expectedAddresses.filter((a) => {
    const [type, key] = a.split('/');
    return Boolean(runtime.getSessionByAddress(key, type));
  });
  check(
    held.length === expectedAddresses.length,
    `the runtime holds a session for all ${expectedAddresses.length} running row(s)`,
    `holds ${held.length}: ${JSON.stringify(held)} of ${JSON.stringify(expectedAddresses)}`
  );

  // THE ASSERTION THIS SCRIPT EXISTS FOR. Before KAN-538 this was 0 for every
  // adopted agent, forever, and nothing said so.
  const announcedAddresses = announced.map((a) => `${a.type}/${a.key}`).sort();
  check(
    announcedAddresses.length === expectedAddresses.length &&
      announcedAddresses.every((a, i) => a === expectedAddresses[i]),
    `every adopted session was ANNOUNCED — expected ${JSON.stringify(expectedAddresses)}`,
    `announced ${JSON.stringify(announcedAddresses)}`
  );
  // ⚠ THE `announced.length > 0` CONJUNCT IS LOAD-BEARING, NOT BELT AND BRACES.
  // `[].every(...)` is `true`, so without it these two checks go GREEN on a
  // build where adoption announces nothing at all — which is precisely the
  // defect, and precisely the run (`--no-adopt-fire`) in which they must not
  // agree with it. A check that can only ever return the answer you were hoping
  // for is not a weak check; it is one that does not exist while appearing to.
  check(
    announced.length > 0 && announced.every((a) => a.adopted === true),
    'each announcement carries a session marked `adopted`, so the consumer cannot mistake it ' +
      'for a spawn',
    `${announced.length} announcement(s) seen`
  );
  check(
    announced.length > 0 && announced.every((a) => Number.isFinite(a.adoptedAt) && a.adoptedAt > 0),
    'each announcement carries an adoption instant',
    `${announced.length} announcement(s) seen`
  );
}

// ───────────────────────────────────────────────────────────────────────────
say('');
say('== 6. the reconcile line no longer asserts health it cannot know  [reads source as text] ==');
say('');
{
  // A SOURCE-TEXT section on purpose: its subject is a sentence, and its verdict
  // stays readable after a failed build because it read what you wrote.
  const daemonSrc = path.join(daemonDir, 'src', 'daemon.ts');
  let text = fs.readFileSync(daemonSrc, 'utf8');
  if (mutation === '--reassert-fine') {
    const before = text;
    text = text.replace(
      /TWO DIFFERENT STATES LOOK EXACTLY LIKE THIS[\s\S]*?Do not read this as either\./,
      'the agents are fine and are simply not addressable over the channel.'
    );
    if (text === before) {
      console.error('--reassert-fine: could not find the reconcile sentence to mutate.');
      process.exit(2);
    }
    say('  --reassert-fine: mutated a COPY of daemon.ts in memory\n');
  }

  // The claim itself, scoped to the log STRING rather than to the file: the
  // explanatory comment above it quotes the retired wording on purpose, and a
  // whole-file grep would match that and call a correct file wrong.
  const logCall = text.slice(
    text.indexOf('surviving agent(s) hold no '),
    text.indexOf("(KAN-274).`")
  );
  check(logCall.length > 0, 'the reconcile log call was located in daemon.ts');
  check(
    !/the agents are fine/.test(logCall),
    'the log line does not claim `the agents are fine`',
    'it does, and it cannot know that: a parked pane holds no registration BECAUSE it never ' +
      'started a server'
  );
  check(
    /cannot tell them apart|CANNOT TELL THEM APART/.test(logCall),
    'it says out loud that it cannot distinguish the two states'
  );
  check(
    /AdoptedStartup/.test(logCall),
    'it names the instrument that CAN distinguish them, rather than leaving the reader stuck'
  );
}

// ───────────────────────────────────────────────────────────────────────────
say('');
for (const c of cleanups) {
  try {
    c();
  } catch {
    // Cleanup is best-effort; a temp dir left behind is not a verdict.
  }
}

if (mutation !== null) {
  // A mutation that does not move the verdict means the section it targets was
  // not testing what it claims to. Under a flag, GREEN is the failure.
  if (failures === 0) {
    say(`RED DRIVE ${mutation}: NO SECTION WENT RED — the proof is not testing what it claims.`);
    process.exit(1);
  }
  say(`RED DRIVE ${mutation}: ${failures} check(s) went red, as intended. EXIT=0`);
  process.exit(0);
}

say(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
