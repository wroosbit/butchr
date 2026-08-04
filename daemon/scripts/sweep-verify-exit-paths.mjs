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
//   2. Enumerating exit paths — counts the `process.exit(0)` inside the fake
//      herdr shim a script writes to disk, and counts "daemon/dist is missing"
//      setup guards, as though either were a verdict.
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
// Usage: node daemon/scripts/sweep-verify-exit-paths.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const SCRIPT_DIRS = ['daemon/scripts', 'extension/scripts'];

/**
 * Identifiers a script accumulates failures into. A verdict-driven exit is one
 * whose value is computed from one of these; anything else is a guard.
 */
const COUNTER = /\b(failures?|failed|problems|errors|violations|leaks|bad)\b/i;

/** Every `process.exit(...)` / `process.exitCode = ...`, with its line. */
function exitPaths(source) {
  const found = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const exitCall = line.match(/process\.exit\s*\(([^;]*)\)/);
    if (exitCall) found.push({ line: i + 1, kind: 'exit', expr: exitCall[1].trim(), text: line.trim() });
    const exitCode = line.match(/process\.exitCode\s*=\s*([^;]+)/);
    if (exitCode) found.push({ line: i + 1, kind: 'exitCode', expr: exitCode[1].trim(), text: line.trim() });
  });
  return found;
}

/**
 * The condition controlling an exit, if a nearby `if` supplies one.
 *
 * `exit(1)` says nothing on its own — `if (failures) process.exit(1)` is a
 * verdict and `if (!existsSync(dist)) process.exit(1)` is a guard, and the
 * difference is entirely in the line above. Reading only the exit's argument
 * misclassified verify-agent-resumption on this sweep's first run: the whole
 * point of level 3 is that the argument is not where the meaning lives.
 */
function controllingCondition(source, lineNumber) {
  const lines = source.split('\n');
  for (let i = lineNumber - 1; i >= Math.max(0, lineNumber - 6); i--) {
    const m = lines[i].match(/\bif\s*\((.*)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Is this exit a verdict, or a guard?
 *
 * A verdict's value — or the condition that reaches it — is derived from
 * accumulated state: `exit(failures ? 1 : 0)`, `exitCode = ok ? 0 : 1`,
 * `if (failures) process.exit(1)`. A guard's is a literal reached at a point
 * where the script has decided it cannot run at all.
 *
 * The `process.exitCode` idiom counts as a verdict when the assignment is
 * conditional or computed: setting it to 1 from inside a check and then ending
 * naturally is how eight of these scripts legitimately report failure.
 */
function classify(entry, source) {
  const { kind, expr, text, line } = entry;

  // A literal exit guarded by a check on accumulated failures is a verdict,
  // whatever its argument looks like.
  const condition = controllingCondition(source, line);
  if (kind === 'exit' && condition && COUNTER.test(condition)) {
    return { verdict: true, why: `reached only when \`${condition.trim().slice(0, 40)}\`` };
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

/**
 * Exits written *into a file this script creates* — the fake `herdr` binaries
 * several scripts put on PATH. They belong to the shim, not to the script's own
 * control flow, and counting them is defect class 2 above.
 */
function insideShim(source, lineNumber) {
  const upTo = source.split('\n').slice(0, lineNumber).join('\n');
  const opens = (upTo.match(/writeFileSync\(|`#!\/bin\/sh|cat <<'EOF'/g) ?? []).length;
  const closes = (upTo.match(/EOF\n|\}\)\;/g) ?? []).length;
  return opens > 0 && opens > closes;
}

const rows = [];
for (const dir of SCRIPT_DIRS) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs).sort()) {
    if (!name.startsWith('verify-') || !name.endsWith('.mjs')) continue;
    const file = path.join(abs, name);
    const source = fs.readFileSync(file, 'utf8');
    const paths = exitPaths(source).map((e) => ({
      ...e,
      ...classify(e, source),
      shim: insideShim(source, e.line)
    }));
    const verdicts = paths.filter((p) => p.verdict && !p.shim);
    const guards = paths.filter((p) => !p.verdict && !p.shim);
    rows.push({
      rel: path.join(dir, name),
      name: name.replace(/\.mjs$/, ''),
      canFail: verdicts.length > 0,
      hasHeader: /WHAT FAILURE THIS WOULD CATCH/.test(source),
      verdicts,
      guards,
      shims: paths.filter((p) => p.shim)
    });
  }
}

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
    for (const g of r.guards) console.log(`      guard    L${g.line}: ${g.text}   (${g.why})`);
    for (const s of r.shims) console.log(`      shim     L${s.line}: ${s.text}   (inside a written-out fake binary)`);
  }
}

const cannotFail = rows.filter((r) => !r.canFail);
const noHeader = rows.filter((r) => !r.hasHeader);

console.log('');
if (cannotFail.length) {
  console.log(`${cannotFail.length} script(s) have NO verdict-driven exit — they cannot report failure:`);
  for (const r of cannotFail) {
    console.log(`  - ${r.rel}` + (r.guards.length ? ` (${r.guards.length} exit(s), all guards)` : ' (no exit path at all)'));
  }
}
if (noHeader.length) {
  console.log(`${noHeader.length} script(s) do not state what failure they would catch:`);
  for (const r of noHeader) console.log(`  - ${r.rel}`);
}

if (!cannotFail.length && !noHeader.length) {
  console.log(
    `ALL PASS — every one of the ${rows.length} verify-* scripts has a verdict-driven exit and\n` +
      'states what failure it would catch.\n\n' +
      'This does NOT establish that any of their assertions can be false. That is the\n' +
      'fourth level of the rule and it is proved only by breaking the behaviour under\n' +
      'test and watching the script go red — see the KAN-119 PR for that evidence.'
  );
}
process.exit(cannotFail.length + noHeader.length > 0 ? 1 : 0);
