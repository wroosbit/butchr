#!/usr/bin/env node
/**
 * verify-standdown-ask-streak-is-visible
 *
 * WHAT FAILURE THIS WOULD CATCH: the board reconciler asking for the same
 * stand-down every cycle, forever, with each cycle's line identical to the
 * last — so a reap that is not happening is indistinguishable from one that is
 * in progress. `epic/KAN-203` measured `task/KAN-577` asked **106 times across
 * 65 minutes**, its slot charged throughout, and every individual line true.
 * Three such agents held 3 of ~10 slots (KAN-552).
 *
 * The loop was not wrong at any single cycle: asking again is correct while a
 * previous ask may not have settled. What it could not do was notice it had
 * asked a hundred times, because it kept no memory between cycles. **A retry
 * that cannot count is indistinguishable from a retry that is working.**
 *
 * ⚠ THE ASSERTION THAT MATTERS MOST IS §2, NOT §1. Making the alarm fire is
 * easy; making it NOT fire on a healthy stand-down is what stops this becoming
 * noise that gets filtered out — which is how the original 106 lines were
 * survivable in the first place.
 *
 * ⚠ WHAT THIS DOES NOT COVER, AND WHO DOES. It drives `reconcileOnce` with a
 * stubbed `deactivate` and a stubbed running set, so it proves the LOOP counts
 * and reports. It does not reap anything and does not establish why the runtime
 * fails to stop these agents — that is the ratchet itself, still open on
 * KAN-552, and this makes it visible rather than fixing it. Nobody covers the
 * join between "the board reports a stuck reap" and "the reap gets unstuck".
 */

// CI-RUNNABLE: yes — imports the built `board-reconcile.js` and drives it with
// in-process stubs. Points `HOME` at a temp dir and touches nothing else: no
// herdr, no CrabCast, no PTY, no network, no Jira, no wall clock.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.env.BUTCHR_DIST
  ? path.resolve(process.env.BUTCHR_DIST)
  : path.join(repoRoot, 'daemon', 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan552-streak-'));
process.env.HOME = tmpHome;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const { BoardReconciler, BOARD_JQL, STAND_DOWN_ASKS_BEFORE_ALARM } = await import(
  path.join(distDir, 'board-reconcile.js')
);

let failures = 0;
const check = (ok, what, detail) => {
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
};

const agent = (type, key) => ({ agentName: `butchr-${type}-${key.toLowerCase()}`, type, key });
const STUCK = agent('task', 'KAN-577');

/**
 * One reconciler, driven for N cycles. `runningFor(cycle)` decides what the
 * fleet looks like each time, so a stand-down that actually takes is modelled
 * by the agent leaving the running set — which is the only way it ever ends.
 */
async function cycles(n, runningFor) {
  const log = [];
  let i = 0;
  const reconciler = new BoardReconciler({
    jira: { async searchBoard() { return { ok: true, issues: [] }; } },
    runningAgents: () => runningFor(i),
    activate: async () => ({ success: true }),
    // The workspace route: `success: true` means ASKED, not stopped.
    deactivate: async () => ({ success: true, standDownRoute: 'workspace' }),
    mode: () => 'converge',
    isSupervisorType: (type) => type === 'epic' || type === 'story',
    log: (...args) => log.push(args.join(' '))
  });
  const seen = [];
  for (; i < n; i++) {
    const c = await reconciler.reconcileOnce();
    if (c.refusal) {
      console.error(`INCOMPLETE: cycle ${i} refused (${JSON.stringify(c.refusal)}); the fixture ` +
        `did not converge, so nothing about the streak was exercised. NOT a finding about the code.`);
      process.exit(2);
    }
    seen.push(c);
  }
  return { log, cycles: seen };
}

console.log(`\n1. A REAP THAT NEVER TAKES BECOMES VISIBLE (threshold ${STAND_DOWN_ASKS_BEFORE_ALARM})`);
{
  // The agent never leaves the running set — the KAN-577 condition.
  const { log } = await cycles(STAND_DOWN_ASKS_BEFORE_ALARM + 1, () => [STUCK]);
  const alarmed = log.filter((l) => /HAS NOW BEEN ASKED/.test(l));

  check(
    alarmed.length > 0,
    'the loop eventually says the stand-down is not happening',
    log.slice(-1)[0]?.slice(0, 220)
  );
  check(
    /ASKED \d+ TIMES/.test(alarmed.join('\n')),
    'and it COUNTS the asks, so "again" and "a hundred times" are different reports',
    alarmed.slice(-1)[0]?.slice(0, 240)
  );
  check(
    /slot stays charged/.test(alarmed.join('\n')),
    'it names the consequence — a charged slot — not just the repetition',
    alarmed.slice(-1)[0]?.slice(0, 240)
  );
  check(
    /not a stand-down in progress/.test(alarmed.join('\n')),
    'and it distinguishes "in progress" from "not happening", which is the whole defect',
    alarmed.slice(-1)[0]?.slice(0, 240)
  );
}

console.log('\n2. ⚠ A HEALTHY STAND-DOWN NEVER ALARMS — the assertion that keeps this signal worth reading');
{
  // Asked once, gone next cycle: what a working reap looks like.
  const { log } = await cycles(4, (i) => (i === 0 ? [STUCK] : []));
  check(
    !/HAS NOW BEEN ASKED/.test(log.join('\n')),
    'one ask followed by the agent going does NOT trip the alarm',
    log.join('\n').slice(0, 240)
  );
  check(
    log.some((l) => /ASKED the runtime to stand down/.test(l)),
    'and the ordinary ask is still reported, so silence is not how it passes',
    log.join('\n').slice(0, 240)
  );
}

console.log('\n3. THE STREAK IS CONSECUTIVE — an agent that goes and returns starts over');
{
  // Stuck for 2 cycles (below threshold), gone, then back. If the count were a
  // TOTAL rather than a streak, the return would alarm immediately.
  const { log } = await cycles(5, (i) => (i === 2 ? [] : [STUCK]));
  check(
    !/HAS NOW BEEN ASKED/.test(log.join('\n')),
    'a run of 2, an exit, and a return does not alarm — the count reset when it left',
    log.filter((l) => /ASKED/.test(l)).slice(-1)[0]?.slice(0, 240)
  );
}

console.log('');
if (failures) {
  console.log(`${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('All assertions passed');
process.exit(0);
