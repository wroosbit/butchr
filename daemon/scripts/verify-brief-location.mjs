// KAN-400: the daemon's three "go and read your brief" messages take the
// brief's location from the runtime that delivered it, instead of each naming
// `.butchr-prompt.md` — a file only `HerdrBridge` writes.
//
// WHAT FAILURE THIS WOULD CATCH: a daemon-composed message sending an agent to
// a file that does not exist on the runtime that started it. Measured under
// CrabCast by `task/KAN-379`: `.butchr-prompt.md` is never written on that path
// — CrabCast writes the brief into a sidecar of its own and types a pointer at
// the pane — so all three messages named a file that is not there. Two of them
// are worse than merely unhelpful: `resumeNudge` ASSERTED a rewrite of it ("your
// .butchr-prompt.md was rewritten by this restart"), and `degradedResumePrompt`
// put it in the FIRST NUMBERED INSTRUCTION given to an agent that has just been
// told its memory is gone. A message that describes an absent mechanism in
// confident prose is this epic's recurring defect, and these two are the copies
// of it that an agent meets when it is least able to check.
//
// It would also catch the quieter half: `HerdrBridge` naming one path and
// writing another. §2 is the only thing standing between those two expressions.
//
// CI-RUNNABLE: yes — §1 and §2 read `daemon/src/*.ts` as text; §3 and §4 import
// the built daemon modules and call them over values this script constructs. It
// needs no peer, no herdr, no PTY, no credential and no network, and it writes
// nothing. The `--static-only` flag below is for a human running this against a
// build that just failed, not for CI, which builds first.
//
// ── WHICH SECTIONS SURVIVE A FAILED BUILD, because the exit code blends ────
//
// `prompts/task.md` warns that a script doing both reports a blended verdict
// after a failed build, and that the section is what must be read rather than
// the exit code. This is one of those scripts, so:
//
//   §1, §2  STATIC — they `readFileSync` `daemon/src/*.ts` and parse text. They
//           read what you WROTE, so their verdict is about your edit whatever
//           the build did.
//   §3, §4  DIST   — they import `../dist/resume.js` and `../dist/*runtime.js`.
//           After a failed build they are testing the PREVIOUS build and their
//           verdict is about code you did not write. `--static-only` runs §1–§2
//           alone, which is the honest thing to do when the build is red.
//
// ── WHAT THIS COVERS, AND WHO COVERS THE REST ──────────────────────────────
//
// This script asserts what the daemon SAYS. It renders both messages itself and
// then asserts on its own output, which is exactly the shape KAN-145 was caught
// by — a proof that supplies its own input has not tested that the input
// arrives. So it deliberately does NOT claim that an agent can act on what it
// renders, or that CrabCast's pointer is where this says it is.
//
// `daemon/scripts/verify-crabcast-brief-reachable-live.mjs` covers that half: it
// starts a real `claude` agent through the CrabCast runtime and watches it
// follow this wording to its actual brief. Neither script is enough alone, and
// the hole between them is named here so nobody has to infer where it is.
//
//   node daemon/scripts/verify-brief-location.mjs [--verbose] [--static-only]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');

const verbose = process.argv.includes('--verbose');
const staticOnly = process.argv.includes('--static-only');

let failures = 0;

const rule = (t) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 10).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const BRIEF_FILE = '.butchr-prompt.md';

// The location a runtime that writes no brief into the workspace answers with.
// Shaped by hand rather than read off `CrabCastRuntime`, because §1–§2 must
// stay independent of `dist`.
const SIDECAR = {
  kind: 'runtime-owned',
  pointer: 'the pointer line CrabCast typed at the start of this session'
};

// ═══ §1 STATIC — the MCP server's instructions ═════════════════════════════
rule('§1 STATIC — the `butchr` MCP server tells every agent where its brief is');

// This string goes into the client's SYSTEM PROMPT, on every request of every
// agent, and it is the one of the three sites that reaches a CrabCast agent
// today — the two resume messages are unreachable on that path until KAN-396
// lands a resume signal. Sliced out of the source rather than imported because
// importing `mcp.ts` starts an MCP server.
const mcpSrc = fs.readFileSync(path.join(srcDir, 'mcp.ts'), 'utf8');
const instructionsAt = mcpSrc.indexOf('\n    instructions:');
check('the `instructions` field was found in mcp.ts', instructionsAt !== -1,
  'the slice below anchors on `\\n    instructions:`; if that moved, this section is measuring nothing');

// From the field to the end of the object literal that holds it. Comments in
// this file DO mention the filename — including the one explaining this change —
// so slicing to the value is the difference between reading the shipped string
// and reading prose about it.
const instructionsEnd = mcpSrc.indexOf('\n  }', instructionsAt);
const instructions = mcpSrc.slice(instructionsAt, instructionsEnd === -1 ? undefined : instructionsEnd);

check(
  `the instructions string names no ${BRIEF_FILE}`,
  !instructions.includes(BRIEF_FILE),
  `it still carries ${BRIEF_FILE}, which no CrabCast-started agent has:\n${instructions.trim().slice(0, 400)}`
);
check(
  'and it still points at the brief rather than dropping the pointer entirely',
  /full brief/i.test(instructions),
  'the pointer sentence is gone. The fix was to stop naming a FILE, not to stop ' +
    'telling agents the long form exists — the short brief and the long one are ' +
    'meant to be reachable from each other.'
);

// ═══ §2 STATIC — one expression for the file herdr writes and names ════════
rule('§2 STATIC — the brief herdr writes is the brief herdr names');

const herdrSrc = fs.readFileSync(path.join(srcDir, 'herdr.ts'), 'utf8');

check(
  'the prompt-file write goes through `workspaceBrief`',
  /const promptFile = workspaceBrief\(session\.workDir\)\.path;/.test(herdrSrc),
  'herdr.ts builds its prompt-file path some other way. That is how the write and ' +
    'the message come apart: two joins that agree until one of them is edited.'
);
check(
  '`briefLocation` derives from the same helper',
  /briefLocation\(type: string, key: string\): BriefLocation \{\s*return workspaceBrief\(/.test(herdrSrc),
  'HerdrBridge.briefLocation no longer answers through workspaceBrief'
);
check(
  `no message in herdr.ts hardcodes ${BRIEF_FILE}`,
  !herdrSrc.split('\n').some((l) => l.includes(BRIEF_FILE) && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')),
  'a non-comment line in herdr.ts still spells the filename'
);

if (staticOnly) {
  rule('verdict (static only)');
  console.log(`   ${failures ? `${failures} FAILED` : 'OK'} — §3 and §4 were skipped by --static-only.`);
  process.exit(failures ? 1 : 0);
}

// ═══ §3 DIST — what the two messages actually render ═══════════════════════
rule('§3 DIST — the two resume messages, rendered for both runtimes');

if (!fs.existsSync(path.join(repoRoot, 'daemon', 'dist', 'resume.js'))) {
  console.error('   setup: daemon/dist is missing. Run `cd daemon && npm run build`, or pass --static-only.');
  process.exit(1);
}

const { degradedResumePrompt, resumeNudge, workspaceBrief, briefReference } = await import(
  '../dist/resume.js'
);

const HERDR = workspaceBrief('/home/x/.local/share/butchr/workspaces/task/kan-400');

// The cold-start prompt. Its first numbered instruction is the whole reason
// this ticket exists: it is handed to an agent that has just been told it has
// no memory, so there is nothing else in its context to cross-check against.
const coldHerdr = degradedResumePrompt('task', 'KAN-400', HERDR);
const coldSidecar = degradedResumePrompt('task', 'KAN-400', SIDECAR);

check(
  'herdr: the cold-start prompt names the absolute path of the file it wrote',
  coldHerdr.includes(HERDR.path),
  coldHerdr.split('\n').find((l) => l.startsWith('1.'))
);
check(
  `CrabCast: the cold-start prompt names no ${BRIEF_FILE}`,
  !coldSidecar.includes(BRIEF_FILE),
  coldSidecar.split('\n').find((l) => l.startsWith('1.'))
);
check(
  "CrabCast: it carries the runtime's own pointer instead, so the instruction is followable",
  coldSidecar.includes(SIDECAR.pointer),
  coldSidecar.split('\n').find((l) => l.startsWith('1.'))
);
if (verbose) {
  console.log(`\n   herdr    step 1: ${coldHerdr.split('\n').find((l) => l.startsWith('1.'))}`);
  console.log(`   CrabCast step 1: ${coldSidecar.split('\n').find((l) => l.startsWith('1.'))}\n`);
}

// The resume nudge. Its defect was not only the path — it ASSERTED a rewrite.
const nudgeHerdr = resumeNudge('task', 'KAN-400', HERDR, 'daemon-restart');
const nudgeSidecar = resumeNudge('task', 'KAN-400', SIDECAR, 'daemon-restart');

check(
  'herdr: the nudge names the file that was in fact rewritten',
  nudgeHerdr.includes(HERDR.path),
  nudgeHerdr
);
check(
  `CrabCast: the nudge asserts no rewrite of ${BRIEF_FILE}`,
  !nudgeSidecar.includes(BRIEF_FILE),
  nudgeSidecar
);
check(
  'the staleness claim itself survives on both — it is what the message is FOR',
  nudgeHerdr.includes('re-rendered') && nudgeSidecar.includes('re-rendered'),
  'the sentence that tells a restored agent its brief moved underneath it is the ' +
    'payload (KAN-242). Removing the false half must not remove the true one.'
);
check(
  'the nudge is still one line, because it is typed into a TUI',
  !nudgeHerdr.includes('\n') && !nudgeSidecar.includes('\n')
);

check(
  'briefReference makes sense mid-sentence on both arms',
  briefReference(HERDR).startsWith('the file at ') && briefReference(SIDECAR) === SIDECAR.pointer,
  `${briefReference(HERDR)} / ${briefReference(SIDECAR)}`
);

// ═══ §4 DIST — each runtime's own answer ═══════════════════════════════════
rule('§4 DIST — what each runtime says about where it puts a brief');

const { HerdrBridge } = await import('../dist/herdr.js');
const { CrabCastRuntime } = await import('../dist/crabcast-runtime.js');

// Called off the prototype, with no instance and no socket. That is safe here
// and nowhere else in these two classes: `briefLocation` answers from its
// arguments and touches no state, which is the property the interface asks for
// — "deterministic from the address" — so calling it this way is a check on
// that property as much as a convenience.
const herdrAnswer = HerdrBridge.prototype.briefLocation.call(null, 'task', 'KAN-400');
const crabAnswer = CrabCastRuntime.prototype.briefLocation.call(null, 'task', 'KAN-400');

check(
  'herdr answers with a workspace file',
  herdrAnswer.kind === 'workspace-file' && herdrAnswer.path.endsWith(BRIEF_FILE),
  JSON.stringify(herdrAnswer)
);
check(
  'and it is under this key\'s workspace, lowercased as the directory is',
  herdrAnswer.kind === 'workspace-file' && herdrAnswer.path.includes(path.join('task', 'kan-400')),
  JSON.stringify(herdrAnswer)
);
check(
  'CrabCast answers `runtime-owned` — it cannot name a path and does not invent one',
  crabAnswer.kind === 'runtime-owned',
  JSON.stringify(crabAnswer)
);
check(
  `and its pointer names no ${BRIEF_FILE}`,
  !JSON.stringify(crabAnswer).includes(BRIEF_FILE),
  JSON.stringify(crabAnswer)
);
check(
  'the pointer describes what CrabCast actually types, so an agent can follow it',
  /Please read and follow the instructions/.test(crabAnswer.pointer),
  crabAnswer.pointer
);
if (verbose) {
  console.log(`\n   herdr    → ${JSON.stringify(herdrAnswer)}`);
  console.log(`   CrabCast → ${JSON.stringify(crabAnswer)}\n`);
}

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (failures) {
  console.log(`   ${failures} check(s) FAILED.`);
} else {
  console.log(
    '   OK — no daemon-composed message names a brief file the running runtime did not write,\n' +
      '   and the file herdr writes is the file herdr names. What an agent DOES with this wording\n' +
      '   is verify-crabcast-brief-reachable-live.mjs, not this script.'
  );
}
console.log('');
process.exit(failures ? 1 : 0);
