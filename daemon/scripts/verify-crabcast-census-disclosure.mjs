// KAN-324: the census discloses what it could not read, and a version bump is
// paid for by reading the fields rather than by moving the number.
//
// WHAT FAILURE THIS WOULD CATCH: a census that answers a SHORT agent list with
// nothing saying it is short. CrabCast's KAN-302 turned a registry row their
// daemon cannot read from "refuse to start" into "start and skip", so from
// read-path contract v4 onward `list_agents` can be missing rows — and at v3
// there was no field that could say so. Measured on the machine this was
// written on, against a live peer at `6258ded`: `agents: []`,
// `configuredAgents: 0`, `unreadableRecordsTotal: 1`. An empty fleet and a
// one-row-short fleet, identical on every field a v3 consumer reads. This
// script would also catch the two ways the fix decays: `?? 0` collapsing "no
// disclosure" into "nothing was skipped", and the report-not-refuse disposition
// being tightened into a version gate.
//
// ── THE SHAPE, BECAUSE IT IS THE THIRD SIGHTING IN SIX HOURS ───────────────
//
// A count that silently excludes what it could not read is this fleet's house
// defect, and the disclosure is usually sitting one field to the left, unread:
//
//   - KAN-319: a guardian poke recorded `delivered: true` at the near end of
//     the wire, six times, never reaching a model.
//   - A Jira search returning 5 of 50 with `hasNextPage: true` beside it —
//     acted on as a complete answer until somebody read the second field.
//   - This one: `agents: []` with `unreadableRecordsTotal: 1` beside it.
//
// All three degrade toward looking finished, which is why they survive review.
//
// ── WHAT SUPPLIES ITS OWN INPUT, AND WHO COVERS WHAT THAT LEAVES ───────────
//
// Sections 1-7 stand up a fake CrabCast and answer their own frames. That is
// deliberate — it is what makes the red reproducible after the machine's
// registry is tidied — and it means those sections are STRUCTURALLY INCAPABLE
// of noticing that a real CrabCast sends something different. A proof that
// supplies its own input has not tested that the input ARRIVES (KAN-145: two
// scripts asserted the daemon carries `activatedBy` by constructing records
// that already had it, while it was null for every agent in production).
//
// The gap is owned, and here is the whole of who owns it:
//
//   - The frames sections 1-7 replay are NOT hand-written. They are
//     `fixtures/crabcast-v4-short-census.json`, captured verbatim off a live
//     CrabCast socket. So "these are the field names CrabCast really sends" is
//     covered by capture rather than by assumption.
//   - That a CURRENT peer still sends them is section 8, which runs against the
//     real socket and is the only section that can fail for that reason. It
//     SKIPS when no socket is there, and a skip is printed as a skip and never
//     counted as a pass.
//   - What nobody covers: that Butchr's DEPLOYED daemon observes any of this.
//     It cannot — the deployed daemon runs in `herdr` mode, where
//     `createAgentRuntime` builds no CrabCast link at all, so the census this
//     script is about is unobservable from it until the flip. That is the
//     finding, not a gap in this script, and it is why KAN-324 is a flip
//     PRECONDITION. Section 7 is the part that is live today.
//
// CI-RUNNABLE: partial — sections 1-7 assert in CI. They stand up their own
// Unix socket and a fake `herdr` on PATH, and need no peer, no real herdr, no
// PTY, no credential and no network. Section 8 needs a live CrabCast daemon and
// SKIPS without one; a skip is printed as a skip and never counted as a pass.
//
// KAN-373 — AND THE EXIT CODE NOW CARRIES THAT SENTENCE. It did not. This
// script ended `process.exit(failures ? 1 : 0)`, which consults the skip
// tally not at all, so a skipped live section exited 0 and a caller reading
// the exit code could not tell a proved peer from an absent one. The prose
// above was true of the PRINTING and false of the process. Now:
//
//   0  every section ran, and every assertion passed
//   1  at least one assertion failed
//   2  nothing failed, and something did not run
//
// Pass `--allow-skipped` to assert that an incomplete run is acceptable to
// THIS caller and get 0 back. See `lib/verdict-exit.mjs`.
//
// ── DRIVING IT RED (AC5) ───────────────────────────────────────────────────
//
// The pre-fix build is `origin/main`, where `listHerdrAgentsChecked` returns
// `{reachable, agents}` and no disclosure exists to read:
//
//   git worktree add /tmp/kan324-prefix origin/main
//   cd /tmp/kan324-prefix/daemon && npm ci --ignore-scripts && npm run build
//   echo "BUILD_EXIT=$?"        # must be 0 before ANY verdict below is read
//   node daemon/scripts/verify-crabcast-census-disclosure.mjs   # from THIS branch
//
// Point it at the pre-fix `dist` with BUTCHR_DIST. The output is on the PR.
//
// **This script imports from `dist`.** So per KAN-314 its verdict is worthless
// after a failed build — it would be testing the previous build, and both
// outcomes mislead: a pass reads as "the mutation was not caught" and a red
// credits the wrong mechanism. Confirm the build exited 0, by a route that
// reports it, before reading a single line below.
//
// Usage: node daemon/scripts/verify-crabcast-census-disclosure.mjs [--verbose]
//        BUTCHR_DIST=<path to a daemon/dist>   to point at another build
//        BUTCHR_CRABCAST_SOCKET=<path>         for section 8

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';

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

/**
 * Run one section, and count a throw as that section's failure.
 *
 * **Written because the first red drive crashed rather than reported.** Against
 * the pre-fix build `reading.unreadableRecords` is `undefined`, section 3
 * destructured it, and the script died at section 3 — non-zero, but for the
 * wrong reason and with sections 4-8 never run, so the drive said nothing about
 * whether *they* catch the defect. An exit code that comes from an uncaught
 * TypeError is not a verdict, and a proof that cannot survive the state it
 * exists to detect cannot report on it.
 */
async function section(title, body) {
  rule(title);
  try {
    await body();
  } catch (err) {
    bad(
      'this section could not run to completion',
      `${err instanceof Error ? err.message : String(err)} — counted as a failure of this ` +
        `section, not swallowed. A build without the disclosure is exactly the state that ` +
        `throws here.`
    );
  }
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

// ── the pre-fix build has no disclosure to import ───────────────────────────
//
// A setup guard, not a verdict: it exits non-zero so a missing build is loud,
// but it is not what this script is testing. The sweep counts it as a guard.
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

const { CrabCastLink, CRABCAST_PIN, CRABCAST_CONTRACT_VERSION } = await import(
  path.join(distDir, 'crabcast-link.js')
);
const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-v4-short-census.json'), 'utf8')
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan324-'));
const cleanups = [];

/**
 * A CrabCast that answers exactly the frames it is handed.
 *
 * `statusFrame` and `listFrame` go out verbatim but for the correlating `id`,
 * so a section that wants a v3 peer builds one by DELETING fields rather than
 * by describing one — which keeps every section's peer a real captured shape
 * with a known difference from it, rather than five hand-written guesses.
 */
async function fakeCrabCast(name, statusFrame, listFrame) {
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
          req.action === 'daemon_status' ? statusFrame : req.action === 'list_agents' ? listFrame : null;
        if (frame) socket.write(JSON.stringify({ ...frame, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  cleanups.push(() => server.close());
  return socketPath;
}

/** Stand up a runtime against a fake peer and wait for one census to land. */
async function censusFrom(name, statusFrame, listFrame) {
  const socketPath = await fakeCrabCast(name, statusFrame, listFrame);
  const logLines = [];
  const link = new CrabCastLink({ socketPath, log: (m) => logLines.push(m) });
  const runtime = new CrabCastRuntime({
    link,
    censusIntervalMs: 50,
    log: (m) => logLines.push(m)
  });
  cleanups.push(() => runtime.dispose());

  const deadline = Date.now() + 5_000;
  let reading = runtime.listHerdrAgentsChecked();
  while (Date.now() < deadline && !reading.reachable) {
    await new Promise((r) => setTimeout(r, 25));
    reading = runtime.listHerdrAgentsChecked();
  }
  return { reading, runtime, link, logLines };
}

const statusOf = () => structuredClone(FIXTURE.daemon_status);
const listOf = () => structuredClone(FIXTURE.list_agents);

// =============================================================================
await section('1. THE DEFECT ITSELF — a short census is distinguishable from an empty one', async () => {
// AC1. The fixture is the real thing: zero agents, one row skipped. Before this
// ticket both readings produced `{reachable: true, agents: []}` and nothing
// else, so nothing a caller could hold told them apart. This is the section
// that goes red on the pre-fix build.
{
  const short = await censusFrom('short', statusOf(), listOf());

  const emptyList = listOf();
  emptyList.unreadableRecords = [];
  emptyList.unreadableRecordsTotal = 0;
  const whole = await censusFrom('whole', statusOf(), emptyList);

  check(
    short.reading.reachable && whole.reading.reachable,
    'both censuses were taken (reachable), so what follows is about what they FOUND',
    `short=${short.reading.reachable} whole=${whole.reading.reachable}`
  );

  check(
    short.reading.unreadableRecordsTotal === 1,
    'the short census discloses unreadableRecordsTotal: 1',
    `got ${JSON.stringify(short.reading.unreadableRecordsTotal)} — on the pre-fix build this field ` +
      `does not exist, which is the red AC5 asks for`
  );

  check(
    whole.reading.unreadableRecordsTotal === 0,
    'the whole census discloses unreadableRecordsTotal: 0 — the zero that makes the count trustworthy'
  );

  // The load-bearing assertion. Everything else is a detail of it.
  const shortAgents = short.reading.agents.length;
  const wholeAgents = whole.reading.agents.length;
  check(
    shortAgents === wholeAgents &&
      short.reading.unreadableRecordsTotal !== whole.reading.unreadableRecordsTotal,
    'two censuses with an IDENTICAL agent count are told apart by the disclosure alone',
    `agents ${shortAgents} vs ${wholeAgents}; totals ` +
      `${JSON.stringify(short.reading.unreadableRecordsTotal)} vs ` +
      `${JSON.stringify(whole.reading.unreadableRecordsTotal)}`
  );

  if (verbose) {
    console.log(`       short: ${JSON.stringify(short.reading.unreadableRecords, null, 2)}`);
  }
}
});

// =============================================================================
await section('2. THE COLLAPSE — a v3 peer reads null, and null is not zero', async () => {
// AC3's real content. `?? 0` is the one-operator version of this ticket's own
// defect: it turns "this peer disclosed nothing" into "this peer disclosed that
// nothing was skipped", which is the opposite claim about how far the agent
// count can be trusted. It is green against every v4 peer, so only a v3 peer
// can catch it — and a v3 peer is exactly what this adapter still expects to
// meet.
{
  const v3Status = statusOf();
  v3Status.contractVersion = 3;
  delete v3Status.unreadableRecords;
  delete v3Status.unreadableRecordsTotal;

  const v3List = listOf();
  delete v3List.unreadableRecords;
  delete v3List.unreadableRecordsTotal;

  const { reading } = await censusFrom('v3', v3Status, v3List);

  check(
    reading.reachable,
    'the census is still TAKEN against a v3 peer — an undisclosed count is not an unreachable one'
  );
  check(
    reading.unreadableRecordsTotal === null,
    'a v3 peer reads null, not 0',
    `got ${JSON.stringify(reading.unreadableRecordsTotal)}. 0 here would claim this peer said ` +
      `nothing was skipped, when it said nothing at all.`
  );
  check(
    Array.isArray(reading.unreadableRecords) && reading.unreadableRecords.length === 0,
    'unreadableRecords is present and empty rather than absent — the total is what distinguishes the states'
  );

  // A shape nobody has seen is not a count either. Reading it as a number would
  // be guessing; reading it as 0 would be the collapse under another name.
  for (const [label, value] of [
    ['a string', '1'],
    ['a negative', -1],
    ['a float', 1.5],
    ['null on the wire', null]
  ]) {
    const oddList = listOf();
    oddList.unreadableRecordsTotal = value;
    const odd = await censusFrom(`odd-${label.replace(/\W+/g, '-')}`, statusOf(), oddList);
    check(
      odd.reading.unreadableRecordsTotal === null,
      `${label} in unreadableRecordsTotal reads as null`,
      `got ${JSON.stringify(odd.reading.unreadableRecordsTotal)}`
    );
  }
}
});

// =============================================================================
await section('3. THE ROWS ARRIVE, VERBATIM WHERE THEY ARE THE PEER’S WORDS', async () => {
// AC2: a total nobody can act on is half a disclosure. The reason has to be the
// peer's own, because a reason we synthesised would be Butchr guessing why
// CrabCast could not read a row it has never seen.
{
  const { reading } = await censusFrom('rows', statusOf(), listOf());
  const [row] = reading.unreadableRecords;
  const source = FIXTURE.list_agents.unreadableRecords[0];

  check(reading.unreadableRecords.length === 1, 'one detail row arrived');
  check(row?.identity === source.identity, `identity is carried verbatim (${source.identity})`);
  check(row?.problem === source.problem, `problem is carried verbatim (${source.problem})`);
  check(row?.line === source.line, `line is carried (${source.line})`);
  check(
    row?.reason === source.reason,
    'reason is the PEER’S sentence, unedited — Butchr never authors why a row it cannot read is unreadable'
  );
  check(
    row?.source === 'crabcast-registry',
    'the row names the leg that could not read it, so a reader is never left deciding who skipped it'
  );

  // Deliberate omission, asserted so it stays deliberate. `raw` is the registry
  // line verbatim and CrabCast flags `promptRedacted` beside it because a row
  // can hold an agent's prompt. Butchr's list_agents_response is read by every
  // agent on the machine; the disclosure does not need the row's text to be
  // actionable, and carrying it would move content across a boundary for no
  // gain. It stays one `crabcast daemon-status` away.
  check(
    row !== undefined && !('raw' in row),
    'the row’s verbatim registry text is NOT carried onto Butchr’s surface',
    `got keys: ${Object.keys(row ?? {}).join(', ')}`
  );
}
});

// =============================================================================
await section('4. THE TOTAL IS NOT THE ARRAY LENGTH', async () => {
// This ticket's own defect, reproduced inside the field written to disclose it.
// CrabCast caps detail lists in this same frame (`pages.*.limit` is 25), so a
// total derived from `unreadableRecords.length` would read a capped list as
// "that is all of them" — a count silently excluding what it did not carry.
{
  const cappedList = listOf();
  cappedList.unreadableRecordsTotal = 40;
  // 25 rows disclosed out of 40, which is what their own paging limit produces.
  cappedList.unreadableRecords = Array.from({ length: 25 }, (_, i) => ({
    ...FIXTURE.list_agents.unreadableRecords[0],
    line: i + 1
  }));

  const { reading } = await censusFrom('capped', statusOf(), cappedList);
  check(
    reading.unreadableRecordsTotal === 40,
    'the peer’s total (40) survives a detail list capped at 25',
    `got ${JSON.stringify(reading.unreadableRecordsTotal)}`
  );
  check(
    reading.unreadableRecords.length === 25,
    'the detail rows are evidence about the rows they name, never a count of the rows there are'
  );
  check(
    reading.unreadableRecordsTotal !== reading.unreadableRecords.length,
    'total and length are read separately — deriving one from the other is the defect one field over'
  );
}
});

// =============================================================================
await section('5. REPORT, NOT REFUSE — a mismatch is logged and the census is still served', async () => {
// AC4, and the one the ticket says will be checked hardest. A later author will
// find report-don't-refuse loose and want to tighten it into a gate. This is
// what has to fail when they do.
//
// KAN-59's reasoning is the part to keep: refusing on a version number would be
// a gate whose predicate is a LABEL rather than the thing the label describes.
// The peer publishing v5 does not tell you anything is wrong; reading the
// fields does.
{
  const aheadStatus = statusOf();
  aheadStatus.contractVersion = CRABCAST_CONTRACT_VERSION + 1;
  aheadStatus.build = { ...aheadStatus.build, commit: 'f'.repeat(40) };

  const { reading, runtime, logLines } = await censusFrom('ahead', aheadStatus, listOf());
  const described = runtime.describe();

  check(
    described.link.peerContractVersion === CRABCAST_CONTRACT_VERSION + 1 &&
      described.link.pinnedContractVersion === CRABCAST_CONTRACT_VERSION,
    'the version mismatch is REPORTED on describe() — both numbers, neither hidden',
    JSON.stringify({
      peer: described.link.peerContractVersion,
      pinned: described.link.pinnedContractVersion
    })
  );
  check(
    described.link.peerMatchesPin === false,
    'peerMatchesPin: false is reported rather than acted on'
  );
  check(
    logLines.some((l) => /Reporting, not refusing/.test(l)),
    'the adapter says out loud that it is reporting rather than refusing',
    `log was: ${JSON.stringify(logLines)}`
  );

  // The assertion that stops the tightening. Everything above could stay true
  // of a daemon that logged the mismatch and then served nothing.
  check(
    reading.reachable === true,
    'the census is STILL SERVED across a version AND a build mismatch — not gated on either',
    `reachable=${reading.reachable}. If this went false, somebody turned a report into a refusal.`
  );
  check(
    reading.unreadableRecordsTotal === 1,
    'and the disclosure is still read across the mismatch — a newer peer is not a reason to stop reading it'
  );
  check(
    described.censusUnreadableRecordsTotal === 1 && described.censusReachable === true,
    'describe() carries the disclosure beside censusReachable — a census that was TAKEN and is SHORT',
    JSON.stringify({
      reachable: described.censusReachable,
      total: described.censusUnreadableRecordsTotal
    })
  );
}
});

// =============================================================================
await section('6. THE SURFACE A CALLER READS — list_agents_response carries it', async () => {
// AC2. A log line is not a surface: the caller deciding what the fleet IS is
// reading this response, and the disclosure has to be in it, beside the count
// it qualifies. Same rule the daemon already applies to `missingAgents` — always
// present, empty rather than absent.
{
  const { MessageRouter } = await import(path.join(distDir, 'router.js'));
  const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
  const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));

  /** A runtime whose census disclosure is whatever the case under test says. */
  function bridgeWith(reading) {
    const bridge = {
      listHerdrAgentsChecked: () => reading,
      listHerdrAgents: () => reading.agents,
      listHerdrStatuses: () =>
        new Map(reading.agents.map((a) => [a.name, a.herdrStatus])),
      listActiveSessions: () => [],
      getSessionByAddress: () => undefined,
      // KAN-473 added this to the AgentRuntime seam, and it is DERIVED from the
      // stub's own `getSessionByAddress` rather than written twice, so a stub
      // cannot disagree with itself about what an address resolves to. The real
      // runtimes answer `ambiguous` here; no stub here holds two sessions on one
      // key, so none of them can reach that outcome — see
      // `verify-ambiguous-key-refusal.mjs` for the case that does.
      resolveSessionByAddress(key, type) {
        const session = this.getSessionByAddress(key, type);
        return session ? { outcome: 'one', session } : { outcome: 'none' };
      },
      abandonSession: () => {},
      terminateSession: () => ({ success: true })
    };
    return bridge;
  }

  function listAgentsVia(reading) {
    let last = null;
    const router = new MessageRouter(
      new WorkspaceRegistry(),
      new PromptLoader(repoRoot),
      bridgeWith(reading),
      (msg) => {
        last = msg;
      },
      () => {},
      {}
    );
    router.handle({ action: 'list_agents' });
    return last;
  }

  const shortResponse = listAgentsVia({
    reachable: true,
    agents: [],
    unreadableRecordsTotal: 1,
    unreadableRecords: [
      {
        source: 'crabcast-registry',
        line: 1,
        problem: 'pre-migration',
        identity: 'crabcast-shell-demo',
        reason: 'the peer’s own sentence'
      }
    ]
  });

  check(
    shortResponse?.action === 'list_agents_response' && shortResponse.success === true,
    'a real list_agents_response was produced'
  );
  check(
    shortResponse?.censusUnreadableRecordsTotal === 1,
    'censusUnreadableRecordsTotal: 1 is ON the response a caller reads',
    `got ${JSON.stringify(shortResponse?.censusUnreadableRecordsTotal)}`
  );
  check(
    shortResponse?.censusUnreadableRecords?.[0]?.identity === 'crabcast-shell-demo',
    'the detail row reaches the caller too, so the disclosure is actionable rather than only alarming'
  );
  check(
    Array.isArray(shortResponse?.agents) && shortResponse.agents.length === 0,
    'and it sits beside an EMPTY agents list — which is the whole point: that pairing was unreadable before'
  );

  // Always present, never absent. A caller cannot distinguish "nothing was
  // skipped" from "this daemon does not track that" from a missing field.
  const wholeResponse = listAgentsVia({
    reachable: true,
    agents: [],
    unreadableRecordsTotal: 0,
    unreadableRecords: []
  });
  check(
    'censusUnreadableRecordsTotal' in (wholeResponse ?? {}) &&
      wholeResponse.censusUnreadableRecordsTotal === 0,
    'a clean census still carries the field, as 0 — the zero is the trustworthy part, not the absence'
  );

  const undisclosedResponse = listAgentsVia({
    reachable: true,
    agents: [],
    unreadableRecordsTotal: null,
    unreadableRecords: []
  });
  check(
    'censusUnreadableRecordsTotal' in (undisclosedResponse ?? {}) &&
      undisclosedResponse.censusUnreadableRecordsTotal === null,
    'and an undisclosed census carries null — three states on the wire, none collapsed into another'
  );
}
});

// =============================================================================
await section('7. THE SAME DEFECT ONE LAYER UP — HerdrBridge’s own row filter discloses', async () => {
// Not scope creep: making the disclosure REQUIRED on the census type means every
// runtime has to answer it, and HerdrBridge's answer would have been a bare
// `null` while it was silently dropping rows in a `.filter` of its own. It can
// count them, so `null` there would have been a worse answer than the truth.
//
// This is also the only section that describes the mode the daemon is ACTUALLY
// running today. Everything above is about the runtime behind the flip.
{
  const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));

  // A `herdr` on PATH that answers a census with one unusable row in it.
  const binDir = path.join(TMP, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeHerdr = path.join(binDir, 'herdr');
  fs.writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node
console.log(JSON.stringify({ result: { agents: [
  { name: 'butchr-task-kan-324', agent: 'claude', cwd: '/tmp/kan-324', agent_status: 'working' },
  { agent: 'claude', cwd: '/tmp/nameless', agent_status: 'working' }
] } }));
`
  );
  fs.chmodSync(fakeHerdr, 0o755);

  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${priorPath}`;
  try {
    const reading = new HerdrBridge().listHerdrAgentsChecked();
    check(reading.reachable === true, 'herdr answered, so the reading is evidence');
    check(
      reading.agents.length === 1,
      'the unusable row is still kept out of `agents` — a row with no name cannot be addressed or supervised',
      `got ${reading.agents.length}`
    );
    check(
      reading.unreadableRecordsTotal === 1,
      'but it is now DISCLOSED rather than silently dropped',
      `got ${JSON.stringify(reading.unreadableRecordsTotal)}`
    );
    check(
      reading.unreadableRecords[0]?.source === 'herdr-census',
      'and it names herdr as the leg it was dropped at, not CrabCast'
    );
  } finally {
    process.env.PATH = priorPath;
  }

  // The census that did not happen discloses null, never 0. A herdr that failed
  // skipped nothing AND read nothing, and 0 would be a claim about a read that
  // never occurred.
  process.env.PATH = path.join(TMP, 'empty-bin');
  try {
    const dead = new HerdrBridge().listHerdrAgentsChecked();
    check(
      dead.reachable === false && dead.unreadableRecordsTotal === null,
      'an unreachable herdr discloses null, not 0 — nothing may be concluded from a census that did not happen',
      JSON.stringify({ reachable: dead.reachable, total: dead.unreadableRecordsTotal })
    );
  } finally {
    process.env.PATH = priorPath;
  }
}
});

// =============================================================================
await section('8. LIVE — the fields actually arrive from a real CrabCast', async () => {
// The section sections 1-7 cannot be. Everything above replays a capture; this
// asks a peer that is running now. It is the only thing here that can notice
// CrabCast renaming, moving or withdrawing the field.
{
  const socketPath =
    process.env.BUTCHR_CRABCAST_SOCKET ||
    path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');

  if (!fs.existsSync(socketPath)) {
    skip(
      'no live CrabCast at ' + socketPath,
      'This section is the ONLY cover for "does the field arrive". Skipped is not passed: ' +
        'sections 1-7 remain green against a capture, and nothing here has checked a current peer.'
    );
  } else {
    const logLines = [];
    const link = new CrabCastLink({ socketPath, log: (m) => logLines.push(m) });
    const runtime = new CrabCastRuntime({ link, censusIntervalMs: 250, log: (m) => logLines.push(m) });
    cleanups.push(() => runtime.dispose());

    const deadline = Date.now() + 15_000;
    let reading = runtime.listHerdrAgentsChecked();
    while (Date.now() < deadline && !reading.reachable) {
      await new Promise((r) => setTimeout(r, 250));
      reading = runtime.listHerdrAgentsChecked();
    }

    const peerVersion = link.describe().peerContractVersion;
    check(reading.reachable, 'the live census was taken', `link: ${JSON.stringify(link.describe())}`);

    if (peerVersion !== null && peerVersion >= 4) {
      check(
        typeof reading.unreadableRecordsTotal === 'number',
        `a live v${peerVersion} peer sends unreadableRecordsTotal, and we read it as a number`,
        `got ${JSON.stringify(reading.unreadableRecordsTotal)} — if this is null against a v4+ ` +
          `peer, the field has moved or been renamed on their side`
      );
      console.log(
        `       live: agents=${reading.agents.length} ` +
          `unreadableRecordsTotal=${JSON.stringify(reading.unreadableRecordsTotal)} ` +
          `peerContractVersion=${peerVersion} pinned=${CRABCAST_CONTRACT_VERSION}`
      );
      if (reading.unreadableRecordsTotal > 0) {
        console.log(
          `       and this peer is SHORT by ${reading.unreadableRecordsTotal} row(s): ` +
            reading.unreadableRecords.map((r) => `${r.identity ?? '(unnamed)'} [${r.problem}]`).join(', ')
        );
      }
    } else {
      skip(
        `live peer publishes contract v${JSON.stringify(peerVersion)}, below 4`,
        'It cannot be expected to send the field. That the adapter reads null rather than 0 ' +
          'against such a peer is section 2, which does not need a live one.'
      );
    }

    check(
      link.describe().peerMatchesPin === false || link.describe().peerMatchesPin === true,
      'the live pin comparison is reported either way rather than throwing',
      JSON.stringify(link.describe())
    );
  }
}
});

// =============================================================================
for (const done of cleanups) {
  try {
    done();
  } catch {
    /* teardown is best-effort; a failed close is not a verdict */
  }
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log(`pin ${CRABCAST_PIN.slice(0, 12)} · contract v${CRABCAST_CONTRACT_VERSION}`);

// KAN-373: `process.exit(failures ? 1 : 0)` stood here, and it read a skipped
// section 8 as a pass — the line printed above it even said "All assertions
// passed (1 skipped)". `reportAndExit` is the whole of the change: a run that
// skipped and did not fail now exits 2, and a caller who wants sections 1-7
// alone has to say `--allow-skipped` rather than inherit a 0.
reportAndExit({ failures, skipped });
