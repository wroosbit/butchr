// Live proof for KAN-423: `butchr_list_agents` answers inside a declared
// budget, and a reduced answer is distinguishable from a whole one.
//
// WHAT FAILURE THIS WOULD CATCH: a fleet census serialised whole into a client
// that cuts it to fit, so that a short list and a clipped list are the same
// bytes. Measured on this machine on 2026-08-15 against a real seven-agent
// fleet: the response was 44,557 characters, the calling client delivered
// 10,000 of them, and the bytes it dropped were the middle of the `agents`
// array. Four rows arrived whole, the fifth stopped inside a string, rows six
// and seven never arrived, and NOTHING IN WHAT ARRIVED SAID HOW MANY THERE
// WERE. A reader that counted got 5 for a fleet of 7 — a well-formed answer,
// and wrong in the comfortable direction: nothing else is running, nobody holds
// that file, that key is free. Three agents hit this in one day (`task/KAN-417`
// twice, `epic/KAN-203` once mid-census) and in every case the fix was an agent
// noticing and reaching for a different tool. None of them was saved by the
// tool telling them.
//
// CI-RUNNABLE: yes — reads a captured census fixture and imports the built
// budget module in process; no live daemon, no herdr, no credential, no peer,
// no terminal, no network.
//
// THE RED IS SECTION 1, AND IT IS THE POINT OF THE SCRIPT
//
// Section 1 does not describe the old behaviour, it performs it: the fixture is
// serialised the way `mcp.ts` used to serialise it, put through a simulated
// client cap that keeps the head and the tail and elides the middle — the
// documented behaviour of the client that was measured — and then read by the
// only instruments a receiving agent has. It asserts the defect is REAL: the
// delivered bytes do not parse, the agents a counter can see are fewer than the
// agents that exist, and no field anywhere in the delivered bytes states the
// true count. If any of those three stops holding, section 1 fails loudly
// rather than quietly proving nothing.
//
// Sections 2-5 then assert the new behaviour on the same fixture, at the same
// cap. Section 3 is the criterion the ticket says is the one that matters, and
// is stated as a difference rather than as a value: a complete answer and a
// clipped answer must not be readable as each other.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: the built `fitListAgentsResponse` and `fitGenericResponse`, and a
// **real captured `list_agents_response`** — `fixtures/kan-423-over-cap-census.json`
// was taken off the running daemon's socket on 2026-08-15 at 46,154 characters
// and 8 agents, and is the reproduction rather than an illustration of it.
//
// **Stubbed: the client's cap, and the MCP round trip.** The elision in section
// 1 is this script's model of what the client did, not the client doing it —
// nobody can make somebody else's truncator run in CI. And nothing in this file
// exercises `mcp.ts`: it tests the fitter, not that the fitter is what the tool
// calls. THAT IS THE KAN-145 HOLE AND IT IS NOT MINE TO CLOSE. Section 5 narrows
// it with a static read of `mcp.ts`, which proves the call site says the right
// thing and not that a real call reaches it.
//
// WHO COVERS THE REST: `probe-list-agents-live-bound.mjs`, beside this file. It
// spawns the built MCP server as a real subprocess, speaks the real protocol to
// it, and has it answer `butchr_list_agents` off the real running daemon — so
// the input ARRIVES rather than being supplied. It needs a live daemon and is
// therefore not CI-runnable, which is exactly why this split exists and exactly
// why neither script alone should be cited as covering both.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

requireFreshDist(path.join(daemonDir, 'src'), path.join(daemonDir, 'dist'), {
  hint: 'npm run build --prefix daemon'
});

const {
  fitListAgentsResponse,
  fitGenericResponse,
  MEASURED_CLIENT_CAP_CHARS,
  DEFAULT_BUDGET_CHARS,
  SECTION_CLIP_ORDER,
  NEVER_CLIPPED
} = await import('../dist/mcp-response-budget.js');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if ((!ok || verbose) && detail) {
    console.log(`         ${String(detail).split('\n').slice(0, 12).join('\n         ')}`);
  }
}

const fixturePath = path.join(scriptDir, 'fixtures', 'kan-423-over-cap-census.json');
const census = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const trueAgentCount = census.agents.length;

/**
 * What the client did to the bytes, modelled.
 *
 * Head and tail kept, middle elided, with the marker the measured client
 * writes. The model is generous to the old behaviour on purpose: a client that
 * cuts the tail off instead, and writes no marker at all — which is what
 * `task/KAN-417` and `epic/KAN-203` both described seeing — loses strictly
 * more, so a defect that shows up under this model shows up under theirs.
 */
function clientTruncate(text, cap) {
  if (text.length <= cap) return text;
  const marker = (n) => `\n\n... [${n} characters truncated] ...\n\n`;
  // Solve for the elided count with the marker's own length in the budget.
  let elided = text.length - cap;
  for (let i = 0; i < 4; i += 1) {
    elided = text.length - cap + marker(elided).length;
  }
  const keep = text.length - elided;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return text.slice(0, head) + marker(elided) + text.slice(text.length - tail);
}

// ───────────────────────────────────────────────────────────────────────────
rule('1. THE RED — the old serialisation, through the cap that was measured');

const oldWay = JSON.stringify(census, null, 2);
const delivered = clientTruncate(oldWay, MEASURED_CLIENT_CAP_CHARS);

console.log(`   fixture:            ${path.relative(daemonDir, fixturePath)}`);
console.log(`   agents in fixture:  ${trueAgentCount}`);
console.log(`   JSON.stringify(res, null, 2):  ${oldWay.length} chars`);
console.log(`   client cap (measured):         ${MEASURED_CLIENT_CAP_CHARS} chars`);
console.log(`   what the model would receive:  ${delivered.length} chars\n`);

check(
  'the old answer exceeds the cap at all (if it did not, this fixture proves nothing)',
  oldWay.length > MEASURED_CLIENT_CAP_CHARS,
  `${oldWay.length} <= ${MEASURED_CLIENT_CAP_CHARS}: recapture the fixture against a fleet large enough to trigger it`
);

let parsedDelivered = null;
try {
  parsedDelivered = JSON.parse(delivered);
} catch {
  parsedDelivered = null;
}
check(
  'the delivered bytes are NOT parseable JSON — a programmatic reader gets an exception',
  parsedDelivered === null,
  'the truncated payload parsed, which would mean the elision landed somewhere harmless'
);

// What a reader that counts can actually see. `"agentName":` appears once per
// row, so counting it is the most favourable thing a careful reader could do
// with the bytes it got.
const visibleRows = (delivered.match(/"agentName":/g) ?? []).length;
check(
  `a counter reading the delivered bytes UNDER-COUNTS the fleet (${visibleRows} visible of ${trueAgentCount})`,
  visibleRows < trueAgentCount,
  `saw ${visibleRows}, fleet is ${trueAgentCount} — if these are equal the elision did not reach the array`
);

// THE ASSERTION THAT IS THE WHOLE TICKET. Under-counting would be survivable if
// the answer said what the true count was. It does not, anywhere.
const statesTheCount = /"agentsTotal"\s*:\s*\d+/.test(delivered);
check(
  'nothing in the delivered bytes states the true fleet size — the under-count is unrecoverable',
  statesTheCount === false,
  'the old payload carried a total after all, which would make this defect self-correcting'
);

console.log('\n   ^ THAT IS THE DEFECT, PERFORMED RATHER THAN DESCRIBED.');
console.log('     Every line above is a PASS about a BROKEN behaviour: the assertions');
console.log('     are that the old answer really does lose agents silently.');

// ───────────────────────────────────────────────────────────────────────────
rule('2. THE GREEN — the same census, through the fitter');

const fitted = fitListAgentsResponse(census, {});
console.log(`   fitted length:      ${fitted.text.length} chars`);
console.log(`   budget:             ${fitted.completeness.budgetChars} chars`);
console.log(`   verdict:            ${fitted.completeness.kind}`);

check(
  'the fitted answer is inside the budget',
  fitted.text.length <= fitted.completeness.budgetChars,
  `${fitted.text.length} > ${fitted.completeness.budgetChars}`
);
check(
  'the fitted answer is inside the measured client cap, so the client cuts nothing',
  fitted.text.length <= MEASURED_CLIENT_CAP_CHARS,
  `${fitted.text.length} > ${MEASURED_CLIENT_CAP_CHARS}`
);

let reparsed = null;
try {
  reparsed = JSON.parse(fitted.text);
} catch (e) {
  reparsed = null;
}
check('the fitted answer parses as JSON', reparsed !== null, 'JSON.parse threw');

check(
  'this census DID need reducing, so the green is about the interesting case',
  fitted.completeness.kind === 'clipped',
  'the fixture fitted whole; recapture it against a larger fleet or this section is vacuous'
);

check(
  '`completeness` is the FIRST key, so it survives a clip nobody expected',
  Object.keys(reparsed ?? {})[0] === 'completeness',
  `first key is ${Object.keys(reparsed ?? {})[0]}`
);

// The field that reports a length is inside the string whose length it
// reports, so writing it changes it. This held by arithmetic luck on the main
// path and was flatly wrong on the section-refusal path — 0 reported for an
// 825-character answer — until `serialiseWithExactChars` made it a fixed point.
// A ticket about a field that misdescribes its own answer should not ship one.
check(
  `\`completeness.chars\` equals the real length (${fitted.completeness.chars} === ${fitted.text.length})`,
  fitted.completeness.chars === fitted.text.length,
  `claims ${fitted.completeness.chars}, is ${fitted.text.length}`
);

check(
  `\`agentsTotal\` states the true fleet size (${reparsed?.agentsTotal} === ${trueAgentCount})`,
  reparsed?.agentsTotal === trueAgentCount,
  `agentsTotal is ${reparsed?.agentsTotal}, fleet is ${trueAgentCount}`
);

check(
  'no agent was dropped at this size — every one is still named',
  Array.isArray(reparsed?.agents) && reparsed.agents.length === trueAgentCount,
  `agents.length is ${reparsed?.agents?.length}, fleet is ${trueAgentCount}`
);

check(
  'every reduction is named, with the call that returns the rest',
  fitted.completeness.kind === 'clipped' &&
    fitted.completeness.clipped.length > 0 &&
    fitted.completeness.clipped.every(
      (c) => typeof c.field === 'string' && typeof c.readTheRest === 'string' && c.readTheRest.length > 0
    ),
  JSON.stringify(fitted.completeness.clipped ?? null)
);

if (fitted.completeness.kind === 'clipped') {
  console.log('\n   what it gave up, in order:');
  for (const c of fitted.completeness.clipped) {
    console.log(
      `     - ${c.field.padEnd(26)} ${c.reduction.padEnd(18)} ${
        c.total === null ? '' : `${c.returned}/${c.total} kept`
      }  -> ${c.readTheRest}`
    );
  }
}

check(
  'a reduced field leaves a stub saying so, rather than vanishing',
  fitted.completeness.kind === 'clipped' &&
    fitted.completeness.clipped
      .filter((c) => c.reduction === 'section-omitted')
      .every((c) => reparsed?.[c.field]?.omitted === 'for-budget'),
  'a section was dropped without leaving `omitted: "for-budget"` behind it'
);

check(
  'nothing on the never-clipped list was clipped',
  fitted.completeness.kind !== 'clipped' ||
    fitted.completeness.clipped.every((c) => !NEVER_CLIPPED.includes(c.field)),
  `NEVER_CLIPPED = ${NEVER_CLIPPED.join(', ')}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('3. THE CRITERION THAT MATTERS — complete and clipped are not the same bytes');

// The ticket: "a short answer and a truncated answer are the same bytes ... if
// a caller cannot tell one from the other, the fix has not landed." And the
// warning that came with it: Jira's `hasNextPage` reads `false` in BOTH cases,
// so a marker must be proved to DIFFER rather than merely to exist.
const small = {
  action: 'list_agents_response',
  success: true,
  agents: [census.agents[0]],
  missingAgents: [],
  preemptedAgents: []
};
const smallFit = fitListAgentsResponse(small, {});
const smallParsed = JSON.parse(smallFit.text);

console.log(`   complete answer verdict: ${smallFit.completeness.kind}`);
console.log(`   clipped  answer verdict: ${fitted.completeness.kind}`);

check(
  'a small census comes back `complete`',
  smallFit.completeness.kind === 'complete',
  smallFit.completeness.kind
);
check(
  'a large census comes back `clipped`',
  fitted.completeness.kind === 'clipped',
  fitted.completeness.kind
);
check(
  'the two verdicts DIFFER in the field a reader checks',
  smallFit.completeness.kind !== fitted.completeness.kind,
  'both answers carry the same verdict — this is the Jira `hasNextPage` defect'
);
check(
  'the complete answer has NO `clipped` key at all — not an empty one, not a false one',
  !('clipped' in smallParsed.completeness),
  `complete verdict carries: ${Object.keys(smallParsed.completeness).join(', ')}`
);
check(
  'the clipped answer has a NON-EMPTY `clipped` array',
  Array.isArray(reparsed?.completeness?.clipped) && reparsed.completeness.clipped.length > 0,
  JSON.stringify(reparsed?.completeness?.clipped ?? null)
);
check(
  'both answers state `agentsTotal`, so the count is checkable either way',
  typeof smallParsed.agentsTotal === 'number' && typeof reparsed?.agentsTotal === 'number',
  `${smallParsed.agentsTotal} / ${reparsed?.agentsTotal}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('4. THE FLEET THAT WILL NOT FIT AT ALL — the count survives anyway');

// A fleet far past the point where even addresses fit. This is the only rung
// that loses an agent outright, so it is the rung that could reintroduce the
// under-count, and the assertions here are that it cannot do so silently.
const huge = {
  action: 'list_agents_response',
  success: true,
  agents: Array.from({ length: 400 }, (_, i) => ({
    ...census.agents[i % census.agents.length],
    key: `KAN-${1000 + i}`,
    agentName: `butchr-task-kan-${1000 + i}`
  })),
  missingAgents: [],
  preemptedAgents: [],
  standbyAgents: census.standbyAgents ?? [],
  standbyTotal: census.standbyTotal ?? 0
};
const hugeFit = fitListAgentsResponse(huge, {});
const hugeParsed = JSON.parse(hugeFit.text);

console.log(`   fleet of 400: fitted to ${hugeFit.text.length} chars, view=${hugeParsed.agentsView}`);
console.log(`   agents returned: ${hugeParsed.agents.length}, agentsTotal: ${hugeParsed.agentsTotal}`);

check(
  'a 400-agent fleet still fits the budget',
  hugeFit.text.length <= hugeFit.completeness.budgetChars,
  `${hugeFit.text.length} > ${hugeFit.completeness.budgetChars}`
);
check(
  '`agentsTotal` is still 400 however few rows came back',
  hugeParsed.agentsTotal === 400,
  `agentsTotal is ${hugeParsed.agentsTotal}`
);
check(
  'the under-count is detectable in one comparison: agents.length < agentsTotal',
  hugeParsed.agents.length < hugeParsed.agentsTotal,
  'nothing was dropped, so this section did not reach the rung it is about'
);
check(
  'the verdict says entries were omitted, and names the offset to resume from',
  hugeFit.completeness.kind === 'clipped' &&
    hugeFit.completeness.clipped.some(
      (c) => c.field === 'agents' && c.reduction === 'entries-omitted' && /offset:\s*\d+/.test(c.readTheRest)
    ),
  JSON.stringify(hugeFit.completeness.clipped ?? null)
);
check(
  'walking from that offset reaches agents the first answer did not carry',
  (() => {
    const rec = hugeFit.completeness.kind === 'clipped'
      ? hugeFit.completeness.clipped.find((c) => c.field === 'agents' && c.reduction === 'entries-omitted')
      : null;
    if (!rec) return false;
    const at = Number(/offset:\s*(\d+)/.exec(rec.readTheRest)?.[1]);
    const next = JSON.parse(fitListAgentsResponse(huge, { offset: at }).text);
    return next.agentsOffset === at && next.agents.length > 0;
  })(),
  'the offset recipe did not return a further window'
);

// `view: 'summary'` buys reach, not immunity. At 400 agents the addresses
// alone are past a 9,000-character budget, so it clips too — and the property
// worth asserting is the one that holds at every size: it carries strictly more
// of the fleet than the full view did, and whatever it drops it discloses.
// (The first draft of this check asserted "all 400, no drop" and went red on
// the real arithmetic. The assertion was wrong, not the fitter; it is recorded
// here rather than quietly weakened.)
const summaryFit = fitListAgentsResponse(huge, { view: 'summary' });
const summary = JSON.parse(summaryFit.text);
check(
  `\`view: "summary"\` reaches further than the full view (${summary.agents.length} vs ${hugeParsed.agents.length} of 400)`,
  summary.agents.length >= hugeParsed.agents.length && summary.agentsTotal === 400,
  `summary carried ${summary.agents.length}, full view carried ${hugeParsed.agents.length}`
);
check(
  'and where even summary drops entries, it says so rather than reading short',
  summary.agents.length === summary.agentsTotal ||
    (summaryFit.completeness.kind === 'clipped' &&
      summaryFit.completeness.clipped.some((c) => c.field === 'agents')),
  `carried ${summary.agents.length}/${summary.agentsTotal} with verdict ${summaryFit.completeness.kind}`
);

// The size at which summary does carry the whole fleet, so that "reaches
// further" is a claim with a number behind it rather than a comparison.
const midFleet = { ...huge, agents: huge.agents.slice(0, 120) };
const midSummary = JSON.parse(fitListAgentsResponse(midFleet, { view: 'summary' }).text);
check(
  '`view: "summary"` carries a 120-agent fleet entire',
  midSummary.agents.length === 120 && midSummary.agentsTotal === 120,
  `carried ${midSummary.agents.length} of ${midSummary.agentsTotal}`
);

const sectionAnswer = JSON.parse(fitListAgentsResponse(census, { section: 'guardian' }).text);
check(
  '`section: "guardian"` returns that field and says which section it is',
  sectionAnswer.section === 'guardian' && sectionAnswer.guardian !== undefined,
  JSON.stringify(Object.keys(sectionAnswer))
);
const refusal = fitListAgentsResponse(census, { section: 'nope' });
const unknownSection = JSON.parse(refusal.text);
check(
  'an unknown section is REFUSED with the available names, not answered empty',
  unknownSection.success === false && Array.isArray(unknownSection.availableSections),
  JSON.stringify(unknownSection).slice(0, 200)
);
check(
  `the refusal reports its own length honestly too (${refusal.completeness.chars} === ${refusal.text.length})`,
  refusal.completeness.chars === refusal.text.length,
  `claims ${refusal.completeness.chars}, is ${refusal.text.length}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('5. THE WIRING — the tool calls the fitter, and no longer stringifies raw');

// Static, over source rather than dist, so this section's verdict is about the
// checkout even when the build is stale. It proves the call site SAYS the right
// thing. It does not prove a real call reaches it — see the header, and
// `probe-list-agents-live-bound.mjs`.
const mcpSource = fs.readFileSync(path.join(daemonDir, 'src', 'mcp.ts'), 'utf8');
const listAgentsBlock =
  /if \(name === "butchr_list_agents"\)[\s\S]*?\n    \}\n/.exec(mcpSource)?.[0] ?? '';

check(
  'the butchr_list_agents branch was found in mcp.ts at all',
  listAgentsBlock.length > 0,
  'the branch regex matched nothing — this section would otherwise pass vacuously'
);
check(
  'that branch calls fitListAgentsResponse',
  /fitListAgentsResponse\(/.test(listAgentsBlock),
  listAgentsBlock.slice(0, 400)
);
check(
  'that branch no longer emits JSON.stringify(res, ...) as its text',
  !/text:\s*JSON\.stringify\(res\b/.test(listAgentsBlock),
  'the raw serialisation is still there — the fitter would be dead code'
);
check(
  'every tool answer passes the budget gate before it is returned',
  /return boundToBudget\(name, await dispatchTool\(/.test(mcpSource),
  'the CallToolRequestSchema handler does not route through boundToBudget'
);
check(
  'the section-clip order is declared, not derived from field size',
  Array.isArray(SECTION_CLIP_ORDER) && SECTION_CLIP_ORDER.length > 0,
  String(SECTION_CLIP_ORDER)
);

// The generic backstop, on a shape it knows nothing about.
const fatUnknown = { action: 'whatever_response', success: true, blob: 'x'.repeat(40_000) };
const backstopped = fitGenericResponse(fatUnknown, { tool: 'butchr_something' });
check(
  'the generic backstop bounds a tool it has no ladder for',
  backstopped.text.length <= DEFAULT_BUDGET_CHARS && backstopped.completeness.kind === 'clipped',
  `${backstopped.text.length} chars, verdict ${backstopped.completeness.kind}`
);
check(
  'and it names what it gave up rather than cutting bytes off the end',
  backstopped.completeness.kind === 'clipped' &&
    backstopped.completeness.clipped.some((c) => c.field === 'blob'),
  JSON.stringify(backstopped.completeness.clipped ?? null)
);

// ───────────────────────────────────────────────────────────────────────────
rule('VERDICT');
console.log(`   ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)`);

process.exit(failures ? 1 : 0);
