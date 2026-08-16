#!/usr/bin/env node
// The resume verdict, read off CrabCast's wire and carried far enough to make a
// restored agent get NUDGED rather than silently recorded as already-working
// (KAN-432).
//
// WHAT FAILURE THIS WOULD CATCH: an absent field read as an answer. Butchr's
// `provision()` never read `activate_response.resumedExistingConversation`, so
// `session.resumedConversation` was `undefined` for every agent CrabCast ever
// started; all four readers of it tested `=== true`; and `undefined === true` is
// `false`, which is the branch meaning *"this agent came up with its prompt on
// the command line and is already working."* So under CrabCast every resumed
// agent took the no-nudge branch while sitting in the exact state the nudge
// exists for — holding all of its memory at an empty prompt, waiting
// indefinitely. KAN-21 established what that costs: two agents sat like that
// until a human retyped their instructions.
//
// **It fails silent and it fails in the worst available direction.** The agents
// are alive, the panes are healthy, `activate` succeeded, the reconciler reports
// `restored`, and nothing is doing anything — and no later sweep can tell,
// because `herdrStatus` reads `done` for an idle agent and `done` is also what a
// correct agent awaiting review reads. And it is not an edge case: CrabCast
// resumes any path it has run before, unasked (`task/KAN-396`, measured both
// arms), so after the cutover the first daemon restart hands back a whole fleet
// of workspaces that have all run before.
//
// CI-RUNNABLE: yes — imports the built daemon modules, stands up its own unix
// socket in a temporary directory, and needs no herdr, no pty, no network, no
// credential and no CrabCast. Sections 3 and 4 create and remove probe
// workspaces under the workspaces root, per path and never by reverting a
// directory.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145). This script stands up its OWN unix socket and answers
// `activate_response` with a `resumedExistingConversation` IT CHOSE. So:
//
//   * IT PROVES the chain from that field to a delivered nudge — that
//     `provision()` reads it, that the verdict survives onto the session, out
//     through `activate_response`, into `reconcile.ts`, and reaches
//     `send_to_agent`. Section 4 runs the REAL `reconcileAgents`, the REAL
//     `MessageRouter` and the REAL `CrabCastRuntime` in one process, so the only
//     thing faked between the wire and the nudge is CrabCast itself.
//   * IT IS STRUCTURALLY INCAPABLE of noticing that CrabCast sends something
//     else, sends it under another name, or stops sending it.
//
// WHO COVERS THE ARRIVAL — named rather than left to inference, because this is
// the gap KAN-145 left open between two individually honest scripts:
//
//   * `daemon/scripts/verify-crabcast-second-activation-resumes.mjs` (KAN-396)
//     drives a REAL CrabCast daemon and reads `resumedExistingConversation` off
//     a real `activate_response`, with a discriminating red arm at a never-run
//     path. That is the only thing in the tree that can fail if CrabCast changes
//     this field. It needs a real daemon and spends real tokens, so it is not
//     CI-safe and its output goes on the pull request.
//   * NOBODY covers the composition end to end against a real CrabCast, and
//     nobody can before the flip — `BUTCHR_AGENT_RUNTIME` is unset, so
//     `reconcile.ts` reaches `HerdrBridge` in production today. That is why
//     KAN-432 is a cutover GATE rather than a bug report, and this script does
//     not narrow that and does not claim to.
//   * The reconciler-path coverage gap `task/KAN-396` named — a REAL daemon
//     restart driving `reconcile.ts` — stays uncovered. Section 4 drives
//     `reconcileAgents` in process, which is not that.
//   * NOBODY nudges on a CrabCast resume that Butchr never asked for. Both nudge
//     sites gate on `session.resume` first, and CrabCast decides resumes from
//     its own record. Section 3 shows the verdict IS recorded on such a session;
//     nothing acts on it. Filed and linked `Relates` from KAN-432.
//
// ---------------------------------------------------------------------------
// RUNNING IT
// ---------------------------------------------------------------------------
//   node daemon/scripts/verify-resumed-conversation-nudge.mjs [--verbose]
//
//   --restore-collapse     patch a COPY of the build so `reconcile.js` reads the
//                          verdict the pre-KAN-432 way (`=== true` plus a
//                          truthiness branch), and watch SECTION 4 go red — a
//                          resumed agent goes UN-NUDGED. This is the red the
//                          ticket asks for: it is about the nudge, not about the
//                          field.
//   --restore-boolean-type restore all five pre-KAN-432 expressions in a COPY of
//                          src/ and run `tsc` over it, requiring it to FAIL.
//                          This is what establishes which sites the type change
//                          makes impossible to inherit wrongly — and, just as
//                          importantly, which two it does not.
//
// A gate nobody has watched fail has not been shown to be a gate, so both red
// modes are part of the proof rather than a convenience. Each ends by failing if
// it went GREEN, because a mutation that did not take is an assertion that is
// not watching what it claims to watch.
//
// Run it after `npm run build` in daemon/.

import net from 'net';
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');
const restoreCollapse = process.argv.includes('--restore-collapse');
const restoreBooleanType = process.argv.includes('--restore-boolean-type');

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
  if (detail && (!ok || verbose)) say(`        ${String(detail).split('\n').slice(0, 8).join('\n        ')}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'crabcast-runtime.js'))) {
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan432-resume-nudge-'));
const cleanups = [];
process.on('exit', () => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

// ── the type red drive: restore the pre-KAN-432 expressions and demand a FAIL ─
//
// It runs FIRST and exits, because it is a claim about the compiler rather than
// about the runtime and it has nothing to do with the sections below.
if (restoreBooleanType) {
  const srcCopy = path.join(scratch, 'src');
  cpSync(path.join(daemonDir, 'src'), srcCopy, { recursive: true });
  symlinkSync(path.join(daemonDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  // `"type": "module"` decides whether `module: NodeNext` emits ESM or CommonJS,
  // and it lives in package.json rather than tsconfig. Without it tsc treats
  // every file as CommonJS and reports `TS1470: import.meta is not allowed` in
  // four unrelated modules — errors that have nothing to do with this field, in
  // a run whose whole verdict is "did it fail, and where". A red drive that goes
  // red for the wrong reason is not a red drive.
  writeFileSync(
    path.join(scratch, 'package.json'),
    JSON.stringify({ name: 'kan432-type-red-drive', type: 'module' }, null, 2)
  );
  writeFileSync(
    path.join(scratch, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          rootDir: 'src',
          outDir: 'dist',
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true
        },
        include: ['src/**/*']
      },
      null,
      2
    )
  );

  // The five sites, each named with what the compiler is expected to do about
  // it. `caught: false` is as much a part of this proof as `caught: true` — see
  // the verdict below.
  const sites = [
    {
      file: 'router.ts',
      now: 'if (!session.resume || !needsResumeNudge(session.resumedConversation)) return;',
      was: 'if (!session.resume || session.resumedConversation !== true) return;',
      caught: true,
      why: 'equality against a boolean'
    },
    {
      file: 'herdr.ts',
      now: "session.resume && session.resumedConversation === 'fresh'",
      was: 'session.resume && session.resumedConversation === false',
      caught: true,
      why: 'equality against a boolean'
    },
    {
      file: 'reconcile.ts',
      now: 'resumedConversation: readResumedConversation(response)',
      was: 'resumedConversation: response.resumedConversation === true',
      caught: true,
      why: 'a boolean assigned INTO a field of the union type'
    },
    {
      file: 'reconcile.ts',
      now: 'if (needsResumeNudge(outcome.resumedConversation)) {',
      was: 'if (outcome.resumedConversation) {',
      caught: false,
      why: 'a truthiness test — legal against a string union, and silently wrong'
    },
    {
      file: 'daemon.ts',
      now: '(o) => needsResumeNudge(o.resumedConversation) && o.nudged === false',
      was: '(o) => o.resumedConversation && o.nudged === false',
      caught: false,
      why: 'a truthiness test — legal against a string union, and silently wrong'
    }
  ];

  for (const site of sites) {
    const target = path.join(srcCopy, site.file);
    const source = readFileSync(target, 'utf8');
    const occurrences = source.split(site.now).length - 1;
    if (occurrences !== 1) {
      console.error(
        `--restore-boolean-type expected exactly one ${JSON.stringify(site.now)} in ${site.file}, ` +
          `found ${occurrences}; the site has moved.`
      );
      process.exit(2);
    }
    writeFileSync(target, source.replace(site.now, site.was));
  }
  say('--restore-boolean-type: restored all five pre-KAN-432 expressions in a copy of src/.');

  let tscOutput = '';
  let tscExit = 0;
  try {
    tscOutput = execFileSync(path.join(daemonDir, 'node_modules', '.bin', 'tsc'), ['-p', scratch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    tscExit = e.status ?? 1;
    tscOutput = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  rule('RED DRIVE (type) — the pre-KAN-432 expressions, put back, must not compile');
  say(tscOutput.trim() ? tscOutput.trim() : '(no compiler output)');
  say('');

  check(tscExit !== 0, 'tsc REJECTED the restored collapse rather than accepting it', `exit ${tscExit}`);
  for (const site of sites.filter((s) => s.caught)) {
    check(
      new RegExp(`src/${site.file}\\(`).test(tscOutput),
      `${site.file} — ${site.why} — is a compile error`,
      tscOutput
    );
  }

  // The honest half, and the reason this mode exists rather than a note in a
  // header. Two of the five sites compile CLEAN, so "the compiler will catch it"
  // is false as a general claim about this field, and a reader who believed it
  // would let the next truthiness site through. `needsResumeNudge`, not the
  // type, is what covers these two.
  const uncaught = sites.filter((s) => !s.caught);
  // Only the two codes this mutation can produce: a comparison with no overlap
  // and an assignment of the wrong type. Counting every diagnostic would let an
  // unrelated compile error inflate the total and turn this check green for a
  // reason that has nothing to do with the field.
  const relevant = [...tscOutput.matchAll(/src\/([a-z-]+\.ts)\((\d+),\d+\): error (TS2367|TS2322)/g)].map(
    (m) => `${m[1]}:${m[2]} ${m[3]}`
  );
  say('');
  say('  NOT caught by the compiler, and stated as part of the verdict:');
  for (const site of uncaught) {
    say(`    ${site.file} — ${site.why}`);
    say(`      ${site.was}`);
  }
  check(
    relevant.length === 3,
    'exactly three of the five sites are compile errors — the other two are truthiness ' +
      'tests the type cannot reach, and `needsResumeNudge` is what covers those',
    `compiler flagged: ${relevant.join(', ')}`
  );

  say('');
  say(failures ? `RED DRIVE (type) FAILED: ${failures} check(s)` : 'RED DRIVE (type): as expected.');
  process.exit(failures ? 1 : 0);
}

// ── which build is under test ──────────────────────────────────────────────
let distUnderTest = dist;
if (restoreCollapse) {
  // The damage is done to a COPY. A red run cannot leave a broken build behind,
  // which matters here more than usual: this repo has live agents working in
  // sibling worktrees off the same shared clone.
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  // The copy still has to resolve `node-pty`, which `herdr.js` imports. Node
  // walks up from the importing file, so one symlink beside the copy is enough.
  symlinkSync(path.join(daemonDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

  const target = path.join(distUnderTest, 'reconcile.js');
  const source = readFileSync(target, 'utf8');
  let patched = source
    .replace('resumedConversation: readResumedConversation(response)', 'resumedConversation: response.resumedConversation === true')
    .replace('if (needsResumeNudge(outcome.resumedConversation))', 'if (outcome.resumedConversation)');
  if (patched === source) {
    console.error('--restore-collapse could not find the reconcile.js reads to patch; they have moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  say('--restore-collapse: patched a copy of the build so reconcile.js reads the verdict the old way.');
}

const fileUrl = (p) => `file://${p}`;
const { readResumedConversation, CrabCastRuntime } = await import(
  fileUrl(path.join(distUnderTest, 'crabcast-runtime.js'))
);
const { CrabCastLink } = await import(fileUrl(path.join(distUnderTest, 'crabcast-link.js')));
const { needsResumeNudge } = await import(fileUrl(path.join(distUnderTest, 'resume.js')));
const { workspaceDirFor, agentNameFor } = await import(fileUrl(path.join(distUnderTest, 'herdr.js')));
const { reconcileAgents } = await import(fileUrl(path.join(distUnderTest, 'reconcile.js')));
const { MessageRouter } = await import(fileUrl(path.join(distUnderTest, 'router.js')));
const { AgentRegistry } = await import(fileUrl(path.join(distUnderTest, 'agent-registry.js')));
const { computeCapacity } = await import(fileUrl(path.join(distUnderTest, 'capacity.js')));
const { WorkspaceRegistry } = await import(fileUrl(path.join(distUnderTest, 'registry.js')));
const { PromptLoader } = await import(fileUrl(path.join(distUnderTest, 'prompt.js')));

// ── 1. the ruling on the third state ───────────────────────────────────────
rule('1. needsResumeNudge — the ruling on `unknown`, made once and in the open');

check(needsResumeNudge('restored') === true, "'restored' → nudged: it holds its memory and has no turn to take");
check(needsResumeNudge('fresh') === false, "'fresh' → not nudged: its prompt went in on the command line");
check(
  needsResumeNudge('unknown') === true,
  "'unknown' → NUDGED: a runtime that cannot tell is not evidence the agent is already working"
);
check(needsResumeNudge(undefined) === false, 'undefined → not nudged: this was not a resume at all');

// The asymmetry the ruling rests on, asserted as a property rather than left in
// a comment: `unknown` must never share a branch with `fresh`.
check(
  needsResumeNudge('unknown') !== needsResumeNudge('fresh'),
  'the two states the old boolean collapsed together now take DIFFERENT branches'
);

// ── 2. the spelling conversion, in exactly one place ───────────────────────
rule('2. readResumedConversation — their name, our verdict, converted once');

check(readResumedConversation({ resumedExistingConversation: true }) === 'restored', 'wire true  → restored');
check(readResumedConversation({ resumedExistingConversation: false }) === 'fresh', 'wire false → fresh');
check(
  readResumedConversation({}) === 'unknown',
  'field ABSENT → unknown, NOT fresh — this is the idempotent branch, which CrabCast documents as ' +
    'the response a reconciler sees most often'
);
check(
  readResumedConversation({ resumedExistingConversation: 'true' }) === 'unknown',
  'an unrecognised type → unknown: a shape nobody has seen is not an answer either way'
);
// Their wire also carries a field spelled the way OURS is, and it answers a
// different question — a resume THEY were asked for. Reading it because the name
// matches would be taking the wrong fact.
check(
  readResumedConversation({ resumedConversation: true }) === 'unknown',
  'their `resumedConversation` is NOT this field and is not read as it'
);

// AC1's "exactly one place", asserted against the PROPERTY ACCESS rather than
// against the string. Prose mentions the field by name in several docblocks —
// that is documentation and is not a conversion — so a grep for the bare name
// answers a question nobody asked. What must be unique is the code that READS
// it off a frame.
const srcDir = path.join(daemonDir, 'src');
const readSites = execFileSync('grep', ['-rn', '\\.resumedExistingConversation', srcDir], {
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean)
  // A docblock may legitimately cite the dotted form (`activate_response.resumedExistingConversation`);
  // what is being counted is executable reads, so comment lines are excluded.
  .filter((line) => {
    const code = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
    return !code.startsWith('*') && !code.startsWith('//');
  });
check(
  readSites.length === 1 && readSites[0].includes('crabcast-runtime.ts'),
  "exactly ONE line of code in daemon/src reads CrabCast's name for this field",
  `found: ${readSites.join('\n') || '(none)'}`
);

// ── 3. the verdict arrives from the wire onto the session ──────────────────
rule('3. CrabCastRuntime.provision — the field is read off activate_response');

/**
 * A unix socket answering the frames a spawn, a tail and a send need, with a
 * `resumedExistingConversation` this script chooses per activation.
 *
 * Deliberately thin. A richer fake would start encoding beliefs about CrabCast
 * that only the live script is entitled to hold.
 */
let nextResume = { present: true, value: true };
/** Every `send_to_agent` the runtime made — this is where a nudge shows up. */
const sends = [];
/**
 * Paths this fake has activated, and therefore the agents its census reports.
 *
 * **The census has to be dynamic, and that is faithful rather than convenient.**
 * `reconcile.ts` reads `list_agents` FIRST to find what survived, and skips
 * anything already alive — so a census that reported these agents from the start
 * would answer `already-running` and never restore, never resume and never
 * nudge, and every section-4 assertion would be about a code path that did not
 * run. Afterwards `router.ts`'s `confirmActivation` re-reads the same census and
 * abandons a session it cannot find. So the agent must be absent before the
 * activation and present after it, which is what a real peer does.
 */
const activated = new Map();
const censusRow = (dir) => ({
  path: dir,
  workDir: dir,
  paneName: `crabcast-${path.basename(dir)}-fake`,
  sessionId: `crabcast-${path.basename(dir)}`,
  status: 'active',
  herdrStatus: 'working',
  agentRuntime: 'claude',
  state: 'running',
  createdAt: new Date(0).toISOString(),
  // `config.launcher`, NOT a top-level `launcher` — see the same correction in
  // `verify-crabcast-reconnect-resync.mjs` (KAN-429). At the top level the
  // daemon never reads it, so this row claimed `claude` and was seen as a row
  // with no launcher at all.
  config: { launcher: 'claude' }
});
const socketPath = path.join(scratch, 'crabcast.sock');
const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (body) => socket.write(`${JSON.stringify({ ...body, id: req.id })}\n`);
      if (req.action === 'daemon_status') {
        reply({ action: 'daemon_status_response', success: true, build: {}, contractVersion: 8 });
      } else if (req.action === 'list_agents') {
        reply({
          action: 'list_agents_response',
          success: true,
          agents: [...activated.keys()].map(censusRow),
          foreignPanes: [],
          unreadableRecordsTotal: 0,
          unreadableRecords: []
        });
      } else if (req.action === 'configure_agent') {
        reply({ action: 'configure_response', success: true });
      } else if (req.action === 'activate_agent') {
        activated.set(req.path, true);
        reply({
          action: 'activate_response',
          success: true,
          started: true,
          alreadyRunning: false,
          sessionId: `crabcast-${path.basename(req.path)}`,
          ...(nextResume.present ? { resumedExistingConversation: nextResume.value } : {})
        });
      } else if (req.action === 'tail_agent') {
        // A pane that looks like a Claude Code prompt, which is what
        // `waitForAgentReady` requires before it will let anything type.
        reply({ action: 'tail_response', success: true, text: 'for shortcuts\n❯ ' });
      } else if (req.action === 'send_to_agent') {
        sends.push({ path: req.path, message: req.message });
        reply({ action: 'send_response', success: true, delivered: true, verdict: 'delivered' });
      } else if (req.action === 'deactivate_agent') {
        reply({ action: 'deactivate_response', success: true });
      }
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => server.listen(socketPath, resolve));
cleanups.push(() => server.close());

const link = new CrabCastLink({ socketPath, log: () => {}, reconnectDelayMs: 50 });
const runtime = new CrabCastRuntime({ link, log: () => {}, censusIntervalMs: 10_000 });
cleanups.push(() => link.close?.());
await sleep(400);

const probeWorkspaces = [];
async function spawnWith(key, resume) {
  nextResume = resume;
  const dir = workspaceDirFor('task', key);
  probeWorkspaces.push(dir);
  const session = runtime.spawnSession('task', key, undefined, 'kan-432 resume probe', 1, false, 'shell');
  for (let i = 0; i < 80 && session.status === 'initializing'; i++) await sleep(50);
  return session;
}
cleanups.push(() => {
  for (const dir of probeWorkspaces) rmSync(dir, { recursive: true, force: true });
});

const wasResumed = await spawnWith('kan-432-probe-restored', { present: true, value: true });
const wasFresh = await spawnWith('kan-432-probe-fresh', { present: true, value: false });
const saidNothing = await spawnWith('kan-432-probe-absent', { present: false, value: undefined });

check(wasResumed.status === 'active', 'the fake wire activated the probe sessions', wasResumed.spawnError ?? wasResumed.status);
check(
  wasResumed.resumedConversation === 'restored',
  "wire true   → session.resumedConversation === 'restored'",
  String(wasResumed.resumedConversation)
);
check(
  wasFresh.resumedConversation === 'fresh',
  "wire false  → session.resumedConversation === 'fresh'",
  String(wasFresh.resumedConversation)
);
check(
  saidNothing.resumedConversation === 'unknown',
  "field absent → session.resumedConversation === 'unknown', NOT undefined and NOT 'fresh'",
  String(saidNothing.resumedConversation)
);

// The pre-KAN-432 state, asserted directly so this section fails if the read is
// ever removed again rather than merely if it is read wrongly.
check(
  wasResumed.resumedConversation !== undefined,
  'the field is SET at all — `undefined` here is the whole defect KAN-432 was filed for'
);

// Section 3's probes are real sessions as far as the capacity gate is
// concerned, and this machine's cap is small. Left running they refuse section
// 4's activations — which is the gate working correctly, and which arrives as
// eight red checks about a nudge that was never reached. Stand them down.
for (const session of [wasResumed, wasFresh, saidNothing]) {
  runtime.terminateSession(session.sessionId);
  activated.delete(session.workDir);
}

// ── 4. the nudge, end to end ───────────────────────────────────────────────
rule('4. THE NUDGE — reconcileAgents → MessageRouter → CrabCastRuntime → the wire');

/**
 * A machine with room, handed to the REAL capacity gate.
 *
 * Not a bypass — `computeCapacity` and the gate above it run exactly as they do
 * in production, against facts they were given instead of facts they measured.
 * Without it this section reads the host's live load average, and this repo runs
 * a fleet of agents on four cores: the first complete run of this script was
 * refused for capacity on five of nine checks, correctly, and reported it as a
 * verdict about the nudge. A proof whose result depends on what else the machine
 * happens to be doing is not measuring the thing it names.
 */
const GIB = 1024 ** 3;
const ROOMY_MACHINE = {
  cores: 16,
  totalBytes: Math.round(64 * GIB),
  availableBytes: Math.round(48 * GIB),
  load1: 0.4,
  busyCores: 0.4,
  busyWindowSeconds: 5
};
const capacitySource = (running, supervisors) =>
  computeCapacity(ROOMY_MACHINE, running, { supervisorsRunning: supervisors });

/**
 * Drive the real reconciler over one registry record and report whether the
 * agent was told to carry on.
 *
 * The only fake between the wire and the nudge is CrabCast. `reconcileAgents`,
 * `MessageRouter` and `CrabCastRuntime` are the production classes.
 */
async function reconcileOne(key, resume) {
  nextResume = resume;
  const home = mkdtempSync(path.join(scratch, 'home-'));
  const registry = new AgentRegistry(path.join(home, 'agents.jsonl'));
  const agentName = agentNameFor('task', key);
  const workDir = workspaceDirFor('task', key);
  probeWorkspaces.push(workDir);
  mkdirSync(workDir, { recursive: true });
  registry.recordActivated({
    agentName,
    type: 'task',
    key,
    workDir,
    url: null,
    // `claude` is required for a nudge to be attempted at all — anything else
    // came up fresh and there is nothing to nudge it about.
    defaultAgent: 'claude',
    activatedBy: null
  });

  const router = new MessageRouter(
    new WorkspaceRegistry(),
    new PromptLoader(path.resolve(daemonDir, '..')),
    runtime,
    () => {},
    () => {},
    { agentRegistry: registry, capacitySource }
  );

  const before = sends.length;
  const result = await reconcileAgents({
    registry,
    herdrBridge: runtime,
    router,
    cause: 'reboot',
    log: (...args) => {
      if (verbose) say(`        [log] ${args.join(' ')}`);
    }
  });
  // Each run leaves a live session behind, and the capacity gate counts them.
  // Three runs against a cap of three would refuse the third — silently, as a
  // `deferred` outcome that makes every nudge assertion below vacuous.
  const session = runtime.getSessionByAddress(key, 'task');
  if (session) runtime.terminateSession(session.sessionId);
  activated.delete(workDir);

  return {
    outcome: result.outcomes[0],
    nudges: sends.slice(before),
    workDir
  };
}

/**
 * A run reached the code under test at all.
 *
 * Asserted before every nudge claim, and separately before the NEGATIVE one,
 * because a run that was refused for capacity or that failed to activate sends
 * nothing — so `nudges.length === 0` passes for a reason that has nothing to do
 * with the branch it claims to be about. That is not hypothetical: it is what
 * this script did on its first complete run, where "A FRESH AGENT WAS NOT
 * NUDGED" was the single PASS in a section where nothing had run.
 */
const restored = (run, label) =>
  check(
    run.outcome?.result === 'restored',
    `${label}: the reconciler actually restored it, so what follows is about the nudge`,
    JSON.stringify(run.outcome)
  );

const restoredRun = await reconcileOne('kan-432-reconcile-restored', { present: true, value: true });
restored(restoredRun, 'wire true');
check(
  restoredRun.outcome?.resumedConversation === 'restored',
  "the verdict travelled the whole way into the RestoreOutcome as 'restored'",
  String(restoredRun.outcome?.resumedConversation)
);
check(
  restoredRun.nudges.length === 1,
  'A RESUMED AGENT WAS NUDGED — one send_to_agent reached the wire',
  `sends: ${restoredRun.nudges.length}`
);
check(
  restoredRun.outcome?.nudged === true,
  'and the outcome records the nudge as delivered rather than merely attempted',
  JSON.stringify(restoredRun.outcome)
);
check(
  /interrupted|carry on|resum/i.test(restoredRun.nudges[0]?.message ?? ''),
  'the message is the interrupted-work nudge rather than some other traffic',
  (restoredRun.nudges[0]?.message ?? '(nothing sent)').slice(0, 160)
);

// THE CASE THE TICKET IS ABOUT. CrabCast's idempotent branch carries no
// `resumedExistingConversation` at all, and their contract says that is the
// response a reconciler sees MOST often. Before KAN-432 this arrived as
// `undefined`, read as `false`, and took the already-working branch in silence.
const absentRun = await reconcileOne('kan-432-reconcile-absent', { present: false, value: undefined });
restored(absentRun, 'field absent');
check(
  absentRun.outcome?.resumedConversation === 'unknown',
  "a response that said nothing produces 'unknown' rather than a claim",
  String(absentRun.outcome?.resumedConversation)
);
check(
  absentRun.nudges.length === 1,
  'AN UNKNOWN VERDICT WAS NUDGED — it is not silently recorded as already-working',
  `sends: ${absentRun.nudges.length}`
);

// And the branch that must stay quiet, so this section cannot pass by nudging
// everything. A test that only ever asserts a nudge happened would go green on
// code that nudged unconditionally.
const freshRun = await reconcileOne('kan-432-reconcile-fresh', { present: true, value: false });
restored(freshRun, 'wire false');
check(
  freshRun.outcome?.resumedConversation === 'fresh',
  "a wire `false` produces 'fresh'",
  String(freshRun.outcome?.resumedConversation)
);
check(
  freshRun.nudges.length === 0,
  'A FRESH AGENT WAS NOT NUDGED — its prompt went in on the command line and it is already working',
  `sends: ${freshRun.nudges.length}`
);

// ── 5. gate 9's latent resume message, switched on for the first time ──────
rule("5. gate 9 — the resume message this ticket makes reachable, and the one it does not");

// KAN-400 recorded two resume-message sites "gated on `resumedConversation`,
// written in exactly one place `CrabCastRuntime` never reaches", LATENT, going
// live the moment a resume signal lands. KAN-432 is that moment for ONE of
// them. The ticket says both; the tree says otherwise, and the tree is checked
// here rather than taken on trust.
//
//   * `resumeNudge`, via `nudgeResumedAgent` — RUNTIME-AGNOSTIC. It asks
//     `herdrBridge.briefLocation(...)`, so under this runtime it gets
//     CrabCast's `runtime-owned` arm. It was unreachable only because nothing
//     ever set `resumedConversation`. It is reachable now, and section 4 has
//     just driven it.
//   * `degradedResumePrompt`, at `herdr.ts` — reached from ONE call site, inside
//     `HerdrBridge.initPty`. `CrabCastRuntime` has no `initPty` and no argv:
//     `provision()` sends the prompt to `configure_agent` and never composes a
//     fallback. So this one does NOT go live with this ticket, and saying so is
//     the point — an unverified claim that it did would read as coverage.
const nudgeMessage = restoredRun.nudges[0]?.message ?? '';
const crabcastPointer = runtime.briefLocation('task', 'kan-432').pointer;

check(
  runtime.briefLocation('task', 'kan-432').kind === 'runtime-owned',
  "this runtime answers briefLocation with its own arm rather than a workspace path"
);
check(
  nudgeMessage.includes(crabcastPointer),
  'THE LIVE MESSAGE CARRIES CRABCAST\'S OWN POINTER — gate 9\'s wording is correct on the ' +
    'first path that can actually deliver it',
  nudgeMessage.slice(0, 200)
);
check(
  !nudgeMessage.includes('.butchr-prompt.md'),
  'and it does NOT name .butchr-prompt.md, which CrabCast never writes — this is the exact ' +
    'sentence KAN-400 was filed about, checked against a message that was really sent'
);
check(
  /re-read it and run the check/i.test(nudgeMessage),
  'the staleness instruction survived onto this path too'
);

// The second site, asserted as ABSENT rather than described as absent.
const herdrSrc = readFileSync(path.join(srcDir, 'herdr.ts'), 'utf8');
const crabcastSrc = readFileSync(path.join(srcDir, 'crabcast-runtime.ts'), 'utf8');
check(
  herdrSrc.includes('degradedResumePrompt(') && !crabcastSrc.includes('degradedResumePrompt'),
  'degradedResumePrompt is still reached from HerdrBridge alone — it does NOT go live here, ' +
    'contrary to the ticket, and that is reported rather than assumed',
  'crabcast-runtime.ts composes no fallback prompt: provision() hands the prompt to configure_agent'
);

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (restoreCollapse) {
  // A mutation that did not take is an assertion that is not watching what it
  // claims to watch, so a GREEN here is a failure of the red drive.
  if (failures === 0) {
    say('  RED DRIVE FAILED: the build was patched back to the pre-KAN-432 reads and every');
    say('  check still passed. Section 4 is not watching the nudge.');
    process.exit(1);
  }
  say(`  RED DRIVE: ${failures} check(s) went red with the old reads restored, as expected.`);
  say('  The ones that matter are section 4\'s: a resumed agent goes UN-NUDGED.');
  process.exit(0);
}

say(failures ? `  ${failures} check(s) FAILED` : '  all checks passed');
process.exit(failures ? 1 : 0);
