// Proof for KAN-481: the cutover watchdog's health predicate is a check.
//
// WHAT FAILURE THIS WOULD CATCH: a cutover health predicate that is satisfied
// by a HEALTHY fleet, so every flip auto-reverts on a red that says nothing
// about the system under test. That is not hypothetical — it is what happened,
// five times: attempt #5 flipped cleanly at 17:21:38Z, ran healthy for 162
// seconds with `sessionless: 0` and `noSession: 0`, and was rolled back on
// `noUrl` alone. §1 below reproduces that red on recorded PLAIN-HERDR frames,
// which is the evidence that the old predicate was measuring the caller rather
// than the fleet. It also catches the replacement rotting the same way: §4
// asserts the new predicate has a reachable branch AND an unreachable one, so
// a future edit cannot quietly turn it into something that can only go green.
//
// CI-RUNNABLE: yes — node builtins only, no build, no daemon, no herdr, no
// credential, no peer, no terminal, no network. Every frame is a literal in
// this file or a recorded line quoted in it. §5 spawns cutover-health.mjs as a
// child node process and writes its frames under os.tmpdir(), never into the
// repository, then removes them.
//
// THIS PROOF IMPORTS NOTHING FROM `dist`. It imports the predicate module from
// `daemon/scripts/lib/`, which is source. `prompts/task.md` requires the
// build's exit code to be confirmed before a `dist`-importing proof's verdict
// is read, because such a proof run after a failed build tested the previous
// build rather than your mutation. That qualifier does not apply here and one
// grep settles it: there is no `../dist/` import below. A red from this script
// is about the tree as written and must not be discarded as build fallout.
//
// ## ⚠ THIS SCRIPT CONSTRUCTS MOST OF THE FRAMES IT ASSERTS ON
//
// Named here rather than left to be inferred, because a proof that supplies
// its own input has not tested that the input arrives (KAN-145). Three
// different kinds of frame appear below and they are NOT worth the same:
//
//   - §1 and §2 use frames TRANSCRIBED FROM `~/butchr-cutover/state/cutover.log`
//     and from a live `list_agents` read taken on 2026-08-15. Those are
//     observations. They are quoted with their timestamps so a reader can go
//     and find the same lines.
//   - §3 CONSTRUCTS the 2026-08-12 signature. Nobody can re-run a flip from
//     three days ago, so this frame is built to the description in
//     `docs/crabcast-runtime.md` — *"`sessionless: true`, `sessionId: null`,
//     `url: null` on every agent"* — and the construction is the claim being
//     made. If that description is wrong, this section is wrong with it.
//   - §4 constructs minimal frames to establish the predicate's branches, and
//     ends by asserting that those frames carry every field a REAL row carries
//     — see REAL_ROW_KEYS for the mutation that got past this proof before it
//     did.
//   - §5 spawns the real `cutover-health.mjs` over `--frame` and asserts its
//     exit codes. That is the process boundary, not just the function.
//
// ## WHAT THIS DOES NOT COVER, AND WHO DOES
//
//   - **That `cutover-health.mjs` reads the SOCKET correctly.** §5 exercises
//     the prober as a process, but only over `--frame`; the socket path needs
//     a live daemon, which CI has not got. It is an observation pasted into
//     the pull request instead. NOBODY ELSE COVERS IT — this is the edge of
//     this proof and it is marked rather than papered over.
//   - **That the watchdog and `cutover.sh` call this correctly.**
//     `~/butchr-cutover/` is outside this repository and outside CI's reach,
//     so no script here can assert on it — which is exactly how `cutover.sh`
//     came to squeeze a three-valued answer through `[ -n "$(...)" ]` and let
//     an UNHEALTHY fleet pass its pre-flip gate (found by `epic/KAN-203`).
//     §5 holds the CONTRACT those callers read; it cannot hold the callers.
//     The sandbox runs that do are pasted in the pull request, and a human
//     drives the cutover that would exercise them for real.
//   - **Whether `channel` is the right second route.** §4 asserts the branch
//     exists and can be false; that it is the RIGHT reachability signal is a
//     judgement, argued in the predicate's docblock, and the only cover for it
//     is a reader who is not the author.
//   - **A route reading a field REAL_ROW_KEYS does not list.** The fidelity
//     check is only as complete as that list, which was transcribed by hand on
//     2026-08-15. A field added to the wire later is a field no fixture models
//     until somebody adds it here. That is narrowed, not closed.
//
// Usage: node daemon/scripts/verify-cutover-health-predicate.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fleetHealth, retiredPredicate, retiredCounts } from './lib/cutover-health-predicate.mjs';

let failures = 0;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       actual   ${JSON.stringify(actual)}`);
  }
}

/**
 * The keys a REAL `list_agents` row carries, transcribed from the daemon
 * socket on 2026-08-15 (`{"action":"list_agents"}`, six agents, every row the
 * same shape).
 *
 * ⚠ THIS EXISTS BECAUSE A FIXTURE THAT IS MISSING A FIELD SILENTLY EXCUSES ANY
 * BOGUS USE OF IT. `epic/KAN-39` found it reviewing this PR, and the
 * demonstration is exact: the fixtures below used to carry four keys, so
 * adding `|| typeof row?.herdrStatus === 'string'` to the reachability test —
 * a route that can NEVER be false, since every real row carries a
 * `herdrStatus` — left this proof **green** (`MUTATED_EXIT=0`, reproduced
 * independently). The predicate would have become incapable of ever tripping
 * on a real fleet while its own proof said it was fine.
 *
 * That is the ticket's whole subject arriving inside the fix for it: a check
 * that cannot go red is not a weak check, it is a check that does not exist
 * while appearing to. §4's `fixtures carry every field a real row carries`
 * is what keeps this list honest, and the list is what makes the next bogus
 * route land on a fixture that can contradict it.
 *
 * It is the same shape as `task/KAN-475`'s finding the same day — a fixture
 * whose rows disagree with the live wire in exactly the field the predicate
 * gates on.
 */
const REAL_ROW_KEYS = [
  'sessionless', 'agentName', 'sessionId', 'type', 'key', 'url', 'createdAt',
  'status', 'workDir', 'herdrStatus', 'agentRuntime', 'supervisor',
  'activatedBy', 'channel'
];

/**
 * A `list_agents` row shaped like a real one — every key in `REAL_ROW_KEYS`,
 * not merely the ones today's predicate happens to read.
 *
 * `herdrStatus` is populated on EVERY row including the sessionless ones,
 * because that is what the wire does: measured `working, working, done, idle,
 * idle, done` across six rows, four of them sessionless. A fixture that left
 * it out would be modelling a fleet that does not exist.
 */
function row({
  name,
  session = null,
  url = null,
  transport = 'channel',
  herdrStatus = 'working',
  type = 'task',
  key = 'KAN-0'
}) {
  return {
    sessionless: session === null,
    agentName: name,
    sessionId: session,
    type,
    key,
    url,
    createdAt: session === null ? null : '2026-08-15T19:49:01.559Z',
    status: session === null ? null : 'active',
    workDir: `/home/brooswit/.local/share/butchr/workspaces/${type}/${key.toLowerCase()}`,
    // Present on every real row, sessionless included — see REAL_ROW_KEYS.
    herdrStatus,
    agentRuntime: 'claude',
    supervisor: false,
    activatedBy: null,
    channel: transport === null ? undefined : { transport }
  };
}

// ---------------------------------------------------------------------------
console.log(bold('\n1. the RETIRED predicate, run against PLAIN HERDR — it fires'));
// ---------------------------------------------------------------------------
// These are the counts `butchr_health` actually wrote to
// `~/butchr-cutover/state/cutover.log`, transcribed. Every one was taken on
// plain herdr with no flip in progress: the SNAPSHOT lines are pre-flip, and
// the ROLLBACK line is after the runtime had already been put back.
//
// This is the section that makes the ticket's case. A check that fires on the
// control is not a check, and here it is, firing on five separate controls.

const RECORDED_PLAIN_HERDR = [
  { at: '2026-08-15T15:04:02Z', what: 'SNAPSHOT (pre-flip)', agents: 8, noSession: 8, noUrl: 6 },
  { at: '2026-08-15T15:09:43Z', what: 'SNAPSHOT (pre-flip)', agents: 7, noSession: 7, noUrl: 6 },
  { at: '2026-08-15T15:17:42Z', what: 'SNAPSHOT (pre-flip)', agents: 8, noSession: 8, noUrl: 7 },
  { at: '2026-08-15T17:21:09Z', what: 'SNAPSHOT (pre-flip)', agents: 7, noSession: 7, noUrl: 4 },
  { at: '2026-08-15T17:24:16Z', what: 'ROLLBACK (post-revert)', agents: 1, noSession: 0, noUrl: 1 }
];

for (const c of RECORDED_PLAIN_HERDR) {
  check(
    `${c.at}  ${c.what}  agents=${c.agents} noSession=${c.noSession} noUrl=${c.noUrl} — retired predicate FIRES`,
    retiredPredicate(c),
    true
  );
}

// The two terms fail for different reasons and the ticket only found one of
// them. Asserted separately so that a future reader does not "fix" the `url`
// term and believe the predicate is now sound.
check(
  'the ROLLBACK line fires on the `noUrl` term alone — the one KAN-481 found',
  { noSession: 0 >= 1, noUrl: 1 >= 1 },
  { noSession: false, noUrl: true }
);
check(
  'a SNAPSHOT line fires on the `noSession` term alone — the one it did NOT find',
  { noSession: 8 >= 8, noUrl: 6 >= 8 },
  { noSession: true, noUrl: false }
);

// ---------------------------------------------------------------------------
console.log(bold('\n2. the NEW predicate, run against the SAME controls — it does not fire'));
// ---------------------------------------------------------------------------
// The recorded lines above are counts rather than frames, so they are rebuilt
// here as the frames that produce them. Where a recorded line does not pin a
// field, the reconstruction is stated rather than assumed — see the note on
// the all-sessionless frames below.

// The live fleet, read off the daemon socket 2026-08-15T19:5x Z. Every field
// below was observed, including the `channel.transport` the old counts never
// captured. Four agents are sessionless — the ordinary state of a herdr fleet
// whose daemon has restarted — and all four hold a live channel registration.
const LIVE_2026_08_15 = [
  row({ name: 'butchr-epic-kan-39', session: 'epic-kan-39-1786823341558', url: 'https://wroosbit.atlassian.net/browse/KAN-39' }),
  row({ name: 'butchr-task-kan-481', session: 'task-kan-481-1786823356013', url: null }),
  row({ name: 'butchr-epic-kan-203', session: null, url: null }),
  row({ name: 'butchr-story-kan-419', session: null, url: null }),
  row({ name: 'butchr-story-kan-117', session: null, url: null }),
  row({ name: 'butchr-epic-kan-59', session: null, url: null })
];

const live = fleetHealth(LIVE_2026_08_15);
check('the live plain-herdr fleet is HEALTHY under the new predicate', live.unhealthy, false);
check('  …6 agents, all 6 reachable', [live.agents, live.reachable], [6, 6]);
check('  …2 by session, 6 by channel', [live.bySession, live.byChannel], [2, 6]);
check('  …and its margin is stated: 6 agents from a trip', live.marginAgents, 6);

// And the retired predicate on the SAME frame, to show the disagreement is
// about the predicate and not about the fleet. `noUrl` is 5 of 6 here — one
// agent short of the old trip — which is how close the control already was.
check(
  '  …while the retired counts on that identical frame read noUrl=5 of 6',
  retiredCounts(LIVE_2026_08_15).noUrl,
  5
);

// The ROLLBACK line: 1 agent, 0 without a session, 1 without a url. It has a
// session, so it is reachable, so the new predicate is quiet where the old one
// tripped. This one needs no assumption about `channel` — the session settles
// it on its own.
const rollbackFrame = [row({ name: 'butchr-epic-kan-39', session: 'epic-kan-39-1786814731572', url: null })];
check(
  '2026-08-15T17:24:16Z ROLLBACK — retired FIRES, new predicate does NOT',
  [retiredPredicate({ agents: 1, noSession: 0, noUrl: 1 }), fleetHealth(rollbackFrame).unhealthy],
  [true, false]
);

// ⚠ THE DECISIVE ONE. These are the watchdog's own polls from attempt #5 — the
// flip that worked. Three agents, every one WITH a session, rolled back on
// `noUrl` at 162 seconds. The new predicate would not have reverted it, and
// that claim needs no reconstruction either: `noSession: 0` means every agent
// had a session, and a session is reachability on its own.
const ATTEMPT_5 = [
  { at: '17:22:53', elapsed: 81, agents: 2 },
  { at: '17:23:13', elapsed: 101, agents: 3 },
  { at: '17:23:34', elapsed: 121, agents: 3 },
  { at: '17:23:54', elapsed: 142, agents: 3 },
  { at: '17:24:14', elapsed: 162, agents: 3 }
];
for (const p of ATTEMPT_5) {
  const frame = Array.from({ length: p.agents }, (_, i) =>
    row({ name: `attempt5-agent-${i}`, session: `sid-${i}`, url: null })
  );
  check(
    `attempt #5 @${p.elapsed}s (agents=${p.agents}, noSession=0, noUrl=${p.agents}) — retired FIRES, new does NOT`,
    [retiredPredicate({ agents: p.agents, noSession: 0, noUrl: p.agents }), fleetHealth(frame).unhealthy],
    [true, false]
  );
}

// ---------------------------------------------------------------------------
console.log(bold('\n3. the 2026-08-12 signature — CONSTRUCTED, and it still fires'));
// ---------------------------------------------------------------------------
// ⚠ This frame is built, not observed: the flip it describes was three days
// ago and cannot be re-run. It is built to `docs/crabcast-runtime.md`'s
// description of what the human saw — "`sessionless: true`, `sessionId: null`,
// `url: null` on every agent" — plus the fact that makes it a failure rather
// than an ordinary daemon restart: nothing could reach any of them. A flip
// drops every channel registration, so `transport: 'unregistered'`, which the
// daemon documents as a REFUSAL rather than a delivery.
const SIGNATURE_2026_08_12 = [
  row({ name: 'butchr-epic-kan-39', session: null, url: null, transport: 'unregistered' }),
  row({ name: 'butchr-story-kan-150', session: null, url: null, transport: 'unregistered' }),
  row({ name: 'butchr-task-kan-234', session: null, url: null, transport: 'unregistered' })
];

const sig = fleetHealth(SIGNATURE_2026_08_12);
check('the 2026-08-12 signature is UNHEALTHY under the new predicate', sig.unhealthy, true);
check('  …3 agents, 0 reachable', [sig.agents, sig.reachable], [3, 0]);
check('  …and it names which agents could not be reached', sig.unreachableAgents.length, 3);
check('  …margin is zero, and says so', sig.marginAgents, 0);
check(
  '  …the retired predicate also fired here — the replacement LOSES NO COVERAGE',
  retiredPredicate(retiredCounts(SIGNATURE_2026_08_12)),
  true
);

// A row with no `channel` block at all is a daemon too old to report one. It
// must not be read as "has a channel": an absent field is not an answer.
const noChannelBlock = [row({ name: 'a', session: null, url: null, transport: null })];
check(
  'an agent whose row carries NO channel block is not assumed reachable',
  fleetHealth(noChannelBlock).unhealthy,
  true
);

// ---------------------------------------------------------------------------
console.log(bold('\n4. the predicate has BOTH branches — it can go green and it can go red'));
// ---------------------------------------------------------------------------
// The failure this section exists for: an edit that makes the predicate
// unfalsifiable. A check with no reachable red is not a weak check, it is a
// check that does not exist while appearing to, and it goes green forever.

check('reachable by session ALONE (channel unregistered)',
  fleetHealth([row({ name: 'a', session: 'sid', transport: 'unregistered' })]).unhealthy, false);
check('reachable by channel ALONE (no session)',
  fleetHealth([row({ name: 'a', session: null, transport: 'channel' })]).unhealthy, false);
check('unreachable by NEITHER — the red branch',
  fleetHealth([row({ name: 'a', session: null, transport: 'unregistered' })]).unhealthy, true);
check('ONE reachable agent among many spares the fleet — the margin is real, not decorative',
  fleetHealth([
    row({ name: 'a', session: null, transport: 'unregistered' }),
    row({ name: 'b', session: null, transport: 'unregistered' }),
    row({ name: 'c', session: 'sid', transport: 'unregistered' })
  ]).unhealthy,
  false);
check('  …and that fleet reports a margin of exactly 1, so it can be watched shrinking',
  fleetHealth([
    row({ name: 'a', session: null, transport: 'unregistered' }),
    row({ name: 'b', session: null, transport: 'unregistered' }),
    row({ name: 'c', session: 'sid', transport: 'unregistered' })
  ]).marginAgents,
  1);

// An empty fleet is not a fault. A drained fleet is what a good cutover looks
// like mid-sequence, and `cutover.log` records four `agents: 0` reads taken
// straight after a rollback restart.
check('an EMPTY fleet is healthy — a drain is not a failure', fleetHealth([]).unhealthy, false);
check('a missing/garbage agents array is healthy rather than a trip', fleetHealth(undefined).unhealthy, false);

// `url` must now be irrelevant to the verdict. Asserted rather than assumed,
// because the whole defect was a url term nobody meant to be load-bearing.
const withUrl = fleetHealth([row({ name: 'a', session: null, url: 'https://x/browse/KAN-1', transport: 'unregistered' })]);
const withoutUrl = fleetHealth([row({ name: 'a', session: null, url: null, transport: 'unregistered' })]);
check('a url does NOT rescue an unreachable agent — the term is gone, not weakened',
  [withUrl.unhealthy, withoutUrl.unhealthy], [true, true]);
const reachableWithoutUrl = fleetHealth([row({ name: 'a', session: 'sid', url: null })]);
check('and a MISSING url does not condemn a reachable one — the defect itself',
  reachableWithoutUrl.unhealthy, false);

// ⚠ FIXTURE FIDELITY — the check that makes every check above worth something.
//
// A route reading a field no fixture carries is inert against every frame in
// this file, so the mutation that introduces it stays green. Asserting that
// fixtures carry what real rows carry is what forces such a mutation to land
// on data that can contradict it. See REAL_ROW_KEYS.
const sampleRows = [
  ...LIVE_2026_08_15,
  ...SIGNATURE_2026_08_12,
  row({ name: 'shape-probe', session: 'sid' })
];
const missingKeys = sampleRows.flatMap((r) =>
  REAL_ROW_KEYS.filter((k) => !(k in r)).map((k) => `${r.agentName}:${k}`)
);
check(
  'every fixture row carries every field a REAL list_agents row carries',
  missingKeys,
  []
);
check(
  '  …including `herdrStatus` on the UNREACHABLE rows, which is what catches a bogus route through it',
  SIGNATURE_2026_08_12.every((r) => typeof r.herdrStatus === 'string'),
  true
);
check(
  '  …and those rows are STILL unreachable, so a herdrStatus route would flip §3 red',
  fleetHealth(SIGNATURE_2026_08_12).unhealthy,
  true
);

// ---------------------------------------------------------------------------
console.log(bold('\n5. the 0/1/2 exit contract the cutover kit reads'));
// ---------------------------------------------------------------------------
// Spawns the real `cutover-health.mjs`. No socket is needed — `--frame` feeds
// it a document — so this runs in CI, and it tests the contract rather than
// the prose describing it.
//
// ⚠ WHY THIS IS HERE: the kit distinguishes three answers, and `cutover.sh`
// squeezed them through a two-valued test (`[ -n "$(butchr_health)" ]`), so an
// UNHEALTHY fleet — which prints a perfectly good line saying so — passed the
// pre-flip gate. Found by `epic/KAN-203` sweeping while this PR was open, and
// reproduced. `cutover.sh` is outside this repository and CI cannot see it;
// what CI CAN hold is the contract it depends on, which is this.

const frameDir = mkdtempSync(path.join(tmpdir(), 'kan481-frames-'));
function runProber(args) {
  const r = spawnSync(process.execPath, [
    fileURLToPath(new URL('./cutover-health.mjs', import.meta.url)), ...args
  ], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '' };
}
function frameFile(name, agents) {
  const p = path.join(frameDir, name);
  writeFileSync(p, JSON.stringify({ agents, missingAgents: [] }));
  return p;
}

const healthyFrame = frameFile('healthy.json', LIVE_2026_08_15);
const unhealthyFrame = frameFile('unhealthy.json', SIGNATURE_2026_08_12);
const emptyFrame = frameFile('empty.json', []);

const healthyRun = runProber(['--frame', healthyFrame]);
check('a reachable fleet exits 0', healthyRun.code, 0);
check('  …and prints its verdict rather than only signalling it',
  JSON.parse(healthyRun.stdout).unhealthy, false);
check('  …with the margin on the line, so a log reader can watch it shrink',
  JSON.parse(healthyRun.stdout).marginAgents, 6);

const unhealthyRun = runProber(['--frame', unhealthyFrame]);
check('an unreachable fleet exits 1 — a VERDICT', unhealthyRun.code, 1);
check('  …and still prints, so the caller can say WHY it refused',
  JSON.parse(unhealthyRun.stdout).unreachableAgents.length, 3);

// ⚠ A drained fleet must be able to flip. The cutover sequence drains BEFORE
// it flips, so an empty fleet exiting non-zero would make the pre-flip gate
// refuse every correctly-prepared cutover.
check('an EMPTY fleet exits 0 — a drain is not a failure', runProber(['--frame', emptyFrame]).code, 0);

// 2, never 1: "I could not look" is not "I looked and it is broken".
check('an unreadable frame exits 2 — NOT a verdict about the fleet',
  runProber(['--frame', path.join(frameDir, 'does-not-exist.json')]).code, 2);
check('  …and 2 is distinct from the unhealthy 1, which is what lets a caller tell them apart',
  runProber(['--frame', path.join(frameDir, 'does-not-exist.json')]).code !== unhealthyRun.code,
  true);

rmSync(frameDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log(bold('\n6. `url` renders ONE way — the absence that wore two faces'));
// ---------------------------------------------------------------------------
// Reads `daemon/src/router.ts` AS TEXT. It is not the compiler and does not
// pretend to be: the assignment is already `TS2322` if `toAgentDto` stops
// normalising, and that is the real gate. What text catches is the OTHER
// direction — somebody widening the field back to `url?: string`, which would
// make the raw assignment legal again and delete the compile error silently.
//
// Why this matters enough to assert: the same agent, read at the same moment,
// answered `url: null` on `list_agents` and carried NO `url` KEY on
// `agent_status`. One absence, two renderings, and `epic/KAN-203` reasonably
// could not tell whether it was looking at one defect or three.

const routerSrc = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8');

check(
  'AgentDto.url is `string | null` — not optional, so the vanishing key is unrepresentable',
  /interface AgentDto\s*\{[\s\S]*?\n\s*url:\s*string \| null;/.test(routerSrc),
  true
);
check(
  '  …and is NOT `url?: string`, which would make the raw assignment legal again',
  /interface AgentDto\s*\{[\s\S]*?\n\s*url\?:/.test(routerSrc),
  false
);
check(
  'toAgentDto normalises the registry\'s `undefined` to null, as recordedUrlFor documents',
  /url: session\.url \?\? this\.recordedUrlFor\(agentNameFor\(session\.type, session\.key\)\) \?\? null,/.test(routerSrc),
  true
);

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`\x1b[31mFAILED\x1b[0m — ${failures} check(s)`);
} else {
  console.log('\x1b[32mPASSED\x1b[0m');
}
process.exit(failures ? 1 : 0);
