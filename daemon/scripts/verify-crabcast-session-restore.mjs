// KAN-346: Butchr's session facts survive a runtime that does not hold them.
//
// WHAT FAILURE THIS WOULD CATCH: a Butchr daemon restart under the CrabCast
// runtime leaving every agent `sessionless: true`, `sessionId: null`, `url:
// null` — the extension with nothing to attach a terminal to, and the human
// opening one by hand. It would also catch the defect found while fixing that
// one, which is worse and was not what the ticket described: an agent CrabCast
// STARTED coming back under CrabCast's own pane name (`crabcast-<key>-<hash>`),
// which `addressFromAgentName` cannot parse, so `list_agents` skipped it and
// the agent was absent from the fleet listing ENTIRELY rather than listed as
// stranded. A shorter list looks like a smaller fleet, and nothing says so.
//
// CI-RUNNABLE: partial — sections 1-4 assert in CI. They stand up their own
// Unix socket and their own agent registry under os.tmpdir(), and need no peer,
// no herdr, no PTY, no credential and no network. Section 5 needs a live
// CrabCast daemon and SKIPS without one; a skip is printed as a skip and never
// counted as a pass.
//
// ── WHAT SUPPLIES ITS OWN INPUT, AND WHO COVERS WHAT THAT LEAVES ───────────
//
// Sections 1-2 answer their own `list_agents` frames, so they are structurally
// incapable of noticing that a real CrabCast sends something different. That
// is the KAN-145 shape and it is owned rather than left to inference:
//
//   - The frames they replay are NOT hand-written. They are
//     `fixtures/crabcast-owned-running-census.json`, captured verbatim off a
//     live CrabCast socket at contract v6 while two agents CrabCast itself had
//     started were RUNNING. Every committed fixture before it has `agents: []`,
//     which is exactly why the owned-row shape had never been examined.
//   - ONE EDIT IS MADE TO THAT DATA AND IT IS MADE HERE, NOT IN THE FILE: the
//     captured absolute paths are rewritten from the fixture's
//     `capturedWorkspacesRoot` to this machine's `workspacesRoot()`. Without it
//     `addressForPath` maps nothing on any machine but the one that captured
//     it, and the sections would pass for the wrong reason on a developer's box
//     and fail on CI. The rewrite touches the path prefix and nothing else.
//   - Section 3 uses no fixture at all: it drives the REAL `AgentRegistry`
//     through the REAL `MessageRouter` and reads the row back off
//     `list_agents`. That is the KAN-294 echo — compare what came back against
//     what was written, rather than trusting a `success`.
//   - That a CURRENT peer still sends the captured shape is section 5, the only
//     section that can fail for that reason.
//   - WHAT NOBODY COVERS: the `claude` launcher. Section 5 spawns with `shell`,
//     as every live CrabCast proof in this repo does, so `expectsRuntime` is
//     exercised only on its `false` branch and the adoption of a row with
//     `launcher: "claude"` is asserted against the fixture rather than against
//     a real one. Nobody covers it, here or elsewhere, and it should be
//     exercised before any cutover.
//
// ── DRIVING IT RED (AC5) ───────────────────────────────────────────────────
//
// Four mutations, because four independent mechanisms are being asserted and
// any one mutation leaves the others green — which is the evidence that they
// ARE independent, not merely the cost of driving them separately:
//
//   1. `adoptFromCensus` — comment out the `this.adoptFromCensus()` call in
//      `startCensus`. Sections 2, 4 and 5 go red; 1 and 3 stay green. The most
//      informative line of that red is the reuse check, which reports
//      `spawnSession returned "…-1786543884695" (initializing)` — a NEW id, on
//      the wire, starting the agent fresh. That is the conversation-destroying
//      path, shown rather than described.
//   2. `recordedUrlFor` — make it `return undefined`. Section 3's two report
//      checks go red while "the registry stored the url verbatim" stays green,
//      which localises the defect to the read side. Sections 2 and 5 stay green.
//   3. `censusRecords` — put `name: row.paneName` back. Section 1 goes red and
//      nothing else does, because adoption addresses rows by path rather than
//      by name.
//   4. Section 5's own leftover guard — leave a probe agent running at
//      `KAN346_PROBE_KEY` and re-run. The guard refuses the section instead of
//      absorbing the reuse. This one was written FROM a real failure rather
//      than for one; see the comment at the guard.
//
// All four transcripts are on the pull request. Per KAN-314, confirm the build
// exited 0 by a route that reports it before reading ANY verdict below — **this
// script imports from `dist`**, so after a failed build it is testing the
// previous build and both outcomes mislead.
//
// Usage: node daemon/scripts/verify-crabcast-session-restore.mjs [--verbose]
//        BUTCHR_DIST=<path to a daemon/dist>    to point at another build
//        BUTCHR_CRABCAST_SOCKET=<path>          for section 5

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const verbose = process.argv.includes('--verbose');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.env.BUTCHR_DIST
  ? path.resolve(process.env.BUTCHR_DIST)
  : path.join(repoRoot, 'daemon', 'dist');

let failures = 0;
let skipped = 0;

function rule(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function ok(message) {
  console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
}
function bad(message, detail) {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${message}`);
  if (detail !== undefined) console.log(`       ${detail}`);
}
function check(condition, message, detail) {
  if (condition) ok(message);
  else bad(message, detail);
}
function skip(message, why) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${message}`);
  console.log(`       ${why}`);
}

/**
 * Run one section, and count a throw as that section's failure.
 *
 * Copied from verify-crabcast-census-disclosure.mjs for its stated reason: a
 * red drive that CRASHES at section 2 says nothing about whether sections 3-5
 * catch the defect, and an exit code that comes from an uncaught TypeError is
 * not a verdict. Removing `adoptFromCensus` is exactly the state that throws
 * here — every later section reads a session that is not there.
 */
async function section(title, body) {
  rule(title);
  try {
    await body();
  } catch (err) {
    bad(
      'this section could not run to completion',
      `${err instanceof Error ? err.message : String(err)} — counted as a failure of this ` +
        `section, not swallowed.`
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, budgetMs, stepMs = 200) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

// ── setup guard, NOT a verdict ─────────────────────────────────────────────
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));
const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { addressFromAgentName, agentNameFor, workspacesRoot, workspaceDirFor } = await import(
  path.join(distDir, 'herdr.js')
);
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan346-'));
const cleanups = [];

// ── the fixture, and the one rewrite made to it ────────────────────────────
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-owned-running-census.json'), 'utf8')
);

/** Rewrite the captured workspace root to this machine's. See the header. */
function localise(value) {
  const from = FIXTURE.capturedWorkspacesRoot;
  const to = workspacesRoot();
  return JSON.parse(JSON.stringify(value).split(from).join(to));
}

const CENSUS = localise(FIXTURE.list_agents);
const STATUS = FIXTURE.daemon_status;

/** A CrabCast that answers exactly the frames it is handed. */
async function fakeCrabCast(name, listFrame, statusFrame = STATUS) {
  const socketPath = path.join(TMP, `${name}.sock`);
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
        const frame =
          req.action === 'daemon_status'
            ? statusFrame
            : req.action === 'list_agents'
              ? listFrame
              : null;
        if (frame) socket.write(JSON.stringify({ ...frame, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  cleanups.push(() => server.close());
  return socketPath;
}

/** A runtime pointed at a fake peer, with its census already read once. */
async function runtimeOn(socketPath) {
  const link = new CrabCastLink({ socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 150, log: () => {} });
  cleanups.push(() => runtime.dispose());
  await until(() => runtime.herdrReachable(), 5_000);
  await sleep(400); // one more census tick, so adoption has run
  return runtime;
}

// The two agents the captured frame holds, in Butchr's terms.
const OWNED = CENSUS.agents.map((row) => {
  const rel = path.relative(workspacesRoot(), row.workDir ?? row.path).split(path.sep);
  return { type: rel[0], key: rel[1], row };
});

console.log(`dist            : ${distDir}`);
console.log(`fixture         : crabcast-owned-running-census.json (${FIXTURE.capturedAt})`);
console.log(`workspaces root : ${workspacesRoot()}`);
console.log(`owned rows      : ${OWNED.map((o) => `${o.type}/${o.key}`).join(', ')}`);

// ───────────────────────────────────────────────────────────────────────────
await section(
  '1. the census names an agent the way Butchr addresses one — the row that used to vanish',
  async () => {
    const runtime = await runtimeOn(await fakeCrabCast('census', CENSUS));
    const records = runtime.listHerdrAgents();

    for (const { type, key, row } of OWNED) {
      const expected = agentNameFor(type, key);
      const record = records.find((r) => (r.workDir ?? '') === (row.workDir ?? row.path));
      check(
        record?.name === expected,
        `an agent CrabCast started is named ${expected}`,
        `got ${JSON.stringify(record?.name)} — CrabCast calls that pane ${JSON.stringify(row.paneName)}`
      );
      check(
        !!record && !!addressFromAgentName(record.name),
        `and addressFromAgentName parses it, so list_agents does not skip the row`,
        `addressFromAgentName(${JSON.stringify(record?.name)}) === null, which is the ` +
          `\`if (!address) continue\` in router.ts — the agent disappears from the fleet listing`
      );
    }

    // The half that must NOT change: herdr names its own panes correctly
    // already, which is why the flip did not lose the foreign ones.
    const foreign = CENSUS.foreignPanes[0];
    const foreignRecord = records.find((r) => r.workDir === foreign.workDir);
    check(
      foreignRecord?.name === foreign.paneName,
      'a foreign pane herdr started keeps the name it already had',
      `expected ${foreign.paneName}, got ${JSON.stringify(foreignRecord?.name)}`
    );
    if (verbose) console.log(`       ${records.length} census records`);
  }
);

// ───────────────────────────────────────────────────────────────────────────
await section('2. adoption — a session re-forms for an agent CrabCast still holds', async () => {
  const runtime = await runtimeOn(await fakeCrabCast('adopt', CENSUS));

  for (const { type, key, row } of OWNED) {
    const session = runtime.getSessionByAddress(key, type);
    check(!!session, `${type}/${key} has a session again`, 'getSessionByAddress returned undefined');
    if (!session) continue;

    check(
      session.adopted === true,
      'and it is marked adopted — this daemon did not start it and does not claim to',
      `adopted === ${JSON.stringify(session.adopted)}`
    );
    check(
      session.createdAt.toISOString() === new Date(row.createdAt).toISOString(),
      'createdAt is READ off the row, not stamped at adoption',
      `session ${session.createdAt.toISOString()} vs row ${row.createdAt}`
    );
    check(session.status === 'active', 'status is active', session.status);
    check(
      session.url === undefined,
      'and it claims NO url — CrabCast has no field for one, so none is invented',
      `url === ${JSON.stringify(session.url)}`
    );
    check(
      session.expectsRuntime === (row.config?.launcher !== 'shell'),
      `expectsRuntime follows config.launcher (${row.config?.launcher})`,
      `expectsRuntime === ${JSON.stringify(session.expectsRuntime)}`
    );
    // The half that makes a terminal possible: every pty verb resolves the
    // remote id off this map, so an adopted session without it would look
    // attached and render nothing.
    check(
      runtime.writePty(session.sessionId, '') === true,
      "the pty address resolves to CrabCast's own session id",
      'writePty returned false, so remoteFor() found nothing and no terminal can attach'
    );
  }

  // ── AN ADOPTED SESSION MUST BE REUSED BY A LATER ACTIVATE, NOT RESPAWNED ──
  //
  // This is the assertion with the most at stake in the whole script, and it is
  // about a conversation rather than a field. An activate against an agent that
  // is already running must return the session we hold; if adoption did not
  // populate the session map, `spawnSession` would instead reach for
  // `configure_agent` + `activate_agent` — which starts the agent FRESH.
  // `task/KAN-275` was lost exactly that way at the 10:58Z flip: CrabCast
  // listed it under unstarted agents with "activating starts FRESH", so it was
  // gone rather than paused, and its PR had to be merged by a non-author.
  //
  // Safe against a fake peer precisely BECAUSE it must not touch the wire:
  // `spawnSession` returns the live session before any request is made. A build
  // where adoption is gone does reach the socket here, and the fake answers no
  // `configure_agent`, so the session stays `initializing` and this check fails
  // rather than hanging.
  {
    const { type, key } = OWNED[0];
    const held = runtime.getSessionByAddress(key, type);
    const again = runtime.spawnSession(type, key, undefined, 'must not respawn', 'shell');
    check(
      !!held && again.sessionId === held.sessionId && again.status === 'active',
      'an activate against an adopted agent REUSES it — it does not start it fresh',
      `spawnSession returned ${JSON.stringify(again.sessionId)} (${again.status}) where the ` +
        `adopted session is ${JSON.stringify(held?.sessionId)}. A new id here is a conversation ` +
        `destroyed, which is how task/KAN-275 was lost.`
    );
  }

  // A foreign pane is NOT adopted, and that is the line the whole design rests
  // on: no sessionId on the row means nothing addresses its pty.
  const foreign = CENSUS.foreignPanes[0];
  const rel = path.relative(workspacesRoot(), foreign.workDir).split(path.sep);
  check(
    runtime.getSessionByAddress(rel[1], rel[0]) === undefined,
    'a foreign pane is NOT adopted — no remote session id, so no session is claimed for it',
    'a session was invented for a pane CrabCast does not own; its terminal would render forever'
  );
});

// ───────────────────────────────────────────────────────────────────────────
// **THIS SECTION PASSES VACUOUSLY IF ADOPTION IS GONE, AND THAT IS SAID HERE
// RATHER THAN DISCOVERED.** Every check below asserts that NOTHING was adopted,
// so a build with `adoptFromCensus` deleted satisfies all four — observed in the
// red drive, where 2b stayed green while 2, 4 and 5 went red. Asking "what would
// have to be true for this to pass while the feature is broken?" answers
// itself: the feature being absent entirely. Section 2 is what covers that, by
// asserting the positive on the same fixture, and the two are only honest as a
// pair. Do not read a green 2b as evidence that adoption ran.
await section('2b. the four rows adoption refuses, each for its own reason', async () => {
  const base = OWNED[0].row;
  const cases = [
    ['state is not running', { ...base, state: 'stopped' }],
    ['no sessionId — nothing would address the pty', { ...base, sessionId: null }],
    ['no createdAt — a creation time may not be guessed', { ...base, createdAt: null }],
    [
      'a path outside Butchr’s workspace tree',
      { ...base, path: '/tmp/not-butchr/whatever', workDir: null }
    ]
  ];
  for (const [why, row] of cases) {
    const frame = { ...CENSUS, agents: [row], foreignPanes: [] };
    const runtime = await runtimeOn(await fakeCrabCast(`refuse-${cases.indexOf(cases.find((c) => c[0] === why))}`, frame));
    check(
      runtime.listActiveSessions().length === 0,
      `refused: ${why}`,
      `adopted ${runtime.listActiveSessions().length} session(s) from a row it should have skipped`
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
await section(
  '3. url — read back off list_agents and agent_status and COMPARED to what was written',
  async () => {
    // No fixture and no fake peer here. A real AgentRegistry, a real
    // MessageRouter, and the KAN-294 echo: write it, read it back, compare.
    const home = fs.mkdtempSync(path.join(TMP, 'home-'));
    const registryFile = path.join(home, 'agents.jsonl');
    const agentRegistry = new AgentRegistry(registryFile);

    const TYPE = 'task';
    const KEY = 'KAN-346';
    const agentName = agentNameFor(TYPE, KEY);
    const workDir = path.join(home, agentName);
    fs.mkdirSync(workDir, { recursive: true });
    const SENT = {
      agentName,
      type: TYPE,
      key: KEY,
      workDir,
      url: 'https://wroosbit.atlassian.net/browse/KAN-346',
      defaultAgent: 'claude',
      activatedBy: null
    };
    agentRegistry.recordActivated(SENT);

    // A census that has the agent and a session map that does not — which is
    // precisely a daemon that has restarted under a runtime holding the panes.
    const bridge = {
      listHerdrAgentsChecked: () => ({
        reachable: true,
        agents: [{ name: agentName, agentRuntime: 'claude', workDir, herdrStatus: 'working' }],
        unreadableRecordsTotal: 0,
        unreadableRecords: []
      }),
      listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
      listHerdrStatuses: () => new Map([[agentName, 'working']]),
      listActiveSessions: () => [],
      getSession: () => undefined,
      getSessionByKey: () => undefined,
      getSessionByAddress: () => undefined,
      describeAgent: () => ({ agentName, type: TYPE, workDir, herdrStatus: 'working' }),
      abandonSession: () => {},
      terminateSession: () => ({ success: true })
    };

    let last = null;
    const router = new MessageRouter(
      new WorkspaceRegistry(),
      new PromptLoader(repoRoot),
      bridge,
      (msg) => {
        last = msg;
      },
      () => {},
      { agentRegistry }
    );

    // ── the durable record, read straight back off disk ──
    const stored = agentRegistry.intents().get(agentName)?.record;
    check(
      stored?.url === SENT.url,
      'the registry stored the url verbatim',
      `sent ${JSON.stringify(SENT.url)}, stored ${JSON.stringify(stored?.url)}`
    );

    // ── list_agents ──
    router.handle({ action: 'list_agents' });
    const row = last?.agents?.find((a) => a.agentName === agentName);
    check(!!row, 'list_agents reports the agent at all', JSON.stringify(last?.agents));
    check(
      row?.sessionless === true,
      'as sessionless — there is genuinely no session, and that is not what this fixes',
      `sessionless === ${JSON.stringify(row?.sessionless)}`
    );
    check(
      row?.url === SENT.url,
      'and its url is what the activation wrote down',
      `sent ${JSON.stringify(SENT.url)}, got ${JSON.stringify(row?.url)} — ` +
        `null here is the pre-KAN-346 behaviour: the daemon holds the url on disk and reports none`
    );
    check(
      row?.sessionId === null && row?.createdAt === null,
      'while the genuinely session-only fields stay null — this did not start inventing them',
      JSON.stringify({ sessionId: row?.sessionId, createdAt: row?.createdAt })
    );

    // ── agent_status, the Info tab ──
    await router.handle({ action: 'agent_status', key: KEY, type: TYPE });
    check(
      last?.action === 'agent_status_response' && last?.url === SENT.url,
      'agent_status answers the same url for the same agent',
      `got ${JSON.stringify(last?.url)} on ${JSON.stringify(last?.action)}`
    );

    // ── and it does NOT invent one for an agent nobody recorded ──
    const ghost = 'butchr-task-kan-000';
    bridge.listHerdrAgentsChecked = () => ({
      reachable: true,
      agents: [
        { name: ghost, agentRuntime: 'claude', workDir: path.join(home, ghost), herdrStatus: 'working' }
      ],
      unreadableRecordsTotal: 0,
      unreadableRecords: []
    });
    router.handle({ action: 'list_agents' });
    const ghostRow = last?.agents?.find((a) => a.agentName === ghost);
    check(
      ghostRow?.url === null,
      'an agent the registry never recorded still answers url: null — nothing is derived from the key',
      `got ${JSON.stringify(ghostRow?.url)}`
    );
  }
);

// ───────────────────────────────────────────────────────────────────────────
await section('4. the two fixes are independent — neither falls out of the other', async () => {
  // The ticket asks for this in as many words: "One may fall out of the other.
  // Do not assume it." They are demonstrably separate mechanisms, and the
  // cheapest proof is that each one's product is absent from the other's owner.
  const runtime = await runtimeOn(await fakeCrabCast('independence', CENSUS));
  const session = runtime.getSessionByAddress(OWNED[0].key, OWNED[0].type);
  check(
    !!session && session.url === undefined,
    'adoption restores a sessionId and NO url — so sessionId does not carry url with it',
    `url === ${JSON.stringify(session?.url)}`
  );
  const src = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'crabcast-runtime.ts'), 'utf8');
  check(
    !/AgentRegistry|recordedUrlFor/.test(src),
    'and the runtime never reads the agent registry — the url leg lives entirely in router.ts',
    'crabcast-runtime.ts mentions the registry, so the two legs are no longer separable'
  );
  const routerSrc = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'router.ts'), 'utf8');
  check(
    /recordedUrlFor/.test(routerSrc) && !/adoptFromCensus/.test(routerSrc),
    'and the router never adopts — the sessionId leg lives entirely in crabcast-runtime.ts',
    'the two legs have grown into each other'
  );
});

// ───────────────────────────────────────────────────────────────────────────
await section('5. LIVE — a real CrabCast, a real restart, a real pty', async () => {
  const socketPath = process.env.BUTCHR_CRABCAST_SOCKET;
  if (!socketPath || !fs.existsSync(socketPath)) {
    skip(
      'the restart repair against a real peer',
      `no CrabCast socket at ${socketPath ?? '(BUTCHR_CRABCAST_SOCKET unset)'}. ` +
        'Sections 1-4 answered their own frames; this is the only one that can notice a peer ' +
        'that changed. Nothing was attempted.'
    );
    return;
  }

  const { createAgentRuntime } = await import(path.join(distDir, 'runtime-switch.js'));
  const TYPE = 'task';
  const KEY = process.env.KAN346_PROBE_KEY ?? 'kan-346-live-probe';
  const workDir = workspaceDirFor(TYPE, KEY);
  const URL = 'https://wroosbit.atlassian.net/browse/KAN-346';

  process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
  process.env.BUTCHR_CRABCAST_SOCKET = socketPath;

  const { runtime: first } = createAgentRuntime({ log: () => {} });
  await until(() => first.herdrReachable(), 8_000);

  // ── A LEFTOVER PROBE MAKES THIS SECTION LIE, SO IT IS REFUSED RATHER THAN
  // ── ABSORBED, AND THIS GUARD IS HERE BECAUSE IT ALREADY HAPPENED
  //
  // The first green run after the red drives printed
  // `spawned session task-kan-346-live-probe-1786542591553, url undefined` —
  // an adoption id, and a url this call had just passed. A probe agent left
  // running by an earlier red drive had been adopted on the first census tick,
  // and `spawnSession` then correctly reused that session instead of starting
  // anything. **Every assertion below still passed**, describing a restart
  // repair for an agent this section never spawned. That is this ticket's own
  // house defect wearing the proof as a costume: an artifact whose sentence
  // claims more than its mechanism covers, degrading toward looking finished.
  //
  // Reuse is the RIGHT behaviour — it is what stops an activate restarting a
  // live agent and losing its conversation, which is how `task/KAN-275` died —
  // so the fix is not to change it but to refuse to call it a spawn.
  const already = first.getSessionByAddress(KEY, TYPE);
  if (already) {
    bad(
      `${TYPE}/${KEY} is already running, so this section cannot spawn one`,
      `a session for it already exists (${already.sessionId}, adopted=${already.adopted}). ` +
        `spawnSession would REUSE it and every check below would pass while proving nothing ` +
        `about a spawn. Clear the leftover and re-run:\n` +
        `         crabcast deactivate ${workDir} && crabcast forget ${workDir}`
    );
    first.dispose();
    return;
  }

  const spawned = first.spawnSession(TYPE, KEY, URL, 'KAN-346 live restore probe.', 'shell');
  await until(() => spawned.status === 'active' || !!spawned.spawnError, 60_000);
  check(
    spawned.status === 'active',
    'a real agent spawned through CrabCast',
    spawned.spawnError ?? `still ${spawned.status}`
  );
  if (spawned.status !== 'active') {
    first.dispose();
    return;
  }
  // Belt and braces on the guard above: the returned session must be one this
  // call created, carrying the url this call passed. An adopted session has
  // neither.
  check(
    spawned.adopted === undefined && spawned.url === URL,
    'and it is genuinely a SPAWN — not a live agent reused, which would prove nothing',
    `adopted=${JSON.stringify(spawned.adopted)} url=${JSON.stringify(spawned.url)}; ` +
      `an adopted session carries no url, so this is a reuse wearing a spawn's assertions`
  );
  console.log(`       spawned session ${spawned.sessionId}, url ${JSON.stringify(spawned.url)}`);

  // THE RESTART. Disposing the runtime and building another against the same
  // live peer is exactly what a daemon restart looks like from CrabCast's side:
  // the session map is gone and the panes are not.
  first.dispose();
  await sleep(1_500);
  const { runtime: second } = createAgentRuntime({ log: () => {} });
  await until(() => second.herdrReachable(), 8_000);

  const back = await until(() => second.getSessionByAddress(KEY, TYPE), 15_000);
  check(
    !!back,
    'after the restart the agent has a session again — NOT sessionless',
    'getSessionByAddress returned undefined, which is the 10:58Z incident reproduced'
  );

  if (back) {
    console.log(`       adopted session ${back.sessionId} (adopted=${back.adopted})`);
    check(back.adopted === true, 'and it is marked adopted rather than claimed as a spawn');
    check(
      back.createdAt.getTime() === spawned.createdAt.getTime() ||
        Math.abs(back.createdAt.getTime() - spawned.createdAt.getTime()) < 5_000,
      "its createdAt is CrabCast's own, within seconds of the spawn we watched",
      `${back.createdAt.toISOString()} vs ${spawned.createdAt.toISOString()}`
    );

    // AC2's mechanism, against a real pty: type into the ADOPTED session and
    // read it back. This is what the extension terminal does.
    const got = [];
    const dispose = second.registerDataListener(back.sessionId, (d) => got.push(d));
    check(typeof dispose === 'function', 'the adopted session serves a pty listener');
    const filled = await until(
      () => (second.getSession(back.sessionId)?.ptyBuffer ?? '').length > 0,
      20_000
    );
    check(filled === true, 'the mirror filled from a real pty_init snapshot');
    second.writePty(back.sessionId, 'echo KANADOPTEDOK\n');
    const echoed = await until(
      () =>
        got
          .join('')
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          .replace(/[^A-Za-z]/g, '')
          .includes('KANADOPTEDOK'),
      25_000
    );
    check(
      echoed === true,
      'typed into the ADOPTED session and read it back — the terminal works after the restart',
      'the pty round trip did not complete; a terminal would render nothing'
    );
    if (dispose) dispose();

    const terminated = second.terminateSession(back.sessionId);
    check(terminated.success === true, 'and the adopted session can be terminated like any other');
  }

  await sleep(1_000);
  second.dispose();
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {}
  // BOTH VERBS, AND `deactivate` FIRST. `forget` on a RUNNING agent reports
  // `alreadyGone: true` for the record and leaves the pane up — which is how
  // the leftover that this section's guard now refuses got left behind in the
  // first place. A red run reaches here with the agent still running, so this
  // is printed unconditionally rather than only on success.
  console.log(`       cleanup: CrabCast still holds this probe. Remove it with BOTH, in order:`);
  console.log(`                crabcast deactivate ${workDir}`);
  console.log(`                crabcast forget ${workDir}`);
});

// ── verdict ────────────────────────────────────────────────────────────────
for (const fn of cleanups) {
  try {
    fn();
  } catch {}
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log('');
if (failures) {
  console.log(`\x1b[31mFAILED — ${failures} check(s)\x1b[0m${skipped ? `, ${skipped} skipped` : ''}`);
} else {
  console.log(`\x1b[32mPASSED\x1b[0m${skipped ? ` — ${skipped} section(s) skipped` : ''}`);
}
process.exit(failures ? 1 : 0);
