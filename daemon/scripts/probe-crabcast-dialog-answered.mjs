// KAN-496: does a CrabCast-spawned agent carrying the dev-channels flag get
// PAST the dialog that flag raises — driven through the REAL runtime?
//
// WHAT FAILURE THIS WOULD CATCH: the flag being sent to a runtime that cannot
// answer the dialog, which is not a degraded channel but a fleet that WEDGES AT
// BOOT. The activation succeeds either way — `configure_response` and
// `activate_response` are both `success: true` — and the only symptom is an
// agent that never reaches its prompt.
//
// A PROBE, not a `verify-`: it configures and activates a real agent against the
// live CrabCast daemon, spends a real charged slot and a few real tokens, and
// depends on a peer. `probe-guardian-poke-delivery.mjs` is the precedent.
//
// CI-RUNNABLE: no — needs the live CrabCast socket, a real herdr, a real pane
// and a real `claude` binary, and it starts an agent that costs capacity.
//
// ---------------------------------------------------------------------------
// ⚠ WHY THIS DRIVES `provision()` AND DOES NOT BUILD ITS OWN PAYLOAD
// ---------------------------------------------------------------------------
// This repository's standing defect is "a proof that supplies its own input has
// not tested that the input arrives" — KAN-145's two scripts asserted that the
// daemon carries `activatedBy` by constructing records that already had it.
// So this calls `runtime.spawnSession(...)`, the production entry point, and
// lets it compose the payload, read the kill switch, send `args`, and fire the
// spawn listener. The only thing supplied here is the listener body, which is a
// copy of what `daemon.ts` installs — and §4 of
// `verify-crabcast-channel-startup-supervision.mjs` is what holds those two in
// agreement, because this file cannot.
//
// ---------------------------------------------------------------------------
// THE ARMS, AND WHY THE SECOND ONE IS THE POINT
// ---------------------------------------------------------------------------
//   ARM SUPERVISED   : flag sent, startup supervision installed  -> reaches prompt
//   ARM UNSUPERVISED : flag sent, NO supervision installed       -> wedges at dialog
//
// ⚠ THE UNSUPERVISED ARM IS THE POSITIVE CONTROL AND IT MUST FAIL. Without it,
// "the agent reached its prompt" is compatible with the dialog never having been
// raised at all — which is exactly what everybody believed until 2026-08-17, and
// is how a proof of a keystroke that never happened would read. The second arm
// is what makes the first mean something: same flag, same runtime, same minute,
// differing only in whether anything answers.
//
// Usage: node daemon/scripts/probe-crabcast-dialog-answered.mjs [--keep]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const keep = process.argv.includes('--keep');

const { CrabCastRuntime } = await import(path.join(DIST, 'crabcast-runtime.js'));
const { CrabCastLink } = await import(path.join(DIST, 'crabcast-link.js'));
const { superviseChannelStartup } = await import(path.join(DIST, 'channel-startup.js'));
const { classifyStartupDialog } = await import(path.join(DIST, 'startup-dialog.js'));

const socketPath =
  process.env.BUTCHR_CRABCAST_SOCKET ||
  path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');

const say = (s = '') => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${String(detail).split('\n').slice(0, 8).join('\n        ')}`);
  return ok;
};

const PROMPT =
  'Print the single word PROBEREADY on a line by itself. Then stop and do nothing else.';

/** The flag on the live process, read off /proc rather than believed. */
function argvOfClaudeIn(workDir) {
  const out = spawnSync('bash', ['-lc', `ps -eo pid,args | grep -F ${JSON.stringify(workDir)} | grep -v grep`], {
    encoding: 'utf8'
  });
  // The pane's own `claude` is easier found by the flag it should be carrying;
  // fall back to any claude whose cwd matches.
  const byCwd = spawnSync(
    'bash',
    ['-lc', `for p in $(pgrep -x claude); do if [ "$(readlink -f /proc/$p/cwd)" = "$(readlink -f ${JSON.stringify(workDir)})" ]; then tr '\\0' ' ' < /proc/$p/cmdline; echo; fi; done`],
    { encoding: 'utf8' }
  );
  return (byCwd.stdout || out.stdout || '').trim();
}

async function runArm({ name, supervise }) {
  say('');
  say('─'.repeat(72));
  say(`ARM ${name} — flag sent, supervision ${supervise ? 'INSTALLED' : 'ABSENT (the control)'}`);
  say('─'.repeat(72));

  // ⚠ THE RUNTIME LOG IS PRINTED, NOT SWALLOWED. The first version of this probe
  // passed `log: () => {}` and both arms came back with an empty pane and no
  // explanation — `provision()` reports its refusals through that log and
  // nowhere else, because it runs behind a `void ... .catch()` with no caller to
  // throw to. A silenced log turned a loud refusal into "nothing happened",
  // which is the exact shape of defect this whole ticket is about.
  const link = new CrabCastLink({ socketPath, log: (m) => say(`        [link] ${m}`) });

  // The dev-channels argv is forced on for BOTH arms, so the arms differ in
  // exactly one thing: whether anything answers the dialog. Reading the real
  // kill switch would make this probe report a different result depending on a
  // file, and the question here is not whether the switch is on.
  const FLAG_ARGV = ['--dangerously-load-development-channels=server:butchr'];
  const armRuntime = new CrabCastRuntime({
    link,
    log: (m) => say(`        [runtime] ${m}`),
    censusIntervalMs: 60_000,
    channelArgv: () => FLAG_ARGV
  });
  // The link connects asynchronously; provisioning before it is up is a refusal
  // that says nothing about the flag.
  await sleep(1500);
  let workDir = '(not assigned)';

  let dialogsAnswered = 0;
  let supervisionVerdict = null;
  if (supervise) {
    // A COPY OF WHAT `daemon.ts` INSTALLS. See the header for why that is a
    // named gap rather than an oversight.
    armRuntime.setAgentSpawnedListener((session, spawnedAt, spawn) => {
      if (spawn.channelEnabled !== true) return;
      void superviseChannelStartup({
        address: { type: session.type, key: session.key },
        spawnedAt,
        world: {
          readPane: async () => {
            const tail = await armRuntime.tailAgent(session.key, session.type, 140);
            return tail.success && typeof tail.text === 'string' ? tail.text : null;
          },
          pressEnter: (confirmation) => {
            dialogsAnswered += 1;
            say(`        [supervisor] pressing Enter — matched on "${confirmation.evidence}"`);
            armRuntime.pressPaneKey(session.key, session.type, 'Enter');
          },
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          // This probe is not testing MCP readiness, only the dialog. Answering
          // `null` keeps the supervisor looping on the pane rather than
          // declaring success on a connection nobody checked.
          freshConnection: () => null,
          log: () => {}
        }
      }).then((v) => {
        supervisionVerdict = v;
      });
    });
  }

  const key = `KAN496P-${name}`;
  let started = false;
  try {
    const session = armRuntime.spawnSession('task', key, undefined, PROMPT, 1, false, 'claude', {
      butchr: {
        command: process.execPath,
        args: [path.join(DIST, 'mcp.js'), '--workspace-type', 'task', '--workspace-key', key]
      }
    });
    workDir = session.workDir;
    started = true;
    say(`        workDir: ${workDir}`);
  } catch (e) {
    check(false, 'spawnSession was accepted', String(e?.message ?? e));
  }

  // The spawn is asynchronous behind `spawnSession`; give the pane time to boot,
  // meet its dialog, and (in the supervised arm) be answered.
  let pane = '';
  let reachedPrompt = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const tail = await armRuntime.tailAgent(key, 'task', 140);
    pane = tail.success && typeof tail.text === 'string' ? tail.text : '';
    if (/PROBEREADY/.test(pane)) {
      reachedPrompt = true;
      break;
    }
  }

  const live = argvOfClaudeIn(workDir);
  const paneShowsDialog = classifyStartupDialog(pane).kind === 'dev-channels';

  return { name, key, started, pane, reachedPrompt, dialogsAnswered, paneShowsDialog, live, armRuntime, link, workDir, supervisionVerdict };
}

say('KAN-496 — does a flagged CrabCast agent get past its dev-channels dialog?');
say(`socket: ${socketPath}`);
say('');
say('⚠ This starts REAL agents against the live CrabCast daemon and costs capacity.');

const results = [];
for (const arm of [
  { name: 'SUPERVISED', supervise: true },
  { name: 'UNSUPERVISED', supervise: false }
]) {
  const r = await runArm(arm);
  results.push(r);

  say('');
  say(`  reached its prompt : ${r.reachedPrompt}`);
  say(`  dialogs answered   : ${r.dialogsAnswered}`);
  say(`  live argv          : ${r.live || '(no claude process found in that cwd)'}`);
  say('  pane (last lines):');
  for (const l of String(r.pane).split('\n').slice(-8)) say(`    │ ${l}`);

  // Tear the agent down before the next arm, so the second is not refused for
  // capacity by the first. The runtime's own close is tried first; the CLI is
  // the belt to its braces, because the adapter's deactivate travels over the
  // link and this loop is about to close it.
  try {
    await r.armRuntime.closeAgentByKey?.(r.key, 'task');
  } catch {}
  await sleep(1000);
  try {
    r.armRuntime.stop?.();
    r.link.close?.();
  } catch {}
  // ⚠ RECORDS OUTLIVE SESSIONS. `deactivate` stops the agent; only `forget`
  // removes CrabCast's record of it, and a probe that leaves records behind
  // makes the next reader's `crabcast list` a lie about the fleet. The first
  // run of this probe left two, and they had to be cleared by hand.
  for (const argv of [['deactivate', r.workDir], ['forget', r.workDir]]) {
    spawnSync('crabcast', [...argv, '--json'], { encoding: 'utf8' });
  }
  await sleep(2000);
}

const sup = results.find((r) => r.name === 'SUPERVISED');
const uns = results.find((r) => r.name === 'UNSUPERVISED');

say('');
say('─'.repeat(72));
say('VERDICT');
say('─'.repeat(72));

check(
  /--dangerously-load-development-channels=server:butchr/.test(sup.live) || sup.reachedPrompt,
  'the flag reached the real process argv in the `=` form',
  sup.live
);
check(
  !/--dangerously-load-development-channels (?!=)/.test(sup.live),
  'and never in the two-token form, which would have swallowed the prompt',
  sup.live
);
check(sup.dialogsAnswered > 0, 'the supervisor identified the dev-channels dialog and pressed Enter');
check(sup.reachedPrompt, 'and the supervised agent REACHED ITS PROMPT and answered', sup.pane.slice(-400));

// ⚠ THE CONTROL. If this passes, the dialog was never blocking and the arm above
// proved nothing about the keystroke.
check(
  !uns.reachedPrompt,
  'THE CONTROL: with no supervision the same spawn does NOT reach its prompt',
  uns.reachedPrompt
    ? 'the unsupervised agent got through anyway — so the dialog is not blocking, and the ' +
      'supervised arm above is not evidence that the keystroke did anything'
    : ''
);
check(
  uns.paneShowsDialog,
  'and is sitting at the dev-channels dialog, which is WHY it did not',
  uns.pane.slice(-400)
);

if (!keep) {
  // ⚠ GUARDED, because `workDir` is a REAL workspace directory now rather than a
  // temp one — `spawnSession` chooses it, not this script. An unguarded
  // recursive delete of whatever ended up in that variable is one refactor away
  // from removing a live agent's workspace. Only this probe's own keys, only
  // under the workspaces root.
  for (const r of results) {
    const looksLikeOurs =
      typeof r.workDir === 'string' &&
      r.workDir.includes(`${path.sep}workspaces${path.sep}task${path.sep}`) &&
      path.basename(r.workDir).startsWith('kan496p-');
    if (!looksLikeOurs) {
      say(`  (left ${r.workDir} alone — it is not one of this probe's workspaces)`);
      continue;
    }
    try { fs.rmSync(r.workDir, { recursive: true, force: true }); } catch {}
  }
}

say('');
if (failures > 0) {
  say(`FAILED — ${failures} check(s).`);
  process.exit(1);
}
say('OK — the flag lands as one token, the dialog is real and blocking, and');
say('    channel-startup supervision under CrabCast answers it.');
process.exit(0);
