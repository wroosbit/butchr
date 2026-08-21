// KAN-600: `daemon/src/declared-approver.ts` and `daemon/scripts/lib/approval-marker.mjs`
// answer the same question the same way — WHO does this pull request body declare
// as its approver?
//
// WHAT FAILURE THIS WOULD CATCH: the two spellings of one grammar drifting, so
// that the required `approval-recorded` gate and the pull-request watcher
// disagree about who a pull request's approver is. The shape that would produce
// is quiet and confusing in exactly the wrong way: the watcher routes a
// `green-idle` at an agent the gate will not accept a marker from, or refuses to
// route at all while the gate is perfectly happy — and both look like a
// notification problem rather than a parsing one.
//
// WHY THERE ARE TWO AT ALL, since a shared module would need no proof. The gate
// runs in CI from a checkout with no `dist` and is a `.mjs` with no type
// declarations; the daemon is TypeScript under `daemon/src` compiled to
// `daemon/dist`. Importing either from the other couples a required check to a
// build step it does not have, or the daemon's type-checking to a file that
// carries no types. The duplication was chosen; THIS is what pays for it.
//
// WHAT THIS DOES NOT ESTABLISH, stated because the name promises more than it
// covers: it compares the two implementations against EACH OTHER over a corpus
// this file wrote. It cannot tell you that both are right — two identical
// mistakes pass it. What it can tell you, and what it exists for, is that a
// change to one of them is a change to both. The cases below are the KAN-321
// use-versus-mention set plus this ticket's own; the gate's own behaviour is
// asserted by `verify-approval-recorded.mjs`, and the watcher's by
// `verify-pr-watch-approver-routing.mjs` §6.
//
// CI-RUNNABLE: yes — it imports the built daemon module and the `.mjs` library
// and compares them in process; no network, no credential, no `gh`, no daemon.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-declared-approver-parity.mjs [dist]

import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', process.argv[2] ?? 'dist');

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const ts = await import(path.join(distDir, 'declared-approver.js'));
const gate = await import(path.join(scriptDir, 'lib', 'approval-marker.mjs'));

/**
 * The corpus. Every entry is a whole pull-request body, because the scanner is
 * stateful across lines — a fence opened on line 3 governs line 9 — so a corpus
 * of single lines would exercise none of what actually goes wrong.
 */
const CORPUS = [
  ['nothing at all', ''],
  ['prose with no declaration', 'Fixes KAN-1.\n\nNothing to declare here.'],
  ['a plain declaration', 'BUTCHR-APPROVER: epic/KAN-39'],
  ['a declaration among prose', 'Fixes KAN-1.\n\nBUTCHR-APPROVER: story/KAN-117\n\nCheers.'],
  ['lower case keyword', 'butchr-approver: epic/KAN-39'],
  ['leading spaces, but fewer than four', '   BUTCHR-APPROVER: epic/KAN-39'],
  ['leading tab', '\tBUTCHR-APPROVER: epic/KAN-39'],
  ['indented four spaces', '    BUTCHR-APPROVER: epic/KAN-39'],
  ['trailing whitespace', 'BUTCHR-APPROVER: epic/KAN-39   '],
  ['two values on one line', 'BUTCHR-APPROVER: epic/KAN-39 story/KAN-117'],
  ['inside a ``` fence', '```\nBUTCHR-APPROVER: epic/KAN-39\n```'],
  ['inside a fence with an info string', '```text\nBUTCHR-APPROVER: epic/KAN-39\n```'],
  ['inside a ~~~ fence', '~~~\nBUTCHR-APPROVER: epic/KAN-39\n~~~'],
  ['a ``` block nested in a ```` block', '````\n```\nBUTCHR-APPROVER: epic/KAN-39\n```\n````'],
  ['an unclosed fence runs to the end', 'intro\n```\nBUTCHR-APPROVER: epic/KAN-39'],
  ['blockquoted', '> BUTCHR-APPROVER: epic/KAN-39'],
  ['doubly blockquoted', '> > BUTCHR-APPROVER: epic/KAN-39'],
  ['in a one-line HTML comment', '<!-- BUTCHR-APPROVER: epic/KAN-39 -->'],
  ['in a multi-line HTML comment', '<!--\nBUTCHR-APPROVER: epic/KAN-39\n-->'],
  ['after a closed HTML comment', '<!-- ignore me -->\nBUTCHR-APPROVER: epic/KAN-39'],
  [
    'an EXAMPLE above the real declaration',
    'Write it like this:\n\n```\nBUTCHR-APPROVER: epic/KAN-39\n```\n\nBUTCHR-APPROVER: story/KAN-117'
  ],
  [
    'a real declaration above an example',
    'BUTCHR-APPROVER: story/KAN-117\n\nFor reference:\n\n```\nBUTCHR-APPROVER: epic/KAN-39\n```'
  ],
  [
    'a full PR body of the shape this fleet writes',
    [
      '## KAN-600',
      '',
      'Jira: https://wroosbit.atlassian.net/browse/KAN-600',
      '',
      'BUTCHR-APPROVER: epic/KAN-39',
      '',
      '### Proof',
      '',
      '```',
      '$ node daemon/scripts/verify-pr-watch-approver-routing.mjs',
      'BUTCHR-APPROVER: story/KAN-117   <- pasted output, not a declaration',
      '```'
    ].join('\n')
  ],
  ['CRLF line endings', 'Fixes KAN-1.\r\n\r\nBUTCHR-APPROVER: epic/KAN-39\r\n'],
  ['a keyword that is not a declaration', 'BUTCHR-APPROVAL: ' + 'a'.repeat(40) + ' BY epic/KAN-39'],
  ['the keyword with no value', 'BUTCHR-APPROVER:'],
  ['the keyword with a trailing word', 'BUTCHR-APPROVER: epic/KAN-39 (thanks!)']
];

rule('1. The two parsers answer identically on every body in the corpus');

{
  console.log('');
  const wrong = [];
  for (const [name, body] of CORPUS) {
    const mine = ts.declaredApproverOf(body);
    const theirs = gate.parseDeclaredApprover(body);
    const same = mine === theirs;
    if (!same) wrong.push({ name, mine, theirs });
    console.log(
      `  ${same ? ' ' : '✗'} ${name.padEnd(46)} ${JSON.stringify(mine)}` +
      (same ? '' : `   gate says ${JSON.stringify(theirs)}`)
    );
  }

  console.log('');
  verdict(
    wrong.length === 0,
    `${CORPUS.length} bodies, one answer each — the watcher and the required gate agree ` +
      'about who every one of them declares',
    `${wrong.length} disagreement(s): ` +
      wrong.map((w) => `${w.name} (${JSON.stringify(w.mine)} vs ${JSON.stringify(w.theirs)})`).join('; ')
  );
}

rule('2. And they label HOW a body carried a line it did not assert, identically');

{
  // `scanQuoted` is what the answers above are derived from, so a corpus that
  // only compares the final verdict would pass while the two disagreed about
  // every line of a body that happens to declare nobody either way. Comparing
  // the labels is what makes §1's agreement mean something.
  console.log('');
  const wrong = [];
  for (const [name, body] of CORPUS) {
    const mine = ts.scanQuoted(body);
    const theirs = gate.scanQuoted(body);
    const same = JSON.stringify(mine) === JSON.stringify(theirs);
    if (!same) wrong.push({ name, mine, theirs });
    // One letter per line: F fenced, I indented, Q blockquote, H HTML comment,
    // `.` the body speaking in its own voice. Not `q[0]` — all four labels begin
    // with "a", so that rendering printed the same letter for every context and
    // showed nothing.
    const LETTER = {
      [ts.QUOTED_AS.FENCED_CODE]: 'F',
      [ts.QUOTED_AS.INDENTED_CODE]: 'I',
      [ts.QUOTED_AS.BLOCKQUOTE]: 'Q',
      [ts.QUOTED_AS.HTML_COMMENT]: 'H'
    };
    const labels = mine.map((q) => (q ? (LETTER[q] ?? '?') : '.')).join('');
    console.log(`  ${same ? ' ' : '✗'} ${name.padEnd(46)} ${labels || '(no lines)'}`);
  }

  // A positive control for §2, because a comparison of two empty things is a
  // comparison that cannot fail: at least one body must actually produce a
  // non-null label, or this section is measuring nothing.
  const anyQuoted = CORPUS.some(([, body]) => ts.scanQuoted(body).some((q) => q !== null));
  const allFour = new Set(
    CORPUS.flatMap(([, body]) => ts.scanQuoted(body)).filter(Boolean)
  );

  console.log('');
  console.log(`  contexts the corpus actually exercises: ${[...allFour].join(', ')}`);
  verdict(
    wrong.length === 0 && anyQuoted && allFour.size === 4,
    'every line of every body gets the same label from both, and the corpus exercises all ' +
      'four quoting contexts rather than agreeing about nothing',
    `${wrong.length} disagreement(s); anyQuoted=${anyQuoted}; contexts=${allFour.size}/4`
  );
}

rule('3. A drift WOULD be caught — the check is shown failing on a planted difference');

{
  // §1 and §2 compare two implementations and pass. Neither says the comparison
  // is capable of failing, and a parity check that cannot go red is worse than
  // none: it is a green nobody will question. So one is driven red here, on a
  // parser deliberately made to disagree about the one case KAN-321 was filed
  // for — a fenced example being read as a declaration.
  const drifted = (body) => {
    const m = /^[ \t]*BUTCHR-APPROVER:[ \t]+(\S+)[ \t]*$/im.exec(String(body ?? ''));
    return m ? m[1] : null;
  };

  const disagreements = CORPUS.filter(
    ([, body]) => drifted(body) !== gate.parseDeclaredApprover(body)
  );

  console.log('');
  console.log('  a parser without the use/mention scan, over the same corpus:\n');
  for (const [name, body] of disagreements) {
    console.log(
      `    ${name.padEnd(46)} ${JSON.stringify(drifted(body))}   gate says ` +
      `${JSON.stringify(gate.parseDeclaredApprover(body))}`
    );
  }

  console.log('');
  verdict(
    disagreements.length > 0,
    `the corpus separates a use/mention-aware parser from one without it on ` +
      `${disagreements.length} bodies, so §1 is a comparison that can fail`,
    'the corpus contains no body that a parser missing the use/mention scan would get ' +
      'wrong, so §1 would pass against a broken implementation'
  );
}

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`);
console.log(
  '  The daemon and the required `approval-recorded` gate read the same line the same way.\n' +
  '  This compares them against each other and never against the truth: two identical\n' +
  '  mistakes pass it, and what it buys is that a change to one is a change to both.'
);

process.exit(failures ? 1 : 0);
