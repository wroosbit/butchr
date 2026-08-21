// KAN-119: every `verify-` script in this repository must be able to fail.
//
// WHAT FAILURE THIS WOULD CATCH: a `verify-` script that cannot report failure
// — no exit path at all, or exits that are only setup guards — being added or
// reintroduced. Five such scripts were in this repository at once, four of them
// cited as evidence in real PR reviews, and one of them printed `FAILED` on
// screen while exiting 0. This sweep is named `sweep-` rather than `verify-`
// deliberately: it is not itself a proof of any product behaviour, so it has no
// business in the namespace it polices.
//
// WHY IT DOES NOT GREP
//
// The rule took four attempts to get right, and the first three each shipped a
// wrong answer:
//
//   1. Pattern-matching for failing-exit spellings — clears a script whose
//      `throw` or `assert` happens to match while it has no exit path at all.
//   2. Enumerating exit paths — counts an exit written into a fixture a script
//      puts on disk, or one merely described in a comment, and counts
//      "daemon/dist is missing" setup guards, as though any were a verdict.
//      Separating the script's own code from the text it contains is
//      `lib/mask-non-code.mjs`, and it is an exact question rather than a
//      heuristic one; KAN-535 has the three ways the counter that preceded it
//      got the answer wrong.
//   3. Reading each exit's *purpose* — separates a guard from a verdict, which
//      is what this file automates: it asks whether an exit's value is derived
//      from an accumulated verdict, not whether a non-zero exit exists.
//   4. Observing the script actually go red — the only test that separates a
//      verdict which can fire from one that cannot. **No tool can do this one.**
//      It is done by breaking the behaviour under test and watching the script
//      fail, and it must not be skipped because this sweep is green.
//
// So: passing this sweep is necessary and *not* sufficient. It answers "can
// this script report a failure at all", which is exactly the question the five
// broken scripts answered no to.
//
// ── KAN-373: AND THE SAME QUESTION ASKED OF SKIPS ──────────────────────────
//
// KAN-119 was three checks rendering a FAILURE as an all-clear. KAN-373 is the
// same defect with the sign flipped — an UNRUN SECTION rendered as one — and
// this sweep would have found it had it looked for skips as well as failures.
// It did not, so it did not. Six scripts held the shape at once: each tallied
// `skipped`, each ended `process.exit(failures ? 1 : 0)`, and that expression
// consults the skip tally not at all. A `CI-RUNNABLE: partial` proof whose live
// section skipped for want of a peer therefore exited 0, and a runner with no
// peer downgraded the gate to nothing while the build went green.
//
// So there is a third question here now, asked of the same masked code and in
// the same shape as the first: **if a script tallies skips, does any verdict
// exit read that tally?** A script with no skip tally is not asked, and a skip
// is never counted as a failure — the answer to an unrun section is a third
// exit code, which is `lib/verdict-exit.mjs`.
//
// ── KAN-561: WHERE "DOES ANY EXIT READ THAT TALLY" IS ANSWERED ────────────
//
// KAN-373 answered it against each verdict exit's EXPRESSION alone, and that
// is a false positive on the contract's most natural spelling:
//
//     if (skipped > 0 && !allowSkipped) process.exit(EXIT_INCOMPLETE);
//
// The tally is read — in the governing CONDITION, which is the one place the
// check did not look, and which KAN-540 had already built the machinery to
// read. It now consults both, over every exit path rather than only the
// verdicts, reusing `governingConditions` rather than a second implementation
// of containment.
//
// **A false positive on a required check is worse than a miss**, and that is
// why this was a defect rather than a refinement: it teaches agents to contort
// correct code to placate the gate, and the contorted shape outlives the fix
// while nobody remembers why it is shaped that way.
//
// ⚠ AND THE WIDENING IS THE HAZARD, so it is bounded rather than assumed: the
// discriminator is unchanged — a tally must be NAMED at an exit — so a script
// that increments `skipped` and mentions it nowhere near one is red exactly as
// before. `verify-exit-path-skip-consultation.mjs` drives that arm red, and it
// is the arm at risk.
//
// A skip-governed exit is scored a SKIP VERDICT: neither a guard (calling it
// one is what made the false positive unreadable) nor a failure verdict
// (`canFail` is KAN-119's question, and an exit reached only when something was
// skipped cannot report a failure). `classify` carries that argument in full.
//
// ⚠ WHAT THIS STILL CANNOT SEE, because the list above looks complete:
//
//   * A script that skips WITHOUT TALLYING — one that prints the word SKIP and
//     returns — is invisible to this check exactly as it is invisible to its
//     own exit code. Nothing covers that, here or elsewhere.
//   * Whether an exit that reads the tally then RENDERS it correctly.
//     `if (skipped > 0) process.exit(0)` consults the tally and swallows it,
//     and passes. It cannot be refused on its shape, because
//     `if (skipped > 0 && allowSkipped) process.exit(0)` is the legitimate
//     `--allow-skipped` arm and differs only in a term this sweep cannot
//     evaluate. `lib/verdict-exit.mjs` removes that class by being the one
//     implementation of the decision; a script that spells the verdict itself
//     is trusted here to spell it right.
//
// Both are named rather than left to be discovered from a green run.
//
// Usage: node daemon/scripts/sweep-verify-exit-paths.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sweepTree } from './lib/sweep-sources.mjs';
import { maskNonCode } from './lib/mask-non-code.mjs';
import {
  conditionalRegions,
  governingConditions,
  renderCondition
} from './lib/governing-conditions.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const SCRIPT_DIRS = ['daemon/scripts', 'extension/scripts'];

/**
 * Identifiers a script accumulates failures into. A verdict-driven exit is one
 * whose value is computed from one of these; anything else is a guard.
 */
const COUNTER = /\b(failures?|failed|problems|errors|violations|leaks|bad)\b/i;

/**
 * Identifiers a script accumulates SKIPS into (KAN-373).
 *
 * A skip is a section that did not run. It is not a failure and must not be
 * counted as one — but a verdict that never consults it cannot tell "the peer
 * proved it" from "nobody started a peer", and 0 is the value every caller
 * reads as "the gate held".
 */
const SKIP_COUNTER = /\b(skipped|skips|unrun|notRun|omitted)\b/i;

/**
 * A script may delegate its verdict to a shared helper rather than spell
 * `process.exit` itself. `lib/verdict-exit.mjs` is that helper, and six scripts
 * end in it since KAN-373.
 *
 * ⚠ THE LIMIT, AND IT FAILS SAFE: this reads ONE LINE, so a `reportAndExit(`
 * call broken across lines is not matched — and an unmatched call means the
 * script shows NO verdict exit and this sweep goes RED. Loud and wrong beats
 * quiet and wrong, which is the direction every rule in this file leans.
 */
const DELEGATED = /\breportAndExit\s*\(([^;]*)\)/;

/**
 * Every `process.exit(...)` / `process.exitCode = ...`, with its line AND its
 * character offset.
 *
 * KAN-540 added `index`. A line number is enough to PRINT an exit and not
 * enough to place it in the control flow: `if (failures) process.exit(1)` puts
 * the condition and the exit on one line, so the question "is this exit inside
 * that `if`'s body" is only answerable against offsets.
 */
function exitPaths(source) {
  const found = [];
  const lines = source.split('\n');
  let offset = 0;
  lines.forEach((line, i) => {
    const exitCall = line.match(/process\.exit\s*\(([^;]*)\)/);
    if (exitCall)
      found.push({
        line: i + 1,
        index: offset + exitCall.index,
        kind: 'exit',
        expr: exitCall[1].trim(),
        text: line.trim()
      });
    const exitCode = line.match(/process\.exitCode\s*=\s*([^;]+)/);
    if (exitCode)
      found.push({
        line: i + 1,
        index: offset + exitCode.index,
        kind: 'exitCode',
        expr: exitCode[1].trim(),
        text: line.trim()
      });
    // KAN-373. Carries `index` for the same reason KAN-540 added it to the two
    // above: containment is answered against offsets, never against lines.
    const delegated = line.match(DELEGATED);
    if (delegated)
      found.push({
        line: i + 1,
        index: offset + delegated.index,
        kind: 'delegated',
        expr: delegated[1].trim(),
        text: line.trim()
      });
    offset += line.length + 1;
  });
  return found;
}

/**
 * An expression with its object KEYS removed, leaving only what it REFERENCES.
 *
 * ⚠ Written because the first version of the KAN-373 check was fooled by its
 * own subject matter. `reportAndExit({ failures: 0, skipped: 0 })` cannot report
 * anything — both tallies are literals — and it PASSED, because the words
 * `failures` and `skipped` were present as KEY NAMES. That is exactly the
 * "pattern-matching for failing-exit spellings" this file's header retires as
 * attempt 1, reintroduced one level down. It was caught by driving the new
 * check red, and by nothing else.
 *
 * `{ failures, skipped }` is shorthand — no colon — so both survive and it is
 * a verdict. `{ failures: 0 }` loses `failures:` and leaves `0`, which
 * references nothing. `{ failures: myCount }` leaves `myCount`, judged on its
 * own name.
 */
function references(expr) {
  return expr.replace(/\b[A-Za-z_$][\w$]*\s*:/g, ' ');
}

/**
 * The identifiers this script increments as a skip tally, if any.
 *
 * Asked of the MASKED copy, so the word "skipped" in a comment or in a printed
 * message is not mistaken for a counter — which is the whole reason this file
 * does not grep.
 */
function skipTallies(code) {
  const found = new Set();
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\+\+|\+=\s*1)/g)) {
    if (SKIP_COUNTER.test(m[1])) found.add(m[1]);
  }
  return [...found];
}

/**
 * The innermost condition governing an exit whose text matches `pattern`, or
 * null if no condition reaching that exit does.
 *
 * `exit(1)` says nothing on its own — `if (failures) process.exit(1)` is a
 * verdict and `if (!existsSync(dist)) process.exit(1)` is a guard, and the
 * difference is entirely in the condition that reaches it. Reading only the
 * exit's argument misclassified verify-agent-resumption on this sweep's first
 * run: the whole point of level 3 is that the argument is not where the meaning
 * lives.
 *
 * KAN-540 REPLACED A SIX-LINE WINDOW WITH CONTAINMENT. This used to return the
 * text after the first `if (` within six lines ABOVE the exit, and check
 * nothing about whether the exit was inside that `if`'s body. Proximity was
 * taken for control flow, so a five-line script whose only exit was
 * unconditional passed this required check. `lib/governing-conditions.mjs`
 * carries the reproduction and the argument; what matters here is that the
 * condition text now comes from a balanced parenthesis match and from nowhere
 * else, so this sweep no longer has a code path that can mistake a line
 * fragment for a condition.
 *
 * The chain is searched innermost-outward rather than only at its innermost
 * link: an exit inside `if (failures) { if (verbose) { … } }` is reached only
 * when `failures`, and the nearest `if` is not the governing one.
 *
 * KAN-561 MADE THE PATTERN A PARAMETER. It was `COUNTER` and nothing else, so
 * the skip question below could not ask this the one thing it needed to know.
 * The parameter is the whole of the change — the containment, the chain order
 * and the innermost-first answer are `governingConditions`' and are untouched.
 */
function governingConditionMatching(regions, index, pattern) {
  // Written as a loop rather than `.find(…) ?? null` deliberately: `find`
  // answers `undefined`, and a `?? null` normalising it is exactly the fallback
  // constant `sweep-script-text-hazards.mjs` refuses — and getting it wrong
  // here fails toward calling every exit a verdict, since `undefined !== null`.
  for (const cond of governingConditions(regions, index)) {
    if (pattern.test(cond)) return cond;
  }
  return null;
}

/**
 * The skip tallies an exit path actually CONSULTS — named in its own
 * expression, or in any condition that governs it.
 *
 * ── KAN-561: WHY THE CONDITION COUNTS, AND WHY IT DID NOT ─────────────────
 *
 * KAN-373's check asked only whether a tally appeared in a verdict exit's
 * EXPRESSION, so the most natural spelling of the tri-state contract —
 *
 *     if (skipped > 0 && !allowSkipped) process.exit(EXIT_INCOMPLETE);
 *
 * — was reported as `tallies \`skipped\`, and no exit reads it`. The tally is
 * read. It is read in the one place the check did not look, and KAN-540 had
 * already built the machinery to look there: `governingConditions`, used one
 * function above for the `failures` question. Two things compounded to hide
 * it — the exit's argument is a named constant and its condition names no
 * `failures`-style counter, so it was not scored a verdict at all, and only
 * verdicts were searched.
 *
 * ⚠ A FALSE POSITIVE ON A REQUIRED CHECK IS WORSE THAN A MISS, which is why
 * this is a defect and not a refinement: it teaches agents to contort correct
 * code to placate the gate, and the contorted shape outlives the fix while
 * nobody remembers why it is shaped that way. #247's author took the
 * documented precaution against exactly this — writing the spelling whose
 * CONDITION names the counter, because the sweep cannot follow a constant —
 * and that was the one spelling this check could not read.
 *
 * ⚠ THE SET SEARCHED IS EVERY EXIT PATH, NOT ONLY THE VERDICTS. An exit that
 * names the tally lets it reach the exit code whatever else that exit is; the
 * old restriction to `verdicts` was the second half of the same blind spot.
 * This does NOT widen the check into uselessness, and the discriminator is
 * unchanged: the tally must be named at an exit. A script that increments
 * `skipped` and mentions it nowhere near one is red exactly as before, which
 * is the arm at risk and the one driven red in
 * `verify-exit-path-skip-consultation.mjs` §2.
 *
 * ⚠ WHAT THIS STILL CANNOT SEE, named because the paragraph above reads as a
 * completeness claim: this answers whether the tally REACHES an exit, never
 * whether the exit then renders it correctly. `if (skipped > 0) process.exit(0)`
 * consults the tally and swallows it, and passes here. It cannot be refused on
 * its shape, because `if (skipped > 0 && allowSkipped) process.exit(0)` is the
 * legitimate `--allow-skipped` arm and differs only in a term this sweep has no
 * way to evaluate. `lib/verdict-exit.mjs` is what removes that whole class by
 * being the one implementation of the decision; a script that spells the
 * verdict itself is trusted here to spell it right.
 *
 * `references` is applied to conditions for the same reason it is applied to
 * expressions — a tally spelled as an object KEY has not been read. Its one
 * edge on a condition is `cond ? skipped : other`, where the key-stripping
 * regex eats a genuine reference; that direction is RED, which is loud rather
 * than quietly permissive, and it is the direction every rule in this file
 * leans.
 */
function consultedTallies(entry, regions, tallies) {
  const texts = [
    references(entry.expr),
    ...governingConditions(regions, entry.index).map(references)
  ];
  return tallies.filter((t) => texts.some((s) => new RegExp(`\\b${t}\\b`).test(s)));
}

/**
 * Is this exit a failure verdict, a SKIP verdict, or a guard?
 *
 * A verdict's value — or the condition that reaches it — is derived from
 * accumulated state: `exit(failures ? 1 : 0)`, `exitCode = ok ? 0 : 1`,
 * `if (failures) process.exit(1)`. A guard's is a literal reached at a point
 * where the script has decided it cannot run at all.
 *
 * The `process.exitCode` idiom counts as a verdict when the assignment is
 * conditional or computed: setting it to 1 from inside a check and then ending
 * naturally is how eight of these scripts legitimately report failure.
 *
 * ── KAN-561 AC3: A SKIP-GOVERNED EXIT IS A THIRD THING, AND THE DECISION IS
 *    RECORDED HERE BECAUSE BOTH OTHER ANSWERS DESTROY SOMETHING ────────────
 *
 * `if (skipped > 0 && !allowSkipped) process.exit(EXIT_INCOMPLETE)` was scored
 * a GUARD, and the diagnostic it printed — *"literal exit — a setup guard or a
 * usage error"* — is not merely unhelpful, it is false about the one exit that
 * implements the contract. So it is not a guard.
 *
 * ⚠ NOR IS IT A FAILURE VERDICT, and this is the half that had to be got right
 * rather than widened into. `canFail` is KAN-119's question — *can this script
 * report a FAILURE at all* — and an exit reachable only when something was
 * SKIPPED cannot report one. Scoring it a verdict would hand a `canFail: true`
 * to a script whose only exit is `if (skipped) process.exit(2)`, which asserts
 * nothing and can never go red on a failing assertion. That is KAN-119's defect
 * with the classifier's own vocabulary, reintroduced by the fix to KAN-373 —
 * the exact "widening is how it stops discriminating" this ticket names.
 *
 * So: **a skip verdict is a verdict about SKIPS and about nothing else.** It
 * does not count toward `canFail`, it does count as consulting the tally, and
 * it is reported under its own label so a reader is never told a real exit is a
 * setup guard. The two questions this file asks — *can it fail* and *do its
 * skips reach the exit code* — needed two sets, and had one.
 *
 * A condition naming BOTH (`if (failures || skipped)`) is a failure verdict:
 * the failure arm is the loudest true statement about it, which is the same
 * precedence `lib/verdict-exit.mjs` gives 1 over 2.
 *
 * ⚠ THE OVERRIDE IS APPLIED LAST, AND ONLY OVER A NON-VERDICT, WHICH IS NOT A
 * TIDINESS CHOICE — it is the fix for a defect this change introduced and a
 * measurement caught. Written as an early branch it fires on the CONDITION
 * alone, and two shapes go wrong in opposite directions:
 *
 *   if (skipped > 0) process.exit(failures ? 1 : 0);   // a FAILURE verdict
 *   if (skipped > 0) process.exitCode = 2;             // NOT a failure verdict
 *
 * The first is a real verdict that happens to sit under a skip condition, and
 * demoting it reports a script that CAN fail as one that cannot — a fresh false
 * positive on a required check, which is this ticket's own defect committed by
 * its fix. The second was scored a failure verdict by the `exitCode` branch
 * below on the strength of the leading `if (` alone, so before this override
 * existed the fix turned it from RED to GREEN for a script that asserts nothing
 * — KAN-119 gutted through the one exit kind the early branch did not cover.
 * Measured on both sweeps rather than reasoned about; §9 of
 * `verify-exit-path-skip-consultation.mjs` is that measurement, kept.
 *
 * So the rule is: **the exit's own argument decides whether it speaks about
 * failures, and the governing condition only gets to speak when the argument
 * does not.** Both kinds are covered, `exit` and `exitCode` alike.
 */
function classify(entry, source, regions) {
  return skipOverride(classifyRaw(entry, source, regions), entry, regions);
}

/**
 * An expression that speaks about FAILURES on its own — a counter named in it,
 * or a value computed from one. Where this holds, the governing condition does
 * not get to reclassify the exit, whichever way `classifyRaw` scored it.
 *
 * `references` strips object keys for the reason it always does: a tally
 * SPELLED as a key has not been read.
 */
function expressionSpeaksOfFailure(expr) {
  return (
    COUNTER.test(references(expr)) || /\?/.test(expr) || /^process\.exitCode/.test(references(expr))
  );
}

/**
 * Convert an exit governed by a skip tally — and by nothing that names a
 * failure counter — into a SKIP verdict.
 *
 * ⚠ IT MUST BE ABLE TO DEMOTE A `verdict: true`, and that is not an oversight
 * to tidy away. `if (skipped > 0) process.exitCode = 2` is scored a failure
 * verdict by the `exitCode` branch on the strength of its leading `if (` alone,
 * with nothing having looked at what the condition says. An override that
 * refused to touch a verdict would leave exactly that shape credited as proof
 * the script can fail — a script that asserts nothing, passing the required
 * check. The argument test above is what keeps the demotion narrow.
 */
function skipOverride(result, entry, regions) {
  if (entry.kind !== 'exit' && entry.kind !== 'exitCode') return result;
  if (expressionSpeaksOfFailure(entry.expr)) return result;
  if (governingConditionMatching(regions, entry.index, COUNTER) !== null) return result;
  const skipCondition = governingConditionMatching(regions, entry.index, SKIP_COUNTER);
  if (skipCondition === null) return result;
  return {
    verdict: false,
    skipVerdict: true,
    why:
      `reached only when \`${renderCondition(skipCondition)}\` — a SKIP verdict: it lets ` +
      'the tally reach the exit code, and it is not a failure verdict'
  };
}

/**
 * The failure-verdict question alone: KAN-119's classifier as it stood, with
 * KAN-540's containment. Every answer it gives is about FAILURES; skips are
 * `skipOverride`'s, applied to what this returns.
 */
function classifyRaw(entry, source, regions) {
  const { kind, expr, text, index } = entry;

  // A literal exit INSIDE the body of a check on accumulated failures is a
  // verdict, whatever its argument looks like.
  const condition = kind === 'exit' ? governingConditionMatching(regions, index, COUNTER) : null;
  if (condition !== null) {
    return { verdict: true, why: `reached only when \`${renderCondition(condition)}\`` };
  }

  // KAN-561's skip classification is NOT here. It is `skipOverride`, applied to
  // this function's answer — the ordering argument is on `classify` above, and
  // the two shapes that go wrong when it is an early branch are named there.

  // reportAndExit(<expr>) — a verdict iff the TALLIES are what it is handed.
  // `references` is what stops `{ failures: 0 }` counting: a tally has to be
  // referenced, not merely spelled as a key.
  if (kind === 'delegated') {
    return COUNTER.test(references(expr))
      ? { verdict: true, why: 'verdict delegated to reportAndExit with an accumulated tally' }
      : { verdict: false, why: 'reportAndExit called with no accumulated tally' };
  }

  if (kind === 'exitCode') {
    // `exitCode = <literal>` inside a conditional line, or `= <expression>`.
    const conditional = /^\s*if\s*\(/.test(text) || /\?/.test(expr) || COUNTER.test(expr);
    return conditional || /^\s*(if|})/.test(text)
      ? { verdict: true, why: 'exitCode set from a check' }
      : { verdict: COUNTER.test(expr), why: 'exitCode assignment' };
  }

  // process.exit(<expr>)
  if (COUNTER.test(expr) || /\?/.test(expr)) {
    return { verdict: true, why: 'exit value derived from an accumulated verdict' };
  }
  if (/^process\.exitCode/.test(expr)) {
    // `process.exit(process.exitCode ?? 0)` — a verdict iff something set it.
    return {
      verdict: /process\.exitCode\s*=/.test(source),
      why: 'exits with the accumulated process.exitCode'
    };
  }
  if (/^0$/.test(expr)) return { verdict: false, why: 'unconditional success exit' };
  return { verdict: false, why: 'literal exit — a setup guard or a usage error' };
}

const IS_VERIFY = (base) => base.startsWith('verify-') && base.endsWith('.mjs');

const rows = [];
const coverage = [];
let sweepUnproven = [];
for (const dir of SCRIPT_DIRS) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) continue;
  // RECURSIVE SINCE KAN-465, and the argument is worth stating because this is a
  // REQUIRED check and it was not wrong when it was written. `daemon/scripts`
  // held 129 `verify-*.mjs` at depth 1 and 129 recursively, so the flat
  // `readdirSync` that stood here read every one of them.
  //
  // It was correct and it was fragile, and the discriminator KAN-465 uses is
  // not "did it miss anything today" but "does the swept tree have depth".
  // THIS ONE DOES — `lib/`, `fixtures/` and `fixtures/kan-321/` — so the
  // property holding was a fact about where files happen to sit, not about the
  // sweep. One `verify-` script added under `lib/` and it leaves the required
  // check silently, taking its own exit-path audit with it. KAN-406's miss was
  // in `scripts/lib/` exactly, so the shape has bitten in this directory
  // before.
  //
  // The conversion is behaviour-preserving on this build by measurement, not by
  // argument: the row set is identical before and after, which is the evidence
  // that pays for touching a required check at all.
  const sweep = sweepTree(abs, {
    match: IS_VERIFY,
    label: dir,
    what: 'verify-*.mjs script(s)'
  });
  coverage.push(sweep.coverage);
  if (!sweep.reachedEverything) sweepUnproven.push(`${dir}: ${sweep.detail}`);
  // `name` is now a path RELATIVE to `abs` — `verify-x.mjs` at the top level,
  // `lib/verify-x.mjs` below it. The `startsWith('verify-')` filter that used
  // to live here has moved into the match predicate above, which applies to the
  // BASENAME: left where it was, it would have silently dropped every nested
  // script, which is the same blind spot one layer down.
  for (const name of sweep.files) {
    const file = path.join(abs, name);
    const source = fs.readFileSync(file, 'utf8');
    // KAN-535: every question below is about the script's own CODE, so ask it
    // of the masked copy — comments, strings, template text and regex literals
    // blanked, `${...}` interpolations left intact because they ARE code.
    // Offsets and line numbers are preserved, so `e.line` still indexes the
    // real file and the diagnostics below quote the real line.
    const code = maskNonCode(source);
    const sourceLines = source.split('\n');
    // KAN-540: the `if` bodies of this file, computed ONCE and handed to every
    // classification below. `classify` still gets the source — the
    // `process.exit(process.exitCode)` branch asks a whole-file question of it
    // — but it no longer derives a CONDITION from it: the only conditions in
    // circulation are the ones `conditionalRegions` matched to a closing
    // parenthesis, which is what makes the retired window's line fragment
    // unrepresentable rather than merely absent.
    const regions = conditionalRegions(code);
    const codeExits = exitPaths(code);
    const inCode = new Set(codeExits.map((e) => `${e.line}:${e.kind}`));
    const paths = codeExits.map((e) => ({
      ...e,
      ...classify(e, code, regions),
      text: (sourceLines[e.line - 1] ?? '').trim()
    }));
    // What the mask removed, kept only so `--verbose` can show its working.
    // Keyed by line and kind, so two exits of the same kind on one line would
    // report as one; that costs a diagnostic label and never a verdict.
    const masked = exitPaths(source)
      .filter((e) => !inCode.has(`${e.line}:${e.kind}`))
      .map((e) => ({ ...e, text: (sourceLines[e.line - 1] ?? '').trim() }));
    const verdicts = paths.filter((p) => p.verdict);
    // KAN-561: a skip verdict is neither. It is excluded from `guards` because
    // calling it one is what made the false positive unreadable in the report,
    // and from `verdicts` because `canFail` is a claim about FAILURES.
    const skipVerdicts = paths.filter((p) => p.skipVerdict === true);
    const guards = paths.filter((p) => !p.verdict && p.skipVerdict !== true);
    // KAN-373: a skip tally that no exit reads is a section that can fail to
    // run while the process still says the gate held. KAN-561: "reads it" means
    // named in an exit's expression OR in a condition governing one, over every
    // exit path rather than only the verdicts — see `consultedTallies`.
    const tallies = skipTallies(code);
    const consulted = new Set(paths.flatMap((p) => consultedTallies(p, regions, tallies)));
    const blindTallies = tallies.filter((t) => !consulted.has(t));
    rows.push({
      rel: path.join(dir, name),
      name: name.replace(/\.mjs$/, ''),
      canFail: verdicts.length > 0,
      hasHeader: /WHAT FAILURE THIS WOULD CATCH/.test(source),
      tallies,
      blindTallies,
      verdicts,
      skipVerdicts,
      guards,
      masked
    });
  }
}

for (const line of coverage) console.log(`  ${line}`);
console.log(`sweeping ${rows.length} verify-* scripts under ${SCRIPT_DIRS.join(', ')}\n`);
console.log(`${'script'.padEnd(48)} ${'verdict exits'.padEnd(14)} ${'guards'.padEnd(7)} header`);
console.log('-'.repeat(48) + ' ' + '-'.repeat(14) + ' ' + '-'.repeat(7) + ' ------');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(48)} ${String(r.canFail ? r.verdicts.length : 'NONE').padEnd(14)} ` +
      `${String(r.guards.length).padEnd(7)} ${r.hasHeader ? 'yes' : 'NO'}`
  );
  if (verbose) {
    for (const v of r.verdicts) console.log(`      verdict  L${v.line}: ${v.text}   (${v.why})`);
    // KAN-561. A LABEL OF ITS OWN, and the table's columns are deliberately
    // unchanged: `verify-exit-path-classifier.mjs` and
    // `verify-exit-path-containment.mjs` both parse the row line with the same
    // regex, anchored on the header column at end of line, and a skip verdict
    // is a fact about one exit rather than a fourth number every reader of that
    // table has to learn. The detail line is where an exit's classification has
    // always been shown.
    for (const s of r.skipVerdicts) console.log(`      skip     L${s.line}: ${s.text}   (${s.why})`);
    for (const g of r.guards) console.log(`      guard    L${g.line}: ${g.text}   (${g.why})`);
    for (const s of r.masked) console.log(`      masked   L${s.line}: ${s.text}   (not code — a comment, a string, or text written out to disk)`);
  }
}

const cannotFail = rows.filter((r) => !r.canFail);
const noHeader = rows.filter((r) => !r.hasHeader);
const skipsInvisible = rows.filter((r) => r.blindTallies.length > 0);

console.log('');
if (skipsInvisible.length) {
  console.log(
    `${skipsInvisible.length} script(s) tally SKIPS that no exit consults — an unrun\n` +
      'section is reported as a pass:'
  );
  for (const r of skipsInvisible) {
    console.log(`  - ${r.rel} (tallies \`${r.blindTallies.join('`, `')}\`, and no exit reads it)`);
  }
  console.log(
    '  A skip is not a failure and must not be counted as one. It is also not a pass.\n' +
      '  `lib/verdict-exit.mjs` is the shared contract: 0 ran-and-passed, 1 failed,\n' +
      '  2 nothing failed and something did not run.\n' +
      '  KAN-561: an exit READS the tally when it is named in the exit\'s expression OR\n' +
      '  in a condition governing it, so `if (skipped > 0 && !allowSkipped) exit(2)`\n' +
      '  counts. If you are seeing this for code of that shape, the check is wrong and\n' +
      '  the ticket wants reopening — do not contort the script to placate it.\n'
  );
}
if (cannotFail.length) {
  console.log(`${cannotFail.length} script(s) have NO verdict-driven exit — they cannot report failure:`);
  for (const r of cannotFail) {
    // KAN-561: a script whose only exit is a SKIP verdict has an exit path, and
    // saying `no exit path at all` about it would send its author looking for
    // the wrong thing. The skip verdict is named, because it is the near miss.
    const other = r.guards.length + r.skipVerdicts.length;
    const detail = other
      ? ` (${other} exit(s), none a failure verdict` +
        (r.skipVerdicts.length ? `; ${r.skipVerdicts.length} report only SKIPS` : '') +
        ')'
      : ' (no exit path at all)';
    console.log(`  - ${r.rel}${detail}`);
  }
}
if (noHeader.length) {
  console.log(`${noHeader.length} script(s) do not state what failure they would catch:`);
  for (const r of noHeader) console.log(`  - ${r.rel}`);
}

if (!cannotFail.length && !noHeader.length && !skipsInvisible.length && !sweepUnproven.length) {
  const tallying = rows.filter((r) => r.tallies.length > 0).length;
  console.log(
    `ALL PASS — every one of the ${rows.length} verify-* scripts has a verdict-driven exit and\n` +
      `states what failure it would catch, and each of the ${tallying} that tally skips names that\n` +
      "tally at an exit — in the exit's expression or in a condition governing it.\n\n" +
      'This does NOT establish that any of their assertions can be false. That is the\n' +
      'fourth level of the rule and it is proved only by breaking the behaviour under\n' +
      'test and watching the script go red — see the KAN-119 PR for that evidence.'
  );
}
if (sweepUnproven.length) {
  console.log(
    'the sweep could not prove it reached every script — its own coverage is in doubt, so\n' +
      'every verdict above is a claim about a SUBSET of the tree:'
  );
  for (const line of sweepUnproven) console.log(`  - ${line}`);
}

process.exit(
  cannotFail.length + noHeader.length + skipsInvisible.length + sweepUnproven.length > 0 ? 1 : 0
);
