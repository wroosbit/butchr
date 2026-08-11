// Live proof for KAN-223: `AgentRuntime` is a real seam, and it is derived from
// the daemon's call sites rather than copied from `HerdrBridge`.
//
// WHAT FAILURE THIS WOULD CATCH: the seam being quietly undone — a module
// retyped from `AgentRuntime` back to the concrete `HerdrBridge` — while every
// required CI check stays green. Section 1 demonstrates exactly that: with
// `router.ts` and `daemon.ts` both reverted, `daemon-typecheck` passes and
// notices nothing. It would also catch an interface that has drifted into a
// copy of the class, by proving every member is required by a real caller.
//
// WHY THAT FIRST FAILURE IS NOT HYPOTHETICAL. `daemon-typecheck` does catch a
// *partial* revert, because `daemon.ts` types its variable as `AgentRuntime`
// and passing that to a `HerdrBridge` parameter fails. Revert both together and
// the type error disappears with them: the daemon compiles, the tests pass, and
// the only thing lost is the property the ticket exists to establish. That is
// the gap this script owns.
//
// THIS SCRIPT WRITES THE RECORD IT ASSERTS ON — it constructs each broken
// variant itself, in a scratch copy of `daemon/src`, and then checks that the
// compiler rejects it. So it proves the *checks can fire*, not that the seam is
// intact in whatever tree you are reading. What is intact in this tree is
// established by the plain `tsc` runs in section 0, against the real sources.
//
// WHAT THAT LEAVES UNCOVERED, and who covers it:
//
//   - Runtime behaviour. This is entirely a type-level proof; nothing here
//     executes the daemon. Behaviour is the existing verify suite's job, and
//     KAN-223 changes no behaviour by construction (types erase).
//   - Whether a real second implementation would *work*. None exists, and the
//     PTY methods are the part that would not be a passthrough — KAN-224 owns
//     that. This script proves a second implementation is expressible, which is
//     a strictly weaker claim and the one the ticket asks for.
//
// Sections:
//
//   0. baseline  — the real sources typecheck, and the stub fixture typechecks
//                  at each site the daemon wires a runtime
//   1. the gap   — revert router.ts and daemon.ts together: `daemon-typecheck`
//                  goes green, and only the fixture catches it
//   2. minimality — remove each of the interface's members in turn; every one
//                  must break a real caller, or it did not belong there
//
// Usage: node daemon/scripts/verify-agent-runtime-seam.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${detail.split('\n').slice(0, 4).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${detail.split('\n')[0]}`);
  }
}

const tsc = path.join(daemonDir, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.error('setup: daemon/node_modules/.bin/tsc is missing — run `npm install` in daemon/ first.');
  process.exit(1);
}

/** A scratch copy of the daemon sources, so nothing below touches the real tree. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kan223-seam-'));
process.on('exit', () => {
  fs.rmSync(work, { recursive: true, force: true });
});

/**
 * The only place this script writes a file. Kept to one call site deliberately:
 * `sweep-verify-exit-paths.mjs` treats each `writeFileSync(` as opening a
 * written-out fake binary, and with six of them it read this script's own
 * verdict exit as belonging to a shim. The heuristic errs safe — a
 * misclassified exit can only make a script fail the sweep, never pass it — so
 * the fix belongs here rather than in the gate.
 */
const write = (file, text) => fs.writeFileSync(file, text);

// package.json comes too: it carries `"type": "module"`, without which NodeNext
// resolves every file as CommonJS and the whole tree fails on `import.meta` —
// turning both sections below green for a reason that has nothing to do with
// the seam. That is not hypothetical; it is what the first run of this script
// did, and section 2 reported PASS because *everything* was broken.
for (const entry of ['src', 'typecheck', 'tsconfig.json', 'package.json']) {
  fs.cpSync(path.join(daemonDir, entry), path.join(work, entry), { recursive: true });
}
fs.symlinkSync(path.join(daemonDir, 'node_modules'), path.join(work, 'node_modules'), 'dir');

const runtimeFile = path.join(work, 'src', 'agent-runtime.ts');
const routerFile = path.join(work, 'src', 'router.ts');
const daemonFile = path.join(work, 'src', 'daemon.ts');

const pristine = {
  runtime: fs.readFileSync(runtimeFile, 'utf8'),
  router: fs.readFileSync(routerFile, 'utf8'),
  daemon: fs.readFileSync(daemonFile, 'utf8')
};

function restore() {
  write(runtimeFile, pristine.runtime);
  write(routerFile, pristine.router);
  write(daemonFile, pristine.daemon);
}

/** `which` is 'src' for the required daemon-typecheck, 'fixture' for the seam proof. */
function typecheck(which) {
  const args = which === 'fixture'
    ? ['-p', path.join(work, 'typecheck', 'tsconfig.json')]
    : ['--noEmit', '-p', path.join(work, 'tsconfig.json')];
  const r = spawnSync(tsc, args, { cwd: work, encoding: 'utf8' });
  return { green: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// ── 0. baseline ────────────────────────────────────────────────────────────
rule('0. baseline — the seam holds in this tree');

const baseSrc = typecheck('src');
check('daemon sources typecheck', baseSrc.green, baseSrc.out);

const baseFixture = typecheck('fixture');
check(
  'a stub implementing AgentRuntime typechecks at every wiring site',
  baseFixture.green,
  baseFixture.out
);

// Everything below asks "is this variant RED?", and a tree that is already red
// for an unrelated reason answers yes to all of them. So a broken baseline is
// not a failed check among others — it invalidates the rest, and the script
// stops rather than reporting passes it has not earned.
if (!baseSrc.green || !baseFixture.green) {
  console.log(
    '\nFAILED — the baseline is not green, so no result below would mean anything.\n' +
      'Fix the tree (or this script\'s scratch copy) before reading sections 1 and 2.\n'
  );
  process.exit(1);
}

// ── 1. the gap this script owns ────────────────────────────────────────────
rule('1. the gap — revert the seam and watch the required check miss it');

write(
  routerFile,
  pristine.router
    .replace('import {\n  HerdrSession,', 'import {\n  HerdrBridge,\n  HerdrSession,')
    .replace('private herdrBridge: AgentRuntime,', 'private herdrBridge: HerdrBridge,')
);
// KAN-278 moved the construction behind `createAgentRuntime`, which returns an
// `AgentRuntime` — so the way to revert the seam in `daemon.ts` is now to go
// back to constructing the concrete class here rather than to delete a type
// annotation. Same revert, expressed against the current text. The assertion
// below is unchanged and still has to hold: with both files reverted,
// `daemon-typecheck` must go green while the fixture catches it.
const REVERTED_DAEMON_WIRING =
  'const herdrBridge = new HerdrBridge();\n' +
  'const agentRuntimeReport = undefined;';
const daemonWiring =
  'const { runtime: herdrBridge, report: agentRuntimeReport } = createAgentRuntime({ log });';
if (!pristine.daemon.includes(daemonWiring)) {
  console.error(
    `setup: daemon.ts no longer contains the wiring line this proof reverts:\n  ${daemonWiring}\n` +
      'Section 1 would silently test nothing, so it stops instead. Update the line above to match.'
  );
  process.exit(1);
}
write(daemonFile, pristine.daemon.replace(daemonWiring, REVERTED_DAEMON_WIRING));

const revertedSrc = typecheck('src');
check(
  'daemon-typecheck is GREEN on a fully reverted seam (it cannot see this)',
  revertedSrc.green,
  revertedSrc.out
);

const revertedFixture = typecheck('fixture');
check(
  'the stub fixture is RED — it is the only check that catches it',
  !revertedFixture.green,
  revertedFixture.green ? 'fixture passed on a reverted seam: this proof is not load-bearing' : undefined
);
check(
  'and it fails at the router assertion specifically',
  !revertedFixture.green && /agent-runtime-stub\.ts.*TS2740|TS2740.*HerdrBridge/s.test(revertedFixture.out),
  revertedFixture.out
);

restore();

// ── 2. minimality ──────────────────────────────────────────────────────────
rule('2. minimality — every member must be required by a real caller');

const lines = pristine.runtime.split('\n');
const start = lines.findIndex((l) => l.startsWith('export interface AgentRuntime'));
const members = [];
for (let i = start + 1; i < lines.length; i++) {
  const m = /^ {2}(\w+)\(/.exec(lines[i]);
  if (!m) continue;
  let depth = 0;
  let j = i;
  for (; j < lines.length; j++) {
    depth += (lines[j].match(/\(/g) || []).length - (lines[j].match(/\)/g) || []).length;
    if (depth === 0 && lines[j].trimEnd().endsWith(';')) break;
  }
  members.push({ name: m.group ? m.group(1) : m[1], from: i, to: j });
  i = j;
}

// Derived, not hardcoded. This started life as `members.length === 20` and
// KAN-247 added a caller for `resolveAddress`, which made the literal wrong and
// the check a maintenance tax that fails on every legitimate addition. Comparing
// the interface's member set against the methods actually called says the thing
// the ticket actually requires — *derived from the call sites* — and catches
// drift in both directions without anyone updating a number.
const CONSUMERS = ['daemon.ts', 'jira-poll.ts', 'nudge.ts', 'reconcile.ts', 'router.ts'];
const called = new Set();
for (const file of CONSUMERS) {
  const src = fs.readFileSync(path.join(work, 'src', file), 'utf8');
  for (const m of src.matchAll(/herdrBridge\.([A-Za-z_][A-Za-z0-9_]*)\(/g)) called.add(m[1]);
}
const declared = new Set(members.map((m) => m.name));
const missing = [...called].filter((n) => !declared.has(n));
const extra = [...declared].filter((n) => !called.has(n));
check(
  `the interface declares exactly the ${called.size} methods the daemon calls`,
  missing.length === 0 && extra.length === 0,
  [
    missing.length ? `called but not declared: ${missing.join(', ')}` : '',
    extra.length ? `declared but never called: ${extra.join(', ')}` : ''
  ].filter(Boolean).join('\n')
);

const unnecessary = [];
for (const member of members) {
  write(
    runtimeFile,
    [...lines.slice(0, member.from), ...lines.slice(member.to + 1)].join('\n')
  );
  const r = typecheck('src');
  if (r.green) unnecessary.push(member.name);
  if (verbose) console.log(`   ${r.green ? 'GREEN (unnecessary!)' : 'RED   (load-bearing)'}  ${member.name}`);
}
restore();

check(
  'removing any member breaks a real caller — nothing here is copied from the class',
  unnecessary.length === 0,
  unnecessary.length ? `these are not required by any caller: ${unnecessary.join(', ')}` : undefined
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${failures ? `FAILED — ${failures} check(s)` : 'OK — the seam is real, load-bearing, and minimal'}\n`
);
process.exit(failures ? 1 : 0);
