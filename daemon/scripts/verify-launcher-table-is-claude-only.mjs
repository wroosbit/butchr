// KAN-395: `claude` is the only agent Butchr launches, nothing chooses a
// launcher any more, and a name this fleet retired is REFUSED rather than
// quietly substituted.
//
// WHAT FAILURE THIS WOULD CATCH: a retired launcher name coming back as a
// silent substitution instead of a refusal — a stored record asking for
// `anti-gravity`, or a UI defaulting a launcher field, resolving to something
// the caller did not ask for and reporting `success: true`. That is KAN-53's
// live incident (2026-08-02: a story agent was a bare shell for twenty minutes,
// reporting `success: true, verified: true`, executing `butchr_send_to_agent`
// messages as shell commands), and KAN-395 found it had SURVIVED one layer
// above the fix: the extension's *Default Agent* select initialised to
// `'shell'` and the service worker read that key with `|| 'shell'` behind it,
// so every sidepanel activation asked the daemon for a bare bash prompt unless
// a human had gone to Settings and chosen Claude. §5 is the line that goes red
// if any of that comes back.
//
// It also catches the quieter half, which is what AC2 of the ticket is about:
// `expectsRuntime` being left as four `!== 'shell'` comparisons against a value
// nothing can produce. §4 asserts the false case is still REACHED — by a real
// activation, not by reading the source — so the ruling below is checked rather
// than believed.
//
// CI-RUNNABLE: yes — imports the built daemon modules, stages its own $HOME and
// a fake `herdr` first on PATH, and reads four repository files as text. No
// live daemon, no real herdr, no pty, no CrabCast peer, no credential, no
// network. Everything it writes is under `os.tmpdir()`.
//
// ---------------------------------------------------------------------------
// THE RULING THIS SCRIPT PINS, BECAUSE A PROOF OF A DECISION SHOULD CARRY IT
// ---------------------------------------------------------------------------
// KAN-395 asked for `claude` to be the only launcher and offered a third
// answer: *"`shell` stays for a reason nobody has named yet — in which case
// this ticket's premise is wrong and it should say so."* That is the answer.
//
//   * `anti-gravity` IS GONE. Nothing named it: no fixture, no registry row
//     (53 rows read on 2026-08-14 — 45 `claude`, 8 with the field absent, 0 of
//     either retired name), and the global config its setup wrote,
//     `~/.gemini/antigravity-cli/mcp.json`, did not exist on the machine that
//     has run this fleet since July.
//   * `shell` STAYS, and the reason is named in
//     `daemon/scripts/lib/channel-probe.mjs` note 3: activating as `shell`
//     "leaves the probe holding the pane at a bash prompt, which is the only
//     way to start `claude` with an extra flag without editing the product."
//     Every channel probe (KAN-217, KAN-219, KAN-244, KAN-249, KAN-250) brings
//     its agent up that way THROUGH THE DAEMON, which is what licenses their
//     claims about the shipped path.
//     `extension/scripts/verify-sidepanel-survives-daemon-restart.mjs` needs
//     one for a different reason — "what the panel needs is a live PTY, not a
//     language model".
//   * SO `expectsRuntime` DID NOT LOSE ITS FALSE CASE and is not a constant.
//     What it lost is any way for ordinary fleet traffic to reach that case.
//     The full ruling is on `HerdrSession.expectsRuntime`.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145). Stated per section rather than left to be inferred:
//
//   * §3 WRITES THE REGISTRY ROW IT THEN ACTIVATES FROM. That is the honest
//     shape for this claim and not a dodge — the thing under test IS "a record
//     already on disk asking for a retired launcher" — but it means §3 proves
//     the daemon's handling of such a row and NOT that any such row exists.
//     None does on this machine; the count above is the evidence for that, and
//     it is an observation pasted into the PR rather than anything a script
//     re-checks. Nobody covers "a row like this appears in the future", and
//     nothing can: that is a fact about a file this repository does not own.
//   * §1, §2 and §4 do NOT supply their own input in the sense that matters:
//     they call the REAL `MessageRouter` → `HerdrBridge.initPty` →
//     `resolveLauncher` path, and read the launcher command back out of a fake
//     `herdr`'s recorded argv. What is faked is the herdr binary, so what the
//     argv says is the whole truth about what would have run.
//   * §5 READS FOUR FILES AS TEXT and asserts on their content. It is a
//     source-text section, so its verdict survives a failed build — and it is
//     the ONLY leg covering the extension, because a Chrome extension's
//     behaviour cannot be exercised from here. `extension/scripts/
//     verify-sidepanel-survives-daemon-restart.mjs` drives the real service
//     worker in a real Chrome and is `CI-RUNNABLE: no`; it is the nearest thing
//     to coverage of the running article and it does not assert this property.
//     So: nobody covers "the built service worker sends no launcher" by
//     execution. §5 covers the source it is built from.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-launcher-table-is-claude-only.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const TYPE = 'task';

// A private HOME before any dist import: workspace paths and the daemon's state
// dir derive from os.homedir(), which reads $HOME at call time. This is what
// keeps the run out of ~/.local/share/butchr and away from the live fleet.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan395-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on PATH, recording every invocation argv-exact. The
// shape is `verify-activate-requires-agent.mjs`'s, deliberately: that script is
// KAN-53's proof and this one is about the same resolution rule, so a second
// dialect of the same fixture would be two things to keep true.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN395_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN395_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

// WHAT THIS SHIM MODELS THAT THE KAN-53 ONE DOES NOT: whether a live runtime
// ends up behind the pane. A real herdr reports \`agent: ''\` for a pane running
// a bare bash prompt and the launcher's binary for anything else — that
// difference is the KAN-58 existence check, and it is exactly the difference
// \`expectsRuntime\` exists to excuse. Reporting a runtime for every pane would
// make §4's shell case pass for the wrong reason.
//
// It is read off the PAYLOAD, not off the whole argv: the payload is wrapped in
// \`env … bash -c <payload>\`, so every command contains the word bash and only
// the last element says what will actually run in the pane.
const runtimeFor = (payload) => (/^bash\\b/.test(payload ?? '') ? '' : 'claude');

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: '9', agent: found.runtime } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    runtime: runtimeFor(args[args.length - 1])
  });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: '9' } } });
}
if (a === 'agent' && b === 'list') {
  out({
    result: {
      agents: started.map((s) => ({
        name: s.name, agent: s.runtime, cwd: s.cwd, agent_status: 'working'
      }))
    }
  });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else {
  out({ result: {} });
}
`);
// A wrapper with this process's node baked in, so the shim never depends on
// what PATH resolves `node` to.
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// Tolerant of the file not existing yet: before the first activation nothing
// has called the shim, and "no invocations" is the honest reading of that —
// not an error, and not a reason for a section to crash before it asserts.
const invocations = () => {
  let raw;
  try {
    raw = fs.readFileSync(path.join(shimState, 'invocations.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
const startsIn = (all) => all.filter((argv) => argv[0] === 'agent' && argv[1] === 'start');
/** The launcher command herdr was told to run, out of an `agent start` argv. */
const launcherCommandOf = (argv) => argv[argv.length - 1];

// --------------------------------------------------------------- the daemon --

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { HerdrBridge, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const launchers = await import(path.join(distDir, 'launchers.js'));
const { AGENT_LAUNCHERS, DEFAULT_AGENT, resolveLauncher } = launchers;

const scratchState = () =>
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan395-state-')), 'integrations.json')
  );
function atlassianRegistry() {
  const registry = new WorkspaceRegistry(scratchState());
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
  registry.setEnabled('jira', true);
  return registry;
}

const bridge = new HerdrBridge();
const registryPath = path.join(scratch, 'agents.jsonl');
const agentRegistry = new AgentRegistry(registryPath);
let sent;
const router = new MessageRouter(
  atlassianRegistry(),
  new PromptLoader(repoRoot),
  bridge,
  (msg) => { sent = msg; },
  () => {},
  { agentRegistry }
);

process.on('exit', () => {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

// The capacity gate reads the real machine, and how busy this box is decides
// nothing about which launcher an activation resolves to.
const PAST_THE_GATE = { override: true };

async function activate(key, extra = {}) {
  sent = undefined;
  await router.handleActivateByKey(
    { action: 'activate_by_key', type: TYPE, key, ...PAST_THE_GATE, ...extra },
    (msg) => { sent = msg; }
  );
  return sent;
}

const sessionFor = (key) =>
  bridge.listActiveSessions().find((s) => s.key.toLowerCase() === key.toLowerCase());

// ------------------------------------------------------------- the harness --

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
function check(ok, claim, evidence) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}`);
  if (evidence !== undefined) console.log(`        ${evidence}`);
  if (!ok) failures++;
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

console.log(`fake herdr: ${path.join(shimDir, 'herdr')}`);
console.log(`HOME for this run: ${fakeHome}`);
console.log(`dist under test: ${distDir}`);

// ───────────────────────────────────────────────────────────────────────────
rule('1. THE TABLE — what Butchr will launch at all  [imports dist]');
// ───────────────────────────────────────────────────────────────────────────

const names = Object.keys(AGENT_LAUNCHERS);
console.log(`   AGENT_LAUNCHERS: ${JSON.stringify(names)}`);
console.log(`   DEFAULT_AGENT:   ${JSON.stringify(DEFAULT_AGENT)}`);

check(
  !names.includes('anti-gravity'),
  "'anti-gravity' is not in the launcher table",
  `keys=${JSON.stringify(names)}`
);
check(
  DEFAULT_AGENT === 'claude' && names.includes('claude'),
  "DEFAULT_AGENT is 'claude' and 'claude' is in the table",
  `DEFAULT_AGENT=${JSON.stringify(DEFAULT_AGENT)}`
);
// Pinned as a SET rather than as "does not include anti-gravity", so that a
// third launcher appearing has to come past this line and past the ruling in
// the header. The ruling is the reason `shell` is in the expected set; if that
// ever stops being true, this is where the ticket to remove it starts.
check(
  JSON.stringify([...names].sort()) === JSON.stringify(['claude', 'shell']),
  'the table is exactly {claude, shell} — see the ruling in this file\'s header',
  `keys=${JSON.stringify(names)}`
);
check(
  typeof launchers.configureAgyMcp !== 'function',
  'configureAgyMcp is gone — the anti-gravity launcher was its only caller',
  `typeof=${typeof launchers.configureAgyMcp}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('2. RESOLUTION — omitted resolves, retired refuses, and they differ  [imports dist]');
// ───────────────────────────────────────────────────────────────────────────
// KAN-53's rule, unchanged, plus the one thing KAN-395 added to it.

const omitted = resolveLauncher();
check(
  omitted.name === 'claude',
  'an omitted defaultAgent resolves to claude — KAN-53, unchanged',
  `resolveLauncher() → ${JSON.stringify(omitted.name)}`
);

let retiredError = null;
try {
  resolveLauncher('anti-gravity');
} catch (e) {
  retiredError = e.message;
}
let unknownError = null;
try {
  resolveLauncher('zzz');
} catch (e) {
  unknownError = e.message;
}
console.log(`   retired: ${retiredError}`);
console.log(`   unknown: ${unknownError}`);

check(
  retiredError !== null,
  "resolveLauncher('anti-gravity') REFUSES — it does not substitute claude",
  `threw: ${retiredError}`
);
check(
  /retired|removed/i.test(retiredError ?? '') && /KAN-395/.test(retiredError ?? ''),
  'and the refusal says the name was retired, and by which ticket',
  `message=${JSON.stringify(retiredError)}`
);
// The two refusals must be DISTINGUISHABLE, which is the whole point of having
// a retired table rather than letting a retired name fall into "unknown". A
// reader of the unknown message goes hunting for a typo; a reader of the
// retired one knows the name was deliberately removed and what to ask for.
check(
  unknownError !== null && retiredError !== unknownError,
  'an UNKNOWN name also refuses, with a different message — the two are distinguishable',
  `unknown=${JSON.stringify(unknownError)}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('3. AC3 — a stored record asking for a retired launcher  [imports dist]');
// ───────────────────────────────────────────────────────────────────────────
// The round trip the sidepanel makes: an agent is stood down, the registry
// keeps what it last ran, and `useFleetControls` re-activates it WITH THAT
// RECORDED VALUE. This section writes the row (see the header: that is what it
// supplies) and then drives the real router with what the standby list hands
// back, which is the leg that matters.

for (const [key, stored, expectStart] of [
  ['KAN-395-RETIRED', 'anti-gravity', false],
  ['KAN-395-SHELL', 'shell', true],
  ['KAN-395-ABSENT', undefined, true]
]) {
  const agentName = agentNameFor(TYPE, key);
  const before = startsIn(invocations()).length;
  const answer = await activate(key, ...(stored ? [{ defaultAgent: stored }] : []));
  const started = startsIn(invocations()).find((argv) => argv[2] === agentName);
  const cmd = started ? launcherCommandOf(started) : null;

  console.log(
    `\n   stored defaultAgent=${JSON.stringify(stored ?? null)} → success=${answer?.success}` +
    `  starts=${startsIn(invocations()).length - before}`
  );
  if (cmd) console.log(`   command herdr was told to run: ${JSON.stringify(cmd)}`);
  if (answer?.error) console.log(`   error: ${answer.error}`);

  if (expectStart) {
    check(
      answer?.success === true && Boolean(started),
      `a stored ${JSON.stringify(stored ?? null)} still starts — no behaviour change for it`,
      `success=${answer?.success}`
    );
  } else {
    check(
      answer?.success !== true && !started,
      `a stored ${JSON.stringify(stored)} REFUSES and starts nothing at all`,
      `success=${answer?.success}, agent start for this name=${Boolean(started)}`
    );
    check(
      /retired|removed/i.test(answer?.error ?? ''),
      'and the refusal reaching the caller is the retirement message, not a generic failure',
      `error=${JSON.stringify(answer?.error)}`
    );
  }
}

// The two that started must not have started the SAME thing — otherwise the
// section above would pass with a launcher table that ignored its input.
const shellCmd = launcherCommandOf(
  startsIn(invocations()).find((argv) => argv[2] === agentNameFor(TYPE, 'KAN-395-SHELL'))
);
const absentCmd = launcherCommandOf(
  startsIn(invocations()).find((argv) => argv[2] === agentNameFor(TYPE, 'KAN-395-ABSENT'))
);
check(
  shellCmd.includes('bash') && !shellCmd.includes('claude'),
  "THE DISCRIMINATION: a stored 'shell' really launched bash",
  `command=${JSON.stringify(shellCmd)}`
);
check(
  absentCmd.includes('claude') && !absentCmd.includes('bash'),
  'and an absent field really launched claude — the two are not the same command',
  `command=${JSON.stringify(absentCmd)}`
);

// ───────────────────────────────────────────────────────────────────────────
rule("4. AC2 — expectsRuntime's false case is still REACHED  [imports dist]");
// ───────────────────────────────────────────────────────────────────────────
// The ticket's premise was that with `shell` gone all four `!== 'shell'` sites
// become constantly true, and a flag whose only false case has been deleted has
// quietly stopped meaning anything. `shell` did not go — see the ruling — so
// this asserts the false case is produced by a REAL activation rather than
// asserting the source still contains the comparison.

const shellSession = sessionFor('KAN-395-SHELL');
const claudeSession = sessionFor('KAN-395-ABSENT');
console.log(`   shell session  expectsRuntime = ${JSON.stringify(shellSession?.expectsRuntime)}`);
console.log(`   claude session expectsRuntime = ${JSON.stringify(claudeSession?.expectsRuntime)}`);

check(
  shellSession?.expectsRuntime === false,
  'a real shell activation sets expectsRuntime FALSE — the case is reachable, not theoretical',
  `expectsRuntime=${JSON.stringify(shellSession?.expectsRuntime)}`
);
check(
  claudeSession?.expectsRuntime === true,
  'and a real claude activation sets it TRUE — so the field still discriminates',
  `expectsRuntime=${JSON.stringify(claudeSession?.expectsRuntime)}`
);
// `undefined` is neither, and it is the value that would appear if the
// assignment were deleted while the field stayed. It reads as FALSE at
// herdr.ts's `!session.expectsRuntime`, which would excuse every dead pane.
check(
  shellSession?.expectsRuntime !== undefined && claudeSession?.expectsRuntime !== undefined,
  'neither is undefined — the assignment is made, not merely declared',
  `shell=${JSON.stringify(shellSession?.expectsRuntime)}, claude=${JSON.stringify(claudeSession?.expectsRuntime)}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('5. NOTHING CHOOSES A LAUNCHER — the extension  [reads source as text]');
// ───────────────────────────────────────────────────────────────────────────
// The product half of the ticket, and the half that was actually broken. This
// section reads source rather than importing anything, so its verdict is about
// what you wrote even after a failed build.

const serviceWorker = read('extension/public/background/service_worker.js');
const optionsPage = read('extension/options.jsx');
const manifest = JSON.parse(read('extension/public/manifest.json'));

// Comments in both files DESCRIBE the deleted fallback, so a bare search for
// the string would match the description of its own removal. Matching on code
// shapes instead: an assignment or a property, never prose.
const codeOnly = (src) =>
  src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const swCode = codeOnly(serviceWorker);
const optCode = codeOnly(optionsPage);

check(
  !/\|\|\s*'shell'/.test(swCode) && !/\|\|\s*"shell"/.test(swCode),
  "the service worker has no `|| 'shell'` fallback left in its code",
  `matches=${JSON.stringify(swCode.match(/\|\|\s*['"]shell['"]/g) ?? [])}`
);
check(
  !/chrome\.storage/.test(swCode),
  'and it reads no launcher out of chrome.storage — the key nothing wrote',
  `matches=${JSON.stringify(swCode.match(/chrome\.storage[^\s(]*/g) ?? [])}`
);
check(
  !/<select/.test(optCode) && !/chrome\.storage/.test(optCode),
  'the options page has no Default Agent select and touches no storage',
  `select=${/<select/.test(optCode)}, storage=${/chrome\.storage/.test(optCode)}`
);
check(
  !(manifest.permissions ?? []).includes('storage'),
  "and the manifest no longer asks for the `storage` permission the select needed",
  `permissions=${JSON.stringify(manifest.permissions)}`
);
// The positive control for this whole section: the reader is looking at the
// real files, and it can still find something it should find. Without it, a
// mistyped path would read as four clean passes.
check(
  /activate_by_key/.test(swCode) && /IntegrationsSection/.test(optCode),
  'THE POSITIVE CONTROL: both files were really read — each still contains what it should',
  `sw=${swCode.length} bytes, options=${optCode.length} bytes`
);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}`);
if (failures) {
  console.log(`FAILED — ${failures} assertion(s) did not hold.`);
} else {
  console.log('OK — claude is what Butchr launches, nothing chooses a launcher, a retired');
  console.log('name refuses rather than substituting, and expectsRuntime still discriminates');
  console.log('because `shell` survived as the channel probes\' bring-up. See the header.');
}
process.exit(failures ? 1 : 0);
