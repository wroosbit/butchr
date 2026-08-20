// KAN-535: `sweep-verify-exit-paths.mjs` must tell a script's own exits from
// the ones it merely contains — in a fixture it writes to disk, or in a comment
// describing the idiom.
//
// WHAT FAILURE THIS WOULD CATCH: the sweep discarding a real verdict exit
// because an ordinary `fs.writeFileSync(` appeared above it. That is the defect
// KAN-535 was filed for: `insideShim` counted `writeFileSync(` as a shim
// opener, so every exit below a script's first fixture write was thrown away.
// The seven-line reproduction in §1 below is the exact shape that produced
// `no exit path at all` for a file with two, turning the REQUIRED
// `verify-script-sweep` check red for a script written the way the sweep asks.
// It would equally catch the opposite failure — the mask swallowing a real
// exit, e.g. by mistaking a division for a regex literal and blanking live code
// (§5), or by counting a `process.exit` inside a written-out fake `herdr`
// binary as the script's own (§2, §3).
//
// CI-RUNNABLE: yes — writes fixture trees under `os.tmpdir()` and runs the
// shipped sweep against them as a child process. Node builtins only: no build,
// no daemon, no herdr, no credential, no network, no terminal.
//
// THIS SCRIPT BUILDS THE FIXTURES IT THEN ASSERTS ON, AND THAT IS A REAL LIMIT.
// §1–§6 prove the classifier answers correctly about source *this script wrote*,
// which is not the same claim as "it answers correctly about the repository".
// A fixture is a guess at what real scripts look like, and a guess that drifts
// stops testing anything while staying green — the KAN-145 shape, where two
// scripts asserted on records they had constructed and nothing exercised a real
// one.
//
// WHAT COVERS THE GAP: §7, which makes no fixtures at all. It runs the shipped
// sweep against THIS repository and asserts that the named real scripts which
// write fake `herdr` binaries still have their own verdict, and still have the
// shim's exits ignored. If the fixtures in §1–§6 drift away from what real
// scripts look like, §7 is what still fails. The two halves are deliberately
// different instruments: §1–§6 can test shapes the repository does not
// currently contain, and §7 can only test the ones it does.
//
// Usage: node daemon/scripts/verify-exit-path-classifier.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

// ---------------------------------------------------------------------------
// Running the shipped sweep against a tree we control
// ---------------------------------------------------------------------------

const SWEEP = 'sweep-verify-exit-paths.mjs';
// KAN-540 added `governing-conditions.mjs`. The list has to be complete or the
// copied sweep dies on an unresolved import, and `runSweep` reads that as a
// non-zero exit with EMPTY stdout — which arrives here as "the sweep reported
// no row for it", i.e. as a substantive finding about the classifier rather
// than as a broken fixture. Every section below fails at once when this list is
// short, which is the tell.
const LIBS = ['sweep-sources.mjs', 'mask-non-code.mjs', 'governing-conditions.mjs'];

/**
 * Build a throwaway repository shaped like this one — `daemon/scripts` with the
 * shipped sweep and its libraries in it — and drop `fixtures` in beside them.
 * The sweep derives its repo root from its own location, so a copy two levels
 * down sweeps the copy and never this checkout.
 */
function treeWith(fixtures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan535-'));
  const scripts = path.join(root, 'daemon', 'scripts');
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(scriptDir, SWEEP), path.join(scripts, SWEEP));
  for (const lib of LIBS) {
    fs.copyFileSync(path.join(scriptDir, 'lib', lib), path.join(scripts, 'lib', lib));
  }
  for (const [name, body] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(scripts, name), body);
  }
  return { root, sweep: path.join(scripts, SWEEP) };
}

/** Run a sweep and return its exit code and output, whichever way it went. */
function runSweep(sweepPath) {
  try {
    const stdout = execFileSync(process.execPath, [sweepPath, '--verbose'], {
      encoding: 'utf8',
      timeout: 60_000
    });
    return { code: 0, stdout };
  } catch (err) {
    if (err.stdout === undefined) throw err;
    return { code: err.status, stdout: err.stdout };
  }
}

/**
 * Parse the sweep's `--verbose` report into one record per script.
 *
 * Rows sit at column 0 and their detail lines are indented, so the shape is
 * read off the indentation rather than off a fixed column count.
 */
function parseReport(stdout) {
  const rows = new Map();
  let current = null;
  for (const line of stdout.split('\n')) {
    // The `why` is separated from the source text by exactly three spaces, and
    // anchoring on that matters: source text routinely contains parentheses of
    // its own — `if (failures) process.exit(1)` — so a match that took the
    // first `(` as the start of `why` would report the text as `if`.
    const detail = line.match(/^\s+(verdict|guard|masked)\s+L(\d+):\s(.*)\s{3}\((.*)\)$/);
    if (detail && current) {
      current[`${detail[1]}s`].push({ line: Number(detail[2]), text: detail[3], why: detail[4] });
      continue;
    }
    const row = line.match(/^(verify-\S+)\s+(NONE|\d+)\s+(\d+)\s+(yes|NO)\s*$/);
    if (row) {
      current = {
        name: row[1],
        verdictCount: row[2] === 'NONE' ? 0 : Number(row[2]),
        guardCount: Number(row[3]),
        header: row[4] === 'yes',
        verdicts: [],
        guards: [],
        maskeds: []
      };
      rows.set(row[1], current);
    }
  }
  return rows;
}

/**
 * How many scripts the sweep says it swept, from its own summary line.
 *
 * The number to compare a parse against: it is printed BEFORE the table, so a
 * report that arrives truncated still carries the count of what should have
 * been in it. `null` when the line is absent, which is itself a short read.
 */
function sweptCount(stdout) {
  const m = stdout.match(/^sweeping (\d+) verify-\* scripts/m);
  return m ? Number(m[1]) : null;
}

const HEADER = (what) =>
  `// WHAT FAILURE THIS WOULD CATCH: nothing — a KAN-535 fixture: ${what}.\n` +
  `// CI-RUNNABLE: no — written into a scratch tree at run time, never committed.\n`;

const cleanup = [];
const check = (label, cond, detail) => (cond ? ok(label) : fail(`${label} — ${detail}`));

try {
  // -------------------------------------------------------------------------
  // The trees. One that must pass, one that must go red.
  // -------------------------------------------------------------------------

  // §1 The seven-line reproduction from the ticket, verbatim in shape: a
  // verdict exit sitting below an ordinary fixture write.
  const REPRO =
    HEADER('the seven-line reproduction') +
    `import fs from 'fs';\n` +
    `let failures = 0;\n` +
    `fs.writeFileSync(target, 'a fixture this script writes');\n` +
    `if (failures) process.exit(1);\n` +
    `process.exit(0);\n`;

  // §2 A fake `herdr` binary in Node, written into a template literal. This is
  // what the real shim-writing scripts look like, and its exits are the shim's.
  const NODE_SHIM =
    HEADER('a Node fake-herdr shim') +
    `import fs from 'fs';\n` +
    `let failures = 0;\n` +
    'fs.writeFileSync(shim, `\n' +
    `const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };\n` +
    `if (args[0] === '--version') { process.stdout.write('herdr 0.6.4'); process.exit(0); }\n` +
    `process.exit(1);\n` +
    '`);\n' +
    `if (failures) process.exit(1);\n` +
    `process.exit(0);\n`;

  // §3 A fake `herdr` binary in shell — the `#!/bin/sh` + heredoc form the
  // retired counter was written around.
  const SHELL_SHIM =
    HEADER('a shell fake-herdr shim') +
    `import fs from 'fs';\n` +
    `let failures = 0;\n` +
    'fs.writeFileSync(bin, `#!/bin/sh\\ncat <<\'EOF\'\\n${census}\\nEOF\\n`, { mode: 0o755 });\n' +
    `process.exit(failures ? 1 : 0);\n`;

  // §4 A real setup guard below a fixture write, plus a real verdict. The
  // retired counter discarded both; the guard must read as a guard and the
  // verdict as a verdict. This is `verify-crabcast-peer-restart-live`'s shape.
  const GUARD_AFTER_WRITE =
    HEADER('a real guard below a fixture write') +
    `import fs from 'fs';\n` +
    `let failures = 0;\n` +
    `fs.writeFileSync(configPath, JSON.stringify({ dataDir }) + '\\n');\n` +
    `if (socketPath.length > 104) {\n` +
    `  console.error('setup: socket path too long');\n` +
    `  process.exit(1);\n` +
    `}\n` +
    `process.exit(failures ? 1 : 0);\n`;

  // §5 Regex literals holding quote characters, above the verdict. A scanner
  // that read one as division would treat the quote inside it as a string
  // opener and blank live code from there, taking the verdict with it. 21 real
  // scripts hold a quote in a regex.
  //
  // THE BACKTICK IS THE ONE THAT MATTERS, and this fixture carries it for a
  // measured reason rather than for completeness. `'` and `"` are bounded: the
  // scanner refuses to carry a quoted string past a newline, so misreading
  // `/["']/` costs one line and the verdict below survives — a fixture holding
  // only those two stays GREEN when regex handling is deliberately broken, which
  // makes it a check that cannot fail for the thing it names. A backtick opens a
  // template literal, which legitimately spans lines and so runs to end of file,
  // blanking every exit below it. `verify-prompt-poller-seam.mjs` is the real
  // script with a backtick in a regex, and it is the one that goes red.
  const REGEX_QUOTE =
    HEADER('regex literals holding quotes and a backtick') +
    `let failures = 0;\n` +
    `const quoted = /["']/g;\n` +
    'const marks = /[*_`]/g;\n' +
    `const ratio = failures / 2 / 1;\n` +
    `if (failures) process.exit(1);\n` +
    `process.exit(0);\n`;

  // §6 The failing branch: a script whose only `process.exit(failures ? 1 : 0)`
  // is in a COMMENT. It must be reported as unable to fail. This is the
  // accident that kept `verify-dep-linking-covers-every-repo-shape` green while
  // its real verdict was being discarded.
  const COMMENT_ONLY =
    HEADER('an exit that exists only in a comment') +
    `// The canonical verdict is \`process.exit(failures ? 1 : 0)\`, and this\n` +
    `// script describes it without ever calling it.\n` +
    `console.log('asserted nothing');\n`;

  const pass = treeWith({
    'verify-kan535-repro.mjs': REPRO,
    'verify-kan535-node-shim.mjs': NODE_SHIM,
    'verify-kan535-shell-shim.mjs': SHELL_SHIM,
    'verify-kan535-guard-after-write.mjs': GUARD_AFTER_WRITE,
    'verify-kan535-regex-quote.mjs': REGEX_QUOTE
  });
  cleanup.push(pass.root);
  const passRun = runSweep(pass.sweep);
  const rows = parseReport(passRun.stdout);
  if (verbose) console.log(passRun.stdout);

  console.log('§1 the seven-line reproduction is classified as verdict-driven');
  {
    const r = rows.get('verify-kan535-repro');
    check('the reproduction produces a row', !!r, 'the sweep reported no row for it');
    if (r) {
      check(
        `it has a verdict-driven exit (found ${r.verdictCount})`,
        r.verdictCount >= 1,
        'the sweep reported NONE — this is the KAN-535 defect'
      );
      check(
        'the verdict is the `if (failures) process.exit(1)` line',
        r.verdicts.some((v) => /if \(failures\) process\.exit\(1\)/.test(v.text)),
        `verdict lines were: ${JSON.stringify(r.verdicts.map((v) => v.text))}`
      );
      check(
        'no exit of its two was discarded',
        r.maskeds.length === 0,
        `${r.maskeds.length} were masked: ${JSON.stringify(r.maskeds.map((m) => m.text))}`
      );
    }
  }

  console.log('§2 a Node fake-herdr shim keeps its exits out of the count');
  {
    const r = rows.get('verify-kan535-node-shim');
    check('the shim fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `the shim's three exits are ignored (masked ${r.maskeds.length})`,
        r.maskeds.length === 3,
        `masked: ${JSON.stringify(r.maskeds.map((m) => m.text))}`
      );
      check(
        'the script keeps its own verdict',
        r.verdicts.some((v) => /if \(failures\) process\.exit\(1\)/.test(v.text)),
        `verdicts: ${JSON.stringify(r.verdicts.map((v) => v.text))}`
      );
      // KAN-540: this asked for `guardCount === 0`, and it passed for the wrong
      // reason. The fixture's own trailing `process.exit(0)` was being credited
      // to the `if (failures)` on the line above it by the retired proximity
      // window, so it counted as a VERDICT and never reached the guard column.
      // It is an unconditional success exit and it is a guard. What this
      // section is actually about is the SHIM's exits, so it now asks that —
      // no guard may sit on a line the mask took out.
      check(
        "the shim's exits are not counted as the script's guards",
        r.guards.every((g) => !r.maskeds.some((m) => m.line === g.line)),
        `${r.guardCount} guard(s): ${JSON.stringify(r.guards.map((g) => g.text))}` +
          `; masked at ${JSON.stringify(r.maskeds.map((m) => m.line))}`
      );
      check(
        "the script's own trailing success exit is its only guard",
        r.guardCount === 1 && /process\.exit\(0\)/.test(r.guards[0].text),
        `${r.guardCount} guard(s): ${JSON.stringify(r.guards.map((g) => g.text))}`
      );
    }
  }

  console.log('§3 a shell fake-herdr shim leaves the verdict below it intact');
  {
    const r = rows.get('verify-kan535-shell-shim');
    check('the shell shim fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `it has a verdict-driven exit (found ${r.verdictCount})`,
        r.verdictCount >= 1,
        'the verdict below the heredoc was discarded'
      );
    }
  }

  console.log('§4 a real guard below a fixture write reads as a guard, not as absent');
  {
    const r = rows.get('verify-kan535-guard-after-write');
    check('the guard fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `the setup guard is counted (found ${r.guardCount})`,
        r.guardCount === 1,
        `guards: ${JSON.stringify(r.guards.map((g) => g.text))}`
      );
      check(
        `the verdict below it survives (found ${r.verdictCount})`,
        r.verdictCount >= 1,
        'the verdict was discarded'
      );
      check(
        'nothing in this script was treated as written-out text',
        r.maskeds.length === 0,
        `masked: ${JSON.stringify(r.maskeds.map((m) => m.text))}`
      );
    }
  }

  console.log('§5 a regex holding quotes does not blank the code below it');
  {
    const r = rows.get('verify-kan535-regex-quote');
    check('the regex fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `the verdict below the regex survives (found ${r.verdictCount})`,
        r.verdictCount >= 1,
        'the scanner ran away at the quote inside the regex'
      );
      check(
        'the division below it was not read as a regex',
        r.maskeds.length === 0,
        `masked: ${JSON.stringify(r.maskeds.map((m) => m.text))}`
      );
    }
  }

  check(
    'the passing tree sweeps clean (exit 0)',
    passRun.code === 0,
    `the sweep exited ${passRun.code}:\n${passRun.stdout}`
  );

  // -------------------------------------------------------------------------
  console.log('§6 an exit that exists only in a comment is reported as no exit');
  {
    const red = treeWith({ 'verify-kan535-comment-only.mjs': COMMENT_ONLY });
    cleanup.push(red.root);
    const redRun = runSweep(red.sweep);
    const redRows = parseReport(redRun.stdout);
    const r = redRows.get('verify-kan535-comment-only');
    check('the comment-only fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `its commented exit is not counted as a verdict (found ${r.verdictCount})`,
        r.verdictCount === 0,
        'prose about the idiom was counted as an exit path'
      );
    }
    check(
      'the sweep reports it as unable to fail',
      /no exit path at all/.test(redRun.stdout),
      `the sweep said:\n${redRun.stdout}`
    );
    check(
      `the sweep exits non-zero for it (exited ${redRun.code})`,
      redRun.code === 1,
      'a script that cannot report failure passed the required check'
    );
  }

  // -------------------------------------------------------------------------
  // §7 No fixtures. The shipped sweep, this repository, the real scripts.
  // -------------------------------------------------------------------------
  console.log('§7 the real fake-herdr scripts still pass, against this checkout');

  // Named rather than described, because AC 2 asks which scripts these are.
  // Each writes a fake `herdr` binary containing at least one `process.exit`,
  // and each has a verdict of its own that must survive.
  const REAL_SHIM_SCRIPTS = [
    'verify-activate-requires-agent',
    'verify-activation-records-real-parentage',
    'verify-ambiguous-key-refusal',
    'verify-board-reconciler-guard',
    'verify-cross-type-activation',
    'verify-launcher-table-is-claude-only',
    'verify-mcp-runtime-validation',
    'verify-message-provenance',
    'verify-prompt-write-refusal',
    'verify-standdown-survives-degraded-activation',
    'verify-startup-admission',
    'verify-tail-asks-every-source',
    'verify-tail-async-awaited'
  ];
  // Not a `herdr` binary, but the same class: generated child scripts held in
  // template literals. These two exits are the only ones the retired counter
  // ever suppressed correctly, so they are the regression to watch.
  const REAL_GENERATED_FIXTURES = 'verify-ci-set-guards-tree-writes';

  const realRun = runSweep(path.join(scriptDir, SWEEP));
  const realRows = parseReport(realRun.stdout);
  // Against the sweep's OWN count rather than a floor. `> 100` was the check
  // here until KAN-540, and a floor cannot tell a complete report from a
  // partial one: a run whose output arrived truncated parsed to 128 of 164 rows
  // and cleared it, so four named scripts were reported ABSENT — a finding
  // about the repository, produced by a short read. `prompts/task.md`: an empty
  // result is a claim about your search.
  check(
    `every row the sweep printed was parsed (${realRows.size})`,
    realRows.size === sweptCount(realRun.stdout),
    `the sweep says it swept ${sweptCount(realRun.stdout)} scripts and ${realRows.size} rows parsed` +
      ' — the report was read partially, so every verdict below is about a subset'
  );

  for (const name of REAL_SHIM_SCRIPTS) {
    const r = realRows.get(name);
    if (!r) {
      fail(`${name} — expected in the sweep's report and absent; has it been renamed?`);
      continue;
    }
    if (r.verdictCount < 1) {
      fail(`${name} — has no verdict-driven exit`);
      continue;
    }
    if (r.maskeds.length < 1) {
      fail(`${name} — no exit was recognised as belonging to the shim it writes`);
      continue;
    }
    ok(`${name}: ${r.verdictCount} verdict(s), ${r.maskeds.length} shim exit(s) ignored`);
  }

  {
    const r = realRows.get(REAL_GENERATED_FIXTURES);
    if (!r) fail(`${REAL_GENERATED_FIXTURES} — absent from the report`);
    else {
      check(
        `${REAL_GENERATED_FIXTURES}: its 2 generated-fixture exits are still ignored (${r.maskeds.length})`,
        r.maskeds.length === 2,
        `masked: ${JSON.stringify(r.maskeds.map((m) => m.text))}`
      );
      check(
        `${REAL_GENERATED_FIXTURES}: keeps its own verdict`,
        r.verdictCount >= 1,
        'its verdict was discarded'
      );
    }
  }

  check(
    `this repository sweeps clean (exit ${realRun.code})`,
    realRun.code === 0,
    'the shipped sweep is red against this checkout'
  );
} finally {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
