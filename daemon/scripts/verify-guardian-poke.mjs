// The guardian's poke: that an undelivered one says so, that a second guardian
// is refused, and that nothing about this mechanism can spawn, interrupt or hold.
//
// WHAT FAILURE THIS WOULD CATCH: a guardian poke that reports success while
// nothing was delivered — the shape in which this whole feature ships silently
// dead. The timer fires every thirty minutes, the send is refused because the
// guardian holds no channel registration, the refusal is swallowed or converted
// into a queued retry, and the fleet is unsupervised while every surface reads
// healthy. That is not hypothetical twice over: KAN-274 was filed because a lost
// registration was invisible to the *sender* until after the interrupt had
// landed, and KAN-284's own description names this exact risk — "the timer
// fires, the send refuses, the fleet is unsupervised, everything reports
// healthy" — as the thing that decides whether the feature is real.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// It would equally catch three narrower regressions, each of which passes any
// test that only asks "did the poke go out":
//
//   * A POKE ON THE COMPOSER. §4. A carrier that interrupts would Ctrl+C the
//     guardian 48 times a day by design, and the recipient would read each one
//     as a refusal nobody made (KAN-301). The interface has no composer in it,
//     and §4 asserts that property of the shipped type rather than trusting the
//     call site.
//   * A POKE THAT SPAWNS. §5. The guardian is a POINTER at an agent that already
//     exists — the human, 2026-08-11: "the guardian agent should pointed to an
//     existing agent, not a whole new agent." A mechanism that started an agent
//     to receive its own pokes would report delivered every time and prove
//     nothing at all.
//   * A SECOND GUARDIAN. §3. Two guardians is two parties each assuming the
//     other swept — which happened to KAN-284 itself, filed twice ninety
//     minutes apart by two agents each assuming the other had checked.
//
// ---------------------------------------------------------------------------
// HOW TO WATCH IT GO RED — no merge base and no mutation needed
// ---------------------------------------------------------------------------
// Run with `--swallow-refusal`. It replaces ONE thing: the world's `send`
// reports its refusals as successes, which is the single-line mistake an author
// makes when they wire a poke to a delivery helper that returns a bare boolean.
// Everything else is the shipped code.
//
//   node daemon/scripts/verify-guardian-poke.mjs --swallow-refusal
//
// §1 and §2 go red: the poke to an unregistered agent reports `delivered: true`,
// `transport: 'channel'` against a connection that does not exist, and the
// record's own description stops distinguishing the loud state from the quiet
// one. That is the defect this script exists for, reproduced from one changed
// line. `--hold-undelivered` is the second recipe: it holds refusals the way
// notify.ts holds news, and §2 goes red because `undelivered` has become
// `pending`, which reads as fine.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), and that is the defect this repository keeps re-finding, so:
//
//   THIS SCRIPT SUPPLIES THE WHOLE WORLD. It constructs a `GuardianWorld` whose
//   `send` returns refusals it chose and whose config it wrote, then drives the
//   shipped `runGuardianPoke`, `GuardianRecord` and `setGuardian`. It therefore
//   tests THE DECISION PROCEDURE — what the mechanism concludes from a refusal —
//   and NOTHING about whether a real refusal ever reaches it.
//
//   WHAT IT DOES NOT COVER, NAMED RATHER THAN LEFT TO BE INFERRED:
//     - that `daemon.ts` wires this poker to `routeChannelMessage` at all;
//     - that a real channel write to a real connection succeeds;
//     - that the timer ever fires.
//
//   WHO COVERS IT: nothing on a schedule, and that is stated rather than
//   implied. What covers it once, at review time, is the live poke pasted into
//   the pull request — a real `guardian`/`poke` call against the running daemon,
//   showing `transport: "channel"`, `interrupted: false` and a real connection
//   id, plus its mirror image against an agent that is not running showing
//   `success: false`. That is an observation of the running system, not a test,
//   and it lapses the moment the wiring changes. `verify-guardian-board-display.mjs`
//   is the sibling that covers the display half; the gap between the two — the
//   daemon's own wiring — is owned by neither, deliberately named here.

import assert from 'assert';

import {
  runGuardianPoke,
  GuardianRecord,
  GuardianPoker,
  setGuardian,
  clearGuardian,
  noGuardian,
  composePokeMessage,
  DEFAULT_POKE_INTERVAL_MS,
  OVERDUE_INTERVALS,
  PROVES_DETAIL
} from '../dist/guardian.js';

const swallowRefusal = process.argv.includes('--swallow-refusal');
const holdUndelivered = process.argv.includes('--hold-undelivered');

const failures = [];
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

/** A clock the proof drives, so nothing here waits on a real interval. */
let clock = Date.parse('2026-08-11T20:00:00.000Z');
const now = () => clock;
const advance = (ms) => {
  clock += ms;
};

const logLines = [];
const log = (message) => logLines.push(message);

/**
 * A world whose refusals the proof chooses.
 *
 * `--swallow-refusal` changes exactly one thing: a refusal is reported as a
 * success. That is the whole recipe for the red, and it is the mistake an author
 * makes by wiring a poke to a helper whose answer is a bare boolean.
 *
 * `--hold-undelivered` is the other recipe: it takes the refusal and reports it
 * as delivered-eventually, which is what using notify.ts's queue here would do.
 */
function worldWith({ route, config }) {
  return {
    emissionEnabled: () => true,
    readConfig: () => config,
    send: () => {
      if (route.routed) return route;
      if (swallowRefusal) return { routed: true, connectionId: 'conn-that-does-not-exist' };
      if (holdUndelivered) return { routed: true, connectionId: 'held-for-redelivery' };
      return route;
    },
    now,
    log
  };
}

const GUARDIAN = { type: 'epic', key: 'KAN-203' };
const CONFIGURED = {
  address: GUARDIAN,
  intervalMs: DEFAULT_POKE_INTERVAL_MS,
  setBy: '[from epic/KAN-39]',
  setAt: new Date(clock).toISOString()
};

// ---------------------------------------------------------------------------
section('§1 A poke to an unregistered agent reports UNDELIVERED, not success (AC2)');
// ---------------------------------------------------------------------------
// KAN-274's refusal, propagated rather than swallowed. `registration-lost` is
// the state a daemon restart leaves behind and is the commonest way a guardian
// becomes unreachable, so it is the one asserted here.

const refused = runGuardianPoke({
  world: worldWith({
    config: CONFIGURED,
    route: {
      routed: false,
      reason: 'registration-lost',
      detail: 'the durable registry expects epic/KAN-203 to hold a connection and it holds none'
    }
  }),
  pokeNumber: 1
});

check(
  'the outcome is `undelivered`',
  refused.outcome === 'undelivered',
  `outcome=${refused.outcome}`
);
check(
  '`delivered` is false — the one field a caller branches on',
  refused.delivered === false,
  `delivered=${refused.delivered}`
);
check(
  "`transport` is 'undelivered' rather than a carrier that did not carry it",
  refused.transport === 'undelivered',
  `transport=${refused.transport}`
);
check(
  'the channel\'s own refusal reason survives to the caller',
  refused.reason === 'registration-lost',
  `reason=${refused.reason}`
);
check(
  'nothing was interrupted',
  refused.interrupted === false,
  `interrupted=${refused.interrupted}`
);
check(
  'the detail says plainly that nothing was delivered',
  /NOTHING WAS DELIVERED/.test(refused.detail),
  refused.detail.slice(0, 80) + '…'
);
check(
  'and it says the poke was NOT retried on the composer',
  /not retried on\s+the composer|not retried on the composer/.test(refused.detail),
  'the composer is named as the thing that did not happen'
);
check(
  'and it says the poke was NOT held for redelivery',
  /not held for redelivery/.test(refused.detail),
  'a held poke would say "sweep now" at a moment nobody chose'
);

// The log line is the other half of "loud": somebody grepping the daemon log at
// the moment they notice the fleet has gone quiet must be able to find this.
check(
  'the log line for an undelivered poke is distinct from a delivered one',
  logLines.some((line) => line.includes('POKE UNDELIVERED')),
  logLines[logLines.length - 1] ?? '(no log line)'
);

// ---------------------------------------------------------------------------
section('§2 An absent guardian is LOUD, and visibly distinct from a quiet success (AC3)');
// ---------------------------------------------------------------------------
// The requirement in the ticket's own words: "Guardian: epic/KAN-203" and
// "Guardian: epic/KAN-203 — last poke landed 4 hours ago" must not render the
// same. Here that is asserted on the record; the rendering half is
// `verify-guardian-board-display.mjs`.

const deliveredWorld = worldWith({
  config: CONFIGURED,
  route: { routed: true, connectionId: 'conn-7' }
});
const refusedWorld = worldWith({
  config: CONFIGURED,
  route: { routed: false, reason: 'no-connection', detail: 'no live channel connection' }
});

const happyRecord = new GuardianRecord({ readConfig: () => CONFIGURED, now });
happyRecord.record(runGuardianPoke({ world: deliveredWorld, pokeNumber: 1 }));
const happy = happyRecord.state();

const sadRecord = new GuardianRecord({ readConfig: () => CONFIGURED, now });
for (let i = 0; i < OVERDUE_INTERVALS; i += 1) {
  sadRecord.record(runGuardianPoke({ world: refusedWorld, pokeNumber: i + 1 }));
  advance(DEFAULT_POKE_INTERVAL_MS);
}
const sad = sadRecord.state();

check(
  'a delivered poke is not overdue',
  happy.overdue === false,
  `overdue=${happy.overdue}`
);
check(
  `${OVERDUE_INTERVALS} undelivered pokes ARE overdue`,
  sad.overdue === true,
  `overdue=${sad.overdue}, consecutiveUndelivered=${sad.consecutiveUndelivered}`
);
check(
  'the two states do not describe themselves the same way',
  happy.detail !== sad.detail,
  'identity alone would have made these identical'
);
check(
  'the overdue description says the fleet is unsupervised',
  /UNSUPERVISED/.test(sad.detail),
  sad.detail.slice(0, 70) + '…'
);
check(
  'the overdue description names the last refusal, so a reader knows where to look',
  sad.detail.includes('no-connection'),
  'the reason is carried through to the sentence'
);
check(
  'a delivered state carries no alarm wording',
  !/UNSUPERVISED/.test(happy.detail),
  'a page where everything is an alarm has no alarms'
);

// THE LIMIT IS CARRIED AS DATA. This is the commitment that a heartbeat cannot
// be mistaken for supervision, and it is asserted rather than left in a comment
// precisely because a comment is invisible to the surfaces that render.
check(
  "`proves` is the literal 'delivery' in BOTH states",
  happy.proves === 'delivery' && sad.proves === 'delivery',
  `happy=${happy.proves}, sad=${sad.proves}`
);
check(
  'the calm state still carries the limit sentence — it is where the overclaim would be made',
  happy.provesDetail === PROVES_DETAIL &&
    /heartbeat proves the loop turns/.test(happy.provesDetail),
  'a heartbeat proves the loop turns; it says nothing about whether its decisions are right'
);
check(
  'no field on the state is named for health',
  !Object.keys(happy).some((k) => /^(healthy|ok|status|fine|green)$/i.test(k)),
  `fields: ${Object.keys(happy).join(', ')}`
);

// A GUARDIAN THAT IS NOT SET AT ALL is the quietest failure and must be the
// loudest state. A fresh install is here.
const emptyRecord = new GuardianRecord({ readConfig: () => noGuardian(), now });
const empty = emptyRecord.state();
check(
  'with no guardian configured, `configured` is false',
  empty.configured === false,
  `configured=${empty.configured}`
);
check(
  'and it says so loudly rather than reading as an ordinary empty state',
  /NO GUARDIAN IS SET/.test(empty.detail),
  empty.detail.slice(0, 60) + '…'
);
check(
  'an unconfigured guardian is NOT reported as overdue — nobody was asked',
  empty.overdue === false,
  'an alarm about an agent nobody named would be an alarm nobody can act on'
);

// ---------------------------------------------------------------------------
section('§3 Exactly one guardian, and the refusal names the condition (AC4)');
// ---------------------------------------------------------------------------

let stored = noGuardian();
const store = {
  now,
  read: () => stored,
  write: (config) => {
    stored = config;
  }
};

const first = setGuardian({ ...store, address: { type: 'epic', key: 'KAN-203' } });
check('the first guardian is accepted', first.ok === true, first.detail ?? '');

const second = setGuardian({ ...store, address: { type: 'epic', key: 'KAN-39' } });
check('a SECOND, different guardian is refused', second.ok === false, `ok=${second.ok}`);
check(
  "the refusal names the condition as `already-set`",
  second.ok === false && second.refusal === 'already-set',
  second.ok === false ? second.refusal : '(not refused)'
);
check(
  'the refusal names the incumbent by address',
  second.ok === false && second.detail.includes('epic/KAN-203'),
  second.ok === false ? second.detail.slice(0, 70) + '…' : ''
);
check(
  'the refusal says WHY there is only one',
  second.ok === false && /each\s+assuming the other swept|assuming the other swept/.test(second.detail),
  'two parties each assuming the other swept'
);
check(
  'nothing was written by the refused set',
  stored.address?.key === 'KAN-203',
  `stored=${stored.address?.type}/${stored.address?.key}`
);

const sameAgain = setGuardian({ ...store, address: { type: 'epic', key: 'KAN-203' } });
check(
  'setting the SAME guardian again is idempotent, not refused',
  sameAgain.ok === true,
  'the options page writes on every save; refusing that would be a rule with no defect behind it'
);

const replaced = setGuardian({
  ...store,
  address: { type: 'epic', key: 'KAN-39' },
  replace: true
});
check(
  'an explicit `replace` is accepted and names who it replaced',
  replaced.ok === true && replaced.replaced?.key === 'KAN-203',
  replaced.ok === true ? replaced.detail : '(refused)'
);

// An interval is not silently reset by a change of guardian — a change that does
// more than its sentence says is this codebase's favourite defect.
stored = { address: GUARDIAN, intervalMs: 90_000, setBy: null, setAt: null };
const keptInterval = setGuardian({
  ...store,
  address: { type: 'story', key: 'KAN-150' },
  replace: true
});
check(
  'changing WHO the guardian is does not silently change HOW OFTEN',
  keptInterval.ok === true && stored.intervalMs === 90_000,
  `intervalMs=${stored.intervalMs}`
);

const cleared = clearGuardian(store);
check(
  'clearing reports what was cleared rather than assuming there was something',
  cleared.cleared?.key === 'KAN-150' && stored.address === null,
  `cleared=${cleared.cleared?.type}/${cleared.cleared?.key}`
);
check(
  'clearing says plainly that nothing is watching the fleet now',
  /nothing is watching the fleet/.test(cleared.detail),
  cleared.detail.slice(0, 60) + '…'
);

// ---------------------------------------------------------------------------
section('§4 The channel and only the channel — no composer, no interrupt, no hold');
// ---------------------------------------------------------------------------
// Asserted against the SHIPPED interface rather than against a call site,
// because the property that matters is that a composer is unrepresentable.

const worldKeys = Object.keys(
  worldWith({ config: CONFIGURED, route: { routed: true, connectionId: 'c' } })
);
check(
  'GuardianWorld exposes no composer, pane, type-into or nudge capability',
  !worldKeys.some((k) => /composer|pane|type|nudge|keystroke|interrupt/i.test(k)),
  `world: ${worldKeys.join(', ')}`
);
check(
  'every poke reports `interrupted: false`, delivered or not',
  refused.interrupted === false &&
    runGuardianPoke({ world: deliveredWorld, pokeNumber: 9 }).interrupted === false,
  'a channel frame waits for the turn boundary; nothing here can take a tool call'
);
check(
  "a delivered poke reports `transport: 'channel'`",
  runGuardianPoke({ world: deliveredWorld, pokeNumber: 10 }).transport === 'channel',
  'the field AC1 asks to see in the pasted evidence'
);

// The no-hold property, read off the module's own source. A queue here would
// convert the loudest state this feature has into `pending`.
const guardianSource = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../src/guardian.ts', import.meta.url), 'utf8')
);
check(
  'guardian.ts does not import notify.ts\'s hold-and-deliver queue',
  !/from '\.\/notify\.js'/.test(guardianSource) &&
    !/PendingNotifications/.test(guardianSource.replace(/\/\*[\s\S]*?\*\//g, '')),
  'holding a poke turns `undelivered` into `pending`, which reads as fine'
);

// ---------------------------------------------------------------------------
section('§5 A pointer, never a spawn (the human, 2026-08-11)');
// ---------------------------------------------------------------------------

check(
  'GuardianWorld has no activator, launcher or registry capability',
  !worldKeys.some((k) => /activate|spawn|launch|start|create|reserve/i.test(k)),
  `world: ${worldKeys.join(', ')}`
);
check(
  'a poke at an agent that is not running produces `undelivered`, not an activation',
  refused.outcome === 'undelivered' && refused.address?.key === 'KAN-203',
  'a guardian the system spawns to receive its own pokes proves nothing'
);
check(
  'guardian.ts imports nothing that could start an agent',
  !/from '\.\/(launchers|herdr|agent-runtime|reconcile|board-reconcile)\.js'/.test(guardianSource),
  'the interface cannot express it and the module cannot reach around it'
);

// ---------------------------------------------------------------------------
section('§6 The poke message says what it is and pre-authorises nothing (KAN-217)');
// ---------------------------------------------------------------------------
// KAN-217 measured a model correctly refusing a probe that ended "do not ask
// permission first" — and from outside, a correct refusal is indistinguishable
// from a broken transport. For a guardian that means the fleet is unsupervised
// while everything reports healthy.

const message = composePokeMessage({
  address: GUARDIAN,
  intervalMs: DEFAULT_POKE_INTERVAL_MS,
  pokeNumber: 3
});

check(
  'it carries the daemon tag, so the recipient can place it',
  message.startsWith('[butchr daemon]'),
  message.slice(0, 30) + '…'
);
check(
  'it points at the brief rather than vouching for itself',
  /your own brief/.test(message),
  'an expectation set out-of-band is what makes an in-band request answerable'
);
check(
  'it says declining is a non-answer rather than a fault',
  /not as a fault/.test(message),
  'KAN-217 refused a probe that pre-authorised itself, and was right to'
);
check(
  'it contains no instruction to skip asking or to act without judgement',
  !/do not ask|without asking|do not question|immediately and without/i.test(message),
  'the exact sentence KAN-217 quoted as its red flag'
);
check(
  'it says the role is ADDITIONAL to the recipient\'s own work',
  /ADDITIONAL TO YOUR OWN WORK/.test(message),
  'the guardian is a pointer at an agent that already has a ticket'
);
check(
  'it asks for a durable artifact a human can judge',
  /LEAVE SOMETHING A HUMAN CAN JUDGE/.test(message),
  'the one thing here that is not cadence'
);
check(
  'it repeats the limit rather than implying the poke is the supervision',
  /says nothing about whether your decisions were right/.test(message),
  'the recipient is told what its own heartbeat is worth'
);

// ---------------------------------------------------------------------------
section('§7 The schedule reads its interval fresh, so a change needs no restart');
// ---------------------------------------------------------------------------
// A restart is the one action that drops every channel registration in the
// fleet. A setting that required one to take effect would make this feature's
// only knob cost the thing it exists to protect.

let liveConfig = { ...CONFIGURED, intervalMs: 60_000 };

// `readConfig` is a closure over `liveConfig` rather than a snapshot of it, which
// is exactly how `daemon.ts` wires it: `() => readGuardianConfig()`, read from
// disk per call. Mutating the binding here is what a human saving the options
// page does to the file.
const readsFresh = new GuardianPoker({
  world: {
    emissionEnabled: () => true,
    readConfig: () => liveConfig,
    send: () => ({ routed: true, connectionId: 'conn-1' }),
    now,
    log
  }
});
const before = readsFresh.state().intervalMs;
liveConfig = { ...liveConfig, intervalMs: 15 * 60_000 };
const after = readsFresh.state().intervalMs;
check(
  'the reported interval follows the config without a restart',
  before === 60_000 && after === 15 * 60_000,
  `${before}ms → ${after}ms`
);

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
if (failures.length) {
  console.log(`FAILED (${failures.length} of ${checks}):`);
  for (const f of failures) console.log(`  - ${f}`);
  if (swallowRefusal) {
    console.log('\n(--swallow-refusal was passed: §1 and §2 failing here is the POINT.');
    console.log(' A refusal reported as a success is the defect this script exists for,');
    console.log(' and it is one changed line away from the shipped behaviour.)');
  }
  if (holdUndelivered) {
    console.log('\n(--hold-undelivered was passed: §1 and §2 failing here is the POINT.');
    console.log(' Holding a poke turns `undelivered` into `pending`, which reads as fine.)');
  }
} else {
  console.log(`All ${checks} checks passed.`);
}
console.log('='.repeat(78));

process.exit(failures.length ? 1 : 0);
