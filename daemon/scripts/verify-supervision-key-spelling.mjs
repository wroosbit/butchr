// Proof for KAN-229: the key a supervision notice names is spelled the way the
// board spells it — in the delivered message and in the `[supervision]` log
// subject — for an agent whose key never went through the registry, and for one
// whose registry record holds the wrong spelling.
//
// WHAT FAILURE THIS WOULD CATCH: a supervisor being told `task/kan-500 → blocked`
// about a child whose ticket is spelled KAN-500, so the agent that receives the
// notice either fails the lookup or guesses. It also catches the narrower fix
// that looks identical from the ticket's description — normalising only the
// `?? key` fallback — which leaves the one path that actually reaches a
// supervisor's pane still sending the pane spelling. §5 is the section that
// would catch that one, and it is the section this ticket did not know it needed.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// READ THIS BEFORE CITING THIS SCRIPT: THE TICKET'S PREMISE WAS WRONG
//
// KAN-229 says the `?? key` fallback puts a lower-cased key into a delivered
// nudge, and asks (AC1) for a `sessionless` agent with no registry record to
// prove it on both surfaces at once. **Half of that is not reachable, and it is
// not reachable for a good reason.** `spelling()` and `notify()` read the same
// record: `recordedKeyFor` misses exactly when `supervisorFor` misses, and a
// change with no supervisor of record is dropped before anything is delivered.
// So the no-record agent reaches the log subject — built above that check — and
// never a pane. §1 shows that, including the drop.
//
// The path that does reach a pane is the lookup *succeeding* on a bad spelling.
// `handleActivateByKey` records the key its caller passed, verbatim, so a
// supervisor that staffs `task/kan-500` writes `kan-500` into the durable
// registry with its own parentage attached. §0 establishes that against the real
// registry rather than asserting it; §2 delivers it to a real pane. A fix
// wrapped around only the fallback would have passed AC1 as written and left
// this untouched — which is why the fix normalises the whole expression.
//
// Sections:
//
//   0. the conditions are real  — a real on-disk AgentRegistry genuinely cannot
//                                 spell an unrecorded agent, and a real
//                                 activation through the real MessageRouter
//                                 genuinely records `kan-500` WITH a parent.
//                                 Nothing below is worth reading if these do not
//                                 hold, because both are the ticket's factual
//                                 claims about code neither §1 nor §2 exercises.
//   1. the log subject          — AC1's reachable half: the unrecorded agent's
//                                 `[supervision]` subject names KAN-500, and the
//                                 notice is dropped rather than delivered
//   2. the delivered notice     — the recorded-bad-spelling agent's supervisor
//                                 receives KAN-500 in its actual pane scrollback
//   3. non-Jira keys            — `confluence/123456789` and `task/scratch`
//                                 arrive exactly as they were (AC3)
//   4. THE RED                  — the same three scenarios against a copy of the
//                                 built module with the rule removed
//   5. HALF THE FIX             — the rule applied to the `?? key` fallback only,
//                                 which is what the ticket's own diagnosis
//                                 describes, and the proof that §2 catches it
//
// WHAT IS REAL HERE AND WHAT IS NOT
//
// Real: `renderedKey`, `SupervisionNotifier`, `supervisionNudgeText` and
// `deliverToAgent` as shipped; a real on-disk `AgentRegistry`; a real
// `MessageRouter` performing a real activation in §0; and the pane's own
// scrollback as the thing asserted on, so §2 reads what a supervisor would
// actually see rather than the string this script passed to a stub.
//
// **Constructed: the census, and the pane.** THIS SCRIPT WRITES THE FLEET IT
// THEN ASSERTS ON — a herdr stub reports the agents and holds the scrollback,
// because the alternative is starting real agents on the machine this runs on.
// That leaves two things uncovered:
//
//   - Nothing here proves a *real* herdr census reaches the *real* daemon's
//     supervision sweep with agents in it. **Who covers it: section 7 of
//     verify-status-change-nudges.mjs (`--live`)**, which kills a real pane and
//     reads a real supervisor's terminal.
//   - Nothing here proves the daemon *wires* `recordedKeyFor` into the notifier
//     at all — §1 and §2 construct the notifier themselves. **Who covers it:
//     nobody, and that is a real hole rather than a rhetorical one.** It is one
//     line (daemon.ts) and the type makes it optional, so deleting it typechecks
//     and leaves every script here green. Filed as **KAN-231**, linked `Relates`;
//     the check that closes it belongs to whichever script boots a real daemon,
//     not to this one.
//
// Usage: node daemon/scripts/verify-supervision-key-spelling.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.join(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(daemonDir, 'dist');

if (!fs.existsSync(path.join(distDir, 'nudge.js'))) {
  // A setup guard, not a verdict: there is nothing to be right or wrong about
  // until the build exists. The verdict-derived exit is at the bottom.
  console.error(`No build at ${distDir}. Run: cd daemon && npx tsc`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan229-'));

// ------------------------------------------------------------------ output --

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const check = (ok, yes, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${yes}`);
  if (!ok && detail) console.log(`        ${detail}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

// ----------------------------------------------------------------- the pane --

/**
 * A herdr whose agents have panes, so "delivered" means a string is in a
 * scrollback rather than a boolean this script chose.
 *
 * Trimmed from the stub in verify-status-change-nudges.mjs, which owns the
 * send-race half of this behaviour; this one needs the pane only because
 * `deliverToAgent` confirms against a tail, and a delivery check that could not
 * fail would make §2 assert on nothing.
 */
function stubHerdr(names, statuses = {}) {
  const alive = [...names];
  const panes = new Map();
  const paneFor = (n) => {
    if (!panes.has(n)) panes.set(n, { scrollback: ['bypass permissions on'], composer: '' });
    return panes.get(n);
  };
  const nameFor = (key, type) => `butchr-${type ?? 'task'}-${String(key).toLowerCase()}`;
  const wrap = (text) =>
    (text.match(/.{1,76}(\s|$)/g) ?? [text])
      .map((l, i) => (i === 0 ? `❯ ${l.trim()}` : `  ${l.trim()}`))
      .join('\n');

  return {
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: path.join(TMP, name),
        herdrStatus: statuses[name] ?? 'working'
      }))
    }),
    confirmAgentPresent: async (n) =>
      alive.includes(n)
        ? { present: true, waitedMs: 0, checks: 1 }
        : { present: false, reason: 'absent', waitedMs: 0, checks: 1, error: `no agent '${n}'` },
    tailAgent: (key, type) => {
      const n = nameFor(key, type);
      if (!alive.includes(n)) return { success: false, error: `no agent '${n}'` };
      const p = paneFor(n);
      return {
        success: true,
        text: [...p.scrollback, '─'.repeat(80), `❯ ${p.composer}`, '─'.repeat(80)].join('\n')
      };
    },
    sendToAgent: async (key, message, type) => {
      const n = nameFor(key, type);
      if (!alive.includes(n)) return { success: false, error: `no agent '${n}'` };
      const p = paneFor(n);
      p.scrollback.push(wrap(message), '● Noted.');
      p.composer = '';
      return { success: true };
    },
    /** Everything this pane actually received, as submitted lines. */
    submitted: (n) => paneFor(n).scrollback.filter((l) => l.startsWith('❯ ')).join('\n')
  };
}

/**
 * Drive one notifier through `working` → `blocked` and hand back everything a
 * reader could see: the log lines, and the supervisor's pane.
 *
 * Two sweeps, because `recognise` only announces a transition *from* `working` —
 * an agent already blocked when the daemon first saw it has not changed under
 * anybody. So the first sweep establishes the baseline and the second is the
 * event.
 */
async function runScenario(nudgeMod, { subject, subjectKey, recordedKey, parent }) {
  const { SupervisionNotifier } = nudgeMod;
  const SUPERVISOR = 'butchr-story-kan-75';
  const bridge = stubHerdr([SUPERVISOR, subject]);
  const lines = [];

  const notifier = new SupervisionNotifier({
    herdrBridge: bridge,
    supervisorFor: (n) => (n === subject ? parent : null),
    recordedKeyFor: (n) => (n === subject ? recordedKey : undefined),
    log: (...a) => lines.push(a.join(' '))
  });

  const census = (status) => ({
    agents: [
      { agentName: SUPERVISOR, type: 'story', key: 'KAN-75', herdrStatus: 'working' },
      { agentName: subject, type: subjectKey.type, key: subjectKey.key, herdrStatus: status }
    ],
    missing: []
  });

  await notifier.onSweep(census('working'));
  const result = await notifier.onSweep(census('blocked'));

  return {
    result,
    lines,
    subjectLine: lines.find((l) => l.startsWith('[supervision]')) ?? '(no line)',
    pane: bridge.submitted(SUPERVISOR)
  };
}

/** A copy of the build with one edit, so the red is the shipped code minus the rule. */
function patchedDist(tag, edits) {
  const dir = path.join(daemonDir, `dist-${tag}-${process.pid}`);
  fs.cpSync(distDir, dir, { recursive: true });
  const report = [];
  for (const [file, from, to] of edits) {
    const target = path.join(dir, file);
    const source = fs.readFileSync(target, 'utf8');
    const hits = source.split(from).length - 1;
    report.push({ file, from, hits });
    fs.writeFileSync(target, source.split(from).join(to));
  }
  return { dir, report, ok: report.every((r) => r.hits === 1) };
}

const nudge = await import(pathToFileURL(path.join(distDir, 'nudge.js')).href);

const UNRECORDED = 'butchr-task-kan-500';
const RECORDED = 'butchr-task-kan-501';
const PARENT = { type: 'story', key: 'KAN-75' };

// =============================================================================
rule('0. THE CONDITIONS ARE REAL — both of them, against real components');
// =============================================================================
//
// This section exists because §1 and §2 stub the registry lookups, and a script
// that stubs the very thing the ticket makes a claim about proves the claim it
// assumed. Both claims are checked here against the real code that produces
// them, so the stubs below are reproducing something rather than inventing it.

{
  const { AgentRegistry } = await import(pathToFileURL(path.join(distDir, 'agent-registry.js')).href);
  const { MessageRouter } = await import(pathToFileURL(path.join(distDir, 'router.js')).href);
  const { WorkspaceRegistry } = await import(pathToFileURL(path.join(distDir, 'registry.js')).href);
  const { PromptLoader } = await import(pathToFileURL(path.join(distDir, 'prompt.js')).href);
  const { createAtlassianIntegration } = await import(
    pathToFileURL(path.join(distDir, 'integrations', 'atlassian-integration.js')).href
  );
  const { IntegrationStateStore } = await import(
    pathToFileURL(path.join(distDir, 'integrations', 'enablement.js')).href
  );

  const registry = new WorkspaceRegistry(new IntegrationStateStore(path.join(TMP, 'i.json')));
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
  registry.setEnabled('jira', true);

  const alive = ['butchr-story-kan-75'];
  const bridge = {
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name, agentRuntime: 'claude', workDir: TMP, herdrStatus: 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    listHerdrStatuses: () => new Map(alive.map((n) => [n, 'working'])),
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    getSessionByAddress: () => undefined,
    confirmAgentPresent: async () => ({ present: true, waitedMs: 0, checks: 1 }),
    abandonSession: () => {},
    terminateSession: () => ({ success: true }),
    closeAgentByKey: () => ({ success: true }),
    tailAgent: () => ({ success: true, text: '' }),
    sendToAgent: async () => ({ success: true }),
    spawnSession: (type, key, url) => {
      const n = `butchr-${type}-${String(key).toLowerCase()}`;
      if (!alive.includes(n)) alive.push(n);
      const workDir = path.join(TMP, type, String(key).toLowerCase());
      fs.mkdirSync(workDir, { recursive: true });
      return { sessionId: `${n}-stub`, type, key, url, createdAt: new Date(),
               status: 'active', workDir, ptyBuffer: '', onDataListeners: [] };
    }
  };

  const agentRegistry = new AgentRegistry(path.join(TMP, 'agents.jsonl'));
  const router = new MessageRouter(
    registry, new PromptLoader(repoRoot), bridge, () => {}, () => {}, { agentRegistry }
  );

  // Claim A: an agent the registry never recorded cannot be spelled by it.
  row('recordedKeyFor(unrecorded)', String(router.recordedKeyFor(UNRECORDED)));
  row('supervisorFor(unrecorded)', String(router.supervisorFor(UNRECORDED)));
  check(
    router.recordedKeyFor(UNRECORDED) === undefined && router.supervisorFor(UNRECORDED) === null,
    'an unrecorded agent has neither a recorded spelling nor a supervisor of record',
    'the two must miss together — if they can miss apart, §1\'s account of why nothing is delivered is wrong'
  );

  // Claim B: a real activation records the caller's spelling verbatim, parent
  // attached. This is the claim KAN-229 does not make and the fix depends on.
  const chatter = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try {
    await router.handleActivateByKey(
      { override: true, type: 'task', key: 'kan-501', defaultAgent: 'claude',
        workspaceType: 'story', workspaceKey: 'KAN-75' },
      () => {}
    );
  } finally {
    console.log = chatter.log; console.warn = chatter.warn;
  }

  const rec = agentRegistry.intents().get(RECORDED)?.record;
  row('record.key after activation', JSON.stringify(rec?.key));
  row('record.activatedBy', JSON.stringify(rec?.activatedBy));
  check(
    rec?.key === 'kan-501' && rec?.activatedBy?.key === 'KAN-75',
    'a real activation records the caller\'s lower-cased key WITH a supervisor of record',
    'the delivered-nudge path in §2 depends on this being producible; if it is not, §2 is hypothetical'
  );
  console.log(
    '\n  So the registry is not a trustworthy speller either, and the fix cannot\n' +
    '  be a guard on the `?? key` fallback alone. §5 is that fix, failing.\n'
  );
}

// =============================================================================
rule('1. THE LOG SUBJECT — AC1\'s reachable half, and the half that is not');
// =============================================================================

const unrecorded = await runScenario(nudge, {
  subject: UNRECORDED,
  subjectKey: { type: 'task', key: 'kan-500' },
  recordedKey: undefined,
  parent: null
});

row('[supervision] subject', unrecorded.subjectLine);
row('changes recognised', String(unrecorded.result.changes.length));
row('delivered', String(unrecorded.result.delivered));
row('skipped, and why', unrecorded.result.skipped.map((s) => s.reason).join('; ') || '(none)');

check(
  unrecorded.subjectLine.includes('task/KAN-500') && !unrecorded.subjectLine.includes('kan-500'),
  'the unrecorded agent\'s log subject names the board\'s spelling',
  unrecorded.subjectLine
);
check(
  unrecorded.result.delivered === 0 &&
    unrecorded.result.skipped[0]?.reason === 'no supervisor of record',
  'and nothing is delivered for it — the same missing record that lost the spelling lost the reader',
  `delivered=${unrecorded.result.delivered} skipped=${JSON.stringify(unrecorded.result.skipped.map((s) => s.reason))}`
);

console.log(
  '\n  This is the correction to the ticket: AC1 asks for this agent to produce\n' +
  '  the board\'s spelling "in a delivered nudge", and no version of this code\n' +
  '  delivers anything for it. The delivered half is §2\'s, on a different agent.\n'
);

// =============================================================================
rule('2. THE DELIVERED NOTICE — what a supervisor\'s pane actually receives');
// =============================================================================

const recorded = await runScenario(nudge, {
  subject: RECORDED,
  subjectKey: { type: 'task', key: 'kan-501' },
  recordedKey: 'kan-501', // what §0 proved a real activation writes
  parent: PARENT
});

row('[supervision] subject', recorded.subjectLine);
row('delivered', String(recorded.result.delivered));
console.log('\n  story/KAN-75\'s pane, as it would render it:\n');
console.log(recorded.pane.split('\n').map((l) => '    ' + l).join('\n'));
console.log();

check(
  recorded.result.delivered === 1,
  'the notice really was delivered — a spelling check on an undelivered notice proves nothing',
  JSON.stringify(recorded.result.skipped)
);
check(
  recorded.pane.includes('task/KAN-501') && !recorded.pane.includes('task/kan-501'),
  'and the supervisor\'s pane names the board\'s spelling',
  recorded.pane
);
check(
  recorded.subjectLine.includes('task/KAN-501'),
  'as does the log subject for the same change — one rule, both surfaces',
  recorded.subjectLine
);

// =============================================================================
rule('3. NON-JIRA KEYS — returned exactly as they arrived (AC3)');
// =============================================================================

for (const [type, key] of [['confluence', '123456789'], ['task', 'scratch'], ['task', 'KAN-77']]) {
  const subject = `butchr-${type}-${key.toLowerCase()}`;
  const out = await runScenario(nudge, {
    subject,
    subjectKey: { type, key },
    recordedKey: key,
    parent: PARENT
  });
  const named = `${type}/${key}`;
  row(`${named} delivered as`, out.pane.match(/\[butchr daemon\] (\S+)/)?.[1] ?? '(nothing)');
  check(
    out.pane.includes(named),
    `${named} reaches the pane unchanged`,
    out.pane
  );
}

// =============================================================================
rule('4. THE RED — the same build with the rule removed');
// =============================================================================
//
// The rule lives in keys.js since this ticket. Reverting `renderedKey` to the
// identity it wraps gives the pre-fix behaviour exactly, because the pre-fix
// `spelling()` was that expression without the call.

const raw = patchedDist('kan229-raw', [
  ['keys.js', 'return JIRA_KEY.test(upper) ? upper : key;', 'return key;']
]);
check(
  raw.ok,
  'the patch site is where this section thinks it is',
  `${JSON.stringify(raw.report)} — \`renderedKey\` has moved or changed shape; this section proves nothing until it is updated`
);

if (raw.ok) {
  const rawNudge = await import(pathToFileURL(path.join(raw.dir, 'nudge.js')).href);

  const redLog = await runScenario(rawNudge, {
    subject: UNRECORDED,
    subjectKey: { type: 'task', key: 'kan-500' },
    recordedKey: undefined,
    parent: null
  });
  const redPane = await runScenario(rawNudge, {
    subject: RECORDED,
    subjectKey: { type: 'task', key: 'kan-501' },
    recordedKey: 'kan-501',
    parent: PARENT
  });

  // These assert the RED IS RED. A failure here means the defect could not be
  // reproduced, and therefore that §1 and §2 are not testing what they claim to.
  check(
    redLog.subjectLine.includes('task/kan-500'),
    'without the rule, the log subject named kan-500',
    redLog.subjectLine
  );
  check(
    redPane.pane.includes('task/kan-501'),
    'without the rule, a supervisor\'s pane really was told about task/kan-501',
    redPane.pane
  );

  // And §1/§2's own assertions, re-run against the red. They must be FALSE, or
  // they are decorations that would pass on the unfixed build.
  check(
    !(redLog.subjectLine.includes('task/KAN-500') && !redLog.subjectLine.includes('kan-500')),
    'and §1\'s own check is false against it — so §1 is a gate, not a happy path',
    'the subject check passed against the unnormalised build'
  );
  check(
    !(redPane.pane.includes('task/KAN-501') && !redPane.pane.includes('task/kan-501')),
    'and §2\'s own check is false against it — so §2 is a gate, not a happy path',
    'the pane check passed against the unnormalised build'
  );

  // Non-Jira keys must be unharmed by the rule, which means the red and the
  // green have to AGREE here. A section 3 that went red too would mean the rule
  // was doing something to keys it should not touch.
  const redScratch = await runScenario(rawNudge, {
    subject: 'butchr-task-scratch',
    subjectKey: { type: 'task', key: 'scratch' },
    recordedKey: 'scratch',
    parent: PARENT
  });
  check(
    redScratch.pane.includes('task/scratch'),
    'and task/scratch is identical either way — the rule only ever touched Jira-shaped keys',
    redScratch.pane
  );

  console.log(`
  what a supervisor was told before this fix:

    log subject   ${redLog.subjectLine.trim()}
    delivered     ${redPane.pane.match(/\[butchr daemon\] \S+ \(\S+\)/)?.[0] ?? '(none)'}

  and neither names a ticket on any board.
`);
}

// =============================================================================
rule('5. HALF THE FIX — the ticket\'s own diagnosis, and why it is not enough');
// =============================================================================
//
// §4 removed the rule outright, which is honest and easy: any check goes red.
// The failure worth guarding against is the one a careful reader of KAN-229
// would have shipped — normalise the FALLBACK, because the ticket says the
// fallback is the defect. That build passes AC1 as the ticket words it and still
// sends `task/kan-501` to a supervisor, because there the lookup succeeded.
//
// This is the section that makes §2 load-bearing rather than redundant with §1.

// The fallback moved inside the call instead of outside it — the census key is
// rendered, the registry's is trusted. That is precisely what KAN-229 prescribes
// ("the lookup is not the problem, the unnormalised fallback is"), so this build
// is the one a careful reader of the ticket ships.
const half = patchedDist('kan229-half', [
  [
    'nudge.js',
    'return renderedKey(this.opts.recordedKeyFor?.(agentName) ?? key);',
    'return this.opts.recordedKeyFor?.(agentName) ?? renderedKey(key);'
  ]
]);

{
  check(
    half.ok,
    'the half-fix patch site is where this section thinks it is',
    `${JSON.stringify(half.report)} — \`spelling\` has moved or changed shape; this section proves nothing until it is updated`
  );

  if (half.ok) {
    const halfNudge = await import(pathToFileURL(path.join(half.dir, 'nudge.js')).href);

    const halfLog = await runScenario(halfNudge, {
      subject: UNRECORDED,
      subjectKey: { type: 'task', key: 'kan-500' },
      recordedKey: undefined,
      parent: null
    });
    const halfPane = await runScenario(halfNudge, {
      subject: RECORDED,
      subjectKey: { type: 'task', key: 'kan-501' },
      recordedKey: 'kan-501',
      parent: PARENT
    });

    row('half-fix log subject', halfLog.subjectLine);
    row('half-fix delivered', halfPane.pane.match(/\[butchr daemon\] \S+/)?.[0] ?? '(none)');

    check(
      halfLog.subjectLine.includes('task/KAN-500'),
      'the fallback-only fix does satisfy AC1 as the ticket words it',
      halfLog.subjectLine
    );
    check(
      halfPane.pane.includes('task/kan-501'),
      'and still sends kan-501 to a supervisor — the ticket\'s diagnosis was not the whole defect',
      halfPane.pane
    );
    check(
      !(halfPane.pane.includes('task/KAN-501') && !halfPane.pane.includes('task/kan-501')),
      'and §2\'s own check is false against it — so §2 is what catches the half fix',
      'the pane check passed against a half-fixed build, which means §2 would not have caught it'
    );

    console.log(`
  one build, two surfaces, and the ticket's own fix on it:

    log subject   ${halfLog.subjectLine.trim()}
    delivered     ${halfPane.pane.match(/\[butchr daemon\] \S+ \(\S+\)/)?.[0] ?? '(none)'}

  the first is what AC1 asked for; the second is what the ticket was filed to stop.
`);
  }
}

// ------------------------------------------------------------------ cleanup --

fs.rmSync(raw.dir, { recursive: true, force: true });
fs.rmSync(half.dir, { recursive: true, force: true });
fs.rmSync(TMP, { recursive: true, force: true });

console.log(
  `\n== ${failures === 0 ? 'done — every section passed' : `${failures} CHECK(S) FAILED`} ==`
);
process.exit(failures === 0 ? 0 : 1);
