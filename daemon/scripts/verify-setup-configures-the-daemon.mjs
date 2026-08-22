// KAN-622: `docs/SETUP.md`'s install path must SET the two knobs that decide
// whether the daemon acts — `BUTCHR_BOARD_RECONCILE` and
// `BUTCHR_ATLASSIAN_PROXY` — and `butchr-doctor` must go red on a box where
// nobody has.
//
// WHAT FAILURE THIS WOULD CATCH: the state this repository was in at
// `origin/main` on 2026-08-21, measured with a positive control so the zeroes
// mean something:
//
//     BUTCHR_ATLASSIAN_PROXY   docs/SETUP.md = 1   (prose only, added by #276)
//     BUTCHR_BOARD_RECONCILE   docs/SETUP.md = 0
//     converge                 docs/SETUP.md = 0
//     BUTCHR_AGENT_RUNTIME     docs/SETUP.md = 4   <- positive control
//
// A reader who followed that document end to end got a daemon in `report` mode
// with the Atlassian proxy `off`: it holds its socket, answers every question,
// staffs nothing and serves no Atlassian tools — and `butchr-doctor` ended in
// `Ready.` `install-service.sh` sets neither knob and the unit it writes
// declares exactly one variable, `PATH`, so `butchr-doctor`'s KAN-550 check
// compared the serving daemon against a declaration of nothing and found
// perfect agreement.
//
// ⚠ THE ASSERTION IS ABOUT SETTING, NOT MENTIONING, AND THAT DISTINCTION IS
// THE WHOLE SCRIPT. PR #276 (KAN-603) landed a correct and welcome §8 that
// NAMES `BUTCHR_ATLASSIAN_PROXY` and explains its ladder. A grep-for-the-word
// check therefore went from red to green the moment #276 merged, while a box
// following the document still had no working Atlassian path. §1 requires an
// `NAME=value` assignment inside a fenced `bash` block in the install path — a
// command the reader actually runs — and §3 proves that requirement rejects a
// document that only talks about the knobs.
//
// CI-RUNNABLE: yes — §1–§4 read `docs/SETUP.md` and `daemon/scripts/butchr-doctor.mjs`
// as TEXT off the checkout; §5 spawns `butchr-doctor.mjs` as a node child with a
// stub `systemctl` on PATH, in a temporary directory. Node builtins only — no
// build, no daemon, no herdr, no credential, no network, no wall clock. §5 needs
// a POSIX `sh` to run the stub and announces itself SKIPPED where there is none,
// and a skip is printed as a skip and never counted as a pass.
//
// READS SOURCE AS TEXT, NOT `dist`. This script imports nothing from
// `daemon/dist`, so a failed build does not invalidate its verdict — it read
// what you wrote. §5 spawns `butchr-doctor.mjs`, which is itself a no-build
// script by contract ("it must run against a clone that has not been built
// yet"), so that section is unbuilt-safe too.
//
// ---------------------------------------------------------------------------
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
// Per KAN-145 — a proof that supplies its own input has not tested that the
// input arrives — said plainly rather than left to be inferred:
//
//   * §1, §2 and §4 read the REAL `docs/SETUP.md` and the REAL
//     `butchr-doctor.mjs` off the checkout. They supply nothing.
//   * §2 is §1's detector run against a knob NOBODY WROTE IT FOR.
//     `BUTCHR_AGENT_RUNTIME` is assigned in §12's `crabcast.conf` block and in
//     no install-path block, so the same matcher must find it in the whole
//     document and NOT in the window. That is a positive control on both halves
//     at once — the assignment regex, and the section window being a window —
//     taken over real text rather than a fixture. If §1 ever passes because its
//     regex matches everything, §2 goes red.
//   * §3 writes a synthetic mention-only document and asserts the detector
//     rejects it. It establishes that the DETECTOR discriminates a mention from
//     an assignment; it establishes NOTHING about `docs/SETUP.md`. §1 is what
//     covers the real document, and neither section covers the other's
//     question.
//   * §5 supplies the stub `systemctl` whose output `butchr-doctor` reads, so
//     what it proves is that the doctor's new check REACTS CORRECTLY to a unit
//     declaration — red when neither knob is declared, green when both are at
//     acting values. It does NOT prove that real systemd on a real box prints
//     what the stub prints. That leg is covered by running `butchr-doctor` on a
//     configured machine and reading its `daemon configuration` line; the PR
//     for this ticket pastes that run. Nobody covers the by-the-book *machine*
//     end to end, because standing one up is the clean-install rehearsal's job
//     (KAN-568/KAN-612), not this script's.
//   * ⚠ NOTHING HERE EXECUTES `docs/SETUP.md`'s OWN COMMANDS. A `printf` in the
//     install path that is well-formed and writes the wrong file would pass
//     every section below. This script guards the document against saying
//     nothing; it does not guard it against being wrong.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SETUP = path.join(repoRoot, 'docs', 'SETUP.md');
const DOCTOR = path.join(here, 'butchr-doctor.mjs');
const VERBOSE = process.argv.includes('--verbose');

/**
 * The two knobs. `acting` is the value that makes the box do something, and it
 * is quoted in failures so a reader is told what to write and not merely that
 * something is missing.
 */
const KNOBS = [
  { name: 'BUTCHR_BOARD_RECONCILE', dflt: 'report', acting: 'converge' },
  { name: 'BUTCHR_ATLASSIAN_PROXY', dflt: 'off', acting: 'jira-write' }
];

/**
 * Where the install path ends.
 *
 * Everything from `## 1.` up to — and not including — `## 8.` is the sequence
 * a reader performs to stand a box up. §8 onward is headed "Optional", and §12
 * is a discussion of a runtime you only read if you were told to. A knob set
 * only past this line is set in material the document itself tells the reader
 * they may skip, which is how `BUTCHR_AGENT_RUNTIME`'s drop-in came to be the
 * only one in the file while both of these were in none.
 */
const WINDOW_START = /^## 1\./;
const WINDOW_END = /^## 8\./;

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  FAIL  ${m}`);
};
const ok = (m) => console.log(`  ok    ${m}`);
const skip = (m) => console.log(`  SKIP  ${m}`);
const say = (m) => console.log(m);
const detail = (m) => {
  if (VERBOSE) console.log(`        ${m}`);
};

/** The install path, as text, with the line each kept line came from. */
function installPath(markdown) {
  const lines = markdown.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === -1 && WINDOW_START.test(lines[i])) start = i;
    else if (start !== -1 && end === -1 && WINDOW_END.test(lines[i])) end = i;
  }
  return { start, end, lines: start === -1 ? [] : lines.slice(start, end === -1 ? lines.length : end) };
}

/**
 * Every fenced ```bash block, as `{ startLine, body }`.
 *
 * Commands the reader runs, and nothing else. A knob named in prose — even in
 * inline code, even with its value shown — is not a step, and the whole reason
 * this script exists is that a document can name a knob at length and never
 * tell anybody to set it.
 */
function bashBlocks(lines, lineOffset = 0) {
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (current === null) {
      if (/^\s*```bash\s*$/.test(line)) current = { startLine: lineOffset + i + 2, body: [] };
      continue;
    }
    if (/^\s*```/.test(line)) {
      blocks.push(current);
      current = null;
      continue;
    }
    current.body.push(line);
  }
  return blocks;
}

/**
 * Is `name` ASSIGNED anywhere in these blocks, and to what?
 *
 * The value character class stops at a backslash on purpose: the drop-in is
 * written with `printf '[Service]\nEnvironment=NAME=value\n'`, so the literal
 * two-character `\n` is what terminates the value in the source text. It also
 * stops at quotes, spaces and `<`, which is what keeps a prose placeholder such
 * as `NAME=<rung>` from counting as a setting.
 */
function assignedIn(blocks, name) {
  const re = new RegExp(`\\b${name}=([A-Za-z0-9_.:/-]+)`);
  const hits = [];
  for (const block of blocks) {
    for (let i = 0; i < block.body.length; i += 1) {
      const m = block.body[i].match(re);
      if (m) hits.push({ line: block.startLine + i, value: m[1], text: block.body[i].trim() });
    }
  }
  return hits;
}

const markdown = fs.readFileSync(SETUP, 'utf8');
const allLines = markdown.split('\n');
const window = installPath(markdown);

// ===========================================================================
say('');
say('== 1. the install path SETS both knobs, in a command the reader runs ==');
// ===========================================================================

if (window.start === -1) {
  fail('docs/SETUP.md has no `## 1.` heading — the install-path window could not be located at all.');
} else if (window.end === -1) {
  fail('docs/SETUP.md has no `## 8.` heading — the install-path window has no end, so §1 would read the whole file.');
} else {
  ok(`install path located: lines ${window.start + 1}..${window.end} of ${allLines.length}`);
  const windowBlocks = bashBlocks(window.lines, window.start);
  detail(`${windowBlocks.length} fenced \`bash\` block(s) inside the window`);

  for (const knob of KNOBS) {
    const hits = assignedIn(windowBlocks, knob.name);
    if (hits.length === 0) {
      fail(
        `${knob.name} is never ASSIGNED in a fenced \`bash\` block in the install path.\n` +
        `        A box that follows docs/SETUP.md therefore runs it at its default \`${knob.dflt}\`,\n` +
        `        which is the inert setting. Naming the knob is not setting it — add a step that\n` +
        `        writes \`Environment=${knob.name}=${knob.acting}\` into a drop-in.`
      );
    } else {
      ok(`${knob.name} is set in the install path (${hits.length} assignment(s), first at line ${hits[0].line}: ${hits[0].value})`);
      for (const hit of hits) detail(`line ${hit.line}: ${hit.text}`);
    }
  }

  // The value that makes the box act has to appear, or the document has told a
  // reader to set the knob without telling them what to set it to. `converge`
  // occurred zero times in the whole file when this ticket was filed.
  const windowText = window.lines.join('\n');
  if (windowText.includes('converge')) {
    ok('the install path names `converge` — the value that makes the board drive the fleet');
  } else {
    fail('the install path never says `converge`, so it does not tell the reader which value to choose.');
  }

  if (windowText.includes('butchr-daemon.service.d')) {
    ok('the install path names the drop-in directory `butchr-daemon.service.d`');
  } else {
    fail(
      'the install path never names `~/.config/systemd/user/butchr-daemon.service.d`.\n' +
      '        That directory is how a knob is set durably. Before this ticket it appeared only\n' +
      '        in §12, as an aside about which runtime you installed — past the point the\n' +
      '        document tells the reader they are finished.'
    );
  }
}

// ===========================================================================
say('');
say('== 2. positive control: the SAME detector, on a knob it was not written for ==');
// ===========================================================================
// `BUTCHR_AGENT_RUNTIME` is assigned in §12's `crabcast.conf` block and in no
// install-path block. Both halves are asserted, because each controls a
// different way §1 could be vacuous: a regex that matches nothing would make §1
// pass only by accident today and fail silently forever after, and a window
// that is not really a window would make §1 pass on §12's drop-in.

{
  const control = 'BUTCHR_AGENT_RUNTIME';
  const whole = assignedIn(bashBlocks(allLines, 0), control);
  const inWindow = window.start === -1 ? [] : assignedIn(bashBlocks(window.lines, window.start), control);

  if (whole.length > 0) {
    ok(`the assignment detector finds ${control} in the document (line ${whole[0].line}: ${whole[0].value}) — so it matches real text, not only fixtures`);
    for (const hit of whole) detail(`line ${hit.line}: ${hit.text}`);
  } else {
    fail(
      `the assignment detector found ${control} NOWHERE in docs/SETUP.md, and §12 sets it in a\n` +
      `        \`bash\` block. The detector is broken, which would make every "ok" in §1 meaningless.`
    );
  }

  if (inWindow.length === 0) {
    ok(`${control} is NOT assigned inside the install-path window — so the window really is a window`);
  } else {
    fail(
      `${control} is assigned inside the install-path window (line ${inWindow[0].line}).\n` +
      `        Either §12's material moved into the install path, or the window is not bounding\n` +
      `        anything — and in the second case §1 would pass on a drop-in the reader is told\n` +
      `        to skip. Re-derive WINDOW_START/WINDOW_END before trusting §1.`
    );
  }
}

// ===========================================================================
say('');
say('== 3. a MENTION does not satisfy §1 — the #276 case, on a fixture ==');
// ===========================================================================
// This is the section the ticket turns on. #276 added a correct §8 that names
// `BUTCHR_ATLASSIAN_PROXY` and explains its ladder, so `grep -c` on that token
// went from 0 to 1 with the box no more working than before. The fixture below
// is that document in miniature: both knobs named in prose, both named inside a
// fenced `bash` block as bare words, and neither set.
//
// It supplies its own input, so it proves the detector discriminates and says
// nothing whatever about `docs/SETUP.md`. §1 owns that question.

{
  const mentionOnly = [
    '## 1. Prerequisites',
    '',
    'The daemon reads `BUTCHR_BOARD_RECONCILE` and `BUTCHR_ATLASSIAN_PROXY`.',
    'The proxy is a ladder: `off`, `jira-read`, `confluence-read`, `jira-write`,',
    '`confluence-write`. See docs/env-knobs.md for the defaults.',
    '',
    'You may want `BUTCHR_ATLASSIAN_PROXY=<rung>` here — pick one.',
    '',
    '```bash',
    'grep BUTCHR_BOARD_RECONCILE ~/.config/systemd/user/butchr-daemon.service',
    'echo BUTCHR_ATLASSIAN_PROXY',
    '```',
    '',
    '## 8. Optional: the Jira credential',
    ''
  ].join('\n');

  const fixtureWindow = installPath(mentionOnly);
  const fixtureBlocks = bashBlocks(fixtureWindow.lines, fixtureWindow.start);
  let discriminated = 0;
  for (const knob of KNOBS) {
    const hits = assignedIn(fixtureBlocks, knob.name);
    if (hits.length === 0) {
      discriminated += 1;
      detail(`${knob.name}: named four ways in the fixture, matched zero times — correct`);
    } else {
      fail(
        `the detector counted ${knob.name} as SET in a document that only mentions it\n` +
        `        (line ${hits[0].line}: ${hits[0].text}). §1 would then go green on a document that\n` +
        `        leaves the reader with an inert box — which is exactly the false green this\n` +
        `        ticket exists to close.`
      );
    }
  }
  if (discriminated === KNOBS.length) {
    ok('a document that names both knobs — in prose, in inline code, and inside a `bash` block — satisfies neither');
  }

  // And the same fixture with real assignments must pass, or §3 is only
  // establishing that the detector says no to everything.
  const setVersion = mentionOnly.replace(
    'echo BUTCHR_ATLASSIAN_PROXY',
    "printf '[Service]\\nEnvironment=BUTCHR_BOARD_RECONCILE=converge\\nEnvironment=BUTCHR_ATLASSIAN_PROXY=jira-write\\n' > drop-in.conf"
  );
  const setWindow = installPath(setVersion);
  const setBlocks = bashBlocks(setWindow.lines, setWindow.start);
  const found = KNOBS.filter((k) => assignedIn(setBlocks, k.name).length > 0);
  if (found.length === KNOBS.length) {
    ok('the same fixture WITH a `printf` drop-in satisfies both — so §3 is a discrimination and not a blanket refusal');
  } else {
    fail(
      `the detector missed ${KNOBS.filter((k) => !found.includes(k)).map((k) => k.name).join(', ')} in a\n` +
      `        fixture that assigns it in the documented \`printf\` form. §1 cannot be trusted to\n` +
      `        recognise the very step this ticket adds.`
    );
  }
}

// ===========================================================================
say('');
say('== 4. butchr-doctor names both knobs and has a failing branch for them ==');
// ===========================================================================
// Static half. §7 of the document is what a reader runs to be told whether the
// steps above are true, and it passed a box where neither knob was decided.

{
  const doctorSrc = fs.readFileSync(DOCTOR, 'utf8');
  for (const knob of KNOBS) {
    if (doctorSrc.includes(knob.name)) ok(`butchr-doctor.mjs names ${knob.name}`);
    else
      fail(
        `butchr-doctor.mjs never mentions ${knob.name}, so step 7 cannot report it.\n` +
        `        Its KAN-550 check compares the serving daemon against WHAT THE UNIT DECLARES,\n` +
        `        and a unit that declares nothing agrees with everything.`
      );
  }
  // `\s*` spans newlines, so this matches the call whether or not the argument
  // is wrapped onto its own line.
  if (/fail\(\s*'daemon configuration'/.test(doctorSrc)) {
    ok('butchr-doctor.mjs has a `fail()` branch under the `daemon configuration` check');
  } else if (doctorSrc.includes("'daemon configuration'")) {
    // Named but only ever reported. That is the shape this whole ticket is
    // about, so it is a failure rather than a warning.
    fail(
      "butchr-doctor.mjs has a `daemon configuration` check that never calls `fail()`.\n" +
      '        A check that can only pass is not a check. §5 is what proves the branch is\n' +
      '        reachable; this is what proves it exists to be reached.'
    );
  } else {
    fail('butchr-doctor.mjs has no `daemon configuration` check at all.');
  }
}

// ===========================================================================
say('');
say('== 5. butchr-doctor actually goes RED on a by-the-book unit, and green on a configured one ==');
// ===========================================================================
// Behavioural half, and the reason §4 is not enough: §4 reads text, and text
// that mentions `fail(` proves as little about the doctor as a document that
// mentions a knob proves about a box.
//
// The stub answers ONLY the `show -p LoadState -p Environment` form the check
// reads, and exits 1 for every other invocation — so systemd-dependent checks
// elsewhere in the doctor degrade to their "could not run systemctl" branches
// rather than being fed something invented. Its two arms differ in exactly one
// thing: what the unit declares.

{
  const shell = '/bin/sh';
  if (!fs.existsSync(shell)) {
    skip(`no ${shell} on this host, so the stub cannot be executed — §5 SKIPPED, which is not a pass.`);
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan622-doctor-'));
    const runWithUnitEnvironment = (declared) => {
      const stub = path.join(dir, 'systemctl');
      fs.writeFileSync(
        stub,
        '#!/bin/sh\n' +
          '# Stub written by verify-setup-configures-the-daemon.mjs §5.\n' +
          'for a in "$@"; do\n' +
          '  if [ "$a" = "LoadState" ]; then\n' +
          `    printf 'LoadState=loaded\\nEnvironment=${declared}\\nExecMainPID=0\\n'\n` +
          '    exit 0\n' +
          '  fi\n' +
          'done\n' +
          'exit 1\n'
      );
      fs.chmodSync(stub, 0o755);
      const r = spawnSync(process.execPath, [DOCTOR], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
      });
      const out = `${r.stdout}${r.stderr}`;
      const line = out.split('\n').find((l) => /^(PASS|WARN|FAIL)\s+daemon configuration$/.test(l.trim()));
      return { verdict: line ? line.trim().split(/\s+/)[0] : null, out };
    };

    // Arm 1 — the by-the-book box. The unit template ships exactly one
    // `Environment=` line, and `install-service.sh` adds none.
    const red = runWithUnitEnvironment('PATH=/usr/bin:/bin');
    if (red.verdict === 'FAIL') {
      ok('a unit declaring only PATH — what install-service.sh writes — makes `daemon configuration` FAIL');
      const why = red.out.split('\n').filter((l) => l.includes('NOT DECLARED'));
      for (const l of why) detail(l.trim());
    } else if (red.verdict === null) {
      fail(
        'butchr-doctor printed no `daemon configuration` line at all under the stub, so §5\n' +
        '        measured nothing. A missing line is not a green.'
      );
    } else {
      fail(
        `a unit declaring only PATH produced \`${red.verdict}  daemon configuration\`, not FAIL.\n` +
        '        That is the exact box this ticket was filed about: installed, healthy-looking,\n' +
        '        staffing nothing, serving no Atlassian tools — and told so by nobody.'
      );
    }

    // Arm 2 — the box step 6.5 produces. Same stub, same doctor, one difference.
    const green = runWithUnitEnvironment(
      `PATH=/usr/bin:/bin ${KNOBS[0].name}=${KNOBS[0].acting} ${KNOBS[1].name}=${KNOBS[1].acting}`
    );
    if (green.verdict === 'PASS') {
      ok('the same unit with both knobs at acting values makes it PASS — so §5 is a discrimination, not a check that always fails');
    } else if (green.verdict === null) {
      fail('butchr-doctor printed no `daemon configuration` line for the configured arm either.');
    } else {
      fail(
        `a unit declaring ${KNOBS.map((k) => `${k.name}=${k.acting}`).join(' and ')} produced\n` +
        `        \`${green.verdict}  daemon configuration\`, not PASS. The check cannot be satisfied by\n` +
        '        following step 6.5, which makes it an obstacle rather than a guard.'
      );
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
