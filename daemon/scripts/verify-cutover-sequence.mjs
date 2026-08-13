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
//   - **Anything about a running fleet.** This is a static read. The sequence's
//     own steps are the instrument for the live system, and they are run by a
//     person on the day.
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
// Sections:
//
//   1. every step carries a precondition, an action, a check, an abort and an owner
//   2. the irreversibility the document is built on still holds in the code
//   3. every instrument the document sends a reader to still exists, and is
//      still named in the document
//   4. the two sentences KAN-378's acceptance criterion 3 requires are present
//   5. the flip step's systemd advice still matches what the installer does
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
 * every `configure.<key> =` assignment in the file. Both halves are needed —
 * `mcpServers` is set by assignment rather than in the literal, and a resume
 * would most naturally arrive the same way.
 */
function configurePayloadKeys(rawSource) {
  const source = stripComments(rawSource);
  const open = source.indexOf('const configure: Record<string, unknown> = {');
  if (open === -1) return null;
  const close = source.indexOf('\n    };', open);
  if (close === -1) return null;
  const literal = source.slice(open, close);
  const keys = new Set();
  for (const m of literal.matchAll(/^\s{6}([A-Za-z_$][\w$]*):/gm)) keys.add(m[1]);
  for (const m of source.matchAll(/\bconfigure\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);
  return [...keys].sort();
}

const payload = configurePayloadKeys(crabcast);

check(
  'the `configure_agent` payload can still be read out of crabcast-runtime.ts',
  payload !== null,
  'the `const configure: Record<string, unknown> = {` literal was not found. It was renamed or ' +
    'restructured, so the two legs below cannot run and the document\'s central claim is unguarded.'
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
  const KNOWN = ['action', 'launcher', 'mcpServers', 'path', 'priority', 'prompt'];
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

// -------------------------------------------------------------- verdict --

rule('Verdict');
console.log(
  failures === 0
    ? `   ${steps.length} steps, ${INSTRUMENTS.length} instruments — the sequence and the code agree.`
    : `   ${failures} failure(s). The written cutover sequence and the code it is a sequence for disagree.`
);

process.exit(failures ? 1 : 0);
