// The dialog answerer and the readiness wait, driven through every outcome they
// can reach — deterministically, on a virtual clock, against the SHIPPED loop.
//
// WHAT FAILURE THIS WOULD CATCH: a channel-enabled activation reporting itself
// ready while the agent is still sitting on an unanswered full-screen dialog and
// will never reach its prompt. There are five separate ways to arrive there and
// this exercises all of them, because each fails silently in production:
//
//   1. **A stale connection read as readiness.** A re-activated agent's PREVIOUS
//      MCP server is still in KAN-243's identity map when the new pane spawns —
//      socket close is not ordered against a fresh connect (agent-connections.ts,
//      decision 3). A watcher that asked "is there a connection?" instead of "is
//      there a connection newer than the spawn?" answers yes instantly, every
//      time, for a session that is dead. Section 4 is that exact shape, and it
//      is the KAN-145 defect in a new costume: a check that passes because it was
//      handed its own answer.
//   2. **A dialog that is never answered reported as anything but a brick.** The
//      failure mode of this whole ticket is an agent that never reaches its
//      prompt, and the only thing standing between that and an operator is the
//      log line. Section 5 asserts the outcome, and asserts the REVERT
//      instruction is in the log beside it.
//   3. **The cap eaten by a herdr outage.** Enters are capped at four; if a send
//      that herdr refused counted against the cap, a five-second herdr hiccup
//      would permanently stop the watcher answering the dialog that is still
//      there. Section 6.
//   4. **A connection that is about to die read as readiness — SECTION 8, and
//      the only one of these that has actually happened.** On a fresh workspace
//      `claude --continue` boots far enough to SPAWN ITS MCP SERVERS and only
//      then discovers there is no conversation to continue. An earlier build of
//      this watcher returned ready on that connection, six seconds in, one dialog
//      answered — and the second `claude` then raised the second dialog with
//      nothing left watching for it. The agent never reached its prompt. That
//      defect survived every section here except the one that was written after a
//      live run found it, which is why the header of `probe-channel-launch.mjs`
//      says what it says about deterministic harnesses agreeing with the bug.
//   5. **The brick misreported because the pane went blank — SECTION 7b, also
//      measured rather than imagined.** `recent-unwrapped` reports what has
//      RECENTLY SCROLLED, and a full-screen dialog paints once and then emits
//      nothing, so a pane wedged behind one reads EMPTY within a minute. Deciding
//      the outcome on the last frame would score that agent as a plain
//      `no-connection` and send an operator hunting a channel fault instead of a
//      box nobody pressed Enter at.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), and this one supplies a great deal: the pane text, the clock, and —
// in sections 1, 2, 3, 5 and 6 — the answer to "has a connection appeared".
//
// What that leaves uncovered is precise and worth naming: **nothing here proves
// the strings it matches against are the strings Claude Code prints.** The
// pattern is imported from the product rather than retyped, so the two cannot
// drift, but a pattern that was wrong about the real dialog would be wrong in
// both places and green here. The same goes for the *shape* of a real startup:
// this asserts the loop does the right thing given two dialogs, not that a real
// `claude` raises two.
//
// SECTION 4 IS THE EXCEPTION AND IS DELIBERATELY BUILT THE OTHER WAY. It uses a
// real `AgentConnectionRegistry`, real `register`/`resolve`, and real `Date`
// timestamps, so the freshness rule is exercised by the code that decides it in
// production rather than by a stub that agrees with it.
//
// WHO COVERS THE REST: `probe-channel-launch.mjs`, which activates real agents
// on the shipped launcher and lets the daemon's own watcher answer the real
// dialog — its pasted output in the KAN-246 PR is the evidence that the pattern
// matches, that two dialogs are what a fresh workspace raises, and that a
// connection follows. That is a live experiment needing a model, a real herdr and
// minutes of wall clock, which is why it is a `probe-` and this is a `verify-`.
//
// Usage: node daemon/scripts/verify-channel-startup-supervision.mjs [--blind]
//
//   --blind   patch a COPY of the build so the dialog pattern matches nothing,
//             and watch this proof go red. AC: a gate nobody has seen fail has
//             not been shown to be a gate.
//
// Run it after `npm run build` in daemon/.

import net from 'net';
import path from 'path';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const blind = process.argv.includes('--blind');

const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'channel-startup.js'))) {
  console.error('daemon/dist/channel-startup.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'butchr-channel-startup-'));
let distUnderTest = dist;

if (blind) {
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  const target = path.join(distUnderTest, 'channel-startup.js');
  const source = readFileSync(target, 'utf8');
  // A pattern that cannot match anything: the defect where the wording moved
  // under us and nothing noticed, which is what a dialog answerer looks like
  // when it has quietly stopped answering.
  const patched = source.replace(
    /export const DEV_CHANNELS_DIALOG_PATTERN =[\s\S]*?;\n/,
    'export const DEV_CHANNELS_DIALOG_PATTERN = /a string no pane will ever print/;\n'
  );
  if (patched === source) {
    console.error('--blind could not find the dialog pattern to patch; the build has moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  console.log('--blind: patched a copy of the build so the dialog pattern matches nothing.\n');
}

const { superviseChannelStartup, MAX_DIALOG_ANSWERS, freshConnectionFrom } =
  await import(`file://${path.join(distUnderTest, 'channel-startup.js')}`);
const { AgentConnectionRegistry } = await import(
  `file://${path.join(distUnderTest, 'agent-connections.js')}`
);

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${detail}`);
  return ok;
};

const ADDRESS = { type: 'task', key: 'KAN-9999' };
const SPAWNED_AT = 1_700_000_000_000;

// THE REAL DIALOG, VERBATIM off a real wedged pane — captured by
// `probe-channel-launch.mjs --only=3` on 2026-08-10 against Claude Code 2.1.226,
// read back through the same `herdr agent read --source recent-unwrapped` the
// watcher uses. Not a hand-drawn approximation: an earlier version of this file
// invented a boxed frame that looked plausible and was not what the client
// prints, which is exactly the kind of self-supplied input that makes a
// deterministic proof agree with a bug.
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

// A REAL session at its prompt, likewise verbatim — the tail of a channel-enabled
// agent that came up clean in phase 1 of the same probe run.
const PROMPT_FRAME = [
  ' ▎ Channels (experimental) messages from server:butchr inject directly in this',
  ' ▎ session · restart without --dangerously-load-development-channels to stop',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
].join('\n');

/**
 * A world the shipped loop can be driven through, on a clock that costs nothing.
 *
 * `sleep` advances the clock instead of waiting, so a 180-second deadline is
 * exercised in microseconds — and exercised for real: the loop's own arithmetic
 * decides when it gives up, not a shortened constant passed in from here.
 */
function makeWorld({ pane, connection, enterThrows = false }) {
  const lines = [];
  const state = { clock: SPAWNED_AT, enters: 0, reads: 0, sends: 0 };
  return {
    state,
    lines,
    world: {
      readPane: () => {
        state.reads += 1;
        return pane(state);
      },
      pressEnter: () => {
        state.sends += 1;
        if (enterThrows) throw new Error("Agent 'butchr-task-kan-9999' has no pane to send keys to");
        state.enters += 1;
      },
      now: () => state.clock,
      sleep: async (ms) => {
        state.clock += ms;
      },
      freshConnection: (spawnedAt) => connection(state, spawnedAt),
      log: (message) => lines.push(message)
    }
  };
}

const run = (spec) => {
  const w = makeWorld(spec);
  return superviseChannelStartup({ address: ADDRESS, spawnedAt: SPAWNED_AT, world: w.world })
    .then((result) => ({ result, ...w }));
};

say('== 1. a fresh workspace: two dialogs, then a server ==');
say('');
{
  // The `||` runs `claude` twice, so the dialog is raised twice; the client
  // spawns its MCP server only after the second one clears.
  const { result, state, lines } = await run({
    pane: (s) => (s.enters < 2 ? DIALOG_FRAME : PROMPT_FRAME),
    connection: (s) => (s.enters >= 2 && s.reads > 3 ? { id: 'conn-7' } : null)
  });
  check(result.ready, 'ready', result.detail);
  check(result.outcome === 'ready', `outcome is 'ready'`, `got '${result.outcome}'`);
  check(result.dialogsAnswered === 2, 'exactly two Enters were sent', `sent ${state.enters}`);
  check(result.connectionId === 'conn-7', 'it names the connection an addressed frame would use');
  check(
    lines.some((l) => /ready after \d+ms .* at its prompt and .* registered/.test(l)),
    'the log says when it became ready AND names both conditions, not merely that it did'
  );
}

say('');
say('== 2. the resumed path: `--continue` succeeds, so ONE dialog ==');
say('');
{
  const { result, state } = await run({
    pane: (s) => (s.enters < 1 ? DIALOG_FRAME : PROMPT_FRAME),
    connection: (s) => (s.enters >= 1 ? { id: 'conn-8' } : null)
  });
  check(result.ready && result.dialogsAnswered === 1, 'ready after one Enter', `sent ${state.enters}`);
}

say('');
say('== 3. no dialog at all — a build with the switch off must not press anything ==');
say('');
{
  // The watcher is not installed when channels are off, so this is the other
  // case: channels on, and a claude that (for whatever reason) raised no dialog.
  const { result, state } = await run({
    pane: () => PROMPT_FRAME,
    connection: (s) => (s.reads >= 2 ? { id: 'conn-9' } : null)
  });
  check(result.ready, 'ready without any dialog');
  check(state.sends === 0, 'and NOT ONE key was sent at the pane', `sent ${state.sends}`);
}

say('');
say('== 4. a connection that was already there is not readiness ==');
say('       (real AgentConnectionRegistry, real register/resolve, real timestamps)');
say('');
{
  // Real time, and the only place this script spends any: the grace inside
  // `freshConnectionFrom` is one second, so a gap that means anything has to be
  // longer than one second. Faking the clock here would be faking the very
  // arithmetic under test.
  const registry = new AgentConnectionRegistry();
  const previous = new net.Socket();
  registry.register(previous, ADDRESS);
  const previousAt = registry.resolve(ADDRESS).registeredAt.getTime();
  const fresh = freshConnectionFrom(registry, ADDRESS);

  await new Promise((r) => setTimeout(r, 1100));
  const spawnedAt = Date.now();

  check(
    fresh(spawnedAt) === null,
    "the PREVIOUS session's connection is not fresh for a spawn 1.1s later",
    'this is the check that would otherwise return ready instantly on every re-activation'
  );
  check(
    fresh(previousAt + 500)?.id !== undefined,
    'a connection inside the 1s grace IS fresh — the spawn timestamp and the registration race'
  );

  const current = new net.Socket();
  registry.register(current, ADDRESS);
  const got = fresh(spawnedAt);
  check(
    got !== null,
    'once a NEW connection registers, it is fresh even though an older one is still held'
  );
  check(
    got?.id === registry.resolve(ADDRESS).id,
    'and it is the same connection `resolve` would route an addressed frame to',
    `fresh=${got?.id} resolve=${registry.resolve(ADDRESS).id}`
  );

  current.destroy();
  check(
    fresh(spawnedAt) === null,
    'a destroyed socket is not readiness — resolve skips it, falls back to the stale ' +
      'one, and that is not fresh either'
  );
  previous.destroy();

  // And the same fact through the loop: a pane that never shows a dialog and a
  // connection that never arrives is a session with no channel behind it.
  const { result } = await run({ pane: () => PROMPT_FRAME, connection: () => null });
  check(result.outcome === 'no-connection', `outcome is 'no-connection'`, `got '${result.outcome}'`);
  check(
    /at a prompt: true/.test(result.detail),
    'and it says the pane WAS at a prompt, so a reader is not sent looking for a wedged agent'
  );
  check(!result.ready, 'and it is not ready');
  check(
    /lost in silence/.test(result.detail),
    'the detail says what an addressed send would do now, not merely that it timed out'
  );
}

say('');
say('== 5. THE BRICK: a dialog nothing can clear ==');
say('');
{
  // Enters land, and the dialog stays. This is what a changed key binding, a
  // second confirmation, or a claude that has stopped accepting Enter looks
  // like from the daemon's side.
  const { result, state, lines } = await run({
    pane: () => DIALOG_FRAME,
    connection: () => null
  });
  check(
    result.outcome === 'dialog-unanswered',
    `outcome is 'dialog-unanswered'`,
    `got '${result.outcome}'`
  );
  check(!result.ready, 'not ready');
  check(
    state.enters === MAX_DIALOG_ANSWERS,
    `it stopped at the cap of ${MAX_DIALOG_ANSWERS} rather than pressing Enter forever`,
    `sent ${state.enters}`
  );
  check(
    /HAS NOT REACHED ITS PROMPT/.test(result.detail),
    'the detail names the actual consequence — the agent never reached its prompt'
  );
  check(
    lines.some((l) => /REVERT — turn channels off/.test(l)),
    'the REVERT instruction is in the log beside the symptom, not only in a PR body'
  );
  check(
    lines.some((l) => /channel\.json/.test(l)),
    'and it names the switch file by path'
  );
}

say('');
say('== 6. a herdr outage must not eat the cap ==');
say('');
{
  const { result, state } = await run({
    pane: () => DIALOG_FRAME,
    connection: () => null,
    enterThrows: true
  });
  check(
    result.dialogsAnswered === 0,
    'no Enter is COUNTED when the send threw',
    `counted ${result.dialogsAnswered}`
  );
  check(
    state.sends > MAX_DIALOG_ANSWERS,
    'it kept trying past the cap, because a send that never left is not one of the four',
    `attempted ${state.sends} send(s)`
  );
  check(
    result.outcome === 'dialog-unanswered',
    'and it still ends by naming the brick rather than a timeout'
  );
}

say('');
say('== 7. an unreadable pane is reported as a question, not as an answer ==');
say('');
{
  const { result } = await run({ pane: () => null, connection: () => null });
  check(result.outcome === 'unreadable-pane', `outcome is 'unreadable-pane'`, `got '${result.outcome}'`);
  check(
    /not an answer/.test(result.detail),
    'the detail refuses to claim the agent is wedged when it could not look'
  );
}

rmSync(scratch, { recursive: true, force: true });

say('');
say('== 7b. the brick as it ACTUALLY looks: a dialog, and then a blank pane ==');
say('');
{
  // `herdr agent read --source recent-unwrapped` reports what has recently
  // scrolled. A full-screen dialog paints once and then emits nothing, so a pane
  // wedged behind one reads EMPTY within a minute — measured by
  // `probe-channel-launch.mjs` phase 3 on 2026-08-10, where the dialog was on the
  // tail at t+30s and gone from it at t+60s with the agent still stuck.
  //
  // If the outcome were decided on the LAST frame, that agent would be reported
  // as a plain `no-connection` and an operator would go looking for a channel
  // fault instead of a box nobody pressed Enter at.
  const { result, lines } = await run({
    pane: (s) => (s.reads < 3 ? DIALOG_FRAME : ''),
    connection: () => null,
    enterThrows: true
  });
  check(
    result.outcome === 'dialog-unanswered',
    `a dialog seen early and a blank pane later is still 'dialog-unanswered'`,
    `got '${result.outcome}'`
  );
  check(
    /may read EMPTY now/.test(result.detail),
    'and the detail warns the reader that the pane will look empty',
    result.detail
  );
  check(
    lines.some((l) => /REVERT — turn channels off/.test(l)),
    'the REVERT instruction is logged for this shape too'
  );
}

say('');
say('== 8. THE REGRESSION: a connection that appears and then dies ==');
say('       (the fresh-workspace sequence a live run caught this watcher getting wrong)');
say('');
{
  // The real sequence, as `probe-channel-launch.mjs` measured it on 2026-08-10:
  //   dialog #1 -> Enter -> `claude --continue` boots -> its MCP server registers
  //   -> "No conversation found to continue" -> that claude EXITS, its connection
  //   goes -> the `||` starts the second claude -> dialog #2 -> Enter -> prompt.
  // The interim frame is the real one, verbatim off that pane.
  const EXITING_FRAME = 'No conversation found to continue';
  const { result, state, lines } = await run({
    pane: (s) => {
      if (s.enters === 0) return DIALOG_FRAME;                 // arm 1's dialog
      if (s.enters === 1 && s.reads < 5) return EXITING_FRAME; // arm 1 booting, then leaving
      if (s.enters === 1) return DIALOG_FRAME;                 // arm 2's dialog
      return PROMPT_FRAME;                                     // arm 2 is up
    },
    // Arm 1's server registers, then goes when arm 1 exits; arm 2's registers
    // once arm 2 is up. `null` in between is what `resolve` answers once the
    // socket is released.
    connection: (s) => {
      if (s.enters === 1 && s.reads < 5) return { id: 'conn-DOOMED' };
      if (s.enters >= 2) return { id: 'conn-REAL' };
      return null;
    }
  });
  check(result.ready, 'ready', result.detail);
  check(
    result.connectionId === 'conn-REAL',
    "it reported the SECOND claude's connection, not the one that was about to die",
    `got ${result.connectionId}`
  );
  check(
    result.dialogsAnswered === 2,
    'BOTH dialogs were answered - it did not stop after the first',
    `answered ${state.enters}`
  );
  check(
    !lines.some((l) => /conn-DOOMED/.test(l)),
    'the doomed connection is never named as ready in the log'
  );
}

say('');
if (failures > 0) {
  say(`FAIL: ${failures} check(s) failed.`);
  if (blind) {
    say('');
    say('This is the expected red for --blind: with a pattern that matches nothing, the');
    say('watcher never presses Enter, so sections 1 and 2 never reach a server and the');
    say('brick in section 5 is misreported as a plain timeout. That is what a dialog');
    say('answerer looks like after the wording moves under it — which is why KAN-248');
    say('exists. Re-run without --blind against the real build to see it green.');
  }
} else {
  say('PASS: every outcome the watcher can reach is reached, and named correctly.');
  if (blind) {
    say('');
    say('BUT --blind was requested and this went GREEN, which means the patch did not');
    say('take: the assertions are not watching what they claim to watch.');
    failures += 1;
  }
}

process.exit(failures ? 1 : 0);
