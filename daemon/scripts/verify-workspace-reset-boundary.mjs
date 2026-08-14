// KAN-380, cutover gate 4: a reset deletes the workspace directory under BOTH
// runtimes, and refuses anything that is not strictly inside the workspaces
// root.
//
// WHAT FAILURE THIS WOULD CATCH: two of them, in opposite directions, and the
// second is the one that matters.
//
//   (a) THE GAP THIS TICKET CLOSES. `CrabCastRuntime.resetWorkspace` refusing
//       — or silently doing nothing — so that a "reset" under that runtime
//       leaves the previous agent's files in place under the same key and the
//       next agent starting there inherits them. CrabCast never creates the
//       workspace directory (their north star 3) and so never deletes it;
//       Butchr owns both ends there, and until this ticket it owned only one.
//       §1 is the direct measurement of that, on disk, before and after.
//
//   (b) THE BOUNDARY WIDENING. A later edit that lets the delete reach outside
//       `workspaces/<type>/<key>/` — the lexical check softened to a
//       `startsWith` prefix test, the `realpath` comparison dropped, the root
//       itself becoming deletable. This is an `rm -rf`, so (b) is the failure
//       worth more than (a): the cost of (a) is a stale directory and the cost
//       of (b) is somebody's files. §3 is pointed at it, and §3 was watched
//       going red for each of those three mutations before it was trusted —
//       the recipe is at the bottom of this header.
//
// CI-RUNNABLE: yes — imports the built daemon modules, builds every fixture
// inside a temporary directory it creates and removes, and reads three source
// files off the checkout; no live daemon, no herdr, no CrabCast, no credential,
// no network, no terminal.
//
// ── IT RELOCATES `HOME`, AND THAT IS A SAFETY PROPERTY RATHER THAN TIDINESS ──
//
// `workspacesRoot()` is derived from `os.homedir()`, so a script that exercises
// a *real* delete against the real `HOME` is a script that deletes real
// workspaces. That is not hypothetical: `verify-crabcast-runtime-switch.mjs`
// asserted `resetWorkspace('task', 'kan-1')` refused, which was true and inert
// while CrabCast's reset was a refusal — and this ticket turned that same line
// into a live `rm -rf` of `~/.local/share/butchr/workspaces/task/kan-1`, which
// exists on the machine this was written on. That line was changed in the same
// commit. `run-ci-verify-set.mjs` sandboxes `HOME` for every child it runs, but
// an agent running one script by hand gets no such sandbox, so this file does
// it for itself, at the top, before it imports anything.
//
// ── WHICH SECTIONS SURVIVE A FAILED BUILD, BECAUSE THEY DIFFER ──────────────
//
// `prompts/task.md`: a proof that imports from `dist` after a failed build
// tested yesterday's code, and 17 of this repository's scripts silently mix
// both kinds. This one mixes them too, so it is labelled rather than left to be
// worked out:
//
//   * §1, §2, §3, §5 import from `../dist/`. **A failed build makes their
//     verdict evidence about the previous build**, whichever way it goes.
//   * §4 reads `daemon/src/*.ts` as text. It tests what you wrote, and its
//     verdict stands whether or not the build succeeded.
//
// Read the section, never the exit code, when the build was not clean.
//
// ── WHAT IT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED ─────────────────
//
// This script creates the fixtures it then deletes. Per `prompts/task.md`, that
// is said here rather than left to be inferred: it proves the delete is aimed
// correctly and confined correctly, and it proves NOTHING about whether the
// daemon's reset path reaches it — no `reset_workspace` request is sent, no
// router is constructed, no agent is torn down first. That leg is covered by
// `verify-crabcast-runtime-live.mjs` under a real CrabCast daemon and by the
// `handleReset`/`handleResetByKey` call sites in `router.ts`, which take the
// runtime through the `AgentRuntime` interface and so cannot see which
// implementation answered. What is NOT covered by anybody today: a reset driven
// end-to-end through the daemon while a CrabCast agent is actually live in the
// directory being removed. Named so the coverage is not overstated.
//
// ── THE RED DRIVE (three mutations, each watched fail) ───────────────────────
//
//   # b1 — the lexical check softened to a prefix test
//   perl -0pi -e "s/const rel = path.relative\(root, target\);\n  return rel !== '' && !rel.startsWith\('..'\) && !path.isAbsolute\(rel\);/return target.startsWith(root);/" daemon/src/workspace-dir.ts
//   npm --prefix daemon run build; echo \"BUILD_EXIT=\$?\"   # not piped
//   node daemon/scripts/verify-workspace-reset-boundary.mjs  # exit 1
//   git checkout -- daemon/src/workspace-dir.ts
//
//   # b2 — the realpath comparison dropped
//   #   delete the `if (!isStrictlyInside(realRoot, realTarget))` block in
//   #   containWorkspaceDir. exit 1, on the symlink cases in §3.
//
//   # b3 — the containment check skipped entirely on the way to the delete
//   #   `removeContained(workspaceDirFor(type, key))` in deleteWorkspaceDir.
//   #   THIS ONE DOES NOT COMPILE, and that is the guard working rather than
//   #   the proof working — see §4 and the PR body. A mutation that does not
//   #   build is not testable as written; b1 and b2 are the ones that compile.
//
// Usage: node daemon/scripts/verify-workspace-reset-boundary.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

// ── the sandbox, before any import that could read a home directory ─────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kan380-reset-'));
const realHome = process.env.HOME;
process.env.HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => {
  if (realHome !== undefined) process.env.HOME = realHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// Dynamic, so `HOME` is already relocated when these modules first evaluate.
const { createAgentRuntime } = await import('../dist/runtime-switch.js');
const { workspacesRoot, workspaceDirFor } = await import('../dist/workspace-dir.js');

const root = workspacesRoot();
if (!root.startsWith(sandbox)) {
  console.error(
    `REFUSING TO RUN: workspacesRoot() is '${root}', which is outside this script's ` +
      `sandbox '${sandbox}'. The HOME relocation did not take, and every delete below ` +
      'would land on the real fleet.'
  );
  process.exit(1);
}
fs.mkdirSync(root, { recursive: true });

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

/** A workspace with a file in it, so "deleted" is a claim about contents too. */
function makeWorkspace(type, key, marker = 'agent-work.txt') {
  const dir = workspaceDirFor(type, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, marker), 'the previous agent was here\n');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'deep.txt'), 'and here\n');
  return dir;
}

function listing(dir) {
  if (!fs.existsSync(dir)) return '(absent)';
  return fs.readdirSync(dir).sort().join(', ') || '(empty)';
}

const quiet = () => {};

// The two runtimes, built through the real switch — so what is exercised below
// is the object a daemon would actually be serving from, not one this script
// picked.
const crab = createAgentRuntime({
  env: {
    BUTCHR_AGENT_RUNTIME: 'crabcast',
    BUTCHR_CRABCAST_SOCKET: path.join(sandbox, 'no-crabcast-here.sock')
  },
  log: quiet
});
const herdr = createAgentRuntime({ env: {}, log: quiet });

check(
  'the switch built a CrabCast-backed runtime and a herdr-backed one',
  crab.report.mode === 'crabcast' &&
    crab.report.implementation === 'CrabCastRuntime' &&
    herdr.report.mode === 'herdr' &&
    herdr.report.implementation === 'HerdrBridge',
  `${crab.report.implementation} / ${herdr.report.implementation}`
);

// ── 1. AC1 — the gap this ticket closes ────────────────────────────────────
rule('1. (dist) a reset under the CrabCast runtime removes the workspace directory');

// NOTE THE SOCKET. It points at nothing, deliberately: this delete makes no
// wire call, and a fixture that needed a live CrabCast would be hiding that.
// The refusal this method used to return was produced *without* a peer too, so
// the difference measured here is the wiring and nothing else.
const crabDir = makeWorkspace('task', 'kan-380-crab');
console.log(`   before:  ${crabDir}\n            contents: ${listing(crabDir)}`);
check('the fixture workspace exists before the reset', fs.existsSync(crabDir));

const crabReset = crab.runtime.resetWorkspace('task', 'kan-380-crab');
console.log(`   after:   contents: ${listing(crabDir)}`);
console.log(`   answer:  ${JSON.stringify(crabReset)}`);

check(
  'CrabCastRuntime.resetWorkspace reports success rather than refusing',
  crabReset.success === true && crabReset.error === undefined,
  JSON.stringify(crabReset)
);
check(
  'the directory is gone from disk — not emptied, gone',
  !fs.existsSync(crabDir),
  `${crabDir} still exists`
);
check(
  'and it no longer refuses by naming CrabCast’s removed `reset`',
  !/no CrabCast counterpart|reset` was removed/.test(String(crabReset.error ?? '')),
  JSON.stringify(crabReset)
);

// ── 2. AC3 — herdr is unchanged, and "unchanged" is measured against herdr ──
rule('2. (dist) behaviour under the herdr runtime is unchanged');

const herdrDir = makeWorkspace('task', 'kan-380-herdr');
const herdrReset = herdr.runtime.resetWorkspace('task', 'kan-380-herdr');
check(
  'HerdrBridge.resetWorkspace still deletes the directory and reports success',
  herdrReset.success === true && herdrReset.error === undefined && !fs.existsSync(herdrDir),
  JSON.stringify(herdrReset)
);

// The "already gone" contract, which `router.ts` reads: `success: false` and NO
// `error`, because a workspace that was never there is not a refusal. Folding
// the two together would make every reset of an absent workspace report a
// failure with a reason, which is a different answer to the same question.
const absentHerdr = herdr.runtime.resetWorkspace('task', 'kan-380-never-existed');
const absentCrab = crab.runtime.resetWorkspace('task', 'kan-380-never-existed');
check(
  'an already-gone workspace is `success:false` with NO error, on both runtimes',
  absentHerdr.success === false &&
    absentHerdr.error === undefined &&
    absentCrab.success === false &&
    absentCrab.error === undefined,
  `herdr=${JSON.stringify(absentHerdr)} crab=${JSON.stringify(absentCrab)}`
);

// And the strongest form of "unchanged": drive both runtimes through the same
// battery and compare their answers. This is what makes §2 an assertion rather
// than an argument — if the CrabCast path grew its own opinion about which
// directories may be destroyed, or its own wording for saying no, these differ.
const battery = [
  ['task', 'kan-380-battery'],
  ['task', 'kan-380-absent'],
  ['task', '../../../escape'],
  ['..', '..'],
  ['', '']
];
const sameAnswer = [];
for (const [type, key] of battery) {
  makeWorkspace('task', 'kan-380-battery');
  const a = herdr.runtime.resetWorkspace(type, key);
  makeWorkspace('task', 'kan-380-battery');
  const b = crab.runtime.resetWorkspace(type, key);
  sameAnswer.push({ type, key, herdr: a, crab: b, same: JSON.stringify(a) === JSON.stringify(b) });
}
check(
  `both runtimes answer identically on all ${battery.length} battery cases, refusal texts included`,
  sameAnswer.every((r) => r.same),
  sameAnswer.filter((r) => !r.same).map((r) => JSON.stringify(r)).join('\n')
);
if (verbose) for (const r of sameAnswer) console.log(`         ${r.type}/${r.key} → ${JSON.stringify(r.herdr)}`);
fs.rmSync(workspaceDirFor('task', 'kan-380-battery'), { recursive: true, force: true });

// ── 3. AC2 — the assertion that matters more than the happy path ────────────
rule('3. (dist) a path outside workspaces/<type>/<key>/ is refused');

// §1 is this section's positive control. "Nothing was deleted" is an assertion
// about an absence, and a delete that never fires reports exactly the same
// absence — so every refusal below is measured on an instrument shown, in this
// same run and through the same method, to actually remove a directory.

const outside = path.join(sandbox, 'not-butchrs', 'precious');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'do-not-delete.txt'), 'somebody else’s files\n');

// (a) a traversal key, refused BY NAME — nothing at the target need exist.
const traversal = crab.runtime.resetWorkspace('task', '../../not-butchrs/precious');
check(
  'a traversal key is refused',
  traversal.success === false && /Refusing to reset workspace/.test(String(traversal.error)),
  JSON.stringify(traversal)
);
check(
  'the refusal names the path it rejected and the root it is measured against',
  String(traversal.error ?? '').includes(root) &&
    /Only directories strictly inside/.test(String(traversal.error)),
  traversal.error
);
check('the target outside the root still exists', fs.existsSync(path.join(outside, 'do-not-delete.txt')));

// (b) the workspaces root itself. Deleting it would take every workspace on the
// machine, which is why `isStrictlyInside` treats the root as not inside itself.
const rootReset = crab.runtime.resetWorkspace('', '');
check(
  'the workspaces root itself is refused',
  rootReset.success === false && /Refusing to reset workspace/.test(String(rootReset.error)),
  JSON.stringify(rootReset)
);
check('the workspaces root still exists', fs.existsSync(root));

// (c) THE WORKSPACE IS A SYMLINK OUT. Lexically perfect, and it points
// somewhere Butchr does not own — the case the `realpath` comparison exists for.
const symlinkTarget = path.join(sandbox, 'not-butchrs', 'symlink-target');
fs.mkdirSync(symlinkTarget, { recursive: true });
fs.writeFileSync(path.join(symlinkTarget, 'do-not-delete.txt'), 'nor these\n');
fs.mkdirSync(path.join(root, 'task'), { recursive: true });
fs.symlinkSync(symlinkTarget, workspaceDirFor('task', 'kan-380-symlink'));
const symReset = crab.runtime.resetWorkspace('task', 'kan-380-symlink');
check(
  'a workspace that is a symlink out of the root is refused',
  symReset.success === false && /resolves to/.test(String(symReset.error)),
  JSON.stringify(symReset)
);
check(
  'the symlink’s target still exists',
  fs.existsSync(path.join(symlinkTarget, 'do-not-delete.txt'))
);

// (d) THE PARENT IS THE SYMLINK. Worse than (c) and easier to miss: the type
// directory is the link, so the workspace path itself looks entirely ordinary.
const parentTarget = path.join(sandbox, 'not-butchrs', 'linked-parent');
fs.mkdirSync(path.join(parentTarget, 'kan-380-child'), { recursive: true });
fs.writeFileSync(path.join(parentTarget, 'kan-380-child', 'do-not-delete.txt'), 'nor this\n');
fs.symlinkSync(parentTarget, path.join(root, 'linkedtype'));
const parentReset = crab.runtime.resetWorkspace('linkedtype', 'kan-380-child');
check(
  'a workspace whose PARENT is a symlink out of the root is refused',
  parentReset.success === false && /resolves to/.test(String(parentReset.error)),
  JSON.stringify(parentReset)
);
check(
  'the linked parent’s contents still exist',
  fs.existsSync(path.join(parentTarget, 'kan-380-child', 'do-not-delete.txt'))
);

// ── 4. the structural guard, read off the source ────────────────────────────
rule('4. (source text) the guard is structural — no runtime deletes anything itself');

// COMMENTS ARE STRIPPED FIRST, and the first run of this section is why: these
// files document the delete at length, so `fs.rmSync(` appears in prose as well
// as in code, and counting raw text reported two call sites where there is one.
// A guard that counts its own documentation is a guard that goes red when
// somebody explains it better.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const workspaceDirSrc = stripComments(
  fs.readFileSync(path.join(daemonDir, 'src', 'workspace-dir.ts'), 'utf8')
);
const herdrSrc = stripComments(fs.readFileSync(path.join(daemonDir, 'src', 'herdr.ts'), 'utf8'));
const crabSrc = stripComments(
  fs.readFileSync(path.join(daemonDir, 'src', 'crabcast-runtime.ts'), 'utf8')
);

const rmCalls = [...workspaceDirSrc.matchAll(/fs\.rmSync\(/g)];
check(
  'workspace-dir.ts contains exactly one fs.rmSync',
  rmCalls.length === 1,
  `${rmCalls.length} found`
);
check(
  'and it sits inside removeContained, whose parameter is a ContainedWorkspaceDir',
  /function removeContained\(dir: ContainedWorkspaceDir\): void \{\s*fs\.rmSync\(dir, \{ recursive: true, force: true \}\);/.test(
    workspaceDirSrc
  ),
  'the rmSync is no longer behind the branded parameter — an unchecked string can reach it'
);
check(
  'exactly one cast mints a ContainedWorkspaceDir, and it is in containWorkspaceDir',
  [...workspaceDirSrc.matchAll(/as ContainedWorkspaceDir/g)].length === 1 &&
    workspaceDirSrc
      .slice(workspaceDirSrc.indexOf('export function containWorkspaceDir'))
      .includes('as ContainedWorkspaceDir'),
  'a second cast is a second place the containment check can be bypassed'
);
check(
  'the exported delete takes an address, never a path',
  /export function deleteWorkspaceDir\(type: string, key: string\)/.test(workspaceDirSrc) &&
    !/export function deleteWorkspaceDir\([^)]*dir: string/.test(workspaceDirSrc),
  'a path parameter would let any caller aim the rm -rf'
);

// The claim the brand cannot make for itself: that the two runtimes delegate
// rather than delete. TypeScript has no opinion about a file that imports `fs`
// and removes what it likes, so this is a source-text assertion and is exactly
// as strong as it staying here.
check(
  'HerdrBridge.resetWorkspace delegates and deletes nothing itself',
  /public resetWorkspace\(type: string, key: string\): \{ success: boolean; error\?: string \} \{\s*return deleteWorkspaceDir\(type, key\);\s*\}/.test(
    herdrSrc
  ),
  'herdr.ts grew its own deletion again — that is the drift this ticket removed'
);
check(
  'CrabCastRuntime.resetWorkspace delegates and deletes nothing itself',
  /resetWorkspace\(type: string, key: string\): \{ success: boolean; error\?: string \} \{\s*return deleteWorkspaceDir\(type, key\);\s*\}/.test(
    crabSrc
  ),
  'crabcast-runtime.ts grew its own deletion'
);
check(
  'neither runtime file calls rmSync at all',
  !/rmSync/.test(herdrSrc) && !/rmSync/.test(crabSrc),
  `herdr=${/rmSync/.test(herdrSrc)} crabcast=${/rmSync/.test(crabSrc)}`
);

// ── 5. the interface, not the implementation ───────────────────────────────
rule('5. (dist) a caller reaching through AgentRuntime cannot tell which one answered');

// `router.ts` holds an `AgentRuntime` and calls `resetWorkspace(type, key)`. It
// is the shape of that call — an address, two strings, no path — that makes the
// guard reach every caller rather than only the two in this repository today.
const viaInterface = [crab.runtime, herdr.runtime].map((runtime) => {
  makeWorkspace('task', 'kan-380-iface');
  const answer = runtime.resetWorkspace('task', 'kan-380-iface');
  return { answer, gone: !fs.existsSync(workspaceDirFor('task', 'kan-380-iface')) };
});
check(
  'both implementations satisfy the interface identically for a valid address',
  viaInterface.every((r) => r.answer.success === true && r.gone),
  JSON.stringify(viaInterface)
);

crab.runtime.dispose?.();

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — reset removes the workspace directory under both runtimes, refuses every ' +
        'target outside workspaces/<type>/<key>/, and the two runtimes answer identically'
  }\n`
);
process.exit(failures ? 1 : 0);
