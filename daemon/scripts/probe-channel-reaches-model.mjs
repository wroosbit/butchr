#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: a `notifications/claude/channel` frame that is
 * written, accepted and parsed by a live client and then never reaches the
 * model — the state KAN-495 measured, in which every daemon instrument read
 * `delivered: true` while the fleet went ~75 minutes unsupervised.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT COSTS
 * ---------------------------------------------------------------------------
 *
 * A PROBE, not a unit check: it spawns two real interactive `claude` sessions
 * and spends real tokens, which is why it is `probe-` rather than `verify-` and
 * why CI does not run it. `probe-guardian-poke-delivery.mjs` is the precedent.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN, AND THE ONE VARIABLE
 * ---------------------------------------------------------------------------
 *
 * Two arms. Identical MCP server, identical prompt, identical client binary,
 * same machine, same minute, both in a pty. They differ in exactly one
 * byte-range of argv:
 *
 *   ARM WITH   : claude --dangerously-load-development-channels server:channelprobe …
 *   ARM WITHOUT: claude …
 *
 * `--dangerously-load-development-channels` is composed in exactly one place in
 * this codebase — `launchers.ts` `developmentChannelFlags()` — and reaches an
 * agent only as argv. So these two command lines are, respectively, what the
 * herdr launcher produces with the kill switch on, and what a CrabCast-spawned
 * agent actually runs (`configure_agent` carries no argv field, so the flag has
 * no route in; see `crabcast-runtime.ts` `setAgentSpawnedListener`).
 *
 * ⚠ **THE POSITIVE CONTROL IS THE POINT, AND IT IS THE `WITH` ARM.** A probe
 * that only ran the `without` arm would report "the token did not appear" and
 * could not tell a dropped frame from a model declining, a prompt it ignored, a
 * client that never called the tool, or a probe server with a typo in it. Every
 * one of those fails toward the comfortable answer. The `with` arm is what makes
 * a negative mean something: it is the same everything, and the token comes back.
 *
 * ⚠ **AND THE TOKEN IS SPLIT.** Its halves are never adjacent in the frame, so a
 * model that prints them joined has assembled them, which a copy cannot do. See
 * `channel-probe-server.mjs`.
 *
 * ---------------------------------------------------------------------------
 * WHY A PTY, WHICH IS NOT AN IMPLEMENTATION DETAIL
 * ---------------------------------------------------------------------------
 *
 * ⚠ **`claude -p` NEVER DELIVERS A CHANNEL FRAME, WITH OR WITHOUT THE FLAG.**
 * Measured here on 2026-08-16 before this file was rewritten: in `--print` mode,
 * both arms called the tool, the fixture emitted the frame in both, and both
 * models answered `NOCHANNEL` — including the flagged one. So a headless harness
 * reports the defect on every arm and the flag looks irrelevant, which is a
 * false negative that reads exactly like a finding.
 *
 * The fleet runs interactive sessions in a pty (`launchers.ts` composes
 * `claude … --continue || claude … <prompt>`, and `-p` is rejected there for a
 * related reason: it would run one headless turn and leave a dead pane). So the
 * probe runs what the fleet runs. `node-pty` is the same library herdr drives.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT COVER — the header edge, marked rather than left to infer
 * ---------------------------------------------------------------------------
 *
 * ⚠ **This probe supplies its own frame**, from a fixture server rather than
 * from the daemon. So it establishes what the CLIENT does with a well-formed
 * frame, and establishes NOTHING about whether the daemon produces one, resolves
 * the right connection, or writes it. That half is covered from the other side
 * by `verify-channel-capability-refusal.mjs` (the daemon must refuse to route to
 * a client it knows cannot render), and by the daemon log lines quoted in the
 * PR. Two honest scripts can still leave a hole between them; this is where the
 * edge of this one is.
 *
 * ⚠ It also proves nothing about a client version other than the one on PATH
 * when it runs. It prints that version, so a reader can see what was measured.
 *
 * Usage: node daemon/scripts/probe-channel-reaches-model.mjs
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import pty from 'node-pty';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'channel-probe-server.mjs');

const DEV_CHANNELS_FLAG = '--dangerously-load-development-channels';
const SERVER_NAME = 'channelprobe';

/** How long an arm gets from spawn to the token appearing on its pane. */
const ARM_TIMEOUT_MS = 150_000;

/**
 * What each arm must print when it sees nothing. A POSITIVE statement of
 * absence rather than an empty answer: an arm that printed nothing at all would
 * be indistinguishable from one that crashed, and this probe must be able to
 * tell "the model looked and there was nothing" from "the model never ran".
 */
const ABSENT_MARKER = 'NOCHANNEL';

/**
 * The instruction, and why step 1 is written as emphatically as it is.
 *
 * The first version of this prompt merely asked for the tool call, and BOTH
 * arms answered `NOCHANNEL` without ever calling it — the model reasoned that
 * it could see no channel block and answered the question it had been given.
 * That is a false negative that looks exactly like the defect: no token, on
 * both arms, with a clean exit. It was caught only because the fixture reports
 * whether it ever saw a `tools/call`, which is the whole reason that check
 * exists and is read before the verdict.
 */
const PROMPT =
  `STEP 1 — REQUIRED, DO THIS FIRST: call the tool arm_channel_probe. It takes no ` +
  `arguments. You must actually call it; do not skip it and do not answer first.\n\n` +
  `STEP 2 — after the tool returns, check whether a <channel> block has appeared ` +
  `anywhere in your context. If one is present it contains two halves of a probe ` +
  `token: join them with no separator and print the joined token on a line of its ` +
  `own, prefixed with TOKEN= and nothing else on that line.\n\n` +
  `STEP 3 — if no <channel> block is present, print ${ABSENT_MARKER} on a line of ` +
  `its own.\n\n` +
  `STEP 4 — if a <channel> block arrives LATER, after you have already answered, ` +
  `print its joined token immediately in the same TOKEN= form. Do not do anything ` +
  `else and do not use any other tool.`;

/**
 * Terminal escape sequences out, so a token painted across a redraw is found.
 *
 * Written with \\u001b escapes rather than literal ESC bytes: an editor or a
 * copy-paste that eats the invisible byte turns this into a regex that chews
 * ordinary text instead, which would quietly lower this probe's chance of
 * matching its own token — a failure toward the comfortable answer.
 */
function strip(text) {
  return text
    // CSI — colour, cursor motion, erase. Claude pads with cursor-forward
    // rather than spaces, so this is most of the pane by volume.
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    // OSC — window title and friends, terminated by BEL or ST.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // The short private-mode and charset sequences that remain.
    .replace(/\u001b[>=<][0-9]*[a-zA-Z]?/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "");
}

/**
 * The startup dialogs a fresh interactive `claude` raises, answered with Enter.
 *
 * ⚠ **The folder-trust dialog blocked EVERY ARM of the first pty run.** A temp
 * working directory is not a trusted folder, so `claude` opens on that dialog
 * and never runs the prompt: the arm times out with no tool call, which reads
 * exactly like the defect this probe exists to find. `startup-dialog.ts`
 * classifies trust as a FOREIGN dialog and this daemon refuses to answer one
 * anywhere — right for somebody else's agent, and wrong here, where the session
 * is this script's own throwaway and answering is setup rather than intervention.
 *
 * The dev-channels marker is the same prose `startup-dialog.ts` matches on,
 * quoted from there rather than re-invented. Only the WITH arm can raise it.
 */
const STARTUP_DIALOGS = [
  { name: "folder-trust", pattern: /Yes,?\s*I\s*trust\s*this\s*folder/i },
  {
    name: "dev-channels",
    pattern: /Loading\s*development\s*channels|I\s*am\s*using\s*this\s*for\s*local\s*development/i
  }
];

function runArm({ label, withFlag, halfA, halfB }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chanprobe-${label}-`));
  const configPath = path.join(dir, 'mcp.json');
  // A FILE, because a stdio MCP server's stderr belongs to the CLIENT — Claude
  // Code captures it into its own MCP logs and never passes it through to
  // whoever spawned `claude`. An earlier version of this probe read the fixture's
  // notes off `claude`'s stderr, found an empty stream, and reported "the fixture
  // never emitted a frame" for runs in which it had emitted one — a failure that
  // looked exactly like the defect under test, on both arms.
  const logPath = path.join(dir, 'probe-server.log');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          command: process.execPath,
          args: [SERVER],
          env: { PROBE_HALF_A: halfA, PROBE_HALF_B: halfB, PROBE_LOG: logPath }
        }
      }
    })
  );

  const args = [];
  if (withFlag) args.push(DEV_CHANNELS_FLAG, `server:${SERVER_NAME}`);
  args.push(
    '--permission-mode',
    'bypassPermissions',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    PROMPT
  );

  const argvShown = `claude ${withFlag ? `${DEV_CHANNELS_FLAG} server:${SERVER_NAME} ` : ''}…`;
  const joined = `${halfA}${halfB}`;
  process.stdout.write(`\n--- ARM ${label} ---\n`);
  process.stdout.write(`argv : ${argvShown}\n`);
  process.stdout.write(`token: ${halfA} + ${halfB} -> ${joined}\n`);

  return new Promise((resolve) => {
    const term = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: dir,
      env: { ...process.env }
    });

    let pane = '';
    let dialogsAnswered = 0;
    let done = false;

    const finish = (why) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        term.kill();
      } catch {
        // Already gone; nothing to do.
      }
      const serverLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      const clean = strip(pane);
      const emitted = /emitted notifications\/claude\/channel/.test(serverLog);
      const toolCalled = /tools\/call arm_channel_probe/.test(serverLog);
      const sawToken = clean.includes(joined);
      const saidAbsent = clean.includes(ABSENT_MARKER);

      process.stdout.write(`ended: ${why}\n`);
      process.stdout.write(`startup dialogs answered      : ${dialogsAnswered}\n`);
      process.stdout.write(`server saw tools/call         : ${toolCalled}\n`);
      process.stdout.write(`server emitted channel frame  : ${emitted}\n`);
      process.stdout.write(`model printed joined token    : ${sawToken}\n`);
      process.stdout.write(`model printed ${ABSENT_MARKER}        : ${saidAbsent}\n`);
      process.stdout.write(`pane tail: ${JSON.stringify(clean.trim().slice(-400))}\n`);

      resolve({ label, toolCalled, emitted, sawToken, saidAbsent, pane: clean });
    };

    term.onData((d) => {
      pane += d;
    });

    // DIALOGS ARE ANSWERED ON A TIMER, NOT ON EVERY BYTE. A pty delivers a
    // dialog in many small writes, so an onData handler fires dozens of times
    // while one box is on screen and would send a burst of Enters into whatever
    // came next — including the composer. Polling a settled pane, with a
    // cooldown between presses, answers each box once.
    let lastPressAt = 0;
    const answered = new Set();
    const poll = setInterval(() => {
      const clean = strip(pane);

      if (clean.includes(joined)) {
        finish("token appeared");
        return;
      }

      const now = Date.now();
      if (now - lastPressAt < 3000) return;
      // Only the LAST screenful is consulted. The whole transcript still
      // contains the trust dialog long after it was dismissed, so matching
      // against all of `pane` would press Enter forever.
      const live = clean.slice(-1500);
      for (const dialog of STARTUP_DIALOGS) {
        if (!dialog.pattern.test(live)) continue;
        if (answered.has(dialog.name) && dialog.name === "folder-trust") continue;
        answered.add(dialog.name);
        dialogsAnswered++;
        lastPressAt = now;
        term.write("\r");
        process.stdout.write(`  [probe] answered ${dialog.name} dialog\n`);
        break;
      }
    }, 1000);

    const timer = setTimeout(() => finish('timed out'), ARM_TIMEOUT_MS);
    term.onExit(() => setTimeout(() => finish('client exited'), 500));
  });
}

const stamp = spawnSync('claude', ['--version'], { encoding: 'utf8' });
process.stdout.write(`client on PATH: ${(stamp.stdout ?? '').trim() || 'unknown'}\n`);

// Distinct tokens per arm, so an arm cannot pass on the other arm's output.
const withArm = await runArm({
  label: 'WITH-FLAG',
  withFlag: true,
  halfA: 'K495W',
  halfB: 'R7T2'
});
const withoutArm = await runArm({
  label: 'WITHOUT-FLAG',
  withFlag: false,
  halfA: 'K495N',
  halfB: 'Q3M8'
});

process.stdout.write('\n=== VERDICT ===\n');

const failures = [];

// ⚠ READ BEFORE THE TOKEN. A model that never called the tool prints
// `NOCHANNEL` truthfully, on BOTH arms, with a clean exit — which is
// byte-identical to the defect this probe exists to find, and it is the
// comfortable answer. Measured on the first run of this script: both arms
// answered `NOCHANNEL` without a single `tools/call` reaching the fixture.
for (const arm of [withArm, withoutArm]) {
  if (!arm.toolCalled) {
    failures.push(
      `${arm.label}: the model never called arm_channel_probe, so no frame was ever emitted ` +
        `at it. Its silence is a fact about the prompt, NOT about channel delivery — do not ` +
        `read it as a result.`
    );
  }
  if (!arm.emitted) {
    failures.push(`${arm.label}: the fixture never emitted a frame — that arm did not run`);
  }
}

// THE CONTROL IS CHECKED BEFORE THE FINDING, rather than reported alongside it.
// Without a working `with` arm the `without` arm's silence is a claim about this
// probe, not about the client.
if (withArm.emitted && withArm.toolCalled && !withArm.sawToken) {
  failures.push(
    'WITH-FLAG (POSITIVE CONTROL) FAILED: the frame was emitted and the model did not print ' +
      'the assembled token, so this probe has measured nothing about the other arm. Something ' +
      'other than the flag is broken — read the pane tail above before reading anything into ' +
      'WITHOUT-FLAG.'
  );
}

const controlHeld =
  withArm.emitted && withArm.toolCalled && withArm.sawToken && withoutArm.emitted && withoutArm.toolCalled;

if (controlHeld) {
  if (withoutArm.sawToken) {
    process.stdout.write(
      'BOTH ARMS REACHED THE MODEL. The dev-channels flag is NOT what decides delivery on ' +
        "this client, and KAN-495's framing needs revisiting — say so loudly.\n"
    );
  } else {
    process.stdout.write(
      'REPRODUCED. Same client, same fixture, same frame, same minute, both in a pty:\n' +
        `  WITH ${DEV_CHANNELS_FLAG}    -> the model assembled and printed the token\n` +
        '  WITHOUT it                  -> the fixture emitted the frame and the model never saw it\n' +
        'The frame dies AT THE CLIENT. The server emitted it; the client discarded it because\n' +
        'development channels were not loaded for that server.\n'
    );
  }
}

for (const f of failures) process.stdout.write(`FAIL: ${f}\n`);
process.stdout.write(`\nfailures: ${failures.length}\n`);
process.exit(failures.length ? 1 : 0);
