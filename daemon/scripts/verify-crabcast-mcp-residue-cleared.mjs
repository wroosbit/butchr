#!/usr/bin/env node
//
// WHAT FAILURE THIS WOULD CATCH: a CrabCast activation refused by
// `configure_agent` because the workspace's `.mcp.json` still holds the
// `atlassian` and `butchr` entries a previous herdr activation wrote — the
// defect measured on 2026-08-15 as 36 spawn failures and 0 activations across
// four human-driven cutover attempts (KAN-474, gate 2). It would also catch the
// two ways of "fixing" it that are worse than the defect: clearing entries
// Butchr does not own, and suppressing a write that does not happen on this
// path anyway.
//
// CI-RUNNABLE: partial — §1 and §2 read `daemon/src/*.ts` as text and assert in
//       full. §3–§8 drive CrabCast's REAL `provisionMcpConfig` out of the peer
//       checkout at ~/code/wroosbit/crabcast, which CI has not got, so they
//       announce themselves SKIPPED there. They are not mocked: this proof's
//       whole value is that the refusal is theirs. Note the skip is reachable
//       ONLY when the checkout is absent — one that is present but dirty,
//       behind CRABCAST_PIN, or serving a stale dist FAILS instead.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL IN THIS PROOF IS CRABCAST'S OWN CODE, NOT A REPRODUCTION OF IT.
//
// §3–§8 import `provisionMcpConfig` from the CrabCast checkout at
// ~/code/wroosbit/crabcast, and assert that it is sitting on exactly the commit
// `CRABCAST_PIN` names (9d4d999…) with a clean tree and a dist no source file is
// newer than. So the red in §3 is the production refusal firing, not this
// script's opinion of what it says. If that checkout is missing or has moved off
// the pin, the live sections REFUSE TO RUN rather than falling back to a
// reproduction — a proof that quietly swaps the real mechanism for a mock is the
// "input the proof supplied itself" defect this repository keeps re-finding.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SCRIPT WRITES ITSELF, AND WHAT THAT LEAVES UNCOVERED.
//
// This script CONSTRUCTS the workspaces it then asserts on: it writes a
// herdr-shaped `.mcp.json` into a temp directory rather than observing one a
// real herdr activation produced. What that leaves uncovered, named rather than
// left to be inferred:
//
//   (a) That `writeWorkspaceMcpConfig` really produces this shape. COVERED
//       ELSEWHERE — `verify-workspace-mcp-preparation.mjs` §6 writes the file
//       through the real function and reads it back. §1 here additionally pins
//       the premise those two share.
//   (b) That a real flipped daemon stops emitting `spawn failed … already
//       defines`. NOT COVERED BY ANY SCRIPT, and not coverable by one:
//       `cutover.sh` refuses to run inside a herdr pane (FATAL, exit 2, even
//       under DRY_RUN=1), so the flip is the human's to drive. The evidence to
//       ask them for is in the PR body, and the ticket names it too:
//         grep -a "spawn failed" ~/.local/share/butchr/daemon.log | tail
//       The `-a` matters (KAN-422): without it the bundled ugrep prints nothing
//       on that file and reads exactly like no matches.
//   (c) That an activated CrabCast agent is REACHABLE from the extension panel.
//       Not this ticket. KAN-475 is the second blocker, filed and linked; a
//       panel still reading "no live agent" after a flip is probably that, and
//       the daemon.log line in (b) is what tells the two apart.
//
// ─────────────────────────────────────────────────────────────────────────────
// BLENDED EXIT — read the section, not just the code. §1 and §2 read source as
// TEXT and are unaffected by a failed build. §3–§8 import `daemon/dist`, so
// after a failed build they test the previous build. `--static-only` runs the
// text sections alone.
//
// RED DRIVES (each breaks one behaviour and names it):
//   --no-clear           skip the clearance entirely. §4 goes red: CrabCast's
//                        real refusal fires on a workspace we were about to
//                        provision. This is the production defect.
//   --clear-whole-file   delete the file instead of the keys. §5 goes red: a
//                        server entry Butchr never wrote is destroyed.
//   --clear-all-keys     remove every key rather than the ones we send. §5 goes
//                        red the same way, from the subtler direction.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const staticOnly = process.argv.includes('--static-only');
const noClear = process.argv.includes('--no-clear');
const clearWholeFile = process.argv.includes('--clear-whole-file');
const clearAllKeys = process.argv.includes('--clear-all-keys');

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, '..');
const srcDir = path.join(daemonDir, 'src');
const distDir = path.join(daemonDir, 'dist');
const CRABCAST_CHECKOUT = path.join(os.homedir(), 'code', 'wroosbit', 'crabcast');

let failures = 0;
const say = (m = '') => console.log(m);
const rule = (m) => {
  say('');
  say('─'.repeat(78));
  say(m);
  say('─'.repeat(78));
};
function check(ok, label, detail) {
  if (ok) {
    say(`  PASS  ${label}`);
  } else {
    failures++;
    say(`  FAIL  ${label}`);
    if (detail !== undefined) {
      for (const line of String(detail).split('\n').slice(0, 12)) say(`        │ ${line}`);
    }
  }
  return ok;
}

const read = (p) => fs.readFileSync(p, 'utf8');
const runtimeSrc = read(path.join(srcDir, 'crabcast-runtime.ts'));
const herdrSrc = read(path.join(srcDir, 'herdr.ts'));
const launchersSrc = read(path.join(srcDir, 'launchers.ts'));
const workspaceDirSrc = read(path.join(srcDir, 'workspace-dir.ts'));
const routerSrc = read(path.join(srcDir, 'router.ts'));

// Comments are prose and must not satisfy a code assertion.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ═══════════════════════════════════════════════════════════════════════════
rule('§1  The premise: Butchr does not pre-write .mcp.json under CrabCast   [source as TEXT]');
// ═══════════════════════════════════════════════════════════════════════════
// If this section is red, the ticket's candidate fix ("stop writing it when
// BUTCHR_AGENT_RUNTIME=crabcast") is back on the table and the fix that shipped
// is aimed at the wrong thing. It is green because there is no such write to
// suppress: the writer has one production caller and it is the other runtime.

const writerCallers = [];
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
  const body = stripComments(read(path.join(srcDir, file)));
  // The definition itself is in launchers.ts; we want CALLS.
  const calls = body.match(/writeWorkspaceMcpConfig\s*\(/g) ?? [];
  const isDefinition = file === 'launchers.ts';
  const callCount = isDefinition
    ? calls.length - (body.match(/export function writeWorkspaceMcpConfig\s*\(/g) ?? []).length
    : calls.length;
  if (callCount > 0) writerCallers.push(`${file} (${callCount})`);
}
check(
  writerCallers.length === 1 && writerCallers[0].startsWith('herdr.ts'),
  'writeWorkspaceMcpConfig has exactly one production caller, and it is herdr.ts',
  `callers found: ${writerCallers.join(', ') || '(none)'}`
);
check(
  !stripComments(runtimeSrc).includes('writeWorkspaceMcpConfig'),
  'crabcast-runtime.ts never calls it, so there is no write to suppress on that path',
  runtimeSrc.split('\n').filter((l) => l.includes('writeWorkspaceMcpConfig')).join('\n') ||
    '(no line mentions it)'
);
// Exactly one runtime is constructed at boot: the two paths cannot both run.
const switchSrc = read(path.join(srcDir, 'runtime-switch.ts'));
check(
  /if\s*\(\s*decision\.mode === 'crabcast'\s*\)[\s\S]*?new CrabCastRuntime\([\s\S]*?return \{ runtime, report \};[\s\S]*?\}\s*const runtime = new HerdrBridge\(\)/.test(
    stripComments(switchSrc)
  ),
  'runtime-switch.ts builds CrabCastRuntime or HerdrBridge, never both',
  'createAgentRuntime no longer has the shape this premise rests on'
);

// ═══════════════════════════════════════════════════════════════════════════
rule('§2  The fix is wired where it has to be, and breaks no existing guard   [source as TEXT]');
// ═══════════════════════════════════════════════════════════════════════════

const runtimeCode = stripComments(runtimeSrc);
check(
  runtimeCode.includes('clearWorkspaceMcpResidue('),
  'crabcast-runtime.ts calls clearWorkspaceMcpResidue',
  '(no code line calls it)'
);
// Ordering is the whole property: clearing AFTER the request repairs nothing.
const clearAt = runtimeCode.indexOf('clearWorkspaceMcpResidue(');
const requestAt = runtimeCode.indexOf('this.link.request(configure)');
check(
  clearAt !== -1 && requestAt !== -1 && clearAt < requestAt,
  'and it clears BEFORE configure_agent is sent, not after',
  `clearWorkspaceMcpResidue at ${clearAt}, link.request(configure) at ${requestAt}`
);
// The guard three other scripts assert. Adding the fix must not re-open it.
check(
  !/import\s*(?:type\s*)?\{[^}]*\}\s*from\s*'\.\/launchers\.js'/.test(runtimeSrc),
  "crabcast-runtime.ts still imports nothing from launchers.js (gate 3's guard, unnarrowed)",
  runtimeSrc.split('\n').filter((l) => l.includes('launchers')).join('\n') ||
    '(no line mentions launchers)'
);
// One spelling of the filename, in the leaf module, used by both writers.
check(
  /export const WORKSPACE_MCP_CONFIG = '\.mcp\.json'/.test(workspaceDirSrc),
  'workspace-dir.ts owns the one spelling of the filename',
  '(WORKSPACE_MCP_CONFIG not declared there)'
);
check(
  !/['"]\.mcp\.json['"]/.test(stripComments(launchersSrc)),
  'launchers.ts no longer spells the filename itself — it imports the constant',
  stripComments(launchersSrc).split('\n').filter((l) => l.includes('.mcp.json')).join('\n')
);
// Address, never a path — the discipline this module already enforces.
check(
  /export function clearWorkspaceMcpResidue\(\s*type: string,\s*key: string,\s*names: readonly string\[\]\s*\)/.test(
    workspaceDirSrc
  ),
  'clearWorkspaceMcpResidue takes an ADDRESS and a name list, never a path',
  '(signature has changed — a path parameter would let a caller aim it)'
);
check(
  /const containment = containWorkspaceDir\(type, key\);/.test(
    workspaceDirSrc.slice(workspaceDirSrc.indexOf('export function clearWorkspaceMcpResidue'))
  ),
  'and it proves containment with the same check the delete uses',
  '(no containWorkspaceDir call inside clearWorkspaceMcpResidue)'
);
// The herdr path must be untouched.
check(
  stripComments(herdrSrc).includes('writeWorkspaceMcpConfig(session.workDir, mcpServers)') &&
    !stripComments(herdrSrc).includes('clearWorkspaceMcpResidue'),
  'herdr.ts still writes the file on every activation and never clears — rollback is self-healing',
  '(the herdr path has changed)'
);
check(
  !stripComments(routerSrc).includes('clearWorkspaceMcpResidue'),
  'and nothing above the runtime seam clears — this is one runtime\'s repair, not a fleet behaviour',
  '(router.ts calls it, which would make it run under herdr too)'
);

if (staticOnly) {
  say('');
  say('--static-only: stopping before the sections that import dist.');
  say(failures > 0 ? `FAILED — ${failures} check(s)` : 'OK — static sections only.');
  process.exit(failures ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
rule('§3  CrabCast at the pin refuses a herdr-written workspace   [REAL CrabCast, imports dist]');
// ═══════════════════════════════════════════════════════════════════════════

// The pin Butchr's adapter claims to be proved against.
const linkSrc = read(path.join(srcDir, 'crabcast-link.ts'));
const pinMatch = linkSrc.match(/CRABCAST_PIN\s*=\s*'([0-9a-f]{40})'/);
if (!check(!!pinMatch, 'crabcast-link.ts declares CRABCAST_PIN', '(constant not found)')) {
  say('');
  say(`FAILED — ${failures} check(s)`);
  process.exit(1);
}
const PIN = pinMatch[1];

// TWO DIFFERENT ANSWERS, AND COLLAPSING THEM IS THE TRAP THIS SPLIT AVOIDS.
//
//   checkout ABSENT  -> environmental. CI has no peer source and never will;
//                       §3–§8 announce themselves SKIPPED and the exit comes
//                       from the static sections alone. This is the `partial`
//                       classification in `ci-partition.md`.
//   checkout PRESENT but dirty / behind the pin / stale dist / drifted
//                    -> a FINDING. The peer source is here and is not what this
//                       proof claims to be driving, so it goes red.
//
// The failing branch is therefore reachable on any machine that has the
// checkout — which is every developer machine and this whole fleet. A skip that
// could never fail would be a section that does not exist while appearing to.
const peerPresent = fs.existsSync(path.join(CRABCAST_CHECKOUT, '.git'));
if (!peerPresent) {
  say(`  SKIP  no CrabCast checkout at ${CRABCAST_CHECKOUT}`);
  say('');
  say('  §3–§8 need the real peer SOURCE to drive its real refusal. They are skipped, not');
  say('  faked: there is no mock of provisionMcpConfig here, deliberately. This is the');
  say('  expected state in CI (see CI-RUNNABLE in the header). On a machine with the');
  say('  checkout these sections run, and a checkout that is present but not at/after the');
  say('  pin FAILS rather than skipping.');
  say('');
  say(
    failures > 0
      ? `FAILED — ${failures} check(s) in the static sections`
      : 'OK — static sections only (§1–§2). The live sections were skipped, not passed.'
  );
  process.exit(failures ? 1 : 0);
}

let peerHead = null;
let peerDirty = null;
try {
  peerHead = execFileSync('git', ['-C', CRABCAST_CHECKOUT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  peerDirty = execFileSync('git', ['-C', CRABCAST_CHECKOUT, 'status', '--porcelain'], {
    encoding: 'utf8'
  }).trim();
} catch (e) {
  check(false, `the CrabCast checkout at ${CRABCAST_CHECKOUT} is readable`, e?.message ?? String(e));
  say('');
  say(`FAILED — ${failures} check(s)`);
  say('The checkout is there but unreadable. That is a finding, not a skip.');
  process.exit(1);
}
// NOT `peerHead === PIN`, and the first draft of this script got that wrong.
//
// The checkout is at 9d4d999 (the commit `docs/crabcast-runtime.md` records the
// gate-3 live proof against, contract v8) while `CRABCAST_PIN` is 8d7348 — an
// ANCESTOR of it. Demanding equality made this section red for a peer that is
// perfectly valid, which would have sent somebody to "fix" a pin that is not
// what this proof depends on.
//
// The question that actually matters is whether the FILE UNDER TEST is the same
// at the pin as in the checkout. It is: zero commits touch `src/provisioning.ts`
// between the two, so the refusal demonstrated below is byte-identical to the
// refusal at the pin. That is asserted rather than asserted-about-HEAD.
check(
  peerDirty === '',
  'the CrabCast checkout has a clean tree, so the code read is the code at its HEAD',
  peerDirty
);
let pinIsAncestor = false;
try {
  execFileSync('git', ['-C', CRABCAST_CHECKOUT, 'merge-base', '--is-ancestor', PIN, peerHead]);
  pinIsAncestor = true;
} catch {
  pinIsAncestor = peerHead === PIN;
}
check(
  pinIsAncestor,
  `and its HEAD (${peerHead.slice(0, 12)}) is at or after CRABCAST_PIN (${PIN.slice(0, 12)})`,
  `HEAD=${peerHead} PIN=${PIN}`
);
const provisioningDrift = execFileSync(
  'git',
  ['-C', CRABCAST_CHECKOUT, 'log', '--oneline', `${PIN}..${peerHead}`, '--', 'src/provisioning.ts'],
  { encoding: 'utf8' }
).trim();
check(
  provisioningDrift === '',
  'and src/provisioning.ts is UNCHANGED between the pin and that HEAD — so the refusal ' +
    'demonstrated below is the refusal at the pin',
  provisioningDrift || '(no drift)'
);

const peerProvisioning = path.join(CRABCAST_CHECKOUT, 'dist', 'provisioning.js');
check(fs.existsSync(peerProvisioning), 'their dist/provisioning.js exists', peerProvisioning);
const peerStale = execFileSync(
  'find',
  [path.join(CRABCAST_CHECKOUT, 'src'), '-name', '*.ts', '-newer', peerProvisioning],
  { encoding: 'utf8' }
).trim();
check(
  peerStale === '',
  'and no source of theirs is newer than it, so their dist is not stale either',
  peerStale
);

const peer = await import(pathToFileURL(peerProvisioning).href);
check(
  peer.MCP_CONFIG_FILENAME === '.mcp.json',
  'their MCP_CONFIG_FILENAME agrees with our WORKSPACE_MCP_CONFIG',
  `theirs=${peer.MCP_CONFIG_FILENAME}`
);

const ours = await import(pathToFileURL(path.join(distDir, 'workspace-dir.js')).href);
const launchers = await import(pathToFileURL(path.join(distDir, 'launchers.js')).href);

// A workspace under the REAL workspaces root, because clearWorkspaceMcpResidue
// takes an address and refuses anything outside it — which is the point of the
// signature and must not be worked around here.
const TYPE = 'task';
const KEY = `KAN-474-PROOF-${process.pid}`;
const workspace = ours.workspaceDirFor(TYPE, KEY);
const sidecar = fs.mkdtempSync(path.join(os.tmpdir(), 'kan474-sidecar-'));
fs.mkdirSync(workspace, { recursive: true });
const mcpFile = path.join(workspace, ours.WORKSPACE_MCP_CONFIG);

// A third-party entry, present from the start. Nothing in this fix may touch it.
const FOREIGN = 'someones-own-server';
const foreignDefinition = { command: '/usr/bin/true', args: ['--not-butchrs'] };

function seedHerdrWorkspace() {
  fs.rmSync(mcpFile, { force: true });
  // Written by the REAL herdr writer, so the shape is not this script's guess.
  launchers.writeWorkspaceMcpConfig(workspace, {
    butchr: { command: '/usr/bin/node', args: ['/opt/butchr/mcp.js'] },
    atlassian: { command: '/usr/bin/npx', args: ['-y', 'mcp-remote', 'https://example.invalid'] }
  });
  const cfg = JSON.parse(read(mcpFile));
  cfg.mcpServers[FOREIGN] = foreignDefinition;
  fs.writeFileSync(mcpFile, JSON.stringify(cfg, null, 2));
}

// What provision() sends CrabCast.
const DEFINITIONS = {
  butchr: { command: '/usr/bin/node', args: ['/opt/butchr/mcp.js', '--workspace-key', KEY] },
  atlassian: { command: '/usr/bin/npx', args: ['-y', 'mcp-remote', 'https://example.invalid'] }
};

const provision = () =>
  peer.provisionMcpConfig({ agentPath: workspace, sidecarDir: sidecar, definitions: DEFINITIONS });

let cleanupDone = false;
function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(sidecar, { recursive: true, force: true });
}
process.on('exit', cleanup);

try {
  seedHerdrWorkspace();
  let refusal = null;
  try {
    provision();
  } catch (e) {
    refusal = e;
  }
  check(
    refusal !== null,
    'THE DEFECT: CrabCast refuses to provision a workspace herdr has written',
    '(provisionMcpConfig returned instead of throwing — the collision did not fire)'
  );
  if (refusal) {
    check(
      /already defines the MCP server\(s\)/.test(refusal.message) &&
        /no record of writing them/.test(refusal.message),
      'and it is the refusal seen in production, in their words',
      refusal.message
    );
    check(
      /'atlassian'/.test(refusal.message) && /'butchr'/.test(refusal.message),
      "naming both of Butchr's servers",
      refusal.message
    );
    say('');
    say('  ── the refusal, verbatim from their code ─────────────────────────');
    for (const line of refusal.message.split('\n')) say(`     ${line}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  rule('§4  After the clearance, the same call succeeds   [REAL CrabCast, imports dist]');
  // ═════════════════════════════════════════════════════════════════════════

  seedHerdrWorkspace();

  if (noClear) {
    say('  --no-clear: skipping the clearance, as the production code did before this fix.');
  } else if (clearWholeFile) {
    say('  --clear-whole-file: deleting the file rather than the keys.');
    fs.rmSync(mcpFile, { force: true });
  } else if (clearAllKeys) {
    say('  --clear-all-keys: removing every key, not just the ones we send.');
    const cfg = JSON.parse(read(mcpFile));
    cfg.mcpServers = {};
    fs.writeFileSync(mcpFile, JSON.stringify(cfg, null, 2));
  } else {
    const clearance = ours.clearWorkspaceMcpResidue(TYPE, KEY, Object.keys(DEFINITIONS));
    check(
      clearance.outcome === 'cleared',
      'clearWorkspaceMcpResidue reports what it did',
      JSON.stringify(clearance)
    );
    check(
      clearance.outcome === 'cleared' &&
        [...clearance.removed].sort().join(',') === 'atlassian,butchr',
      'removing exactly the two entries we are about to send',
      JSON.stringify(clearance)
    );
    check(
      clearance.outcome === 'cleared' && clearance.kept.includes(FOREIGN),
      `and keeping '${FOREIGN}', which Butchr never wrote`,
      JSON.stringify(clearance)
    );
  }

  let secondRefusal = null;
  try {
    provision();
  } catch (e) {
    secondRefusal = e;
  }
  check(
    secondRefusal === null,
    'THE FIX: CrabCast now provisions the same workspace without refusing',
    secondRefusal?.message
  );

  const after = secondRefusal ? null : JSON.parse(read(mcpFile));
  if (after) {
    check(
      JSON.stringify(after.mcpServers.butchr) === JSON.stringify(DEFINITIONS.butchr) &&
        JSON.stringify(after.mcpServers.atlassian) === JSON.stringify(DEFINITIONS.atlassian),
      'and the servers in the file are the ones WE sent, written by THEM',
      JSON.stringify(after.mcpServers, null, 2)
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  rule("§5  Somebody else's entry survives the whole cycle   [REAL CrabCast, imports dist]");
  // ═════════════════════════════════════════════════════════════════════════
  // The reason this is key-scoped rather than a file delete. CrabCast MERGES,
  // so a foreign entry is live configuration — destroying it would be Butchr
  // committing the offence their refusal exists to prevent.

  check(
    after !== null && JSON.stringify(after.mcpServers?.[FOREIGN]) === JSON.stringify(foreignDefinition),
    `'${FOREIGN}' is still in the file, byte-identical, after clear + provision`,
    after ? JSON.stringify(after.mcpServers, null, 2) : '(no file — provisioning refused)'
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§6  Idempotence, and the herdr rollback   [imports dist]');
  // ═════════════════════════════════════════════════════════════════════════

  const second = ours.clearWorkspaceMcpResidue(TYPE, KEY, Object.keys(DEFINITIONS));
  check(
    second.outcome === 'cleared' || second.outcome === 'nothing-of-ours',
    'a second clearance is safe (it removes what CrabCast just wrote; CrabCast rewrites it)',
    JSON.stringify(second)
  );
  const third = ours.clearWorkspaceMcpResidue(TYPE, KEY, Object.keys(DEFINITIONS));
  check(
    third.outcome === 'nothing-of-ours',
    'and a third finds nothing of ours left to remove',
    JSON.stringify(third)
  );
  check(
    third.outcome === 'nothing-of-ours' && third.present.includes(FOREIGN),
    `while still reporting '${FOREIGN}' as present`,
    JSON.stringify(third)
  );

  // Rollback: herdr's writer puts the entries back, untouched by any of this.
  launchers.writeWorkspaceMcpConfig(workspace, {
    butchr: { command: '/usr/bin/node', args: ['/opt/butchr/mcp.js'] },
    atlassian: { command: '/usr/bin/npx', args: ['-y', 'mcp-remote', 'https://example.invalid'] }
  });
  const rolledBack = JSON.parse(read(mcpFile));
  check(
    !!rolledBack.mcpServers.butchr && !!rolledBack.mcpServers.atlassian,
    'ROLLBACK: the first herdr activation after a revert restores both entries',
    JSON.stringify(rolledBack.mcpServers, null, 2)
  );
  check(
    JSON.stringify(rolledBack.mcpServers[FOREIGN]) === JSON.stringify(foreignDefinition),
    `and still does not disturb '${FOREIGN}'`,
    JSON.stringify(rolledBack.mcpServers, null, 2)
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§7  The prototype family, and the file we will not touch   [imports dist]');
  // ═════════════════════════════════════════════════════════════════════════
  // Every key in the map comes from a file Butchr does not solely own, so a
  // server named `toString` — or `constructor`, `valueOf`, `__proto__` — is a
  // reachable input. The naive membership test would report one as OURS TO
  // REMOVE when nothing of ours wrote it, so it fails toward deleting somebody
  // else's entry: the precise outcome key-scoping exists to prevent.

  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [FOREIGN]: foreignDefinition } }, null, 2));
  const proto = ours.clearWorkspaceMcpResidue(TYPE, KEY, ['toString', 'constructor', '__proto__']);
  check(
    proto.outcome === 'nothing-of-ours',
    'a name inherited from Object.prototype is NOT reported as an entry we removed',
    JSON.stringify(proto)
  );
  check(
    JSON.stringify(JSON.parse(read(mcpFile)).mcpServers) ===
      JSON.stringify({ [FOREIGN]: foreignDefinition }),
    'and the file is untouched by that call',
    read(mcpFile)
  );
  // But a real own key by that name IS ours to remove when we sent it.
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { toString: { command: '/x' }, [FOREIGN]: foreignDefinition } }, null, 2)
  );
  const realToString = ours.clearWorkspaceMcpResidue(TYPE, KEY, ['toString']);
  check(
    realToString.outcome === 'cleared' && realToString.removed.join(',') === 'toString',
    "and an OWN key literally named 'toString' is still removed when we send it",
    JSON.stringify(realToString)
  );

  // Unparseable: refused and left alone, not replaced.
  const corrupt = '{ this is not json';
  fs.writeFileSync(mcpFile, corrupt);
  const refused = ours.clearWorkspaceMcpResidue(TYPE, KEY, Object.keys(DEFINITIONS));
  check(
    refused.outcome === 'refused',
    'an unparseable .mcp.json is REFUSED rather than replaced',
    JSON.stringify(refused)
  );
  check(
    read(mcpFile) === corrupt,
    'and its bytes are exactly as they were — CrabCast will refuse with a better error',
    read(mcpFile)
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§8  It cannot be aimed outside a workspace   [imports dist]');
  // ═════════════════════════════════════════════════════════════════════════

  const traversal = ours.clearWorkspaceMcpResidue('task', '../../../../etc', ['butchr']);
  check(
    traversal.outcome === 'refused',
    'a traversal key is refused by name, before anything is read',
    JSON.stringify(traversal)
  );
  const missing = ours.clearWorkspaceMcpResidue('task', `KAN-474-NO-SUCH-${process.pid}`, ['butchr']);
  check(
    missing.outcome === 'absent',
    'and a workspace that does not exist is `absent`, not an error',
    JSON.stringify(missing)
  );
} finally {
  cleanup();
}

// ── verdict ────────────────────────────────────────────────────────────────
say('');
if (failures > 0) {
  say(`FAILED — ${failures} check(s)`);
  if (noClear) {
    say('');
    say('This is the expected red for --no-clear. The behaviour that made it red:');
    say('nothing removed Butchr\'s own entries from the workspace before configure_agent,');
    say('so CrabCast refused to take over servers it had no record of writing. That is');
    say('the production defect — 36 spawn failures, 0 activations, 2026-08-15.');
  }
  if (clearWholeFile || clearAllKeys) {
    say('');
    say(`This is the expected red for ${clearWholeFile ? '--clear-whole-file' : '--clear-all-keys'}.`);
    say('The behaviour that made it red: the activation succeeds, but an MCP server entry');
    say('Butchr never wrote was destroyed on the way. CrabCast MERGES into this file, so');
    say('that entry was live configuration. Removing the collision does not require it.');
  }
} else {
  say('OK — the real CrabCast refusal fires on a herdr-written workspace, the clearance');
  say('removes exactly the entries Butchr owns, and the same provisioning call then');
  say('succeeds with a third party\'s entry still intact. The herdr path is untouched, so');
  say('a rollback restores the file on its next activation.');
  for (const [flag, label] of [
    [noClear, '--no-clear'],
    [clearWholeFile, '--clear-whole-file'],
    [clearAllKeys, '--clear-all-keys']
  ]) {
    if (flag) {
      failures++;
      say('');
      say(`UNEXPECTED GREEN: ${label} was passed and nothing went red. The red drive is not`);
      say('exercising what it claims to; treat this run as a failure.');
    }
  }
}
process.exit(failures ? 1 : 0);
