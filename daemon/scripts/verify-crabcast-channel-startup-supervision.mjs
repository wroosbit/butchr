// KAN-496 — cutover gate 3, RE-DERIVED: the premises of channel-startup
// supervision under CrabCast, now that it is ON rather than deliberately off.
//
// WHAT FAILURE THIS WOULD CATCH: Butchr sending the dev-channels flag to a
// runtime that cannot answer the dialog the flag raises. That is not a
// degraded channel — it is a fleet that WEDGES AT BOOT. Measured on 2026-08-17:
// a real CrabCast-spawned `claude` carrying the flag sits at "WARNING: Loading
// development channels / ❯ 1. I am using this for local development" and is
// still there at 45 seconds. Nothing else in the tree would report it: the
// activation succeeds, `configure_response` and `activate_response` are both
// `success: true`, and the only symptom is an agent that never reaches its
// prompt.
//
// ---------------------------------------------------------------------------
// THIS FILE REPLACES `verify-crabcast-channel-startup-disablement.mjs`
// ---------------------------------------------------------------------------
// That script asserted the premises of the OPPOSITE ruling — KAN-393's, that
// supervision was deliberately disabled here — and its load-bearing premise was
// `configure_agent` having no argv member. KAN-348's register closed gate 3 on
// that basis and named its own expiry: "if `configure_agent` ever gains an argv
// member, the trigger becomes spellable and the structural argument collapses."
//
// It gained one (CrabCast contract 12, their PR #122, KAN-504). So the old
// script was not repaired — it was asserting a ruling that no longer holds, and
// a proof kept green by editing its expectations is a proof of nothing. This is
// the replacement, watching the premises of the ruling that replaced it.
//
// CI-RUNNABLE: yes — reads `daemon/src/*.ts` as TEXT and asserts against them in
// process; no build, no live daemon, no herdr, no credential, no peer, no
// terminal, no CrabCast socket.
//
// ---------------------------------------------------------------------------
// WHAT THIS ASSERTS, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// A SOURCE-TEXT proof. It does not import from `dist`, which is deliberate:
// its verdict is readable after a failed build because it read what you wrote.
// It also bounds it, and the bounds are named rather than left to be inferred:
//
//   * **That the keystroke actually lands on a real pane.** Nothing static can
//     establish that. WHO COVERS IT: `probe-crabcast-dialog-answered.mjs`,
//     which spawns a real flagged agent through the real runtime and reads the
//     pane afterwards, and the daemon log lines quoted in the PR body.
//   * **That `channelReach` really is derived rather than declared.** This
//     reads source text, and text can lie about a getter. WHO COVERS IT:
//     `verify-channel-capability-refusal.mjs` §3, which CONSTRUCTS both
//     runtimes and drives the derivation both ways through the injected seam.
//   * **That a frame then reaches a model.** WHO COVERS IT:
//     `probe-channel-reaches-model.mjs`. That is the ticket's AC1 and it is a
//     probe, not a verify: it spawns real sessions and spends real tokens.
//
// MADE TO GO RED — each flag mutates a COPY of the source text in memory and
// asserts against that, so a red run leaves the tree untouched:
//
//   node daemon/scripts/verify-crabcast-channel-startup-supervision.mjs --drop-argv
//   node daemon/scripts/verify-crabcast-channel-startup-supervision.mjs --two-token-flag
//   node daemon/scripts/verify-crabcast-channel-startup-supervision.mjs --refuse-keystroke
//   node daemon/scripts/verify-crabcast-channel-startup-supervision.mjs --crabcast-verdict
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

const verbose = process.argv.includes('--verbose');
const dropArgv = process.argv.includes('--drop-argv');
const twoTokenFlag = process.argv.includes('--two-token-flag');
const refuseKeystroke = process.argv.includes('--refuse-keystroke');
const crabcastVerdict = process.argv.includes('--crabcast-verdict');
const mutating = dropArgv || twoTokenFlag || refuseKeystroke || crabcastVerdict;

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
  launchers: path.join(srcDir, 'launchers.ts'),
  daemon: path.join(srcDir, 'daemon.ts'),
  herdrCli: path.join(srcDir, 'herdr-cli.ts')
};
for (const [name, file] of Object.entries(FILES)) {
  if (!existsSync(file)) {
    console.error(`Missing ${name} at ${file} — this script reads the tree, not a build.`);
    process.exit(2);
  }
}

let runtimeSrc = readFileSync(FILES.runtime, 'utf8');
let launchersSrc = readFileSync(FILES.launchers, 'utf8');
const daemonSrc = readFileSync(FILES.daemon, 'utf8');
const herdrCliSrc = readFileSync(FILES.herdrCli, 'utf8');

if (dropArgv) {
  // THE DEFECT IN MINIATURE. Somebody "tidies" the payload builder and the
  // dev-channels argv stops being sent — while `channelReach` still reads the
  // switch and still answers 'loaded'. Frames written, delivered:true, nothing
  // arriving: KAN-495 restored with the alarm switched off.
  runtimeSrc = runtimeSrc.replace(
    '  if (input.channelArgv.length > 0) {\n    payload.args = input.channelArgv;\n  }\n',
    ''
  );
}
if (twoTokenFlag) {
  // THE DEFECT IN MINIATURE, and the one that would actually have shipped: the
  // obvious two-element spelling, which is correct under herdr's ordering and
  // swallows the prompt under CrabCast's.
  launchersSrc = launchersSrc.replace(
    '[`${DEV_CHANNELS_FLAG}=server:${CORE_MCP_SERVER}`]',
    '[DEV_CHANNELS_FLAG, `server:${CORE_MCP_SERVER}`]'
  );
}
if (refuseKeystroke) {
  // THE DEFECT IN MINIATURE. `pressPaneKey` goes back to refusing
  // unconditionally — which is what it did before this ticket — while the flag
  // keeps being sent. Every spawn then wedges at a dialog nobody answers.
  runtimeSrc = runtimeSrc.replace(
    '    const resolved = this.resolveSessionByAddress(key, type);',
    "    throw new Error('pressPaneKey has no CrabCast counterpart');\n" +
      '    const resolved = this.resolveSessionByAddress(key, type);'
  );
}
if (crabcastVerdict) {
  // THE DEFECT IN MINIATURE, and the subtlest of the four. The spawn listener
  // carries CrabCast's `channelEnabled` instead of Butchr's argv decision.
  // Theirs is `false` for every agent this runtime spawns, so `daemon.ts`
  // returns at its first line, no dialog is ever answered, and every agent
  // wedges — with nothing in the log saying why.
  runtimeSrc = runtimeSrc.replace(
    '        channelEnabled: spawnCarriedTheFlag,',
    '        channelEnabled: readChannelEnabled(activated),'
  );
}

say('KAN-496 — cutover gate 3 re-derived: the premises of channel-startup supervision');
say(`repo: ${repoRoot}`);
if (mutating) {
  say('');
  say('*** RUNNING WITH A MUTATION — a red below is the expected outcome. ***');
  say(
    `    ${[
      dropArgv && '--drop-argv',
      twoTokenFlag && '--two-token-flag',
      refuseKeystroke && '--refuse-keystroke',
      crabcastVerdict && '--crabcast-verdict'
    ]
      .filter(Boolean)
      .join(' ')}`
  );
  say('    The tree on disk is NOT modified; the mutation is applied to a string.');
}

const stripComments = (ts) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
// Strings go too, for the "no second composer" check only. The flag's NAME
// legitimately appears in prose all over this tree — refusal text in
// `channel.ts` says which flag a client was not started with, and it has to.
// What must not exist is a second place that BUILDS the argv. Comments first,
// so an apostrophe inside one cannot open a phantom string.
const stripStrings = (ts) =>
  ts
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
const runtimeCode = stripComments(runtimeSrc);
const launchersCode = stripComments(launchersSrc);

// ───────────────────────────────────────────────────────────────────────────
rule('§1  The flag HAS a route into the CrabCast spawn path');
// ───────────────────────────────────────────────────────────────────────────
// PREMISE 1, inverted from the old script. Gate 3 rested on there being no
// route; the supervision rests on there being one. Both halves are asserted,
// because a payload field nobody fills is the same as no field.

check(
  /import\s*\{[^}]*developmentChannelArgv[^}]*\}\s*from\s*'\.\/launchers\.js'/.test(runtimeSrc),
  'crabcast-runtime.ts imports the flag composer from launchers.js',
  runtimeSrc.split('\n').filter((l) => l.includes('launchers')).join('\n') ||
    '(no line mentions launchers)'
);

const typeMatch = runtimeSrc.match(/export type ConfigureAgentPayload = \{([\s\S]*?)\n\};/);
if (check(Boolean(typeMatch), 'the ConfigureAgentPayload type declaration is findable')) {
  check(
    /^\s{2}args\?:\s*string\[\];/m.test(typeMatch[1]),
    'and it declares `args?: string[]` — the member the flag travels in',
    typeMatch[1].trim().slice(0, 300)
  );
}

check(
  /payload\.args\s*=\s*input\.channelArgv/.test(runtimeCode),
  'the builder actually FILLS args from the input (a declared field nobody sets is no field)',
  runtimeCode.split('\n').filter((l) => l.includes('payload.args')).join('\n') ||
    '(nothing assigns payload.args)'
);

// REQUIRED, not optional. This is the assertion that stops the flag being
// dropped by a future edit in silence: an optional input could simply be left
// out at the one call site and nothing would say so.
const inputMatch = runtimeSrc.match(/export interface ConfigureAgentInput \{([\s\S]*?)\n\}/);
if (check(Boolean(inputMatch), 'the ConfigureAgentInput declaration is findable')) {
  check(
    /^\s{2}channelArgv:\s*string\[\];/m.test(inputMatch[1]),
    'and `channelArgv` is REQUIRED on it (`channelArgv:`, never `channelArgv?:`)',
    (inputMatch[1].match(/channelArgv\??:.*/) || ['(absent)'])[0]
  );
}

check(
  /channelArgv\s*$|channelArgv\s*\n/.test(
    (runtimeCode.match(/buildConfigureAgentPayload\(\{[\s\S]*?\}\)/) || [''])[0]
  ),
  'and provision() passes it at the one call site',
  (runtimeCode.match(/buildConfigureAgentPayload\(\{[\s\S]*?\}\)/) || ['(call site not found)'])[0]
);

// ───────────────────────────────────────────────────────────────────────────
rule('§2  The flag is spelled `--flag=value`, one argv token, in ONE place');
// ───────────────────────────────────────────────────────────────────────────
// PREMISE 2, and the one that would have taken the fleet down on day one.
// `--dangerously-load-development-channels` is variadic. Two tokens means it
// eats whatever follows, and CrabCast places caller argv BEFORE the prompt.

check(
  /\[`\$\{DEV_CHANNELS_FLAG\}=server:\$\{CORE_MCP_SERVER\}`\]/.test(launchersSrc),
  'developmentChannelArgv composes ONE element, `--flag=value`',
  (launchersSrc.match(/return channelEmissionEnabled\(\).*/) || ['(not found)'])[0]
);

check(
  !/\[\s*DEV_CHANNELS_FLAG\s*,/.test(launchersCode),
  'and never the two-element form, which is what swallows the prompt',
  (launchersCode.match(/\[\s*DEV_CHANNELS_FLAG\s*,.*/) || ['(absent, as required)'])[0]
);

// ONE COMPOSER. The string must not be spelled anywhere else — a second copy is
// the fact-with-two-implementations defect, and under this runtime the copy
// that drifted would be the one nobody reads.
const composersOutsideLaunchers = ['crabcast-runtime.ts', 'daemon.ts', 'channel.ts', 'herdr.ts']
  .filter((f) => existsSync(path.join(srcDir, f)))
  .filter((f) =>
    stripStrings(stripComments(readFileSync(path.join(srcDir, f), 'utf8'))).includes(
      'dangerously-load-development-channels'
    )
  );
check(
  composersOutsideLaunchers.length === 0,
  'and no other module composes the flag literal in code',
  `also spelled in: ${composersOutsideLaunchers.join(', ') || '(nowhere)'}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('§3  channelReach is DERIVED from that argv, not declared beside it');
// ───────────────────────────────────────────────────────────────────────────
// AC2's premise. The behaviour is proved by construction in
// `verify-channel-capability-refusal.mjs` §3; what is watched here is that the
// source cannot drift back to a literal.

check(
  !/channelReach\s*=\s*'(loaded|not-loaded|unknown)'\s*as const/.test(runtimeCode),
  'channelReach is not a literal constant any more',
  (runtimeCode.match(/channelReach\s*=.*/) || ['(no assignment — good)'])[0]
);
check(
  /get channelReach\(\)[\s\S]{0,200}this\.channelArgv\(\)/.test(runtimeCode),
  'and it reads this.channelArgv() — the same source provision sends',
  (runtimeCode.match(/get channelReach\(\)[\s\S]{0,160}/) || ['(getter not found)'])[0]
);
// ⚠ THE KAN-503 TRAP, ASSERTED RATHER THAN WRITTEN DOWN. `channelEnabled` is
// CrabCast's reach toward THEIR daemon. Deriving this from it switches off the
// loud refusal while delivery is dead.
check(
  !/get channelReach\(\)[\s\S]{0,300}channelEnabled/.test(runtimeCode),
  'and NEVER from CrabCast’s channelEnabled (the KAN-503 trap)',
  (runtimeCode.match(/get channelReach\(\)[\s\S]{0,300}/) || [''])[0]
);

// ───────────────────────────────────────────────────────────────────────────
rule('§4  The spawn listener fires, carrying BUTCHR’s verdict');
// ───────────────────────────────────────────────────────────────────────────
// PREMISE 3. `daemon.ts` gates supervision on `spawn.channelEnabled !== true`,
// and that field must mean "did this spawn carry OUR flag".

// ⚠ NO LONGER ANCHORED ON THE GUARD BEING THE LISTENER'S FIRST STATEMENT
// (KAN-497). It was, and this regex required it, until KAN-497 put the
// spawn-reach record above the guard — deliberately, because `channelEnabled:
// false` is the verdict most worth keeping and a listener that returns first
// drops it. The premise this section rests on is unchanged and is what is
// asserted now: supervision is gated on the spawn's own verdict, on `!== true`,
// with no other conditional ahead of it. Comments are stripped first so that
// prose in the block above the guard can neither satisfy nor defeat the match.
const daemonCode = daemonSrc
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
  .join('\n');
check(
  /setAgentSpawnedListener\(\(session, spawnedAt, spawn\) => \{(?:(?!\bif\b)[\s\S])*?if \(spawn\.channelEnabled !== true\) return;/.test(
    daemonCode
  ),
  "daemon.ts's listener still gates on spawn.channelEnabled !== true, and on nothing before it",
  daemonSrc.split('\n').filter((l) => l.includes('channelEnabled')).join('\n')
);
check(
  /this\.agentSpawnedListener\s*=\s*listener/.test(runtimeCode),
  'CrabCastRuntime STORES the listener (it used to discard it deliberately)',
  '(no assignment to this.agentSpawnedListener)'
);
check(
  /this\.agentSpawnedListener\(session, spawnedAt, \{/.test(runtimeCode),
  'and CALLS it from provision',
  '(the listener is stored and never invoked — which is the old behaviour)'
);
check(
  /channelEnabled:\s*spawnCarriedTheFlag/.test(runtimeCode),
  'with OUR argv decision, not CrabCast’s channelEnabled',
  (runtimeCode.match(/channelEnabled:.*/g) || []).join('\n')
);
check(
  /const spawnCarriedTheFlag = channelArgv\.length > 0;/.test(runtimeCode),
  'and that decision is the SAME channelArgv the payload was built from — read once',
  (runtimeCode.match(/const spawnCarriedTheFlag.*/) || ['(not derived from channelArgv)'])[0]
);

// ───────────────────────────────────────────────────────────────────────────
rule('§5  ⚠ THE PAIRING: whatever sends the flag can answer the dialog');
// ───────────────────────────────────────────────────────────────────────────
// THE LOAD-BEARING SECTION. Everything above establishes that the flag reaches
// the agent. This establishes that the dialog it raises can be answered — and
// without it, all of the above is a fleet that wedges at boot.

check(
  !/pressPaneKey\([^)]*\): void \{\s*\n\s*throw new Error\(/.test(runtimeCode),
  'pressPaneKey is NOT an unconditional throw any more',
  (runtimeCode.match(/pressPaneKey\([^)]*\): void \{[\s\S]{0,120}/) || [''])[0]
);
check(
  /runHerdrCli\(\['pane', 'send-keys', paneId, keyName\]\)/.test(runtimeCode),
  'it sends the keystroke to the herdr pane — CrabCast publishes no keystroke verb',
  '(no herdr send-keys call in crabcast-runtime.ts)'
);
check(
  /paneIdForCwd\(session\.workDir\)/.test(runtimeCode),
  'addressed by workDir, the one name both daemons agree on',
  '(pane is resolved some other way)'
);
// AMBIGUITY IS REFUSED. Two panes in a directory and a guess would type at the
// wrong agent, which is worse than not typing at all.
check(
  /Refusing rather than picking/.test(herdrCliSrc),
  'and two panes in one directory are refused rather than guessed',
  '(paneIdForCwd resolves ambiguity by choosing)'
);
// AND THE COUPLING IS DECLARED. This is the one assumption that can rot — it is
// an observation of this deployment, not of CrabCast's contract — so it has to
// be written where the next reader meets it.
check(
  /herdr/i.test(runtimeCode.match(/pressPaneKey[\s\S]{0,1200}/)?.[0] ?? '') &&
    /substrate|spawns its panes through herdr|pane substrate/i.test(runtimeSrc),
  'and the herdr-substrate assumption is stated in the source, not left to be inferred',
  '(no prose names the substrate assumption)'
);

// ───────────────────────────────────────────────────────────────────────────
rule('Verdict');
// ───────────────────────────────────────────────────────────────────────────

if (mutating) {
  // A mutation that does not move the verdict means the assertion is not
  // watching what it claims to watch. Green under a mutation is a FAILURE.
  if (failures === 0) {
    say('  FAIL  the mutation produced NO red — this script is not watching what it says');
    say('        A proof that stays green under its own defect is a proof of nothing.');
    process.exit(1);
  }
  say(`  The mutation produced ${failures} red check(s), which is the expected outcome.`);
  say('  Re-run without a flag to see the clean tree pass.');
  process.exit(0);
}

if (failures > 0) {
  say(`  FAILED — ${failures} check(s).`);
  say('  Gate 3 was re-derived by KAN-496: supervision is ON here because the flag now');
  say('  reaches the agent and raises a real dialog. A red above means one of the');
  say('  premises that ruling rests on has moved. Do not repair it by deleting the');
  say('  assertion — re-derive the ruling, as this file did to the one before it.');
  process.exit(1);
}

say('  OK — the flag has a route in, it is spelled so it cannot swallow the prompt,');
say('  channelReach is derived from what is actually sent, the spawn listener carries');
say('  Butchr’s own verdict, and the dialog that flag raises can be answered.');
process.exit(0);
