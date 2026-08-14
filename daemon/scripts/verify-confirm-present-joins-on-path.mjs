// KAN-397, the CI half: `confirmAgentPresent` finds an agent CrabCast started,
// against a staged peer serving a REAL captured census of exactly that
// population.
//
// WHAT FAILURE THIS WOULD CATCH: `CrabCastRuntime.confirmAgentPresent` joining
// the census on the raw `paneName` instead of on the name derived from the row's
// path. An agent CrabCast started carries THEIR pane name —
// `crabcast-<key>-<hash>` — so that join cannot succeed for the population this
// runtime creates, and `router.ts`'s `confirmActivation` answers `absent` by
// calling `abandonSession` and reporting the activation `success: false`. The
// defect is a working agent torn down by the thing that checks whether it
// started.
//
// CI-RUNNABLE: yes — it stands up its own Unix socket and answers its own
// frames from a committed capture. No live peer, no herdr, no PTY, no
// credential, no network.
//
// ── WHY THIS EXISTS BESIDE THE LIVE SCRIPT, AND WHAT EACH IS WORTH ─────────
//
// `verify-crabcast-confirm-present-name-join.mjs` drives a real CrabCast, spawns
// a real `claude` agent and asserts the same thing. It is class `no`: it cannot
// run in CI, so it is a one-time demonstration at review time and **nothing
// re-evaluates it after merge**. That is the KAN-295 condition, named in
// `ci-partition.md`, and it is the whole reason this file exists: this one runs
// on every pull request, forever, and it is what would catch the join being
// reverted in a year by somebody who never read the ticket.
//
// **What it is NOT worth, stated plainly: this script SUPPLIES ITS OWN INPUT.**
// It serves frames from a committed capture, so it is structurally incapable of
// noticing that CrabCast has changed what it puts on the wire. If their pane
// naming changed tomorrow, every assertion here would stay green while the
// daemon broke. **The live script is what covers that**, and neither script
// covers it alone — the hole is between them, and this paragraph is the edge of
// mine.
//
// ── THE FIXTURE IS A REAL CAPTURE, WHICH IS THE POINT ──────────────────────
//
// `fixtures/crabcast-owned-running-census.json` is a raw `list_agents` frame off
// a LIVE CrabCast at build `6f47df7d05eb`, captured for KAN-346 while two agents
// CrabCast itself had started were running. So the `crabcast-<key>-<hash>` pane
// names asserted against here are **measured, not invented** — which matters,
// because a proof of this defect written against a hand-typed pane name would be
// asserting that our own guess about their naming is self-consistent.
//
// Two rewrites are made to it and both are declared where they happen: the
// captured workspaces root is rebased onto this machine's (§0), and §3 sets
// `agentRuntime` on one row to exercise the strict `requireRuntime` arm, because
// the captured agents were `shell` spawns and carry `null` there. Nothing else
// is touched.
//
// ── HOW IT WAS MADE TO GO RED ──────────────────────────────────────────────
//
//   Revert the join in `daemon/src/crabcast-runtime.ts`:
//
//     -  const match = all.find((r) => butchrNameForCensusRow(r) === agentName);
//     +  const match = all.find((r) => r.paneName === agentName);
//
//   then `cd daemon && npm run build` (confirm it exited 0, unpiped) and re-run.
//   §2 and §3 go red — `absent`, with the error naming a pane that is not in the
//   census — while §1 and §4 stay green: the census still reports the agent, and
//   `describeAgent` still resolves it, because it joins on the path first. The
//   transcript of that run is on the pull request.
//
// Usage: node daemon/scripts/verify-confirm-present-joins-on-path.mjs [--verbose]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const verbose = process.argv.includes('--verbose');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(scriptDir, '..', 'dist');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 10).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

function note(label, value) {
  console.log(`   ....  ${label}: ${value}`);
}

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error('setup: daemon/dist is missing. Run `cd daemon && npm run build` first.');
  process.exit(1);
}

const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));
const { agentNameFor, workspacesRoot } = await import(path.join(distDir, 'herdr.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan397-'));
const cleanups = [];

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-owned-running-census.json'), 'utf8')
);

/**
 * Rewrite the captured workspaces root onto this machine's.
 *
 * `addressForPath` is `path.relative(workspacesRoot(), dir)` and answers null
 * for anything outside that tree, so on a machine whose home differs from the
 * capture's every row would be foreign and every assertion below would be
 * asserting nothing. This is a rewrite of the ADDRESS the capture was taken at,
 * never of the shape it recorded.
 */
function localise(value) {
  return JSON.parse(JSON.stringify(value).split(FIXTURE.capturedWorkspacesRoot).join(workspacesRoot()));
}

/** A CrabCast that answers exactly the frames it is handed. */
async function fakeCrabCast(name, listFrame) {
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
            ? FIXTURE.daemon_status
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

/** Stand up a runtime against a fake peer and wait for one census to land. */
async function runtimeOver(name, listFrame) {
  const socketPath = await fakeCrabCast(name, listFrame);
  const link = new CrabCastLink({ socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 25, log: () => {} });
  cleanups.push(() => runtime.dispose());
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !runtime.listHerdrAgentsChecked().reachable) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return runtime;
}

// ── 0. the fixture, and what makes it the right one ────────────────────────
rule('0. the capture — real rows, for the population this defect is about');

const CENSUS = localise(FIXTURE.list_agents);
const owned = CENSUS.agents;

check('the capture holds agents CrabCast itself started', owned.length >= 1, `agents: ${owned.length}`);
note('workspaces root', workspacesRoot());

// The row this whole file is about. `workDir` is ABSENT on an owned row and
// `path` carries the address — the asymmetry the fixture's own note warns about,
// and the reason the derivation reads `workDir ?? path` rather than either one.
const row = owned[0];
const address = path.relative(workspacesRoot(), row.workDir ?? row.path).split(path.sep);
const butchrName = agentNameFor(address[0], address[1]);

note('row.paneName', JSON.stringify(row.paneName));
note('row.workDir ', JSON.stringify(row.workDir));
note('row.path    ', JSON.stringify(row.path));
note('butchr name ', JSON.stringify(butchrName));

check(
  'its pane carries CrabCast\'s name and NOT the Butchr one — the premise everything below needs',
  row.paneName !== butchrName && /^crabcast-/.test(row.paneName),
  `paneName=${JSON.stringify(row.paneName)} butchrName=${JSON.stringify(butchrName)}`
);
check(
  'and an owned row carries `path` with no `workDir`, so the derivation must fall back',
  typeof row.path === 'string' && row.path.length > 0 && !row.workDir,
  JSON.stringify({ path: row.path, workDir: row.workDir })
);

// ── 1. the baseline KAN-346 already established ────────────────────────────
rule('1. the census lists it under the Butchr name (KAN-346 — the baseline)');

const runtime = await runtimeOver('owned', CENSUS);
const listed = runtime.listHerdrAgents().find((a) => a.name === butchrName);
check('`listHerdrAgents` names the row from its path', !!listed, JSON.stringify(runtime.listHerdrAgents()));

// ── 2. THE DEFECT — lenient arm ────────────────────────────────────────────
rule('2. confirmAgentPresent finds it under that same name — lenient arm');

// A short timeout deliberately: the census is already in hand, so a correct
// lookup answers on the first poll. A long one would only make a red slow.
const lenient = await runtime.confirmAgentPresent(butchrName, false, 3_000);
check(
  'requireRuntime=false — present',
  lenient.present === true,
  `${JSON.stringify(lenient)}\nA raw \`paneName\` join answers 'absent' here, naming a pane that IS in ` +
    `the census under a different name.`
);
note('lenient', JSON.stringify(lenient));

// ── 3. THE DEFECT — strict arm, which is what production uses ──────────────
rule('3. and on the strict arm, which is the reading a real spawn gets');

// THE ONE FABRICATED FIELD IN THIS SCRIPT, DECLARED. The captured agents were
// `shell` spawns, so `agentRuntime` is null on both and the strict arm would
// refuse them for a reason that has nothing to do with the name. `router.ts`
// passes `session.expectsRuntime ?? true`, and that is true for every launcher
// but `shell` — so the strict arm is the one production takes and it must be
// exercised. Only this field is changed; the pane name, the path and the shape
// are the capture's own.
const withRuntime = localise(structuredClone(FIXTURE.list_agents));
withRuntime.agents[0].agentRuntime = 'claude';

const strictRuntime = await runtimeOver('owned-claude', withRuntime);
const strict = await strictRuntime.confirmAgentPresent(butchrName, true, 3_000);
check('requireRuntime=true — present', strict.present === true, JSON.stringify(strict));
note('strict', JSON.stringify(strict));

check(
  'the two arms agree, which is what identifies a failure here as the LOOKUP rather than the flag',
  strict.present === lenient.present,
  `strict.present=${strict.present} lenient.present=${lenient.present}`
);

// ── 4. the join that is deliberately NOT changed (KAN-397 AC3) ─────────────
rule('4. describeAgent still resolves it — the `paneName` fallback stays, and why');

// `describeAgent` looks the row up by PATH first and only falls back to
// `paneName` for `census.foreign`, where herdr's naming makes `paneName` the
// Butchr name. That is why it was already correct while `confirmAgentPresent`
// was not, and this section is what would notice if somebody "fixed" it into
// uniformity and broke the foreign case.
const described = runtime.describeAgent(address[1], address[0]);
check(
  'an agent CrabCast started resolves by path, not by pane name',
  described.agentName === butchrName && (described.workDir ?? '') === (row.workDir ?? row.path),
  JSON.stringify(described)
);

const foreign = CENSUS.foreignPanes.find((r) => /^butchr-/.test(r.paneName));
if (foreign) {
  const frel = path.relative(workspacesRoot(), foreign.workDir ?? foreign.path).split(path.sep);
  const fdesc = runtime.describeAgent(frel[1], frel[0]);
  check(
    'and a herdr-started foreign pane still resolves too — the case the fallback serves',
    fdesc.agentName === foreign.paneName,
    JSON.stringify({ described: fdesc, paneName: foreign.paneName })
  );
  note('foreign paneName equals its butchr name', String(foreign.paneName === fdesc.agentName));
}

// ── cleanup ────────────────────────────────────────────────────────────────
for (const fn of cleanups.reverse()) {
  try {
    fn();
  } catch {
    /* a socket already closed is not a finding */
  }
}
fs.rmSync(TMP, { recursive: true, force: true });

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (failures) {
  console.log(`   ${failures} check(s) failed.`);
  console.log('   If §0 is among them the capture no longer holds the population this tests,');
  console.log('   and the rest of the run means nothing — fix that before reading §2 or §3.');
} else {
  console.log(
    '   OK — an agent CrabCast started, carrying a crabcast-<key>-<hash> pane name off a real\n' +
      '   captured census, is found by confirmAgentPresent under the Butchr name every caller\n' +
      '   addresses it by, on both requireRuntime arms.'
  );
}
console.log('');
process.exit(failures ? 1 : 0);
