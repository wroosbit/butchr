// The two MCP transforms sit ABOVE the runtime seam, so no runtime can omit
// them — KAN-398.
//
// WHAT FAILURE THIS WOULD CATCH: a second runtime shipping without the
// transforms `HerdrBridge` applied, which is KAN-398 exactly.
// `CrabCastRuntime.provision()` sent `configure_agent` the raw assembly and
// CrabCast wrote it into `.mcp.json` verbatim, so `pathPrefix` — a BUTCHR field
// no MCP client reads — crossed the wire unmaterialised and the core `butchr`
// server went unstamped. KAN-157 and KAN-145 were both undone on that path
// while the herdr path stayed correct, and NOTHING WENT RED: `butchr_*` calls
// still worked (the flags are read for parentage, not reachability) and the
// Atlassian server happened to start because the inherited PATH resolved the
// same Node. The symptom was `activatedBy: null` and an org chart with nothing
// to draw — one layer away from anything anybody was looking at.
//
// CI-RUNNABLE: yes — reads `daemon/src/*.ts` as TEXT and imports
// `daemon/dist/launchers.js` in process. No live daemon, no herdr, no CrabCast
// peer, no credential, no terminal. §6 writes one file, under `os.tmpdir()`
// and never into the repository tree.
//
// ---------------------------------------------------------------------------
// WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// THE SHAPE OF THE DEFECT IS A GAP BETWEEN TWO CORRECT-LOOKING PIECES, so the
// sections are split along that seam rather than by file:
//
//   §1–§3 and §7 are SOURCE-TEXT assertions and do not import from `dist`.
//     Their verdict is readable after a failed build — they read what you wrote
//     (prompts/task.md). §3 is the load-bearing one: it asserts the transform
//     is APPLIED AT THE CALL SITE, not merely that it exists.
//   §4–§6 IMPORT FROM `dist` and are about behaviour. A failed build makes
//     their verdict evidence about the previous build; read the section, never
//     the exit code, if the build was not clean.
//
// §4 AND §6 SUPPLY THEIR OWN INPUT — they construct definitions and hand them
// to the transform. That is KAN-145's trap stated on itself: **a proof that
// supplies its own input has not tested that the input arrives.** KAN-145's two
// verify scripts asserted `activatedBy` was carried correctly by building
// registry records that already had the field in them, and stayed green while
// production was `null` for every agent.
//
//   WHO COVERS THE ARRIVAL, since this script does not:
//     * `MessageRouter` calling the transform at all — §3 here, statically, on
//       every `spawnSession` call site in `router.ts`. That is the leg KAN-145
//       had nobody for.
//     * A real CrabCast peer writing what we sent into a real `.mcp.json` —
//       `verify-crabcast-claude-launcher-live.mjs` §5, which needs a live peer
//       and is therefore `CI-RUNNABLE: no`. It is the ticket's own acceptance
//       criterion and it cannot run here.
//     * The `.mcp.json` a herdr activation writes — `verify-mcp-assembly.mjs`
//       for the assembly, `verify-activation-records-real-parentage.mjs` for
//       the stamp.
//
// NOT ASSERTED HERE AT ALL, named so nobody banks it: that the BRAND is what
// stops a raw assembly reaching the seam. That is a compile-time property and
// this script does not run `tsc`. Its red drive is `tsc` itself — replace
// `prepareWorkspaceMcpServers(mcpServers, …)` with `mcpServers` at either call
// site and the build fails with TS2345. The PR body carries that transcript.
// §1 and §2 assert the two source facts the guarantee rests on (the seam's
// parameter type, and that one function is the only producer), which is what a
// text proof can honestly do.
//
// MADE TO GO RED — each flag mutates a COPY of the source text in memory, so a
// red run leaves the tree untouched:
//
//   node daemon/scripts/verify-workspace-mcp-preparation.mjs --raw-at-callsite
//   node daemon/scripts/verify-workspace-mcp-preparation.mjs --refuse-after-strip
//   node daemon/scripts/verify-workspace-mcp-preparation.mjs --transform-in-runtime
//
// Going GREEN under any of them is counted as a failure: a mutation that does
// not move the verdict means the assertion is not watching what it says it is.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');

const verbose = process.argv.includes('--verbose');
const rawAtCallsite = process.argv.includes('--raw-at-callsite');
const refuseAfterStrip = process.argv.includes('--refuse-after-strip');
const transformInRuntime = process.argv.includes('--transform-in-runtime');
const mutating = rawAtCallsite || refuseAfterStrip || transformInRuntime;

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
    say(`        ${String(detail).split('\n').slice(0, 8).join('\n        ')}`);
  }
  return ok;
};

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
const FILES = {
  seam: path.join(srcDir, 'agent-runtime.ts'),
  launchers: path.join(srcDir, 'launchers.ts'),
  router: path.join(srcDir, 'router.ts'),
  herdr: path.join(srcDir, 'herdr.ts'),
  runtime: path.join(srcDir, 'crabcast-runtime.ts')
};
for (const [name, file] of Object.entries(FILES)) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${name} at ${file} — this script reads the tree, not a build.`);
    process.exit(2);
  }
}
const distLaunchers = path.join(repoRoot, 'daemon', 'dist', 'launchers.js');
if (!fs.existsSync(distLaunchers)) {
  console.error('daemon/dist/launchers.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const read = (key) => fs.readFileSync(FILES[key], 'utf8');
const seamSrc = read('seam');
const launchersSrc = read('launchers');
let routerSrc = read('router');
const herdrSrc = read('herdr');
let runtimeSrc = read('runtime');

if (rawAtCallsite) {
  // THE DEFECT IN MINIATURE, and it is the one the type system catches: a call
  // site hands the seam the assembly it got from `mcpServersForSpawn()` without
  // preparing it. That is precisely what `provision()` was given.
  routerSrc = routerSrc.replace(
    'prepareWorkspaceMcpServers(mcpServers, { type, key }),',
    'mcpServers,'
  );
}
if (refuseAfterStrip) {
  // THE DEFECT IN MINIATURE. The refusal is asked AFTER the assembly has been
  // prepared — so it reads a field `materializeMcpServers` has already
  // stripped, and answers "nothing unusable" for ever.
  // replaceAll, so the mutation is the defect rather than the defect at one of
  // the two call sites — both §5 assertions must be able to see it.
  routerSrc = routerSrc.replaceAll(
    'const refusal = refuseUnusableMcpServers(mcpServers);',
    'const refusal = refuseUnusableMcpServers(prepareWorkspaceMcpServers(mcpServers, { type, key }));'
  );
}
if (transformInRuntime) {
  // THE DEFECT IN MINIATURE, arriving from the other side: a runtime starts
  // applying a transform of its own. Two implementations each doing it their
  // own way is the state KAN-398 ended.
  runtimeSrc = runtimeSrc.replace(
    "import type { BriefLocation, ResumeCause } from './resume.js';",
    "import type { BriefLocation, ResumeCause } from './resume.js';\n" +
      "import { materializeMcpServers } from './launchers.js';"
  );
}

say('KAN-398 — the workspace MCP transforms sit above the runtime seam');
say(`repo: ${repoRoot}`);
if (mutating) {
  say('');
  say('*** RUNNING WITH A MUTATION — a red below is the expected outcome. ***');
  say(
    `    ${[
      rawAtCallsite && '--raw-at-callsite',
      refuseAfterStrip && '--refuse-after-strip',
      transformInRuntime && '--transform-in-runtime'
    ]
      .filter(Boolean)
      .join(' ')}`
  );
  say('    The tree on disk is NOT modified; the mutation is applied to a string.');
}

// ───────────────────────────────────────────────────────────────────────────
rule('§1  The seam accepts only prepared definitions');
// ───────────────────────────────────────────────────────────────────────────

check(
  /export type WorkspaceMcpServers = McpServerDefinitions & \{/.test(seamSrc),
  'agent-runtime.ts declares the WorkspaceMcpServers brand',
  '(searched for the exported type alias)'
);

const spawnSig = seamSrc.match(/ {2}spawnSession\(([\s\S]*?)\n {2}\): HerdrSession;/);
if (check(Boolean(spawnSig), "the interface's spawnSession signature is findable")) {
  check(
    /mcpServers\?: WorkspaceMcpServers/.test(spawnSig[1]),
    'its mcpServers parameter is WorkspaceMcpServers, not McpServerDefinitions',
    spawnSig[1]
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§2  One producer, and the cast is written in exactly one place');
// ───────────────────────────────────────────────────────────────────────────
// The brand is only worth what its producer is. A second `as WorkspaceMcpServers`
// anywhere is a claim that a transform ran, made by code that did not run it.

check(
  /export function prepareWorkspaceMcpServers\(/.test(launchersSrc),
  'launchers.ts exports prepareWorkspaceMcpServers',
  '(searched for the export)'
);
check(
  /materializeMcpServers\(withWorkspaceIdentity\(defs, identity\)\) as WorkspaceMcpServers/.test(
    launchersSrc
  ),
  'it applies withWorkspaceIdentity first, then materializeMcpServers',
  '(the order is load-bearing — see the docblock)'
);

const casts = [];
for (const file of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.ts')) continue;
  const full = path.join(srcDir, file);
  if (!fs.statSync(full).isFile()) continue;
  const text = full === FILES.router ? routerSrc : fs.readFileSync(full, 'utf8');
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const m of stripped.matchAll(/as WorkspaceMcpServers/g)) {
    void m;
    casts.push(file);
  }
}
check(
  casts.length === 1 && casts[0] === 'launchers.ts',
  'the cast to WorkspaceMcpServers appears once in daemon/src, in launchers.ts',
  `found in: ${casts.join(', ') || '(nowhere — the producer has gone)'}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('§3  THE ARRIVAL LEG — every spawn call site prepares what it passes');
// ───────────────────────────────────────────────────────────────────────────
// This is the section that would have caught KAN-145's hole, and the one §4
// cannot stand in for: it asserts the transform is CALLED, on the real path,
// rather than that it works when called.

const spawnCalls = [...routerSrc.matchAll(/this\.herdrBridge\.spawnSession\(([\s\S]*?)\n {6}\);/g)];
if (
  check(
    spawnCalls.length > 0,
    `router.ts's spawnSession call sites are findable (${spawnCalls.length} found)`,
    'the calls moved or were reformatted — this assertion is no longer reading what it thinks it reads'
  )
) {
  const unprepared = spawnCalls
    .map((m, i) => [i, m[1]])
    .filter(([, body]) => !body.includes('prepareWorkspaceMcpServers('));
  check(
    unprepared.length === 0,
    `all ${spawnCalls.length} pass prepareWorkspaceMcpServers(...), none passes a raw assembly`,
    unprepared.map(([i, body]) => `call ${i}:\n${body}`).join('\n---\n') || '(none)'
  );
}

// The other half: nothing reaches the seam by a route that skips the router.
const otherCallers = [];
for (const file of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.ts')) continue;
  const full = path.join(srcDir, file);
  if (!fs.statSync(full).isFile()) continue;
  if (full === FILES.router || full === FILES.herdr || full === FILES.runtime) continue;
  const text = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  if (/\.spawnSession\(/.test(text)) otherCallers.push(file);
}
check(
  otherCallers.length === 0,
  'router.ts is the only caller of spawnSession in daemon/src',
  `also called from: ${otherCallers.join(', ')}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('§4  The transform does both things  [imports dist — see header]');
// ───────────────────────────────────────────────────────────────────────────
// SUPPLIES ITS OWN INPUT. See the header for what that leaves uncovered and who
// covers it.

const launchers = await import('../dist/launchers.js');
const { prepareWorkspaceMcpServers, unusableMcpServers, materializeMcpServers } = launchers;
const CORE = launchers.CORE_MCP_SERVER;

const assembled = {
  atlassian: {
    command: '/opt/node/v20.20.2/bin/npx',
    args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp'],
    pathPrefix: ['/opt/node/v20.20.2/bin']
  },
  [CORE]: { command: '/usr/bin/node', args: ['/butchr/daemon/dist/mcp.js'] }
};
const prepared = prepareWorkspaceMcpServers(assembled, { type: 'task', key: 'KAN-398' });

check(
  prepared.atlassian.pathPrefix === undefined,
  'pathPrefix is gone from the prepared assembly',
  `pathPrefix=${JSON.stringify(prepared.atlassian.pathPrefix)}`
);
check(
  prepared.atlassian.env?.PATH?.startsWith('/opt/node/v20.20.2/bin'),
  'and its directory leads the materialised env.PATH',
  `env.PATH=${JSON.stringify(prepared.atlassian.env?.PATH)}`
);
check(
  prepared[CORE].args.includes(launchers.WORKSPACE_TYPE_FLAG) &&
    prepared[CORE].args.includes(launchers.WORKSPACE_KEY_FLAG) &&
    prepared[CORE].args.includes('task') &&
    prepared[CORE].args.includes('KAN-398'),
  'the core server carries this workspace\'s identity on its argv',
  `args=${JSON.stringify(prepared[CORE].args)}`
);
check(
  assembled.atlassian.pathPrefix !== undefined && assembled[CORE].args.length === 1,
  'the input assembly was not mutated — every activation resolves it fresh',
  `input core args=${JSON.stringify(assembled[CORE].args)}`
);
// The idempotence `writeWorkspaceMcpConfig` relies on: it materialises again on
// its way to disk, and must not change a prepared assembly when it does.
check(
  JSON.stringify(materializeMcpServers(prepared)) === JSON.stringify(prepared),
  'materializeMcpServers is idempotent, so the writer may safely apply it again',
  '(writeWorkspaceMcpConfig runs it on the way to disk)'
);

// ───────────────────────────────────────────────────────────────────────────
rule('§5  The refusal is asked while it can still see the field');
// ───────────────────────────────────────────────────────────────────────────
// WHY THE ORDER IS AN ASSERTION AND NOT A STYLE NOTE: the strip is what makes
// the wrong order silent. Asked afterwards, the check is green for ever and
// green because it is blind.

const stripped = prepareWorkspaceMcpServers(
  { atlassian: { command: 'x', args: [], unusable: 'no Node on this machine' } },
  { type: 'task', key: 'KAN-398' }
);
check(
  unusableMcpServers(stripped).length === 0,
  'a prepared assembly reports nothing unusable — the field is stripped',
  `got ${JSON.stringify(unusableMcpServers(stripped))}`
);
check(
  unusableMcpServers({
    atlassian: { command: 'x', args: [], unusable: 'no Node on this machine' }
  }).length === 1,
  'and the SAME assembly unprepared reports one — so the check can distinguish',
  '(the positive control: without this, the assertion above passes on a broken reader)'
);

for (const [label, site] of [
  ['config.type', /const refusal = refuseUnusableMcpServers\(mcpServers\);[\s\S]{0,900}?prepareWorkspaceMcpServers\(mcpServers, \{ type: config\.type, key \}\)/],
  ['type', /const refusal = refuseUnusableMcpServers\(mcpServers\);[\s\S]{0,900}?prepareWorkspaceMcpServers\(mcpServers, \{ type, key \}\)/]
]) {
  check(
    site.test(routerSrc),
    `router.ts asks the refusal BEFORE preparing, at the ${label} call site`,
    'the refusal must read the raw assembly; see refuseUnusableMcpServers'
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§6  the workspace file is the ONLY writer, and it keeps the stamp  [imports dist]');
// ───────────────────────────────────────────────────────────────────────────
// THIS SECTION USED TO ASSERT THE OPPOSITE HALF OF A PAIR, AND KAN-395 DELETED
// THE OTHER HALF. Until then `launcher.setup` for `anti-gravity` received a
// STAMPED assembly and wrote it into `~/.gemini/antigravity-cli/mcp.json` — one
// file serving every workspace, so a stamp written there named whichever agent
// was activated last. `configureAgyMcp` stripped the stamp for that reason, and
// §6 proved the strip: agy's file without the flags, the workspace's file with
// them, one input and two opposite correct answers.
//
// The anti-gravity launcher is gone and `configureAgyMcp` went with it, so the
// hazard has no writer left to come from. What replaces the paired assertion is
// the property that makes that true and would break first if it stopped being:
// **`launchers.ts` exports no writer of a config outside the workspace.** A new
// global-config writer added later reintroduces the whole hazard, and this is
// the line that goes red when one appears.
//
// The positive control is kept verbatim: the workspace writer DOES carry the
// stamp, so a green here cannot be a reader that never finds the flags.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan398-'));
const workspacePath = path.join(tmpDir, 'workspace');
fs.mkdirSync(workspacePath);

launchers.writeWorkspaceMcpConfig(workspacePath, prepared);
const wsWritten = JSON.parse(fs.readFileSync(path.join(workspacePath, '.mcp.json'), 'utf8'));
const wsCoreArgs = wsWritten.mcpServers?.[CORE]?.args ?? [];

// Named rather than pattern-matched: the point is that THIS function is gone,
// and a rename would be a new writer that this list must be told about.
const globalWriters = ['configureAgyMcp'].filter((name) => typeof launchers[name] === 'function');
check(
  globalWriters.length === 0,
  'launchers.ts exports no writer of an MCP config outside the workspace (KAN-395)',
  `global-config writers still exported: ${JSON.stringify(globalWriters)}`
);
check(
  wsCoreArgs.includes(launchers.WORKSPACE_TYPE_FLAG) &&
    wsCoreArgs.includes(launchers.WORKSPACE_KEY_FLAG),
  'THE POSITIVE CONTROL: a prepared assembly through the workspace writer DOES carry them',
  `workspace core args=${JSON.stringify(wsCoreArgs)}`
);
check(
  wsCoreArgs.includes('/butchr/daemon/dist/mcp.js'),
  'and it carries the real argv, so the flags above sit on a command that would run',
  `workspace core args=${JSON.stringify(wsCoreArgs)}`
);
fs.rmSync(tmpDir, { recursive: true, force: true });

// ───────────────────────────────────────────────────────────────────────────
rule('§7  Neither runtime implementation applies a transform of its own');
// ───────────────────────────────────────────────────────────────────────────
// The property the seam buys. It is also what keeps §1 of gate 3's guard
// (verify-crabcast-channel-startup-disablement.mjs) intact and UNNARROWED:
// crabcast-runtime.ts still imports nothing from launchers.js.

check(
  !/import\s*(?:type\s*)?\{[^}]*\}\s*from\s*'\.\/launchers\.js'/.test(runtimeSrc),
  'crabcast-runtime.ts imports nothing from launchers.js',
  runtimeSrc
    .split('\n')
    .filter((l) => l.includes('launchers'))
    .join('\n') || '(no line mentions launchers)'
);
const herdrCode = herdrSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
check(
  !herdrCode.includes('withWorkspaceIdentity('),
  'herdr.ts no longer stamps the identity itself — it arrives stamped',
  herdrCode
    .split('\n')
    .filter((l) => l.includes('withWorkspaceIdentity'))
    .join('\n') || '(no code line calls it)'
);
check(
  !herdrCode.includes('unusableMcpServers('),
  'herdr.ts no longer runs the refusal it could no longer see the field for',
  herdrCode
    .split('\n')
    .filter((l) => l.includes('unusableMcpServers'))
    .join('\n') || '(no code line calls it)'
);

// ── verdict ────────────────────────────────────────────────────────────────
say('');
if (failures > 0) {
  say(`FAILED — ${failures} check(s)`);
  if (rawAtCallsite) {
    say('');
    say('This is the expected red for --raw-at-callsite. The behaviour that made it red:');
    say('a spawnSession call site passes the assembly straight from mcpServersForSpawn(),');
    say('so pathPrefix and the identity stamp never happen. §3 is the arrival leg, and');
    say('the real tree additionally fails to COMPILE here — see the header.');
  }
  if (refuseAfterStrip) {
    say('');
    say('This is the expected red for --refuse-after-strip. The behaviour that made it red:');
    say('the refusal is handed an assembly whose `unusable` field has already been stripped,');
    say('so it answers "nothing unusable" on every activation, for ever, silently.');
  }
  if (transformInRuntime) {
    say('');
    say('This is the expected red for --transform-in-runtime. The behaviour that made it red:');
    say('crabcast-runtime.ts imports a transform, so the two implementations are each doing');
    say('their own preparation again — which is the state KAN-398 ended. It also re-opens');
    say("§1 of gate 3's guard, which forbids that import for an unrelated reason.");
  }
} else {
  say('OK — the transforms run once, above the seam, on every path that reaches it:');
  say('the seam accepts only prepared definitions, one function produces them, both call');
  say('sites call it, the refusal is asked while it can still see its field, and neither');
  say('runtime applies anything of its own. The workspace file is the only writer left');
  say('(KAN-395 deleted the global agy config writer with the launcher that needed it).');
  for (const [flag, label] of [
    [rawAtCallsite, '--raw-at-callsite'],
    [refuseAfterStrip, '--refuse-after-strip'],
    [transformInRuntime, '--transform-in-runtime']
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
