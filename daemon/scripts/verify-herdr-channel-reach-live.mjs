#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: `AgentSpawn.channelEnabled` not ARRIVING —
 * a spawn-reach record that every offline proof agrees about and that no real
 * spawn ever produces. That is KAN-145's defect exactly, and its two scripts
 * both missed it by constructing the records they then asserted on. This is
 * the only thing in the tree that drives a real `HerdrBridge`, the real
 * `claude` launcher and the real kill switch into a real pane and then reads
 * what the store holds.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHY THIS IS A FILE OF ITS OWN, AND NOT A `--live` SECTION OF ITS SIBLING
 * ---------------------------------------------------------------------------
 *
 * It was one, and that was wrong in a way worth recording rather than quietly
 * fixing. `verify-herdr-channel-reach-per-agent.mjs` carried this as §5 behind
 * a `--live` flag, tallied the skip when the flag was absent, and then ended
 * `process.exit(failures ? 1 : 0)` — **a verdict that consults the tally not at
 * all**. So the ordinary invocation printed `GREEN` and exited `0` while the
 * only section that tests arrival had not run. The header called §5 *"the only
 * section that can"* and the mechanism said everything was fine: the sentence
 * and the mechanism disagreeing, which is the defect this epic keeps re-finding
 * in a new costume. KAN-373 is the ticket for that shape; #246 is its fix.
 *
 * **Splitting is the repair rather than an exit code, and the difference
 * matters.** A skip that must be *reported* is a hole a reader has to be told
 * about; a section that lives in its own `CI-RUNNABLE: no` file is a hole the
 * file boundary makes visible without anybody being told. The sibling now has
 * no skip to tally and no way to report a green it did not earn, because there
 * is nothing in it that can fail to run. That is the same preference for the
 * type over the assertion this repository states elsewhere: an unrepresentable
 * state beats a checked one. It is also the established idiom here —
 * `verify-crabcast-runtime-live.mjs`, `verify-fleet-switch-live.mjs` and
 * `verify-message-provenance-live.mjs` are all their own files for this reason.
 *
 * ---------------------------------------------------------------------------
 * THE EXIT CONTRACT, WHICH IS #246'S AND NOT A SECOND SPELLING OF IT
 * ---------------------------------------------------------------------------
 *
 *   0  every arm ran, and every assertion passed.
 *   1  at least one assertion FAILED. Loudest fact, so it wins over 2.
 *   2  nothing failed, and something did not run. Green with holes.
 *
 * `--allow-skipped` makes a caller who accepts an incomplete run say so out
 * loud, and turns 2 into 0.
 *
 * ⚠ **The constants are spelled locally here, and that is temporary and
 * deliberate.** `daemon/scripts/lib/verdict-exit.mjs` is the shared helper and
 * it does not exist on `main` yet — it arrives with #246, which was still open
 * when this landed. Importing a module that is not there would be a proof that
 * cannot run. **When #246 lands, delete these three constants and the four-line
 * verdict at the foot of this file and call the helper**; the values, the flag
 * name and the precedence are copied from that PR precisely so the swap is
 * mechanical and no second vocabulary outlives it.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHAT THIS SUPPLIES, AND THE ARM IT CANNOT MEASURE
 * ---------------------------------------------------------------------------
 *
 * It supplies the **two-line listener body** — `record(address,
 * spawn.channelEnabled)`. The production listener lives in `daemon.ts` and is
 * not exported, so no script can call the real one. §3 of the sibling is what
 * makes that honest: it asserts against `src/daemon.ts` as TEXT that the
 * production closure records the same three-state verdict at the same seam,
 * ahead of the supervision guard. Neither covers the other, and the seam
 * between them is real — **nothing would notice if `daemon.ts` stopped
 * installing the listener at all.**
 *
 * ⚠ **The `loaded` arm cannot run on this build, for a product reason rather
 * than a harness one — KAN-557.** A channel-enabled `claude` spawn is refused
 * by `herdr agent start` with *"blocked during startup and is not ready for
 * prompts"*, so `agentSpawnedListener` never fires. This script reports that as
 * a skip, which is what makes its exit `2` rather than `0`. When KAN-557 lands
 * the arm asserts and the exit becomes `0` with no edit here.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT
 * ---------------------------------------------------------------------------
 *   node daemon/scripts/verify-herdr-channel-reach-live.mjs [--verbose] [--allow-skipped]
 *
 * Run it after `npm run build` in daemon/. It starts REAL panes and writes the
 * REAL kill switch; both are restored in a `finally`.
 */

// CI-RUNNABLE: no — it needs a real herdr on PATH, spawns two real `claude`
// panes and writes the fleet's own channel kill switch. None of those exist on
// a runner, and none of them can be mocked without destroying the only thing
// this script is for: that the `AgentSpawn` is the product's rather than one a
// harness built.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');
const allowSkipped = process.argv.includes('--allow-skipped');

// ⚠ DELETE THESE AND IMPORT `./lib/verdict-exit.mjs` WHEN #246 LANDS. See the
// header. The values and the flag name are #246's, copied rather than invented.
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCOMPLETE = 2;

let failures = 0;
let skipped = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('─'.repeat(74));
  say(title);
  say('─'.repeat(74));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) {
    say(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
  }
  return ok;
};
const skip = (what, why) => {
  skipped += 1;
  say(`  SKIP  ${what}\n        ${why}`);
};

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'channel-spawn-reach.js'))) {
  console.error('daemon/dist is missing or predates KAN-497 — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const u = (f) => `file://${path.join(dist, f)}`;
const { ChannelSpawnReachStore } = await import(u('channel-spawn-reach.js'));
const { CHANNEL_SWITCH_PATH } = await import(u('channel.js'));
const { HerdrBridge } = await import(u('herdr.js'));

const switchExisted = existsSync(CHANNEL_SWITCH_PATH);
const switchBefore = switchExisted ? readFileSync(CHANNEL_SWITCH_PATH, 'utf8') : null;
const restoreSwitch = () => {
  if (switchBefore !== null) writeFileSync(CHANNEL_SWITCH_PATH, switchBefore);
  else if (existsSync(CHANNEL_SWITCH_PATH)) rmSync(CHANNEL_SWITCH_PATH);
};
mkdirSync(path.dirname(CHANNEL_SWITCH_PATH), { recursive: true });

try {
  // ═════════════════════════════════════════════════════════════════════════
  rule('⚠ THE REAL SPAWN — AC1, and the only thing that tests arrival');
  // ═════════════════════════════════════════════════════════════════════════
  const { workspaceDirFor } = await import(u('workspace-dir.js'));
  const bridge = new HerdrBridge();

  // THE HARNESS-SUPPLIED HALF, AND IT IS TWO LINES ON PURPOSE. §3 asserts
  // against `src/daemon.ts` that the production closure does exactly this, at
  // this seam, ahead of the supervision guard. What is NOT supplied is
  // everything on the left of it: the switch read, the command composed, the
  // pane started, and the `AgentSpawn` that comes back out.
  const liveStore = new ChannelSpawnReachStore();
  const seen = [];
  bridge.setAgentSpawnedListener((session, spawnedAt, spawn) => {
    seen.push({ key: session.key, channelEnabled: spawn.channelEnabled, command: spawn.command });
    liveStore.record({ type: session.type, key: session.key }, spawn.channelEnabled);
  });
  const liveReachOf = (address) => liveStore.get(address) ?? bridge.channelReach;

  const spawnedKeys = [];
  const spawnUnder = (enabled, key) => {
    writeFileSync(CHANNEL_SWITCH_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`);
    const session = bridge.spawnSession(
      'task', key, undefined, 'KAN-497 reach probe — this pane is closed immediately.',
      1, false, 'claude'
    );
    spawnedKeys.push(key);
    return session;
  };

  try {
    // ON FIRST, DELIBERATELY. On a live fleet the switch is normally on, so
    // this arm changes nothing, and the off-arm's window is a fraction of a
    // second before the `finally` puts it back. Off is also the SAFE
    // direction to be wrong in — a send that would have taken the channel
    // falls back to the composer and still arrives.
    const on = spawnUnder(true, 'kan497-reach-on');
    const off = spawnUnder(false, 'kan497-reach-off');

    const onAddr = { type: 'task', key: 'kan497-reach-on' };
    const offAddr = { type: 'task', key: 'kan497-reach-off' };

    // The product's own verdict, off a real spawn. Printed as well as
    // asserted, because a reviewer re-running this should see the argv that
    // produced it.
    for (const s of seen) {
      say(`  ${s.key}: channelEnabled=${JSON.stringify(s.channelEnabled)}  ${String(s.command).slice(0, 90)}…`);
    }

    // ── the OFF arm: a real spawn, all the way to the record ─────────────
    check(
      off.status !== 'terminated',
      'switch OFF → the pane started',
      `${off.status} / ${off.spawnError ?? ''}`
    );
    check(
      seen.some((s) => s.key === 'kan497-reach-off' && s.channelEnabled === false),
      'switch OFF → the listener fired, carrying the launcher’s own `false`',
      JSON.stringify(seen)
    );
    check(
      liveReachOf(offAddr) === 'not-loaded',
      'switch OFF → and the record that arrived reads not-loaded',
      liveReachOf(offAddr)
    );

    // ── the ON arm ⚠ AND WHY IT HAS TWO ACCEPTABLE OUTCOMES ──────────────
    //
    // Measured 2026-08-20 on this repository at `4a429ba`: a channel-enabled
    // `claude` spawn is REFUSED by `herdr agent start`, after 7.4s, with
    // *"agent … is blocked during startup and is not ready for prompts"*. That
    // is not this harness being slow and it is not the 20s budget — herdr
    // detected the agent sitting on a dialog and said so.
    //
    // ⚠ THE DIALOG IS THE ONE THE FLAG ITSELF RAISES, and the consequence is
    // an ordering defect that belongs to the product rather than to this
    // script: `startAgentInOwnTab` throws, so `agentSpawnedListener` is never
    // called, so `superviseChannelStartup` — whose ENTIRE JOB is to answer
    // that dialog (KAN-246) — never runs. The supervision is downstream of a
    // call that fails because of the thing it exists to supervise. It is
    // latent today only because the fleet runs CrabCast. `agent start` gained
    // the readiness wait in herdr 0.7 and `initPty`'s own comment still
    // describes the 0.6.4 behaviour it replaced.
    //
    // ⚠ SO THIS ARM ACCEPTS TWO OUTCOMES AND A CHECK THAT ACCEPTS ANYTHING IS
    // NOT A CHECK. It is written to have a reachable red: a THIRD outcome —
    // the spawn succeeding but leaving no record, or leaving one that reads
    // `unknown` or `not-loaded` — fails here. And when the ordering defect is
    // fixed, the `blocked` branch stops being reachable and this arm becomes
    // the plain `'loaded'` measurement AC1 asked for, with no edit needed.
    // ⚠ THE REFUSAL HAS TWO SHAPES AND BOTH WERE OBSERVED, minutes apart, on
    // the same machine and the same build. They are one cause read through two
    // instruments, so matching only the first would have this arm reporting a
    // hard failure half the time for a condition it is meant to recognise:
    //
    //   * `agent … is blocked during startup and is not ready for prompts`
    //     — herdr's OWN detection, returned at 7.4s, well inside its budget.
    //   * `failed: spawnSync herdr ETIMEDOUT`
    //     — Node's spawnSync timeout firing first, so herdr never got to say
    //     it. Same wedged agent; a different process noticed.
    //
    // So the branch is "the spawn did not complete", with the exact text
    // printed rather than summarised. That is deliberately broad, and the red
    // it leaves reachable is the one this ticket is about: a spawn that
    // SUCCEEDS and leaves no record, or a wrong one — KAN-145's defect
    // exactly. What it can no longer catch is a `loaded` arm that fails for
    // some unrelated reason, and that is the trade, stated rather than hidden.
    const onRecorded = liveReachOf(onAddr);
    const onBlocked = on.status === 'terminated' && (on.spawnError ?? '') !== '';

    if (onBlocked) {
      say('');
      say('  ⚠ THE ON ARM WAS REFUSED BY HERDR, AND THIS IS A PRODUCT FINDING:');
      say(`      ${on.spawnError}`);
      say('    A channel-enabled spawn cannot complete on the herdr path, so the spawn');
      say('    listener never fires and KAN-246 channel-startup supervision never runs.');
      say('    AC1’s `loaded` arm is therefore NOT measured live here. See the ticket');
      say('    filed against KAN-497 for the ordering defect.');
      skip(
        "AC1's `loaded` arm",
        'blocked by the product ordering defect named above, not by this harness. ' +
          'The launcher half of that arm IS measured — by the argv printed above, and ' +
          'by verify-channel-spawn-verdict §1 and verify-channel-capability-refusal §6, ' +
          'which drive the real launcher under both switch states in CI.'
      );
    }
    check(
      onBlocked || onRecorded === 'loaded',
      'switch ON  → a real spawn reads loaded, OR herdr refuses it as blocked-on-dialog',
      `record=${JSON.stringify(onRecorded)} status=${on.status} spawnError=${on.spawnError ?? '(none)'}`
    );
    // THE DISCRIMINATING ROW for the pair — asked ONLY when the ON arm really
    // produced a record. ⚠ It was gated on `!onBlocked` for one run and that
    // was wrong in the way this file keeps warning about: with the ON arm
    // refused, it compared `'unknown'` against `'not-loaded'`, found them
    // different, and printed PASS. A green for a pair where one side is the
    // fall-through is a check passing for the wrong reason — it would have
    // gone green on a build with no store in it at all.
    if (onRecorded === 'loaded') {
      check(
        liveReachOf(onAddr) !== liveReachOf(offAddr),
        'so the answer is per-agent, not one fleet-wide value'
      );
    }
    check(
      liveReachOf({ type: 'task', key: 'kan497-never-spawned' }) === 'unknown',
      'and an agent this daemon never spawned still reads unknown'
    );
  } finally {
    restoreSwitch();
    for (const key of spawnedKeys) {
      try {
        bridge.closeAgentByKey(key, 'task');
      } catch (e) {
        say(`  (could not close ${key}: ${e?.message ?? e})`);
      }
      // Removed per path rather than by reverting a directory — `task/KAN-291`
      // lost three uncommitted files to a harness that ran `git checkout`.
      const dir = workspaceDirFor('task', key);
      if (dir.includes(`${path.sep}workspaces${path.sep}`) && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
} finally {
  restoreSwitch();
}

say('');

// ── THE VERDICT ────────────────────────────────────────────────────────────
//
// Written as counter-conditioned exits rather than through a `verdictFor`
// helper of my own, for two reasons that point the same way.
//
// ⚠ **The first is that `sweep-verify-exit-paths.mjs` could not see the helper
// version, and it was right not to.** It reads each exit's *expression* and
// asks whether the value is derived from an accumulated counter;
// `process.exit(code)` names a local whose provenance it cannot follow, so it
// scored this file as `NONE — 2 exit(s), all guards`, which is its verdict for
// a script that cannot report failure. #246 teaches it to resolve a reference
// back to what it was assigned from; until that lands, an exit whose CONDITION
// names the counter is the spelling the sweep can actually check. Writing code
// a required check cannot read, and then arguing the check is behind, is how a
// gate stops being a gate.
//
// The second is that duplicating #246's helper here would have been a second
// implementation of one decision — the thing this repository keeps paying for.
// Four lines of branch, deleted wholesale when the helper lands, leaves nothing
// to drift.
//
// The ORDER is the contract's and is load-bearing: a failure outranks a skip,
// so a run that both failed and skipped is FAILING. There is no `?? 0` on
// either tally — a fallback would convert "this script lost track of its own
// skips" into "nothing was skipped", the exact substitution the contract exists
// to refuse.
if (failures > 0) {
  say(`RED — ${failures} assertion(s) failed${skipped ? `, ${skipped} skipped` : ''}.`);
  process.exit(EXIT_FAIL);
}
if (skipped > 0 && !allowSkipped) {
  say(`INCOMPLETE — nothing failed, and ${skipped} arm(s) did not run.`);
  say('A skip is not a pass, and nothing here has checked what those arms would have said.');
  say('If an incomplete run is acceptable to you, say so with --allow-skipped and this exits 0.');
  process.exit(EXIT_INCOMPLETE);
}
say(
  skipped > 0
    ? `GREEN, with ${skipped} arm(s) skipped and --allow-skipped passed to accept them.`
    : 'GREEN — every arm ran, and every assertion passed.'
);
process.exit(EXIT_PASS);
