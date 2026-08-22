// KAN-633: a story may transition and comment on the tasks the board places
// under it, and this is what bounds that widening.
//
// WHAT FAILURE THIS WOULD CATCH: the supervised write grant escaping the
// approver relation it was argued for — `refuseWriteOutsideSupervision`
// permitting a target the board does not link or parent to the caller, the
// unreadable-board branch failing OPEN so that a Jira outage becomes a blanket
// permission, the own-ticket fast path acquiring a board read so that a slow
// Jira stops an agent moving its own ticket, the link parse reading only one
// direction so that a story's authority depends on who typed the link, a third
// operation quietly acquiring `supervised-ticket`, or `router.ts` ceasing to
// call the second gate at all — which would leave the two widened writes
// bounded by nothing, since the first gate returns `null` for them by design.
// `daemon/scripts/red-drive-kan633.sh` drives that last one red on demand.
//
// CI-RUNNABLE: yes — imports the built daemon modules and reads `router.ts` as
// text; no live daemon, no herdr, no credential, no peer, no terminal, no
// network.
//
// ── THIS SCRIPT IMPORTS `dist`, SO READ THE BUILD BEFORE READING THE VERDICT ─
//
// Sections 1 to 4 and 6 import `daemon/dist/atlassian-proxy.js`. Run after a
// FAILED build they test the previous build and their verdict is evidence about
// code nobody wrote — `prompts/task.md` states the rule and two worked cases.
// Section 5 is the exception and is marked: it reads `daemon/src/router.ts` as
// TEXT, so its verdict is about the tree in front of you whatever the build
// did. There is no blended assertion; the sections do not share a verdict
// variable beyond the failure count, and a red is reported per section.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// **It writes the board it then asserts on.** `SupervisionBoard` is an
// interface, and every board below is an object literal a few lines above the
// check that uses it. So this proves what the gate DECIDES given a board, and
// proves nothing about whether the real board arrives — which is exactly the
// KAN-145 shape `prompts/task.md` names: a proof that supplies its own input
// has not tested that the input arrives.
//
// The gap is split deliberately rather than left whole, and none of these is
// nobody:
//
//   - **The parse** — the part of the adapter most likely to be wrong — is not
//     supplied by this script. §3 feeds `supervisionFieldsFrom` real Jira issue
//     bodies, both link directions, and asserts an unreadable body is `null`
//     rather than an empty result. That function is exported from
//     `atlassian-proxy.ts` for this reason.
//   - **The wiring** — that `router.ts` calls the gate at all, and before it
//     sends anything — is §5, read off the source as text.
//   - **The fetch** — that `this.jira.proxyRead` returns a body carrying
//     `parent` and `issuelinks` for a real issue — is covered by NOBODY in CI,
//     and it cannot be: it needs a credential. The nearest existing cover is
//     `probe-atlassian-proxy-write.mjs`, which drives a real write through a
//     real `mcp.ts` against real Atlassian — and it is **not** cover for this,
//     because it never makes a cross-ticket call and so never reaches the
//     supervision read at all. Said plainly rather than implied: **this leg is
//     uncovered by any script in the tree.** What stands in for it is a real
//     agent's call pasted into the KAN-633 pull request, which is the leg no
//     script can run.
//
// Usage: node daemon/scripts/verify-supervised-write-scope.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  operationByTool,
  PROXY_OPERATIONS,
  refuseWriteOutsideCaller,
  refuseWriteOutsideSupervision,
  supervisionFieldsFrom
} from '../dist/atlassian-proxy.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
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

/** The two writes KAN-633 widened, named here so §1 can measure rather than assume. */
const EXPECTED_SUPERVISED = ['atlassian_transition_issue', 'atlassian_add_comment'];

const transition = operationByTool('atlassian_transition_issue');
const args = (issueKey) => ({ issueKey, transitionId: '31' });

/**
 * A board that answers from a table, and counts how many times it was asked.
 *
 * The count is not decoration. §2's claim is that the own-ticket path makes NO
 * board read, and "the gate returned null" is true whether or not it read —
 * so without the counter that section would assert the availability property it
 * names by measuring something else entirely.
 */
function boardOf(table) {
  const board = {
    calls: [],
    async issue(key) {
      board.calls.push(key);
      const row = table[key];
      if (!row) return { ok: false, detail: `no such issue ${key} in this fixture.` };
      return row;
    }
  };
  return board;
}

const says = (parent, linkedStories) => ({ ok: true, parent, linkedStories });
const cannotSay = (detail) => ({ ok: false, detail });

// ── 1. exactly the two writes this ticket argued for ───────────────────────
rule('1. the table grants supervised-ticket to exactly the operations KAN-633 argued for');

const supervised = PROXY_OPERATIONS.filter(
  (op) => op.writeScope && op.writeScope.kind === 'supervised-ticket'
).map((op) => op.tool);

console.log(`   supervised-ticket writes: ${supervised.join(', ') || '(none)'}`);

check(
  'the parse found supervised writes at all — a zero here makes every count below meaningless',
  supervised.length > 0,
  `found ${supervised.length}; if this is 0 the scope tag has been renamed and this file is asserting nothing`
);
check(
  'exactly the two operations KAN-633 widened carry it, and no third has been added quietly',
  JSON.stringify([...supervised].sort()) === JSON.stringify([...EXPECTED_SUPERVISED].sort()),
  `found ${JSON.stringify(supervised)}, expected ${JSON.stringify(EXPECTED_SUPERVISED)}`
);
check(
  'every supervised write is a write — the scope has not been hung on a read',
  PROXY_OPERATIONS.filter((op) => op.writeScope?.kind === 'supervised-ticket').every(
    (op) => op.method !== 'GET'
  ),
  'a GET carries supervised-ticket; reads are not bounded by this gate and never were'
);

// ── 2. the own-ticket half, and the availability property that hangs off it ─
rule('2. the caller\'s own ticket is decided WITHOUT a board read');

{
  const board = boardOf({});
  const verdict = await refuseWriteOutsideSupervision(
    transition,
    args('KAN-291'),
    { type: 'task', key: 'KAN-291' },
    board
  );
  check('an agent moving its own ticket is permitted', verdict === null, JSON.stringify(verdict));
  check(
    'and the board was never asked — a Jira outage cannot stop it',
    board.calls.length === 0,
    `the board was asked for ${JSON.stringify(board.calls)}; the fixture above answers nothing, ` +
      'so this call would fail closed during an outage that must not affect it'
  );
}

{
  // Case is not a licence, and it is not a refusal either: `issueKey` upper-cases
  // before it validates, so the comparison here has to as well.
  const board = boardOf({});
  const verdict = await refuseWriteOutsideSupervision(
    transition,
    args('kan-291'),
    { type: 'task', key: 'kan-291' },
    board
  );
  check(
    'a lower-case own key is the same ticket, still with no board read',
    verdict === null && board.calls.length === 0,
    JSON.stringify({ verdict, calls: board.calls })
  );
}

// ── 3. the parse, fed real Jira bodies rather than the shape it wants ──────
rule('3. supervisionFieldsFrom reads both link directions, and says when it cannot read');

const storyEnd = (key) => ({ key, fields: { issuetype: { name: 'Story' } } });
const taskEnd = (key) => ({ key, fields: { issuetype: { name: 'Task' } } });
/** `<this issue> blocks <story>` — the shape both briefs use as their worked example. */
const blocksStory = (key) => ({ type: { name: 'Blocks' }, outwardIssue: storyEnd(key) });
/** `<this issue> relates to <story>` — ordinary bookkeeping, and NOT a grant. */
const relatesStory = (key) => ({ type: { name: 'Relates' }, outwardIssue: storyEnd(key) });

check(
  'a `Blocks` link with the story as the OUTWARD end is found — the worked example',
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { parent: { key: 'KAN-39' }, issuelinks: [blocksStory('KAN-657')] }
    })
  ) === JSON.stringify({ parent: 'KAN-39', linkedStories: ['KAN-657'] }),
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { parent: { key: 'KAN-39' }, issuelinks: [blocksStory('KAN-657')] }
    })
  )
);
// ⚠ THE CHECK THIS SECTION EXISTS FOR SINCE `story/KAN-657`'s FINDING.
// `prompts/story.md` tells a story agent to "link liberally — all four standard
// types", naming `Relates` for loose association. If `Relates` conferred
// supervision, that instruction would be an instruction to grant yourself write
// access — and it did, and three live instances were created by accident in one
// evening before anybody noticed.
check(
  '⚠ a `Relates` link to a story confers NOTHING — the brief tells agents to make these',
  JSON.stringify(
    supervisionFieldsFrom({ fields: { issuelinks: [relatesStory('KAN-657')] } })
  ) === JSON.stringify({ parent: null, linkedStories: [] }),
  JSON.stringify(supervisionFieldsFrom({ fields: { issuelinks: [relatesStory('KAN-657')] } }))
);
for (const t of ['Duplicate', 'Cloners', 'relates', 'BLOCKS', '']) {
  check(
    `a link of type ${JSON.stringify(t)} to a story confers nothing`,
    supervisionFieldsFrom({
      fields: { issuelinks: [{ type: { name: t }, outwardIssue: storyEnd('KAN-657') }] }
    }).linkedStories.length === 0,
    JSON.stringify(
      supervisionFieldsFrom({
        fields: { issuelinks: [{ type: { name: t }, outwardIssue: storyEnd('KAN-657') }] }
      })
    )
  );
}
check(
  'an INWARD `Blocks` story confers nothing — that is a story blocking a task, the opposite claim',
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { issuelinks: [{ type: { name: 'Blocks' }, inwardIssue: storyEnd('KAN-612') }] }
    })
  ) === JSON.stringify({ parent: null, linkedStories: [] }),
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { issuelinks: [{ type: { name: 'Blocks' }, inwardIssue: storyEnd('KAN-612') }] }
    })
  )
);
check(
  'a linked TASK is not a story and does not become a supervisor',
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: taskEnd('KAN-624') }] }
    })
  ) === JSON.stringify({ parent: null, linkedStories: [] }),
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: taskEnd('KAN-624') }] }
    })
  )
);
// ⚠ THE THREE LIVE INSTANCES, AS FIXTURES. `story/KAN-657` created these on
// 2026-08-21 by following its brief, and reported them against this PR. They
// are reproduced by KEY so that a later widening which re-admits `Relates`
// reddens on the real tickets it would have captured, not on an invented one.
for (const key of ['KAN-282', 'KAN-573', 'KAN-634']) {
  check(
    `⚠ ${key} — a real accidental \`Relates\` to KAN-657 — grants KAN-657 nothing`,
    supervisionFieldsFrom({
      fields: { parent: { key: 'KAN-39' }, issuelinks: [relatesStory('KAN-657')] }
    }).linkedStories.includes('KAN-657') === false,
    `${key} would be writable by story/KAN-657 on the strength of bookkeeping it was told to do`
  );
}
// The positive control for the five refusals above: the same parse, one field
// different, says YES. Without it a parse that returned [] for everything would
// satisfy all of them.
check(
  'and the same fixture with type `Blocks` IS a grant — the refusals above are not vacuous',
  supervisionFieldsFrom({
    fields: { parent: { key: 'KAN-39' }, issuelinks: [blocksStory('KAN-657')] }
  }).linkedStories.includes('KAN-657'),
  'the parse refuses every link type, so the whole story branch is dead'
);
check(
  'keys are upper-cased on the way out, so a lower-case link is still a match',
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { parent: { key: 'kan-39' }, issuelinks: [blocksStory('kan-657')] }
    })
  ) === JSON.stringify({ parent: 'KAN-39', linkedStories: ['KAN-657'] }),
  JSON.stringify(
    supervisionFieldsFrom({
      fields: { parent: { key: 'kan-39' }, issuelinks: [blocksStory('kan-657')] }
    })
  )
);
check(
  'an issue with genuinely neither reads as neither, rather than as unreadable',
  JSON.stringify(supervisionFieldsFrom({ fields: {} })) ===
    JSON.stringify({ parent: null, linkedStories: [] }),
  JSON.stringify(supervisionFieldsFrom({ fields: {} }))
);
// ⚠ THE DISTINCTION THIS WHOLE FUNCTION EXISTS FOR. A body it cannot read must
// NOT come back as an issue with no parent and no links: the first is refused
// for want of an answer and retried, the second is refused as an answer and
// sends the agent off to fix a link that may already be there.
for (const [label, body] of [
  ['a body with no fields object', { key: 'KAN-1' }],
  ['a body that is null', null],
  ['a body that is a string', 'KAN-1'],
  ['a fields that is an array', { fields: [] }]
]) {
  check(
    `${label} is unreadable (null), NOT an empty result`,
    supervisionFieldsFrom(body) === null,
    JSON.stringify(supervisionFieldsFrom(body))
  );
}

// ── 4. the decision itself, both answers and the outage ────────────────────
rule('4. the gate permits the approver, refuses everyone else, and fails CLOSED');

{
  // The worked example from `prompts/story.md`: task KAN-234, parent epic
  // KAN-39, link `KAN-234 blocks KAN-150` — and it is story/KAN-150's to
  // approve on the strength of that link.
  const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
  check(
    'the story named by the link may transition the task it approves',
    (await refuseWriteOutsideSupervision(
      transition,
      args('KAN-234'),
      { type: 'story', key: 'KAN-150' },
      board
    )) === null,
    'the widening does not permit the one case it was written for: every refusal below is vacuous'
  );
}
{
  const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
  check(
    'the parent epic may transition it too — the second branch of merge governance',
    (await refuseWriteOutsideSupervision(
      transition,
      args('KAN-234'),
      { type: 'epic', key: 'KAN-39' },
      board
    )) === null,
    'the parent branch is refused; an epic could not close a task that has no story'
  );
}
{
  const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
  const verdict = await refuseWriteOutsideSupervision(
    transition,
    args('KAN-234'),
    { type: 'story', key: 'KAN-107' },
    board
  );
  check(
    'a story the board does NOT link to the task is refused — AC 3',
    verdict?.reason === 'not-your-supervisee',
    JSON.stringify(verdict)
  );
  check(
    'and the refusal prints what the board actually said, so the gap is fixable',
    Boolean(verdict) &&
      verdict.error.includes('KAN-39') &&
      verdict.error.includes('KAN-150') &&
      verdict.error.includes('KAN-234'),
    verdict?.error
  );
  check(
    'and it says the write did not happen',
    Boolean(verdict) && /Nothing was\s+sent to Atlassian|Nothing was sent to Atlassian/.test(verdict.error),
    verdict?.error
  );
}
{
  // A near-miss key must not pass. Substring or prefix comparison would let a
  // story for KAN-15 supervise a task linked to KAN-150.
  for (const near of ['KAN-15', 'KAN-1500', 'KAN-150X', 'XKAN-150']) {
    const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
    check(
      `a caller ${JSON.stringify(near)} cannot supervise KAN-234 by resembling KAN-150`,
      (
        await refuseWriteOutsideSupervision(
          transition,
          args('KAN-234'),
          { type: 'story', key: near },
          board
        )
      )?.reason !== undefined,
      'a near-miss key was permitted'
    );
  }
}
{
  // ⚠ THE FAIL-CLOSED BRANCH. KAN-291 rejected a subtree scope partly because
  // it could not answer this, and the answer has to be visible in a test or it
  // is a sentence in a docblock: a board that cannot be read refuses, and says
  // it is refusing for want of an answer rather than answering no.
  const board = boardOf({ 'KAN-234': cannotSay('Atlassian answered 503.') });
  const verdict = await refuseWriteOutsideSupervision(
    transition,
    args('KAN-234'),
    { type: 'story', key: 'KAN-150' },
    board
  );
  check(
    'an unreadable board REFUSES — it does not fall open',
    verdict?.reason === 'supervision-unreadable',
    JSON.stringify(verdict)
  );
  check(
    'the refusal carries what the board said, rather than swallowing it',
    Boolean(verdict) && verdict.error.includes('Atlassian answered 503.'),
    verdict?.error
  );
  check(
    'and it says this is a refusal for want of an answer, so the agent retries rather than concluding',
    Boolean(verdict) && /RATHER THAN AN ANSWER/.test(verdict.error) && /retry/i.test(verdict.error),
    verdict?.error
  );
  check(
    'and it tells the agent its OWN ticket is unaffected, which is the half that stays working',
    Boolean(verdict) && verdict.error.includes('KAN-150 are decided without this read'),
    verdict?.error
  );
}
{
  // The outage must not reach the own-ticket path. This is the same dead board,
  // asked about the caller's own key.
  const board = boardOf({ 'KAN-150': cannotSay('Atlassian answered 503.') });
  check(
    'the same dead board does not stop an agent moving its OWN ticket',
    (await refuseWriteOutsideSupervision(
      transition,
      args('KAN-150'),
      { type: 'story', key: 'KAN-150' },
      board
    )) === null,
    "an outage reached the own-ticket path, which is the horn of KAN-291's dilemma this design claims to have removed"
  );
}
{
  // A caller with no Jira key at all — a `confluence` workspace is keyed by a
  // page id — is refused before any read, exactly as in the first gate.
  const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
  const verdict = await refuseWriteOutsideSupervision(
    transition,
    args('KAN-234'),
    { type: 'confluence', key: '163933' },
    board
  );
  check(
    'a caller whose key is not a Jira issue is refused, and told why',
    verdict?.reason === 'caller-has-no-ticket',
    JSON.stringify(verdict)
  );
  check('and no board read was made on its behalf', board.calls.length === 0, JSON.stringify(board.calls));
}
{
  const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
  check(
    "an unidentified caller is refused — a supervised write is never made on nobody's behalf",
    (await refuseWriteOutsideSupervision(transition, args('KAN-234'), null, board))?.reason ===
      'caller-has-no-ticket',
    JSON.stringify(await refuseWriteOutsideSupervision(transition, args('KAN-234'), null, board))
  );
}
{
  // The gate has no opinion about anything that is not a supervised write, and
  // it must not acquire one: an own-ticket write refused HERE would be refused
  // twice for one reason, and a read refused here would break the read surface.
  const board = boardOf({});
  const others = PROXY_OPERATIONS.filter((op) => op.writeScope?.kind !== 'supervised-ticket');
  const verdicts = [];
  for (const op of others) {
    verdicts.push(
      await refuseWriteOutsideSupervision(op, args('KAN-150'), { type: 'task', key: 'KAN-291' }, board)
    );
  }
  check(
    `the gate leaves all ${others.length} other operations alone, reads included`,
    verdicts.every((v) => v === null) && board.calls.length === 0,
    JSON.stringify({ refused: verdicts.filter(Boolean).length, calls: board.calls })
  );
}

// ── 5. the wiring — READ AS TEXT, so a failed build does not invalidate it ──
//
// The two gates are two calls in one method, and the second is the only thing
// bounding a supervised write: the first returns `null` for the cross-ticket
// case by design. So "is it still called" is a property worth a check of its
// own, exactly as KAN-587 established for the first call.
rule('5. router.ts calls BOTH gates, and both before it sends anything (source text)');

const routerSrc = fs.readFileSync(path.join(repoRoot, 'daemon/src/router.ts'), 'utf8');
const handlerStart = routerSrc.indexOf('private async handleAtlassianProxyCall(');
const handlerBody = handlerStart === -1 ? null : routerSrc.slice(handlerStart, handlerStart + 12000);

check(
  'handleAtlassianProxyCall was located — §5 asserts nothing until this is repaired',
  handlerBody !== null,
  'the method has been renamed or moved; every check below is vacuous'
);

if (handlerBody) {
  const identityGate = handlerBody.indexOf('refuseWriteOutsideCaller(operation, args, callerIdentity)');
  const supervisionGate = handlerBody.indexOf('refuseWriteOutsideSupervision(');
  const send = handlerBody.indexOf('this.jira.proxyWrite(');

  check(
    'the identity gate is called in the handler',
    identityGate !== -1,
    'no call to `refuseWriteOutsideCaller(operation, args, callerIdentity)` in the handler body'
  );
  check(
    'the supervision gate is called in the handler',
    supervisionGate !== -1,
    'no call to `refuseWriteOutsideSupervision(` in the handler body — the two supervised ' +
      'writes are now bounded by NOTHING, because the identity gate returns null for them'
  );
  check(
    'the supervision gate is awaited rather than dropped on the floor',
    /await refuseWriteOutsideSupervision\(/.test(handlerBody),
    'the call is not awaited; an un-awaited promise refuses nothing and the write proceeds'
  );
  check(
    'its verdict is acted on rather than computed and discarded',
    /if \(supervisionRefusal\) \{[\s\S]{0,200}?return;/.test(handlerBody),
    'no `if (supervisionRefusal) { … return; }` follows the call'
  );
  check(
    'the write is sent in this handler at all — the positive control for the ordering below',
    send !== -1,
    'no `this.jira.proxyWrite(` found; the ordering checks would pass vacuously'
  );
  check(
    'both gates run BEFORE anything is sent to Atlassian',
    identityGate !== -1 &&
      supervisionGate !== -1 &&
      send !== -1 &&
      identityGate < send &&
      supervisionGate < send,
    JSON.stringify({ identityGate, supervisionGate, send })
  );
}

// ── 6. positive control — the instrument was shown saying yes ──────────────
//
// Almost every assertion above is that something is refused, and a gate that
// refused EVERY input would satisfy most of them while making the two widened
// writes unusable. §4's first two checks are the yes; this repeats it for the
// comment operation, which §4 never exercises, so a widening that reached only
// the transition cannot pass as both.
rule('6. positive control — the comment operation is really served, not merely tagged');

{
  const comment = operationByTool('atlassian_add_comment');
  const commentArgs = (issueKey) => ({ issueKey, bodyMarkdown: 'ruling: rebase first.' });
  const board = boardOf({ 'KAN-234': says('KAN-39', ['KAN-150']) });
  check(
    'a story may comment on the task it approves — the ruling reaches where that task reads it',
    (await refuseWriteOutsideSupervision(
      comment,
      commentArgs('KAN-234'),
      { type: 'story', key: 'KAN-150' },
      board
    )) === null,
    'the comment half of the widening is refused; a story still cannot put a ruling on its task'
  );
  check(
    'and the identity gate does not refuse it first, which would make the above unreachable in production',
    refuseWriteOutsideCaller(comment, commentArgs('KAN-234'), { type: 'story', key: 'KAN-150' }) === null,
    JSON.stringify(
      refuseWriteOutsideCaller(comment, commentArgs('KAN-234'), { type: 'story', key: 'KAN-150' })
    )
  );
  const stranger = boardOf({ 'KAN-999': says('KAN-40', []) });
  check(
    "and a comment on a stranger's ticket is still refused — the yes above is not a blanket yes",
    (
      await refuseWriteOutsideSupervision(
        comment,
        commentArgs('KAN-999'),
        { type: 'story', key: 'KAN-150' },
        stranger
      )
    )?.reason === 'not-your-supervisee',
    JSON.stringify(
      await refuseWriteOutsideSupervision(
        comment,
        commentArgs('KAN-999'),
        { type: 'story', key: 'KAN-150' },
        stranger
      )
    )
  );
}

console.log(
  `\n${failures ? 'FAILED' : 'OK'} — the supervised write scope is the approver relation, ` +
    "decided without a read for the caller's own ticket and failing closed for everything else. " +
    'The instrument was shown saying yes in the same run.'
);
if (failures) console.log(`${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
