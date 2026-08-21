// Proof for KAN-579: a `missingAgents` row's premise is about a NAME, so its
// conclusion may not be about the AGENT unless something actually looked.
//
// WHAT FAILURE THIS WOULD CATCH: `butchr_list_agents` printing "It is not
// running." about an agent that is running — the row's premise (`herdr has no
// agent by that name`) being true while its conclusion is false, because the
// agent is alive under a name Butchr did not derive. Observed by `epic/KAN-59`
// on KAN-572: `task/KAN-373` came back under `missingAgents` with that
// sentence while `herdr agent list` showed `crabcast-kan-373-075e5405edda3743`
// working. The remedy that sentence invites is destructive — the tool
// description tells a supervisor to re-activate or stand down, and
// re-activation RESUMES A CONVERSATION — so the cost of the wrong sentence is
// somebody's in-flight work, not a cosmetic blemish.
//
// Four shapes of it, and §2 is the one that keeps the fix honest:
//
//   * the row asserting death over a directory it never looked in (§1);
//   * the fix over-applied — the sentence deleted everywhere, so a REAL loss
//     stops being reported as one and KAN-21's whole detectability half is
//     quietly disarmed (§2);
//   * "the census could not answer" collapsing into "nothing is there", which
//     is the same over-reach one level up: an unreachable census (§3) and a
//     partially-read one (§4) are not evidence of death;
//   * `occupiedBy` arriving as `[]` or omitted rather than `null`, so a caller
//     cannot tell "nothing found there" from "this daemon cannot answer" (§5).
//
// §6 is static and asserts the invariant the TYPE carries: the sentence exists
// at exactly one site in `router.ts`, inside `reasonForMissingAgent`'s `clear`
// arm. That is what makes the other five sections hold for reasons other than
// coincidence — a future author cannot reintroduce the conclusion at the call
// site without deleting a line this section names.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ── WHAT THIS SCRIPT WRITES ITSELF, AND WHAT THAT LEAVES UNCOVERED ──────────
//
// The AgentRegistry rows are SEEDED here, not produced by driving a real
// activation — the same house style as verify-parentage-in-list-agents.mjs, and
// the same limit. So this file does not test that an activation writes a
// workDir a census could ever match; it tests what the router concludes from a
// record that has one. If `AgentRecord.workDir` and the runtime's `cwd` ever
// stop denoting the same directory, every section here stays green and every
// row goes `clear` in production — the KAN-145 shape, where two honest scripts
// leave a hole between them.
//
// The census is NOT self-supplied in that sense: sections 1-5 put a real
// `herdr` stub on PATH and the real HerdrBridge parses its real subprocess
// output, so `workDir` reaches the check through production code rather than
// being handed to it. What is uncovered is the write side of the pair.
//
// WHO COVERS IT: nobody yet. KAN-581 is that gap filed rather than papered
// over — it is open, so this line names a ticket and not a coverage.
//
// Usage: node daemon/scripts/verify-missing-agent-name-vs-agent.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');
const repoRoot = path.resolve(scriptDir, '..', '..');

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan579-'));
const realPath = process.env.PATH;
let seq = 0;

/** The sentence this whole ticket is about. Written once, compared everywhere. */
const CLAIM = 'It is not running.';

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(34)} ${value}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ PASS — ' + yes : '→ FAILED — ' + no}`);
};

// ------------------------------------------------------------- the harness --

/**
 * Put a `herdr` on PATH whose census is exactly `rows`.
 *
 * A stub BINARY rather than a stub bridge: the real HerdrBridge runs it and
 * parses its output, so `name`, `agent` and `cwd` reach the router through the
 * production reader. `rows` are raw census rows, so a name Butchr would never
 * derive is expressible — which is the entire population under test.
 *
 * `missing: true` makes a row that carries neither `name` nor `pane_id`; the
 * reader refuses it and discloses it, which is how §4 gets a non-zero
 * `unreadableRecordsTotal` without hand-writing one.
 */
function stubHerdr(rows) {
  const bin = path.join(TMP, `bin-${++seq}`);
  fs.mkdirSync(bin, { recursive: true });
  const payload = JSON.stringify({
    id: 'cli:agent:list',
    result: {
      type: 'agent_list',
      agents: rows.map((r) =>
        r.unreadable
          ? { agent: 'claude', agent_status: 'working', cwd: r.cwd ?? '/tmp/nowhere' }
          : {
              name: r.name,
              agent: r.runtime === undefined ? 'claude' : r.runtime,
              agent_status: 'working',
              ...(r.cwd === undefined ? {} : { cwd: r.cwd })
            }
      )
    }
  });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`, {
    mode: 0o755
  });
  process.env.PATH = `${bin}:${realPath}`;
}

/** No herdr at all: the census cannot be TAKEN, which is not the same as empty. */
function noHerdr() {
  const bin = path.join(TMP, `empty-${++seq}`);
  fs.mkdirSync(bin, { recursive: true });
  process.env.PATH = bin;
}

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(TMP, 'integrations.json'))
);
registry.registerIntegration(createAtlassianIntegration());
registry.setEnabled('jira', true);
const prompts = new PromptLoader(repoRoot);

/** A registry record as an activation writes one. Seeded — see the header. */
function record(type, key, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  return {
    agentName: `butchr-${type}-${key.toLowerCase()}`,
    type,
    key,
    workDir,
    defaultAgent: 'claude',
    activatedBy: null
  };
}

/** Drive the real `list_agents` handler over a registry seeded with `records`. */
function listAgents(records) {
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++seq}.jsonl`));
  for (const r of records) agentRegistry.recordActivated(r);

  let response;
  const router = new MessageRouter(
    registry,
    prompts,
    new HerdrBridge(),
    (msg) => {
      response = msg;
    },
    () => {},
    { agentRegistry }
  );
  router.handle({ action: 'list_agents' });
  return response;
}

const findMissing = (res, agentName) =>
  (res.missingAgents ?? []).find((r) => r.agentName === agentName);

/** Every reason string the response carries, for the shape section. */
const allMissing = (res) => res.missingAgents ?? [];

// ------------------------------------- 1. the observed case: alive, renamed --

rule('§1  AC1+AC2 — alive under a name Butchr did not derive (the KAN-572 observation)');

{
  const workDir = path.join(TMP, 'workspaces', 'task', 'kan-373');
  const task = record('task', 'KAN-373', workDir);

  // Exactly what `epic/KAN-59` saw: herdr has a working pane in this agent's
  // own directory, under CrabCast's spelling. `addressFromAgentName` cannot
  // parse that name, so `surveyAgents` drops the row and it can never appear
  // in `agents` — the row is absent by construction, not by accident.
  stubHerdr([{ name: 'crabcast-kan-373-075e5405edda3743', cwd: workDir }]);

  const res = listAgents([task]);
  const missing = findMissing(res, task.agentName);

  row('row present under missingAgents', missing ? 'yes' : 'NO — nothing to assert on');
  row('its workDir', missing?.workDir);
  row('census pane in that directory', 'crabcast-kan-373-075e5405edda3743 (agent_status: working)');
  row('appears in res.agents?', res.agents.some((a) => a.workDir === workDir) ? 'yes' : 'no');
  console.log(`\n  reason, in full:\n\n    ${missing?.reason ?? '(no row)'}\n`);
  console.log(`  occupiedBy: ${JSON.stringify(missing?.occupiedBy ?? null)}`);

  const asserts = missing && !missing.reason.includes(CLAIM);
  verdict(
    asserts,
    `the row does not assert "${CLAIM}" about an agent that is running`,
    missing
      ? `the row asserts "${CLAIM}" while a working pane occupies its workDir`
      : 'no missingAgents row was produced at all, so nothing was tested'
  );

  const named =
    Array.isArray(missing?.occupiedBy) &&
    missing.occupiedBy.some((o) => o.agentName === 'crabcast-kan-373-075e5405edda3743');
  verdict(
    named,
    'the row NAMES what is live in its workDir, so a reader can go and look',
    'occupiedBy does not name the pane occupying the directory'
  );
}

// -------------------------------- 2. the discriminating arm — a REAL loss --

rule('§2  the fix is not "delete the sentence": a genuine loss still reports one');

{
  const workDir = path.join(TMP, 'workspaces', 'task', 'kan-374');
  const task = record('task', 'KAN-374', workDir);

  // A whole census that simply does not contain this directory. Nothing was
  // unreadable and every live row names where it is, so the search was capable
  // of finding an occupant and genuinely found none.
  stubHerdr([{ name: 'butchr-task-kan-999', cwd: path.join(TMP, 'workspaces', 'task', 'kan-999') }]);

  const res = listAgents([task]);
  const missing = findMissing(res, task.agentName);

  console.log(`\n  reason, in full:\n\n    ${missing?.reason ?? '(no row)'}\n`);
  console.log(`  occupiedBy: ${JSON.stringify(missing?.occupiedBy ?? null)}`);

  verdict(
    missing && missing.reason.includes(CLAIM),
    `a searched-and-empty directory still yields "${CLAIM}" — KAN-21 detectability intact`,
    'a real loss no longer reports itself as one; the sentence was deleted rather than earned'
  );
  verdict(
    missing && missing.occupiedBy === null,
    'occupiedBy is null when nothing occupies the directory',
    `occupiedBy was ${JSON.stringify(missing?.occupiedBy)} — expected null`
  );
}

// ----------------------------------------- 3. the census could not be taken --

rule('§3  an unreachable census is not an empty one');

{
  const workDir = path.join(TMP, 'workspaces', 'task', 'kan-375');
  const task = record('task', 'KAN-375', workDir);

  noHerdr();

  const res = listAgents([task]);
  const missing = findMissing(res, task.agentName);

  console.log(`\n  reason, in full:\n\n    ${missing?.reason ?? '(no row)'}\n`);

  verdict(
    missing && !missing.reason.includes(CLAIM),
    'no death is asserted off a census that could not be taken',
    `the row concluded "${CLAIM}" having searched nothing at all`
  );
  verdict(
    missing && /could not be taken/.test(missing.reason),
    'the reason names WHY the question went unanswered',
    'the reason does not say what stopped the check'
  );
}

// ---------------------------------------------- 4. the census was only part --

rule('§4  a partially-read census is not a whole one');

{
  const workDir = path.join(TMP, 'workspaces', 'task', 'kan-376');
  const task = record('task', 'KAN-376', workDir);

  // One readable row elsewhere, one row the reader refuses because it carries
  // neither `name` nor `pane_id`. The refused row could be this agent.
  stubHerdr([
    { name: 'butchr-task-kan-998', cwd: path.join(TMP, 'workspaces', 'task', 'kan-998') },
    { unreadable: true }
  ]);

  const res = listAgents([task]);
  const missing = findMissing(res, task.agentName);

  row('censusUnreadableRecordsTotal', res.censusUnreadableRecordsTotal);
  console.log(`\n  reason, in full:\n\n    ${missing?.reason ?? '(no row)'}\n`);

  verdict(
    res.censusUnreadableRecordsTotal > 0,
    'the fixture really did produce an unreadable row (the check can be exercised)',
    'no row was refused, so this section proves nothing about partial censuses'
  );
  verdict(
    missing && !missing.reason.includes(CLAIM),
    'no death is asserted while part of the fleet went unread',
    `the row concluded "${CLAIM}" over a census short by ${res.censusUnreadableRecordsTotal} rows`
  );
}

// ------------------------------------------------------------- 5. the shape --

rule('§5  occupiedBy is present on every row, and is never an empty array');

{
  const a = record('task', 'KAN-377', path.join(TMP, 'workspaces', 'task', 'kan-377'));
  const b = record('task', 'KAN-378', path.join(TMP, 'workspaces', 'task', 'kan-378'));
  stubHerdr([{ name: 'crabcast-kan-377-deadbeefdeadbeef', cwd: a.workDir }]);

  const res = listAgents([a, b]);
  const rows = allMissing(res);

  for (const r of rows) {
    row(
      r.agentName,
      `occupiedBy=${JSON.stringify(r.occupiedBy)}  ${'occupiedBy' in r ? '' : '(KEY ABSENT)'}`
    );
  }

  verdict(
    rows.length === 2,
    'both seeded agents are reported missing, so both shapes are under test',
    `expected 2 missing rows, got ${rows.length}`
  );
  verdict(
    rows.every((r) => 'occupiedBy' in r),
    'the key is present on every row, so an older daemon stays distinguishable',
    'at least one row omitted occupiedBy'
  );
  const badShape = rows.filter(
    (r) => !(r.occupiedBy === null || (Array.isArray(r.occupiedBy) && r.occupiedBy.length > 0))
  );
  verdict(
    badShape.length === 0,
    'null or a non-empty array — never [], so there is one spelling of "nothing found"',
    `${badShape.length} row(s) carried neither null nor a non-empty array: ` +
      badShape.map((r) => `${r.agentName}=${JSON.stringify(r.occupiedBy)}`).join(', ')
  );
}

// ----------------------------- 6. the invariant the type carries (static) --

rule('§6  the conclusion is writable at exactly one site (source as text)');

{
  // Static: reads `src` rather than importing `dist`, so this section's verdict
  // is about the code as written and survives a failed build. Anything above
  // this line is a `dist` import and does not.
  const src = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'router.ts'), 'utf8');

  // ⚠ COMMENTS ARE STRIPPED FIRST, and the first draft of this section did not
  // strip them — it counted 3 and called that a violation, when 2 of the 3 were
  // doc comments *quoting* the sentence in order to forbid it. A prose mention
  // cannot reach the wire; only a string literal can. Counting the raw file
  // measures how often the sentence is DISCUSSED, which is a different question
  // and one whose honest answer trends upward as the reasoning is written down.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  const inProse = src.split(CLAIM).length - 1;
  const occurrences = code.split(CLAIM).length - 1;
  const composer = /function reasonForMissingAgent\(/.test(code);

  row(`"${CLAIM}" in router.ts, all text`, `${inProse} (prose included — not the check)`);
  row('…in code, comments stripped', occurrences);
  row('reasonForMissingAgent exists', composer ? 'yes' : 'no');

  verdict(
    occurrences === 1,
    'one site, so no call site can attach the conclusion to a premise lacking it',
    `the sentence appears in ${occurrences} string literals; a second site can drift from the first`
  );
  verdict(
    composer,
    'the single composer is the one function that owns the reason',
    'reasonForMissingAgent is gone — the conclusion is being written by hand again'
  );
}

// --------------------------------------------------------------- the verdict --

process.env.PATH = realPath;
fs.rmSync(TMP, { recursive: true, force: true });

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures ? 1 : 0);
