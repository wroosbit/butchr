// Live proof for KAN-378: the written cutover sequence cannot quietly stop
// matching the code it is a sequence for, and a step cannot be added without
// the four things that make it a step.
//
// WHAT FAILURE THIS WOULD CATCH: `docs/crabcast-cutover-sequence.md` going on
// saying "activating under CrabCast starts agents FRESH" after somebody wires
// a resume through to `configure_agent` — the document's central claim, and
// the whole reason the flip is a one-way door, surviving as prose after the
// mechanism under it moved. It also catches the defect the ticket was filed
// about arriving one layer down: a step added to the sequence with no
// precondition, no check, no abort condition or nobody named to read it, which
// is the shape "drain the fleet first" had while it was a phrase in a design
// doc.
//
// CI-RUNNABLE: yes — reads `docs/*.md`, `daemon/src/*.ts` and
// `daemon/scripts/install-service.sh` off the checkout as text and asserts on
// their contents; node builtins only, no build, no daemon, no herdr, no
// credential, no peer, no terminal, no network.
//
// THIS PROOF READS SOURCE AS TEXT AND IMPORTS NOTHING FROM `dist`, which
// decides what its verdict is worth after a failed build. `prompts/task.md`
// requires the build's exit code to be confirmed before a proof's verdict is
// read, because a `dist`-importing proof run after a failed build tested the
// previous build rather than your mutation. Nothing here imports from `dist`,
// so a red is about the tree as written and is not to be discarded — that is
// the qualifier the rule carries for exactly this case, and one grep settles
// it: there is no `../dist/` import below.
//
// ## THIS SCRIPT DOES NOT WRITE THE RECORD IT ASSERTS ON
//
// Every section reads the real document and the real `daemon/src` off the
// checkout. There is no fixture and no constructed input, so a green run is a
// statement about this tree rather than about a record the script made for
// itself (KAN-145's defect). The cost of that choice is the same one
// `verify-doc-constant-pins.mjs` pays: the sections cannot be shown firing
// without damaging the tree, so the red drive is a recipe rather than a
// section — see below, and see the pull request for its real output.
//
// ## WHAT THIS DOES NOT COVER, AND WHO DOES
//
//   - **Whether the order is right.** Nothing mechanical can know that. §1
//     establishes that each step is step-shaped, never that step 4 belongs
//     before step 5. The only cover for that is a reader who is not the author
//     walking the sequence and saying where it is ambiguous, which KAN-378's
//     acceptance criterion 4 requires and which is recorded on the ticket.
//   - **Whether the checks a step names would actually catch the failure it is
//     placed against.** §3 establishes that the instrument exists and that the
//     document still names it. It says nothing about whether reading it answers
//     the question the step asks.
//   - **The freshness of §2's allow-list.** §2's second leg is a
//     change-detector over the `configure_agent` payload, not a proof that the
//     payload is still resume-free: a key nobody predicted goes red and asks a
//     human to re-read the claim. That is deliberate — a guard that could only
//     see fields it was told to look for would miss the rename — but it means a
//     green there is "nothing moved", never "somebody checked".
//   - **Whether §4b's tool-to-action mapping is RIGHT.** §6 requires the socket
//     action to be named beside the tool and re-reads the pair from `mcp.ts`,
//     so a rename on either side surfaces. It cannot tell that a step sends the
//     driver to the action that answers the question that step is asking.
//   - **Anything about a running fleet.** This is a static read. The sequence's
//     own steps are the instrument for the live system, and they are run by a
//     person on the day. `probe-cutover-readiness.mjs` is the driver's tool for
//     that, and nothing here runs it — §6 asserts it exists, imports only node
//     builtins and carries no write verb, never that its output is correct.
//
// ## Made to go red — the recipe, because the sections read the real tree
//
//   # §1, a step loses its check
//   perl -0pi -e 's/- \*\*Check:\*\* `boardControl.mode`[^\n]*\n//' docs/crabcast-cutover-sequence.md
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- docs/crabcast-cutover-sequence.md
//
//   # §2, the central claim stops being true: a resume is wired through
//   perl -pi -e "s/^(\s*)configure\.mcpServers = mcpServers;/\$1configure.resume = session.resume;\n\$1configure.mcpServers = mcpServers;/" daemon/src/crabcast-runtime.ts
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- daemon/src/crabcast-runtime.ts
//
//   # §2, the other direction: herdr stops resuming
//   perl -pi -e 's/claude --continue/claude/' daemon/src/herdr.ts
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- daemon/src/herdr.ts
//
//   # §3, an instrument is renamed out from under the document
//   perl -pi -e "s/case 'agent_runtime_report':/case 'agent_runtime_status':/" daemon/src/router.ts
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- daemon/src/router.ts
//
//   # §4, the irreversibility statement is edited away
//   perl -pi -e 's/starts it FRESH/starts it/' docs/crabcast-cutover-sequence.md
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- docs/crabcast-cutover-sequence.md
//
//   # §5, the installer stops re-rendering the unit, so the drop-in warning is stale
//   perl -pi -e 's{^render "\$UNIT_SRC/butchr-daemon.service".*$}{: # no longer rendered}' daemon/scripts/install-service.sh
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- daemon/scripts/install-service.sh
//
//   # §6, ONE step goes back to agent-only vocabulary — the walkthrough's
//   #     finding 2, returning. A driver Q6 says cannot be an agent is handed a
//   #     check only an agent can run. Note the mutation is one step and not the
//   #     page: a document-wide version of it does NOT go red, which is what
//   #     found this leg satisfying itself twice over.
//   perl -pi -e 's/`butchr_list_agents` \(socket `list_agents`, or the probe\) lists no `task\/\*` agent/`butchr_list_agents` lists no `task\/*` agent/' docs/crabcast-cutover-sequence.md
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- docs/crabcast-cutover-sequence.md
//
//   # §7, THE ONE THAT FIRES WHEN THE BUG IS FIXED — gate 10 closes (KAN-432)
//   #     and the document is left describing a defect that no longer exists.
//   #     This is the direction a guard written around an open bug would miss.
//   perl -pi -e "s/^(\s*)this\.channelEnabled\.set/\$1if (activated.resumedExistingConversation === true) session.resumedConversation = true;\n\$1this.channelEnabled.set/" daemon/src/crabcast-runtime.ts
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- daemon/src/crabcast-runtime.ts
//
//   # §7, the other direction: the gate is open and the document stops saying so
//   perl -0pi -e 's/drops `resumedExistingConversation` on the floor/reads it/' docs/crabcast-cutover-sequence.md
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- docs/crabcast-cutover-sequence.md
//
//   # §7, the flip-moment warning is softened while "refining" it — KAN-434 AC1
//   perl -0pi -e 's/does not resume its conversation; it loses it/may not resume its conversation/' docs/crabcast-cutover-sequence.md
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- docs/crabcast-cutover-sequence.md
//
//   # §7, the mechanism the gate-10 explanation rests on is renamed in the code
//   perl -pi -e 's/resumedConversation === true/resumedConversation === TRUE_/' daemon/src/reconcile.ts
//   node daemon/scripts/verify-cutover-sequence.mjs            # exit 1
//   git checkout -- daemon/src/reconcile.ts
//
// Sections:
//
//   1. every step carries a precondition, an action, a check, an abort and an owner
//   2. the irreversibility the document is built on still holds in the code
//   3. every instrument the document sends a reader to still exists, and is
//      still named in the document
//   4. the two sentences KAN-378's acceptance criterion 3 requires are present
//   5. the flip step's systemd advice still matches what the installer does
//   6. every `butchr_*` instrument names the socket action beside it, and the
//      read-only probe §4b hands the driver exists and stays read-only
//   7. §1's resume refinement and gate 10 still match the code they describe —
//      in BOTH directions, so the section fires when the gate closes as well as
//      when the document drifts (KAN-434)
//
// Usage: node daemon/scripts/verify-cutover-sequence.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const DOC_REL = 'docs/crabcast-cutover-sequence.md';
const DOC = path.join(repoRoot, DOC_REL);

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

/**
 * `whyFailed` prints only on failure and `whyPassed` only under --verbose.
 * Two arguments rather than one shared `detail`, copying
 * `verify-doc-constant-pins.mjs`: a failure explanation printed beside the word
 * PASS is a small instance of the defect this whole ticket is about.
 */
function check(label, ok, whyFailed, whyPassed) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (whyFailed) console.log(`         ${String(whyFailed).split('\n').join('\n         ')}`);
  } else if (verbose && whyPassed) {
    console.log(`         ${String(whyPassed).split('\n')[0]}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------- setup --
//
// Exit 2, never 1: a missing document is this script being run from the wrong
// place, and reporting it as a verdict would say the sequence is broken when
// the invocation is.
if (!fs.existsSync(DOC)) {
  console.error(`setup: ${DOC} does not exist — run this from a Butchr checkout.`);
  process.exit(2);
}

const doc = fs.readFileSync(DOC, 'utf8');

console.log(`document: ${DOC_REL} · ${doc.split('\n').length} lines`);

// --------------------------------------------- 1. every step is step-shaped --

rule('1. Every step carries a precondition, an action, a check, an abort and an owner');

/**
 * A step is a `### Step <id> — <title>` heading and everything under it up to
 * the next heading or horizontal rule. The id is deliberately loose (`8`,
 * `R3`): the sequence has a rollback arm and numbering it separately is the
 * document's business, not this script's.
 */
function stepsIn(text) {
  const lines = text.split('\n');
  const out = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^### Step (\S+) — (.+)$/);
    if (heading) {
      current = { id: heading[1], title: heading[2], line: i + 1, body: [] };
      out.push(current);
      continue;
    }
    if (current) {
      if (/^(#{1,3} |---\s*$)/.test(lines[i])) {
        current = null;
        continue;
      }
      current.body.push(lines[i]);
    }
  }
  return out.map((s) => ({ ...s, body: s.body.join('\n') }));
}

const REQUIRED_LABELS = ['Precondition', 'Action', 'Check', 'Abort', 'Who'];

const steps = stepsIn(doc);

check(
  `the document contains steps at all`,
  steps.length > 0,
  `no \`### Step <id> — <title>\` headings found in ${DOC_REL}. Either the sequence was deleted or its ` +
    `heading format changed, and this section is blind to a format it does not know.`,
  `${steps.length} steps: ${steps.map((s) => s.id).join(', ')}`
);

for (const step of steps) {
  const missing = REQUIRED_LABELS.filter(
    (label) => !new RegExp(`^\\s*[-*]\\s+\\*\\*${label}:\\*\\*\\s*\\S`, 'm').test(step.body)
  );
  check(
    `Step ${step.id} (${DOC_REL}:${step.line}) carries ${REQUIRED_LABELS.join(', ')}`,
    missing.length === 0,
    `missing or empty: ${missing.join(', ')}\n` +
      `A step without a precondition is one somebody can reach out of order; without a check, one ` +
      `nobody can tell succeeded; without an abort, one with no stopping condition; without an owner, ` +
      `one everybody assumes somebody else read.`,
    `all five present`
  );
}

// ------------------------- 2. the irreversibility still holds in the code --

rule('2. The irreversibility the document is built on still holds in the code');

const crabcast = read('daemon/src/crabcast-runtime.ts');
const herdr = read('daemon/src/herdr.ts');

/**
 * Comments out, before anything is read as code.
 *
 * THIS IS NOT TIDINESS AND IT WAS NOT PREDICTED. The first run of this script
 * reported `mcpConfig` as a new payload key, which would have sent a reader to
 * re-read the document over a field that has not been sent since KAN-294 — it
 * survives only inside a comment explaining why it was WRONG. A guard whose
 * false positive points at a corrected defect is worse than no guard, because
 * the reader it interrupts finds a plausible story waiting for them.
 *
 * The stripping is deliberately crude: `//` to end of line will also truncate a
 * line whose string holds a `//`, which is harmless here because the only thing
 * read afterwards is `configure.<key> =` assignments and an object literal's
 * keys, neither of which lives inside a URL.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * The `configure_agent` payload, as keys: the object literal's own keys plus
 * every `payload.<key> =` assignment in the file. Both halves are needed —
 * `mcpServers` is set by assignment rather than in the literal, and a resume
 * would most naturally arrive the same way.
 *
 * **KAN-482 gave the payload a declared type and a builder**, and this reads the
 * new home. The declared type is folded in as a THIRD source rather than
 * replacing the other two: a field can now be added to `ConfigureAgentPayload`
 * and populated by a caller this function never looks at, so reading only the
 * literal would miss it. Reading all three is what keeps the document's central
 * claim — that nothing here carries a resume — a claim about the payload rather
 * than about one statement that builds it.
 */
function configurePayloadKeys(rawSource) {
  const source = stripComments(rawSource);
  const open = source.indexOf('const payload: ConfigureAgentPayload = {');
  if (open === -1) return null;
  const close = source.indexOf('\n  };', open);
  if (close === -1) return null;
  const literal = source.slice(open, close);
  const keys = new Set();
  for (const m of literal.matchAll(/^\s{4}([A-Za-z_$][\w$]*):/gm)) keys.add(m[1]);
  for (const m of source.matchAll(/\bpayload\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);

  const typeOpen = source.indexOf('export type ConfigureAgentPayload = {');
  if (typeOpen === -1) return null;
  const typeClose = source.indexOf('\n};', typeOpen);
  if (typeClose === -1) return null;
  for (const m of source.slice(typeOpen, typeClose).matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

const payload = configurePayloadKeys(crabcast);

check(
  'the `configure_agent` payload can still be read out of crabcast-runtime.ts',
  payload !== null,
  'the `const payload: ConfigureAgentPayload = {` literal, or the `ConfigureAgentPayload` type ' +
    'declaration, was not found. One of them was renamed or restructured, so the two legs below ' +
    "cannot run and the document's central claim is unguarded."
);

if (payload) {
  const resumeish = payload.filter((k) => /resume|continue|restore|transcript/i.test(k));
  check(
    'the payload carries nothing that would resume a conversation',
    resumeish.length === 0,
    `the payload now carries: ${resumeish.join(', ')}\n` +
      `${DOC_REL} tells its reader that activating under CrabCast starts an agent FRESH, and that the ` +
      `flip is therefore a one-way door for every live conversation. If a resume is now sent, THAT ` +
      `SENTENCE IS FALSE and the sequence built on it needs rewriting — starting with §1 and Q4, and ` +
      `with whether steps 3 to 5 are still required at all.`,
    `payload keys: ${payload.join(', ')}`
  );

  // A change-detector, and it is honest about being one: see the header. A key
  // nobody predicted is not necessarily a resume, and the only safe response is
  // a human re-reading the claim rather than a regex deciding for them.
  // KAN-492 added `refusable`, `chargeable` and `preemptable`, and this is the
  // review the trigger asked for rather than a list quietly extended. §1 of the
  // document was re-read against the new payload: its claim is that activating
  // under CrabCast starts an agent FRESH because Butchr sends nothing that could
  // ask for a conversation back. All three new keys are CrabCast capacity gate
  // flags — whether their gate may refuse the agent, whether it occupies a
  // charged slot, whether it may be stood down. None of them names a
  // conversation, a transcript or a directory's history, so none can carry a
  // resume, and the fresh-start claim holds unchanged. The document's own
  // enumeration of the payload was stale the moment this landed and was updated
  // in the same commit — that sentence is at `docs/crabcast-cutover-sequence.md`
  // in the resume table, and it now lists eight fields rather than five.
  const KNOWN = [
    'action',
    'chargeable',
    'launcher',
    'mcpServers',
    'path',
    'preemptable',
    'priority',
    'prompt',
    'refusable'
  ];
  const unknown = payload.filter((k) => !KNOWN.includes(k));
  check(
    'the payload is the one the document was written against',
    unknown.length === 0,
    `new key(s) since KAN-378: ${unknown.join(', ')}\n` +
      `This is a review trigger rather than an accusation. Re-read §1 of ${DOC_REL} against the new ` +
      `payload; if the fresh-start claim still holds, add the key to KNOWN in this script and say in ` +
      `the pull request that you checked.`,
    `unchanged: ${KNOWN.join(', ')}`
  );
}

check(
  'herdr still resumes with `--continue`, which is the other half of the table',
  /claude --continue/.test(herdr),
  '`claude --continue` no longer appears in daemon/src/herdr.ts.\n' +
    `${DOC_REL} §1 contrasts the two runtimes: herdr resumes, CrabCast starts fresh. If herdr has ` +
    `stopped resuming, the left-hand column of that table is wrong and the flip is no longer the only ` +
    `thing that ends a conversation.`,
  'herdr.ts still launches with --continue'
);

check(
  'the resume cause is still carried on the local session and not over the wire',
  /\.\.\.\(resume \? \{ resume \} : \{\}\)/.test(crabcast),
  'the local `...(resume ? { resume } : {})` on the CrabCast session object is gone.\n' +
    'That expression is what makes the fresh start legible: the runtime is HANDED a resume cause and ' +
    'keeps it to itself. If it has moved, find out where it went before trusting the document.',
  'crabcast-runtime.ts still keeps the resume cause local'
);

// ------------------------------------- 3. the instruments still exist --

rule('3. Every instrument the document sends a reader to exists, and is still named there');

/**
 * `docToken` is what the document tells a reader to go and read. `probes` are
 * where that surface is declared in this repository. Both directions matter:
 * a rewrite of the document that drops the instrument leaves a step with no
 * way to be checked, and a rename in the code leaves the document sending
 * somebody to a surface that no longer answers.
 */
const INSTRUMENTS = [
  {
    docToken: 'agent_runtime_report',
    why: 'the only reading of which runtime is actually serving — steps 1, 8 and R3 turn on it',
    probes: [{ file: 'daemon/src/router.ts', needle: "case 'agent_runtime_report':" }]
  },
  {
    docToken: 'butchr_deactivate_agent',
    why: 'what a drain does: it writes `deactivated` intent, and intent is what survives the restart',
    probes: [
      { file: 'daemon/src/mcp.ts', needle: 'name: "butchr_deactivate_agent"' },
      { file: 'daemon/src/router.ts', needle: "case 'deactivate_by_key':" }
    ]
  },
  {
    docToken: 'butchr_list_agents',
    why: 'every emptiness claim in the drain is read off this census',
    probes: [{ file: 'daemon/src/mcp.ts', needle: 'name: "butchr_list_agents"' }]
  },
  {
    docToken: 'butchr_tail_agent',
    why: "step 9's canary check reads the pane through it",
    probes: [{ file: 'daemon/src/mcp.ts', needle: 'name: "butchr_tail_agent"' }]
  },
  {
    docToken: 'butchr_send_to_agent',
    why: "step 9's canary check proves delivery through it",
    probes: [{ file: 'daemon/src/mcp.ts', needle: 'name: "butchr_send_to_agent"' }]
  },
  {
    docToken: 'butchr_guardian',
    why: 'step 6 reads who the guardian is off it',
    probes: [{ file: 'daemon/src/mcp.ts', needle: 'name: "butchr_guardian"' }]
  },
  {
    docToken: 'boardControl.mode',
    why: "step 2's freeze and step 11's restore are both read off it",
    probes: [{ file: 'daemon/src/board-control.ts', needle: 'mode: BoardMode;' }]
  },
  {
    docToken: 'missingAgents',
    why: 'the drain is complete when the registry expects nobody, and this is where that shows',
    probes: [{ file: 'daemon/src/router.ts', needle: 'missingAgents' }]
  },
  {
    docToken: 'foreignPanes',
    why: "Q3 and step 9's abort both turn on which side of the census an agent lands",
    probes: [{ file: 'daemon/src/crabcast-runtime.ts', needle: 'foreignPanes' }]
  },
  {
    docToken: 'unreadableRecordsTotal',
    why: 'abort condition 3',
    probes: [{ file: 'daemon/src/crabcast-link.ts', needle: 'unreadableRecordsTotal' }]
  }
];

for (const inst of INSTRUMENTS) {
  check(
    `${DOC_REL} still names \`${inst.docToken}\``,
    doc.includes(inst.docToken),
    `the document no longer mentions it. ${inst.why}. A step whose instrument has been edited out is a ` +
      `step that reads "check it worked" and names nothing.`,
    inst.why
  );
  for (const probe of inst.probes) {
    const exists = fs.existsSync(path.join(repoRoot, probe.file));
    check(
      `\`${inst.docToken}\` → ${probe.file} declares it`,
      exists && read(probe.file).includes(probe.needle),
      `\`${probe.needle}\` not found in ${probe.file}.\n` +
        `${DOC_REL} sends a reader to this surface during a cutover. If it has been renamed, the ` +
        `document is sending somebody to an instrument that will not answer, on the day they can least ` +
        `afford to work it out.`,
      probe.needle
    );
  }
}

// ------------------------------------ 4. the required statements are present --

rule("4. The two statements KAN-378's acceptance criterion 3 requires are present");

/**
 * A presence check, and it is only worth something because §2 is beside it.
 * On its own this leg could keep a sentence green long after it stopped being
 * true — which is the part-2 defect `docs/doc-constant-drift.md` names. §2
 * re-reads the code the first sentence describes, so the pair can only stay
 * green while the claim is still the code's behaviour.
 */
const REQUIRED_STATEMENTS = [
  {
    what: 'activating under CrabCast starts agents fresh',
    test: /starts it FRESH|starts agents FRESH/,
    why: 'AC3: the irreversibility must be stated in the document itself, in the words a reader needs before they act'
  },
  {
    what: 'rollback does not restore conversations',
    test: /does not restore conversations/i,
    why: 'AC3: a reader who plans around an undo that does not exist is the failure this sentence prevents'
  },
  {
    what: 'the document is not an authorisation to cut over',
    test: /not an authorisation/i,
    why: "KAN-378's scope: the ticket produces a plan, not a flip, and the document has to say so on its face"
  }
];

for (const s of REQUIRED_STATEMENTS) {
  check(
    `${DOC_REL} states: ${s.what}`,
    s.test.test(doc),
    `not found. ${s.why}.`,
    s.why
  );
}

// ------------------------------- 5. the flip step's systemd advice is current --

rule("5. The flip step's systemd advice still matches what the installer does");

const installer = read('daemon/scripts/install-service.sh');

check(
  'install-service.sh still re-renders butchr-daemon.service',
  /render "\$UNIT_SRC\/butchr-daemon\.service"/.test(installer),
  'the installer no longer renders `butchr-daemon.service`.\n' +
    `${DOC_REL} step 8 tells the driver to set the variable in a drop-in rather than in the unit, ` +
    `because the installer overwrites the unit. If that is no longer true, the warning is stale — and a ` +
    `stale warning about a one-way door is worse than none.`,
  'the unit is rendered unconditionally, so an inline Environment= line is lost at the next install'
);

check(
  `${DOC_REL} step 8 uses a drop-in rather than editing the unit`,
  doc.includes('butchr-daemon.service.d'),
  'the document no longer names `butchr-daemon.service.d`. Setting the variable in the unit itself is ' +
    'silently undone by the next `install-service.sh`, and the flip would then be reverted by an ' +
    'unrelated install rather than by a decision.',
  'step 8 writes 10-runtime.conf into the drop-in directory'
);

check(
  'the installer still leaves butchr-daemon.service.d alone',
  !/butchr-daemon\.service\.d/.test(installer),
  'the installer now touches `butchr-daemon.service.d`. The drop-in step 8 writes may no longer ' +
    'survive an install, which is the whole reason the document prefers it to editing the unit.',
  'no mention of the drop-in directory in install-service.sh'
);

// ------------------- 6. the driver Q6 requires can run the checks --

rule('6. Every `butchr_*` instrument names its socket action, and the probe exists');

/**
 * KAN-378's AC4 walkthrough, by `epic/KAN-39`, found the document contradicting
 * itself: Q6 concludes the driver **must not** be an agent this daemon manages,
 * and every check was then written as a `butchr_*` MCP call — which a human at a
 * terminal does not have. Step 1 was the only step that named a non-agent route.
 *
 * THE FIX IS §4b, AND THIS SECTION IS WHY IT CANNOT QUIETLY COME UNDONE. A
 * `butchr_*` tool named anywhere in the document must have its socket action
 * named too, so a step added later in agent vocabulary alone goes red rather
 * than reaching a driver who cannot run it.
 *
 * WHAT IT DOES NOT DO: check that the mapping is *correct*. The pairs are read
 * from `mcp.ts` below, so a wrong pair in the document survives if the right
 * action name happens to appear somewhere in the page. That is a reviewer's
 * job, and it is on the face of §4b's table rather than hidden in here.
 */
const MCP_TO_SOCKET = [
  ['butchr_list_agents', 'list_agents'],
  ['butchr_deactivate_agent', 'deactivate_by_key'],
  ['butchr_activate_agent', 'activate_by_key'],
  ['butchr_tail_agent', 'tail_agent'],
  ['butchr_send_to_agent', 'send_to_agent'],
  ['butchr_guardian', 'guardian']
];

const mcpSource = read('daemon/src/mcp.ts');

/**
 * PER STEP, NOT PER DOCUMENT, and the first version of this got it wrong in a
 * way worth leaving on the record. It asked whether the socket action appeared
 * anywhere in the page, which is satisfied by §4b's own table — so a step added
 * later in pure agent vocabulary passed, which is precisely the defect. The
 * mutation written into the red-drive recipe above did not go red, and that is
 * how it was found: **a check whose red drive will not fire is not a check.**
 *
 * The route may be named on the step itself or by pointing at the probe, since
 * either leaves the driver able to act.
 *
 * AND THE TOOL NAME IS STRIPPED FIRST, WHICH IS THE SECOND TIME THIS LEG WAS
 * SATISFYING ITSELF. `butchr_list_agents` CONTAINS `list_agents`, so a step
 * naming only the MCP tool passed a search for the socket action — the same
 * self-satisfaction `verify-doc-constant-pins.mjs` §3 avoids by stripping the
 * marker before searching for what the marker says. Both were caught the same
 * way, by a red drive that would not go red, and the lesson is cheaper stated
 * than rediscovered: **run the mutation before believing the check.**
 */
const routeNamed = (block, action) =>
  block.replace(/butchr_[a-z_]+/g, '').includes(action) || block.includes('probe-cutover-readiness');

for (const [tool, action] of MCP_TO_SOCKET) {
  if (!doc.includes(tool)) continue; // a tool the document does not use needs no route

  for (const step of steps) {
    if (!step.body.includes(tool)) continue;
    check(
      `Step ${step.id} names \`${tool}\` and a route for it (\`${action}\`, or the probe)`,
      routeNamed(step.body, action),
      `this step tells the driver to use \`${tool}\` and names no non-agent route.\n` +
        `Q6 says the driver is a human at a terminal or an agent outside this fleet, and neither has ` +
        `MCP tools. A step whose only instrument is an agent tool is not a step that driver can run — ` +
        `see §4b, and name the socket action beside the tool the way step 1 does.`,
      `${tool} → ${action}`
    );
  }

  check(
    `§4b's table pairs \`${tool}\` with \`${action}\``,
    doc.includes(action),
    `the document tells the driver to use \`${tool}\` and never names \`${action}\` anywhere, so §4b's ` +
      `table has lost the row that makes the tool reachable without an agent.`,
    `${tool} → ${action}`
  );
  // The pair itself is read from the MCP server, so a rename there surfaces here
  // rather than in a driver's hands during the cutover.
  check(
    `\`${tool}\` → \`${action}\` is still the pair daemon/src/mcp.ts wires`,
    mcpSource.includes(`name: "${tool}"`) && mcpSource.includes(`callDaemonAPI('${action}'`),
    `mcp.ts no longer wires \`${tool}\` to \`${action}\`. §4b's table is now telling a driver to send ` +
      `an action the daemon may not answer.`,
    'wired'
  );
}

const PROBE = 'daemon/scripts/probe-cutover-readiness.mjs';
check(
  `${PROBE} exists — the read-only route §4b hands the driver`,
  fs.existsSync(path.join(repoRoot, PROBE)),
  `${DOC_REL} §4b tells the driver to run it. A document naming a tool that is not in the tree is ` +
    `the same defect as a document naming an instrument that no longer answers.`
);
check(
  `${DOC_REL} names the probe`,
  doc.includes('probe-cutover-readiness'),
  'the probe is in the tree and the document no longer sends anybody to it, which leaves Q6 ' +
    'contradicting the steps again.'
);

if (fs.existsSync(path.join(repoRoot, PROBE))) {
  const probe = read(PROBE);
  // The probe is for the worst day: a checkout nobody has installed, and a
  // build that may not exist. Both would be caught here before they cost
  // somebody the one moment the tool is for.
  check(
    'the probe imports node builtins only — no node_modules, no dist',
    !/from\s+'(?!net|os|path|fs|url|crypto)[^']+'/.test(probe.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the probe now imports something outside node builtins. It is the tool for a machine mid-cutover; ' +
      'a dependency on an install or a build is a dependency on the thing that may be broken.'
  );
  check(
    'the probe writes nothing — no activation, no deactivation',
    !/(deactivate_by_key|activate_by_key|send_to_agent|reset_by_key)/.test(probe),
    'the probe now carries a write verb. §4b says it reads and never writes, because standing an agent ' +
      'down is a decision with a ticket comment attached and must not be one keystroke from a status read.'
  );
}

// ------------------ 7. §1's resume refinement still matches the code --------

rule("7. §1's resume refinement, and gate 10, still match the code they describe");

/**
 * WHY THIS IS NOT A `verify-doc-constant-pins.mjs` PIN — KAN-434's acceptance
 * criterion 3 asks for that to be answered rather than assumed.
 *
 * A pin binds a sentence to a CONSTANT'S VALUE: it hashes a declaration and
 * asserts the document quotes what that declaration says. What this section
 * guards is not a value. It is **the absence of a read** — `provision()` not
 * consuming `activate_response.resumedExistingConversation` — and an absence
 * has no declaration to hash.
 *
 * Pinning the nearest constant instead would bind the sentence to something
 * that does not move when the claim goes false, and that is not hypothetical:
 * it is the failure U-6 records one page over. `docs/crabcast-runtime.md`'s
 * contract-boundary sentence IS pinned, to `CRABCAST_CONTRACT_VERSION`. The
 * constant never moved, so the pin stayed green — and the sentence went false
 * anyway, because what changed was CrabCast's contract growing to cover a
 * surface, not our constant's value. A pin catches a constant moving; it cannot
 * catch the world moving underneath a constant that stayed put.
 *
 * THE DIRECTION THAT MATTERS MOST IS THE ONE THAT FIRES WHEN THE GATE CLOSES.
 * KAN-432 is fixing gate 10 in parallel with this document. When it lands,
 * `provision()` starts reading the field, and this document's "nobody on this
 * side learns" row, its Gate 10 section, §4's precondition and step 10's
 * per-agent check all become descriptions of a defect that no longer exists.
 * This section goes red and names them. **A guard that only fired while the bug
 * was open would be deleted by the fix**, which is the opposite of what a
 * document like this needs.
 */

const reconcile = read('daemon/src/reconcile.ts');

/**
 * The wire field CrabCast reports its resume decision on. Comments are stripped
 * first for §2's reason, and it is load-bearing here rather than tidy: this
 * document's own prose names the field, several comments in the runtime discuss
 * it, and **a mention is not a read.** Without the strip this leg would report
 * the gate closed the moment somebody explained why it was open.
 */
const RESUME_WIRE_FIELD = 'resumedExistingConversation';
const runtimeReadsResumeField = stripComments(crabcast).includes(RESUME_WIRE_FIELD);

/**
 * Whitespace-normalised. The document wraps at 80 columns and every sentence
 * asserted below spans a line break, so a naive test against `doc` would report
 * a missing sentence that is sitting there — a false red that teaches a reader
 * to distrust this script.
 */
const flat = doc.replace(/\s+/g, ' ');

const GATE_10_OPEN_CLAIM = /drops `resumedExistingConversation` on the floor/;
const gateStated = GATE_10_OPEN_CLAIM.test(flat);

check(
  runtimeReadsResumeField
    ? `${DOC_REL} has stopped claiming the resume signal is dropped, now that provision() reads it`
    : `${DOC_REL} states that provision() drops \`${RESUME_WIRE_FIELD}\` — gate 10, open`,
  runtimeReadsResumeField ? !gateStated : gateStated,
  runtimeReadsResumeField
    ? `daemon/src/crabcast-runtime.ts NOW READS \`${RESUME_WIRE_FIELD}\`, so gate 10 looks closed ` +
      `(KAN-432) — and ${DOC_REL} still tells its reader the signal is dropped on the floor.\n` +
      `A resumed agent is no longer recorded as a working one, so §1's table row, the Gate 10 section, ` +
      `§4's precondition and abort condition 7 are describing a defect that has been fixed. Re-read them ` +
      `together: the cost of leaving them is a driver hand-nudging a fleet that no longer needs it, ` +
      `during the one operation where invented work is most expensive.`
    : `daemon/src/crabcast-runtime.ts does not read \`${RESUME_WIRE_FIELD}\`, so gate 10 is open — and ` +
      `${DOC_REL} no longer says so.\n` +
      `That sentence is the whole reason step 10 checks each agent for a TURN rather than for presence. ` +
      `Without it a reader draws from step 9's green that resumed agents are fine, which is precisely ` +
      `the conclusion this document was corrected to prevent.`,
  runtimeReadsResumeField ? 'the gate is closed and the document agrees' : 'the gate is open and the document says so'
);

/**
 * KAN-432 LANDED, SO THESE TWO LEGS ASSERT THE FIX RATHER THAN THE DEFECT.
 *
 * They read `resumedConversation === true` and `if (outcome.resumedConversation)`
 * — the two expressions the Gate 10 section used to describe line by line. Both
 * are gone: the comparison is a compile error against the three-state
 * `ResumedConversation`, and the guard is now `needsResumeNudge`. Keeping the
 * old assertions would have pinned this document to a defect that no longer
 * exists, which is what §7's own preamble says a guard must not do.
 *
 * ⚠ **COMMENTS ARE STRIPPED FIRST, AND THAT IS LOAD-BEARING RATHER THAN TIDY.**
 * The `if (outcome.resumedConversation)` leg was GREEN against the fixed tree on
 * the run that found this — not because the guard was there, but because
 * `reconcile.ts`'s new comment *quotes the old expression* while explaining what
 * replaced it. A mention is not a branch. §7 already draws exactly that
 * distinction for `RESUME_WIRE_FIELD` and did not apply it here, so the leg most
 * likely to be read as "the guard is unchanged" was the one that could not tell
 * the difference. It fails toward the comfortable answer, which is why it is
 * fixed rather than left.
 */
const reconcileCode = stripComments(reconcile);

check(
  '`daemon/src/reconcile.ts` no longer branches on `resumedConversation === true`',
  !/resumedConversation === true/.test(reconcileCode),
  'the pre-KAN-432 comparison is back in `reconcile.ts`.\n' +
    `${DOC_REL}'s Gate 10 section now records that comparison as HISTORY. If it has returned, a ` +
    `third state is being folded into an answer again and the gate is reopened — the document, the ` +
    `nudge and step 10's stated mechanism all go false together.`,
  'the comparison the gate-10 explanation rests on, asserted absent'
);

check(
  'the nudge is guarded by `needsResumeNudge`, so an UNKNOWN verdict is told rather than assumed',
  /needsResumeNudge\(outcome\.resumedConversation\)/.test(reconcileCode),
  'the nudge is no longer guarded by `needsResumeNudge`.\n' +
    'The document states that a resumed agent IS now told to carry on, and that an unknown verdict ' +
    'is nudged rather than silently recorded as already-working. Both of those claims are this ' +
    'guard. If it moved, the consequence moved with it, in either direction.'
);

check(
  'herdr is still the side that sets it, from `hasRestorableConversation`',
  /hasRestorableConversation\(/.test(herdr) && /resumedConversation/.test(herdr),
  'herdr no longer derives `resumedConversation` from `hasRestorableConversation`.\n' +
    `${DOC_REL} §4 and step R4 both rest on this being a CrabCast-path defect ONLY — that after a ` +
    `rollback the herdr path sets the field and DOES nudge. If that stopped being true, rollback ` +
    `acquires the same failure and R4's check is wrong.`,
  'the producer that makes gate 10 CrabCast-only'
);

/**
 * The sentences KAN-434 is accountable for. Presence-only, and worth something
 * only because the legs above re-read the code they describe — the pairing
 * `docs/doc-constant-drift.md` calls part 2, and the same reason §4 states.
 */
const RESUME_STATEMENTS = [
  {
    what: 'the flip-moment warning is intact',
    test: /does not resume its conversation; it loses it/,
    why: 'AC1: the refinement must not weaken the warning, and this is the sentence carrying it'
  },
  {
    what: 'the pre-flip conversation is still said to be lost',
    test: /the pre-flip conversation is lost/i,
    why: 'AC1: this is a refinement only while this still stands'
  },
  {
    what: 'the cost is stated as one cold start per workspace',
    test: /one cold start per workspace/i,
    why: 'the corrected conclusion a reader is meant to draw, and the whole point of the amendment'
  },
  {
    what: "KAN-396's measurement is cited re-runnably rather than asserted",
    test: /verify-crabcast-second-activation-resumes\.mjs/,
    why: 'a claim about a peer that a reader cannot re-run is a claim they must take on trust'
  },
  {
    what: 'the unmeasured reconciler path is named',
    test: /U-5/,
    why: 'AC5: what remains uncovered is named rather than left to be inferred from silence'
  }
];

for (const s of RESUME_STATEMENTS) {
  check(
    `${DOC_REL} states: ${s.what}`,
    s.test.test(flat),
    `not found. ${s.why}.`,
    s.why
  );
}

// -------------------------------------------------------------- verdict --

rule('Verdict');
console.log(
  failures === 0
    ? `   ${steps.length} steps, ${INSTRUMENTS.length} instruments — the sequence and the code agree.`
    : `   ${failures} failure(s). The written cutover sequence and the code it is a sequence for disagree.`
);

process.exit(failures ? 1 : 0);
