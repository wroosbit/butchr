// Cutover gate 3's ruling, and the premises it actually rests on (KAN-393).
//
// WHAT FAILURE THIS WOULD CATCH: gate 3 silently re-opening. The ruling is that
// channel-startup supervision is DISABLED under CrabCast deliberately, and its
// load-bearing premise is structural rather than observational — the
// dev-channels dialog that supervision exists to answer **cannot be raised** on
// this path, because `--dangerously-load-development-channels` reaches an agent
// only as argv and `configure_agent` has no argv field. That premise is one
// import away from being false. A later author who wires `launchers.js` into
// `crabcast-runtime.ts`, or who adds a `command`/`args` member to the
// `configure_agent` frame, or who starts sending CrabCast's `"builtin"` channel
// sentinel, restores a dialog with **nothing watching for it** — which is the
// wedged agent KAN-246 exists to prevent, arriving by a route KAN-246 cannot
// see. Nothing else in the tree would report it: `setAgentSpawnedListener` would
// still not fire, the log line would still say "deliberately", and the only
// symptom is an agent that never reaches its prompt.
//
// CI-RUNNABLE: yes — reads `daemon/src/*.ts` and two docs as TEXT and asserts
// against them in process; no build, no live daemon, no herdr, no credential, no
// peer, no terminal, no CrabCast socket.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT ASSERTS, AND — MORE IMPORTANTLY — WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// This is a SOURCE-TEXT proof and it does not import from `dist`. That is
// deliberate and it is what makes its verdict readable after a failed build
// (prompts/task.md): it read what you wrote. It also bounds it.
//
// IT ASSERTS THE PREMISES, NEVER THE CONCLUSION. The conclusion — "no startup
// dialog is met under CrabCast" — is prose, and prose cannot go red. §1–§3 watch
// the three facts the conclusion is derived from, so this script fails when the
// derivation stops holding rather than when somebody edits the sentence.
//
// WHAT IT LEAVES UNCOVERED, NAMED RATHER THAN IMPLIED:
//
//   * **That a real `claude` under CrabCast meets no dialog.** Nothing static
//     can establish that. WHO COVERS IT: nobody, mechanically. The evidence is
//     seven cold starts inherited from `task/KAN-278` (two) and `task/KAN-379`
//     (five, PR #164) — an observation on one machine, cited as inherited in the
//     PR body and in `docs/crabcast-runtime.md`. This script exists precisely
//     because that evidence is thin: it guards the argument that does not
//     depend on it.
//   * **That CrabCast's `configure_agent` will not grow an argv field.** §2
//     reads OUR frame, so it catches Butchr starting to send one. A field
//     CrabCast adds and we never populate is invisible here, and harmless until
//     someone populates it — at which point §2 goes red.
//   * **Non-dev-channels startup dialogs.** Workspace trust, the welcome screen
//     and anything else in `startup-dialog.ts`'s `FOREIGN_DIALOGS` are outside
//     the ruling and outside this script. This daemon refuses to answer them on
//     every runtime, so they are an agent that starts late, not a channel
//     defect. WHO COVERS IT: `verify-startup-dialog-discrimination.mjs`, for the
//     classification; nothing, for their frequency under CrabCast.
//   * **The `pty_*` contract gap.** §6 asserts it is written down, and that is
//     all a static read can do. Whether CrabCast reshapes that surface is not
//     knowable from here; `verify-crabcast-runtime-live.mjs` is what meets a
//     real peer.
//
// THE DOC ASSERTIONS (§5, §6) ARE A WEAKER CLASS AND ARE MARKED AS SUCH. They
// prove a sentence survives deletion, not that it is true. They are here because
// AC3 asked for a disablement that a future reader does not have to re-derive,
// and a written reason that anybody can quietly delete is not one.
//
// MADE TO GO RED — each flag mutates a COPY of the source text in memory and
// asserts against that, so a red run leaves the tree untouched:
//
//   node daemon/scripts/verify-crabcast-channel-startup-disablement.mjs --import-launchers
//   node daemon/scripts/verify-crabcast-channel-startup-disablement.mjs --argv-field
//   node daemon/scripts/verify-crabcast-channel-startup-disablement.mjs --builtin-sentinel
//
// Each is the real defect in miniature, and going GREEN under one is itself
// counted as a failure — a mutation that does not move the verdict means the
// assertion is not watching what it says it watches.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');
const docsDir = path.join(repoRoot, 'docs');

const verbose = process.argv.includes('--verbose');
const importLaunchers = process.argv.includes('--import-launchers');
const argvField = process.argv.includes('--argv-field');
const builtinSentinel = process.argv.includes('--builtin-sentinel');
const mutating = importLaunchers || argvField || builtinSentinel;

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('─'.repeat(72));
  say(title);
  say('─'.repeat(72));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) {
    say(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
  }
  return ok;
};

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
const FILES = {
  runtime: path.join(srcDir, 'crabcast-runtime.ts'),
  daemon: path.join(srcDir, 'daemon.ts'),
  launchers: path.join(srcDir, 'launchers.ts'),
  runtimeDoc: path.join(docsDir, 'crabcast-runtime.md'),
  cutoverDoc: path.join(docsDir, 'crabcast-cutover-sequence.md')
};
for (const [name, file] of Object.entries(FILES)) {
  if (!existsSync(file)) {
    console.error(`Missing ${name} at ${file} — this script reads the tree, not a build.`);
    process.exit(2);
  }
}

const read = (key) => readFileSync(FILES[key], 'utf8');

let runtimeSrc = read('runtime');
const daemonSrc = read('daemon');
const launchersSrc = read('launchers');
const runtimeDoc = read('runtimeDoc');
const cutoverDoc = read('cutoverDoc');

if (importLaunchers) {
  // THE DEFECT IN MINIATURE. Somebody needs one export from `launchers.js` — a
  // constant, a helper — and adds the import. Nothing warns, the build is clean,
  // and the flag now has a route into the file that composes the spawn frame.
  runtimeSrc = runtimeSrc.replace(
    "import type { ResumeCause } from './resume.js';",
    "import type { ResumeCause } from './resume.js';\nimport { developmentChannelFlags } from './launchers.js';"
  );
}
if (argvField) {
  // THE DEFECT IN MINIATURE. `configure_agent` grows a way to pass argv and we
  // populate it — which is exactly how the dev-channels flag would reach a
  // CrabCast-spawned `claude` and raise the dialog nothing is watching for.
  // KAN-482 moved the frame into `buildConfigureAgentPayload`, so the anchor
  // moved with it. The mutation is unchanged in substance: a field carrying
  // argv, added to the literal that goes on the wire.
  runtimeSrc = runtimeSrc.replace(
    "    launcher: input.defaultAgent ?? 'claude',",
    "    launcher: input.defaultAgent ?? 'claude',\n    args: extraLauncherArgs,"
  );
}
if (builtinSentinel) {
  // THE DEFECT IN MINIATURE. Sending the sentinel makes `channelEnabled` answer
  // `true`, so `daemon.ts`'s gate stops returning early — reason 2 of the ruling
  // collapses, silently.
  // KAN-482: same mutation, new home — the conditional now lives in
  // `buildConfigureAgentPayload` and writes `payload.mcpServers`.
  runtimeSrc = runtimeSrc.replace(
    '  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {\n    payload.mcpServers = input.mcpServers;\n  }',
    '  payload.mcpServers = { ...(input.mcpServers ?? {}), crabcast: \'builtin\' };'
  );
}

say('KAN-393 — cutover gate 3: the ruling, and the premises it rests on');
say(`repo: ${repoRoot}`);
if (mutating) {
  say('');
  say('*** RUNNING WITH A MUTATION — a red below is the expected outcome. ***');
  say(
    `    ${[importLaunchers && '--import-launchers', argvField && '--argv-field', builtinSentinel && '--builtin-sentinel']
      .filter(Boolean)
      .join(' ')}`
  );
  say('    The tree on disk is NOT modified; the mutation is applied to a string.');
}

// ───────────────────────────────────────────────────────────────────────────
rule('§1  The dev-channels flag has no route into the CrabCast spawn path');
// ───────────────────────────────────────────────────────────────────────────
// PREMISE 1 of the ruling, and the load-bearing one. The flag is argv-only and
// this file cannot compose argv, so the dialog cannot be raised here.

const launchersImport = /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*'\.\/launchers\.js'/.test(
  runtimeSrc
);
check(
  !launchersImport,
  'crabcast-runtime.ts imports nothing from launchers.js',
  runtimeSrc
    .split('\n')
    .filter((l) => l.includes('launchers'))
    .join('\n') || '(no line mentions launchers)'
);

// Comments and string literals are stripped before this one, deliberately: the
// ruling ITSELF names the flag, in the docblock and in the log line, and it has
// to — a disablement that cannot say what it disabled is the silence AC3
// refused. What must not exist is a *code* reference, so that is what is
// searched. Strip order matters: comments first, so that an apostrophe inside
// one ("daemon.ts's") cannot open a phantom string.
const stripComments = (ts) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const stripStrings = (ts) =>
  ts
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');

const runtimeNoComments = stripComments(runtimeSrc);
const runtimeCode = stripStrings(runtimeNoComments);
check(
  !runtimeCode.includes('DEV_CHANNELS_FLAG') &&
    !runtimeCode.includes('developmentChannelFlags') &&
    !runtimeCode.includes('dangerously-load-development-channels'),
  'no CODE in crabcast-runtime.ts references the flag or its composer',
  runtimeCode
    .split('\n')
    .filter(
      (l) =>
        l.includes('DEV_CHANNELS_FLAG') ||
        l.includes('developmentChannelFlags') ||
        l.includes('dangerously-load-development-channels')
    )
    .join('\n') || '(named only in comments and log text, which is where the ruling lives)'
);

// The other end of the same premise: the flag really is argv-only, composed in
// one place. If `developmentChannelFlags` ever returned something that was not
// spliced into a command line, "argv-only" would stop being true and §1 would be
// asserting the wrong thing.
check(
  /export function developmentChannelFlags\(\): string \{/.test(launchersSrc) &&
    launchersSrc.includes(`${'`'}${'$'}{DEV_CHANNELS_FLAG} server:${'$'}{CORE_MCP_SERVER}${'`'}`),
  'launchers.ts is still the only composer, and composes the flag as a command-line string',
  launchersSrc
    .split('\n')
    .filter((l) => l.includes('DEV_CHANNELS_FLAG'))
    .join('\n')
);

// ───────────────────────────────────────────────────────────────────────────
rule('§2  The configure_agent frame carries no argv');
// ───────────────────────────────────────────────────────────────────────────
// PREMISE 1's other half. A flag needs a field to travel in; this frame has
// none. Asserted as a CLOSED SET rather than by grepping for `args`, because the
// failure is a field being ADDED and a deny-list cannot see a name nobody has
// thought of yet.

// KAN-482 MOVED THE FRAME OUT OF `provision()` and into the exported
// `buildConfigureAgentPayload`, and gave it a declared type. This section reads
// the new home, and it got STRONGER rather than merely relocated: the closed set
// is now checked TWICE — once against the object literal, as before, and once
// against `ConfigureAgentPayload` itself, which is the thing a future author
// would have to widen before a new field could be assigned anywhere. The old
// wording is kept in the failure text because "the frame moved" is still the
// most likely reason this goes red.

// KAN-492 WIDENED BOTH CLOSED SETS BY THREE, deliberately and with the reason
// recorded, because a closed set quietly widened is the same as no closed set.
// `refusable`, `chargeable` and `preemptable` are CrabCast's published capacity
// gate flags and carry supervisor-ness across the seam. They are safe for THIS
// section's purpose, which is narrower than "the payload may not grow": it is
// that nothing may reach `configure_agent` that turns a CrabCast CHANNEL on.
// The channel is an MCP server entry — their `{"crabcast": "builtin"}` sentinel
// — so the fields that could enable it are `mcpServers` and a command line, and
// those are still guarded exactly as before. A capacity flag cannot spawn a
// channel server. If a future addition is NOT of that kind, it does not belong
// on these lists.
//
// ⚠ READ "CHANNEL" HERE AS *CRABCAST'S*, NOT BUTCHR'S (KAN-503). The two words
// are the same and the things are not. CrabCast's `channelEnabled` is about the
// agent's reach TOWARD THEIR DAEMON — their read-path contract: an agent without
// it "has no identity: it cannot reach this daemon". Butchr's channel is a
// `notifications/claude/channel` frame going DAEMON → MODEL, and the client
// renders one only when `--dangerously-load-development-channels` is in argv.
// So this section guards a premise of DIALOG supervision, which is what it has
// always been for, and it is NOT a guard on frame delivery. Measured 2026-08-16
// by `probe-channel-reaches-model.mjs`'s third arm: with CrabCast's real builtin
// server present and no flag, the frame is emitted and the model never sees it.
// A future reader who makes this file red by sending the sentinel has NOT
// thereby given the fleet a channel — see `buildConfigureAgentPayload`.
const typeMatch = runtimeSrc.match(/export type ConfigureAgentPayload = \{([\s\S]*?)\n\};/);
const ALLOWED = [
  'action',
  'path',
  'priority',
  'refusable',
  'chargeable',
  'preemptable',
  'launcher',
  'prompt',
  'mcpServers'
];
if (check(Boolean(typeMatch), 'the ConfigureAgentPayload type declaration is findable')) {
  const declared = [...typeMatch[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map(
    (m) => m[1]
  );
  const undeclaredExtras = declared.filter((k) => !ALLOWED.includes(k));
  check(
    undeclaredExtras.length === 0,
    `the payload TYPE declares exactly ${ALLOWED.join(', ')} — nothing else`,
    `unexpected: ${undeclaredExtras.join(', ') || '(none)'}\nall fields: ${declared.join(', ')}`
  );
}

const frameMatch = runtimeSrc.match(
  /const payload: ConfigureAgentPayload = \{([\s\S]*?)\n {2}\};/
);
if (!check(Boolean(frameMatch), 'the configure_agent frame literal is findable in the builder')) {
  say('        The frame moved or was restructured. That is not automatically a defect,');
  say('        but it means this assertion is no longer reading what it thinks it reads.');
} else {
  const body = frameMatch[1];
  const keys = [...body.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  const LITERAL_ALLOWED = [
    'action',
    'path',
    'priority',
    'refusable',
    'chargeable',
    'preemptable',
    'launcher',
    'prompt'
  ];
  const unexpected = keys.filter((k) => !LITERAL_ALLOWED.includes(k));
  check(
    unexpected.length === 0,
    `the frame literal sets exactly ${LITERAL_ALLOWED.join(', ')} — nothing else`,
    `unexpected: ${unexpected.join(', ') || '(none)'}\nall keys: ${keys.join(', ')}`
  );

  // `mcpServers` is set conditionally after the literal and is the only other
  // member. It is a map of MCP server DEFINITIONS, not a command line.
  const assignments = [...runtimeSrc.matchAll(/^\s*payload\.([A-Za-z0-9_]+)\s*=/gm)].map(
    (m) => m[1]
  );
  check(
    assignments.length > 0 && assignments.every((k) => k === 'mcpServers'),
    'the only member assigned after the literal is mcpServers',
    `assignments: ${assignments.join(', ') || '(none — the conditional assignment has gone)'}`
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§3  Even if the listener fired, the gate returns — channelEnabled is false');
// ───────────────────────────────────────────────────────────────────────────
// PREMISE 2. Independent of §1 and §2, and it is what makes the ruling survive a
// surprise on the wire.

check(
  /setAgentSpawnedListener\(\(session, spawnedAt, spawn\) => \{\s*\n\s*if \(spawn\.channelEnabled !== true\) return;/.test(
    daemonSrc
  ),
  "daemon.ts's listener still returns on `spawn.channelEnabled !== true`",
  daemonSrc
    .split('\n')
    .filter((l) => l.includes('channelEnabled'))
    .join('\n')
);

// SCOPED TO THE FRAME-BUILDING REGION, and searched for a bare token inside it.
//
// Two earlier drafts of this check were wrong in opposite directions, and both
// are worth recording because the second is the one that nearly shipped. The
// first matched a SHAPE — `configure.mcpServers = {…crabcast` plus a quoted key
// — and the mutation `{ ...(mcpServers ?? {}), crabcast: 'builtin' }` walked
// past both halves: `[^}]*` cannot cross the `}` in `?? {}`, and the key was
// unquoted. It went GREEN under `--builtin-sentinel`, and the green-under-
// mutation guard at the bottom is the only thing that caught it. The second
// searched the whole file for the token and went RED on a clean tree — because
// the ruling's own log line has to name the sentinel to explain not sending it.
//
// So: comments stripped (the decision is explained in them), string literals
// KEPT (the sentinel is a string value), and the search confined to the region
// that builds and sends the frame. A token has no shape to evade, and the region
// has no prose in it.
// KAN-482 SPLIT THE REGION IN TWO, and the split is not cosmetic. Building the
// frame and sending it used to be adjacent statements; the builder is now an
// exported function ABOVE the class and the send is deep inside it, so a single
// slice spanning both would swallow the whole class head — including, at
// `spawnSession`, the ruling's own log line, which has to NAME the sentinel in
// order to say it is not sent. That is the third draft of this check making the
// second draft's mistake by accident: a region wide enough to be red on a clean
// tree. So: the builder's body, and provision's body down to the send. Nothing
// between them writes to the payload — the builder returns it and provision
// holds it — and §2's `payload.` assignment sweep is what holds that claim,
// because it is file-wide rather than region-scoped.
const sliceBetween = (from, to) => {
  const start = runtimeNoComments.indexOf(from);
  if (start < 0) return null;
  const end = runtimeNoComments.indexOf(to, start);
  return end > start ? runtimeNoComments.slice(start, end) : null;
};
const builderRegion = sliceBetween('const payload: ConfigureAgentPayload = {', 'return payload;');
const sendRegion = sliceBetween(
  'const configure = buildConfigureAgentPayload({',
  'await this.link.request(configure)'
);
const frameRegion =
  builderRegion !== null && sendRegion !== null ? `${builderRegion}\n${sendRegion}` : null;
if (check(Boolean(frameRegion), 'the frame-building region of provision() is findable')) {
  check(
    !frameRegion.includes('builtin') && !frameRegion.includes('crabcast'),
    'nothing in it sends CrabCast\'s "builtin" channel sentinel',
    frameRegion
      .split('\n')
      .filter((l) => l.includes('builtin') || l.includes('crabcast'))
      .join('\n') || '(the region names neither token)'
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§4  setAgentSpawnedListener is unfired, and says it is a decision');
// ───────────────────────────────────────────────────────────────────────────

const stub = runtimeSrc.match(
  /setAgentSpawnedListener\(\s*_listener[\s\S]*?\n {2}\}/
);
if (check(Boolean(stub), 'the CrabCast setAgentSpawnedListener stub is findable')) {
  const body = stub[0];
  check(
    !body.includes('_listener('),
    'the stub never invokes the listener it was handed',
    body.split('\n').slice(0, 4).join('\n')
  );
  check(
    /KAN-393/.test(body) && /deliberate/i.test(body),
    'its log line names KAN-393 and says the disablement is deliberate',
    body
  );
  check(
    /cutover blocker|not a cutover blocker/i.test(body),
    'its log line states the gate verdict rather than only the mechanism',
    body
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§5  The ruling is written where a future reader will look  [weak class]');
// ───────────────────────────────────────────────────────────────────────────
// These prove a sentence survives deletion, never that it is true. AC3 asked for
// a disablement that is not re-derived from silence, so the sentence existing IS
// part of the deliverable — but it is a weaker thing than §1–§3 and is labelled
// so no reader banks it as evidence of behaviour.

check(
  /Gate 3, the ruling/.test(runtimeDoc),
  'docs/crabcast-runtime.md carries the gate 3 ruling section',
  '(searched for the section heading)'
);
check(
  /cannot be raised/.test(runtimeDoc) && /argv/.test(runtimeDoc),
  'the doc gives the structural argument, not only the spawn count',
  '(searched for "cannot be raised" and "argv")'
);
check(
  /seven|five more/.test(runtimeDoc) && /inherit|KAN-379/.test(runtimeDoc),
  'the doc cites the cold-start observations as inherited rather than as its own',
  '(searched for the count and the citation)'
);

// ───────────────────────────────────────────────────────────────────────────
rule('§6  The pty_* contract gap is recorded, with what depends on it  [weak class]');
// ───────────────────────────────────────────────────────────────────────────
// KAN-393 item 2. The surface's status was already in `crabcast-link.ts`; what
// was missing was the dependency and the blast radius.

check(
  /PTY group is uncontracted/i.test(runtimeDoc),
  'docs/crabcast-runtime.md records the pty_* group as outside the contract'
);
check(
  /sidepanel terminal/i.test(runtimeDoc) &&
    /pty_init/.test(runtimeDoc) &&
    /pty_input/.test(runtimeDoc) &&
    /pty_resize/.test(runtimeDoc),
  'it names all three actions and the shipped feature that rides on them'
);
check(
  /[Ss]ilent/.test(runtimeDoc.split('PTY group is uncontracted')[1] ?? ''),
  'it names which reshape fails silently, rather than listing the actions only'
);
check(
  /uncontracted surface/.test(cutoverDoc) && /pty_init/.test(cutoverDoc),
  "the cutover sequence's step 9 canary says its terminal check runs on that surface"
);
check(
  /CRABCAST_PIN/.test(cutoverDoc),
  'and tells the driver how to tell a cutover fault from a moved surface'
);

// ── verdict ────────────────────────────────────────────────────────────────
say('');
if (failures > 0) {
  say(`FAILED — ${failures} check(s)`);
  if (importLaunchers) {
    say('');
    say('This is the expected red for --import-launchers. The behaviour that made it red:');
    say('crabcast-runtime.ts now imports from launchers.js, so the module that composes the');
    say('dev-channels flag is reachable from the module that builds the spawn frame. §1 is');
    say('the premise of the ruling, and it no longer holds.');
  }
  if (argvField) {
    say('');
    say('This is the expected red for --argv-field. The behaviour that made it red: the');
    say('configure_agent frame gained a member outside the closed set, so the frame can now');
    say('carry argv. A flag with a field to travel in is a dialog nothing is watching for.');
  }
  if (builtinSentinel) {
    say('');
    say('This is the expected red for --builtin-sentinel. The behaviour that made it red:');
    say('provision() sends {"crabcast":"builtin"}, so channelEnabled answers true and');
    say("daemon.ts's gate stops returning early. Reason 2 of the ruling is gone.");
    say('');
    say('⚠ AND ONLY REASON 2 (KAN-503). Reason 1 still holds — measured, not assumed: an');
    say('agent really configured --mcp crabcast and really activated answered');
    say('channelEnabled: true and still ran claude with NO --dangerously-load-development-');
    say('channels on its argv, and met no dev-channels dialog. Reason 3 is untouched.');
    say('⚠ DO NOT READ THIS RED AS "so we should send the sentinel". It would NOT give the');
    say('fleet a channel: CrabCast\'s channelEnabled is about reach toward THEIR daemon, and');
    say('a notifications/claude/channel frame still dies at the client without the argv flag.');
    say('probe-channel-reaches-model.mjs arm 3 measures exactly that world. See');
    say('buildConfigureAgentPayload for why this is now a ruling and not a deferral.');
  }
} else {
  say('OK — gate 3 is closed by construction: the dev-channels flag cannot reach a');
  say('CrabCast-spawned agent, the spawn gate would return anyway, and both the ruling');
  say('and the pty_* contract gap are written down where the next reader will meet them.');
  for (const [flag, label] of [
    [importLaunchers, '--import-launchers'],
    [argvField, '--argv-field'],
    [builtinSentinel, '--builtin-sentinel']
  ]) {
    if (flag) {
      say('');
      say(`BUT ${label} was requested and this went GREEN, which means the mutation did not`);
      say('take: these assertions are not watching what they claim to watch.');
      failures += 1;
    }
  }
}

process.exit(failures ? 1 : 0);
