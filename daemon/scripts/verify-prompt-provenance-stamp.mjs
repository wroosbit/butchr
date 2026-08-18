#!/usr/bin/env node
//
// KAN-242 — the brief names the commit it came from, and the check it carries
// is a real one.
//
// WHAT FAILURE THIS WOULD CATCH: a provenance block that renders, reads
// convincingly, and cannot tell an agent anything. Three shapes of that, each
// of which would ship green under a laxer test:
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
//   1. **Stamping `HEAD` instead of the template's own last commit.** The
//      obvious implementation, and it is wrong in the direction that hides the
//      defect: `HEAD` moves on every unrelated commit, so the block would name
//      a different sha every few minutes and the `log <sha>..origin/main`
//      comparison would list commits that touched nothing the reader cares
//      about. An agent that ran it would see noise, conclude the check is
//      broken, and stop running it. Section 1 makes HEAD and the template's
//      commit deliberately different and asserts which one is stamped.
//   2. **An embedded command that is decorative.** The block tells an agent to
//      run two commands and read their output as the answer. If the sha, the
//      pathspec or the ref in that command line is wrong, the command still
//      *runs* — and prints nothing, which the block explicitly defines as "this
//      brief is current". A wrong command is therefore not a broken check but a
//      check that always answers "fine". Sections 2 and 3 run the embedded text
//      verbatim, against a real `origin`, and assert both answers.
//   3. **A fabricated or silently-omitted stamp where git cannot answer.** A
//      block that quietly disappeared on a non-git install would read as
//      "nothing to check here", which is the same lie as (2) told by omission.
//      Section 4 renders from a directory that is not a checkout.
//   4. **The renderer and the shipped prompts disagreeing about the token** —
//      added by `epic/KAN-39` in review, after demonstrating that sections 1-5
//      could not see it. Rename `PROVENANCE_VARIABLE`'s value, rebuild, and
//      every brief ships the literal `{{PROMPT_PROVENANCE}}` — no commit, no
//      check command, the feature dead on the page an agent reads — while this
//      script, `verify-operative-rules-are-carried.mjs` and
//      `sweep-verify-exit-paths.mjs` **all exited 0**. Section 6 closes it, and
//      the reason it was open is stated at the top of that section because it
//      is this repository's own standing lesson committed in the file that
//      quotes it: sections 1-5 spell their fixture's placeholder
//      `{{${PROVENANCE_VARIABLE}}}`, derived from the constant, so the fixture
//      moved with the rename and the two could never disagree. **Section 6
//      derives nothing from the code under test**: it spells the token
//      literally and reads the four real `prompts/*.md` off disk.
//
// The defect all three protect against is the one this ticket exists for: an
// artifact whose sentence claims more than its mechanism covers, degrading
// toward looking finished. The prose in `prompts/*.md` promises the reader that
// two commands will settle whether a rule has moved. This script is what makes
// that promise true rather than plausible.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT WRITES THE REPOSITORY IT THEN ASSERTS ON — SAID PLAINLY, BECAUSE
// THAT IS THE KAN-145 FAILURE MODE AND THE HEADER IS WHERE THE EDGE GOES
// ---------------------------------------------------------------------------
// Every fixture in **sections 1-5** is built here: the scratch checkout, its
// `origin`, the template, the commits. So what those prove is that **the
// renderer, given a repository, produces a correct and executable stamp**.
//
// **Section 6 is the deliberate exception, and it exists because that property
// was not enough.** It reads the four real `prompts/*.md` off the checkout and
// spells the token literally, so nothing in it moves when the code moves. If
// you add a case above, ask which of the two it belongs in — a fixture case
// that could have been written by reading `prompt.ts` proves the renderer is
// self-consistent, which is a weaker claim than it looks.
//
// What is NOT proved, and cannot be by anything in this file:
//
//   * **that a real activation carries it into a real `.butchr-prompt.md`.**
//     The daemon's path from `loadAndRender` to the file on disk (router.ts →
//     `spawnSession` → herdr.ts) is not exercised here at all. WHO COVERS IT:
//     `verify-prompt-write-refusal.mjs` exercises the loader against a real
//     activation, and KAN-242's PR body pastes a `grep` of the block out of a
//     live workspace's `.butchr-prompt.md`. Neither is this script.
//   * **that an agent which reads the block acts on it.** That is a question
//     about a model. WHO COVERS IT: `probe-stale-rule-compliance.mjs`, a live
//     two-agent experiment, and it is not a CI check. A green run here is never
//     evidence that the brief works — only that the mechanism under the brief
//     is honest.
//
// Those two gaps are between scripts rather than inside one, which is exactly
// how KAN-145 stayed green while `activatedBy` was null for every agent in
// production. They are named so nobody infers a coverage that does not exist.
//
// PRECONDITION: `cd daemon && npm install && npm run build` — this imports the
// real `PromptLoader` from `../dist`, never a copy of it.
//
// Usage: node daemon/scripts/verify-prompt-provenance-stamp.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', 'dist');
/** The checkout this script is running from — section 6 reads the real prompts. */
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

if (!fs.existsSync(path.join(distDir, 'prompt.js'))) {
  // A setup guard, not a verdict: there is nothing to judge if the build is
  // absent. sweep-verify-exit-paths.mjs classifies this correctly.
  console.error(`No build at ${distDir}. Run: cd daemon && npm install && npm run build`);
  process.exit(1);
}

const { PromptLoader, templateProvenance, renderProvenanceBlock, PROVENANCE_VARIABLE } =
  await import(path.join(distDir, 'prompt.js'));

const failures = [];
let caseNumber = 1;

function check(what, condition, evidence) {
  const id = `case ${caseNumber++}`;
  if (condition) {
    console.log(`  PASS  ${id}: ${what}`);
  } else {
    console.log(`  FAIL  ${id}: ${what}`);
    failures.push(`${id} (${what})`);
  }
  if (evidence && (verbose || !condition)) {
    for (const line of String(evidence).split('\n')) console.log(`          ${line}`);
  }
}

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'KAN-242',
      GIT_AUTHOR_EMAIL: 'kan242@example.invalid',
      GIT_COMMITTER_NAME: 'KAN-242',
      GIT_COMMITTER_EMAIL: 'kan242@example.invalid'
    }
  }).trim();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan242-provenance-'));
const clone = path.join(scratch, 'checkout');
const originRepo = path.join(scratch, 'origin.git');

/** The two lines the block tells the reader to run, extracted from its own text. */
function embeddedCommands(block) {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('git -C '));
}

/** Run one of those lines exactly as written, as a shell would split it. */
function runEmbedded(line) {
  const [, ...args] = line.split(/\s+/);
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

try {
  // -------------------------------------------------------------------------
  console.log('\n== 1. the stamp names the TEMPLATE\'s last commit, not HEAD ==\n');
  // -------------------------------------------------------------------------
  // The whole section rests on making the two differ. A repository where the
  // template happens to be the most recent commit cannot distinguish a correct
  // implementation from `rev-parse HEAD`, and that is the state a scratch
  // fixture falls into by default — so an unrelated commit is added on top,
  // deliberately, and its sha is asserted ABSENT from the block.
  fs.mkdirSync(path.join(clone, 'prompts'), { recursive: true });
  git(clone, ['init', '--quiet', '--initial-branch=main']);

  const template = 'prompts/task.md';
  const templateBody = [
    '# Task Agent System Prompt (Jira)',
    '',
    'You are an agent for **{{KEY}}**.',
    '',
    '## This brief is a snapshot, and it can be out of date',
    '',
    `{{${PROVENANCE_VARIABLE}}}`,
    '',
    'RULE-OF-THE-DAY: ALPHA',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(clone, template), templateBody);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'the rule as first briefed']);
  const templateCommit = git(clone, ['rev-parse', 'HEAD']);
  const templateShort = git(clone, ['rev-parse', '--short', 'HEAD']);

  // An unrelated commit, so HEAD moves off the template.
  fs.writeFileSync(path.join(clone, 'UNRELATED.md'), 'nothing to do with the prompts\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'an unrelated change']);
  const headCommit = git(clone, ['rev-parse', 'HEAD']);
  const headShort = git(clone, ['rev-parse', '--short', 'HEAD']);

  check(
    'the fixture actually distinguishes the two (HEAD != the template\'s commit)',
    headCommit !== templateCommit,
    `template ${templateShort}   HEAD ${headShort}`
  );

  const p1 = templateProvenance(clone, template);
  check(
    'templateProvenance() reports the commit the template last changed in',
    p1.commit?.sha === templateCommit,
    `reported ${p1.commit?.shortSha ?? '(none)'}, expected ${templateShort}`
  );
  check(
    'and does NOT report HEAD',
    p1.commit?.sha !== headCommit,
    `reported ${p1.commit?.shortSha ?? '(none)'}, HEAD is ${headShort}`
  );

  const loader = new PromptLoader(clone);
  const brief = loader.loadAndRender(template, { KEY: 'KAN-242', URL: '' });
  const block = brief.slice(brief.indexOf('- **Rendered**'), brief.indexOf('RULE-OF-THE-DAY')).trim();

  check(
    'the rendered brief carries the short sha of the template\'s commit',
    block.includes(templateShort),
    block
  );
  check(
    "the rendered brief does not carry HEAD's sha",
    !block.includes(headShort),
    `HEAD short sha ${headShort}`
  );
  check(
    `no unsubstituted {{${PROVENANCE_VARIABLE}}} survives into the brief`,
    !brief.includes(`{{${PROVENANCE_VARIABLE}}}`),
    brief
  );

  // -------------------------------------------------------------------------
  console.log('\n== 2. the embedded command runs, and answers "current" ==\n');
  // -------------------------------------------------------------------------
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', originRepo]);
  git(clone, ['remote', 'add', 'origin', originRepo]);
  git(clone, ['push', '--quiet', '-u', 'origin', 'main']);

  const commands = embeddedCommands(block);
  check(
    'the block embeds exactly two git commands for the reader to run',
    commands.length === 2,
    commands.join('\n')
  );
  check(
    'the first is the fetch, against the checkout the brief was rendered from',
    commands[0] === `git -C ${clone} fetch origin`,
    commands[0]
  );

  // Verbatim. If the sha, the pathspec or the ref in the rendered text is
  // wrong, this is where it shows.
  //
  // KAN-523 CHANGED WHAT "CURRENT" LOOKS LIKE, and the new shape is the safer
  // one to assert. The check used to be a history walk whose "current" answer
  // was SILENCE — so a command that was malformed, or pointed at the wrong
  // path, produced the reassuring answer by failing. It is now a blob
  // comparison, and "current" is two IDENTICAL shas: a positive, 40-character
  // answer that a broken command cannot counterfeit. Section 3 still exists for
  // the other half — that a DIFFERENT pair is reachable.
  runEmbedded(commands[0]);
  const whenCurrent = runEmbedded(commands[1]);
  const currentShas = whenCurrent.split('\n').map((l) => l.trim()).filter(Boolean);
  check(
    'running the second verbatim against an unmoved origin/main prints two identical shas',
    currentShas.length === 2 && currentShas[0] === currentShas[1] && /^[0-9a-f]{40}$/.test(currentShas[0]),
    `got: ${JSON.stringify(whenCurrent)}`
  );

  // -------------------------------------------------------------------------
  console.log('\n== 3. the rule moves; the FROZEN brief\'s own check finds it ==\n');
  // -------------------------------------------------------------------------
  // KAN-234's shape, deterministically. `block` was rendered before this change
  // and is never re-rendered — it is the frozen artifact, exactly as a live
  // agent's `.butchr-prompt.md` is. The question is whether the commands it
  // froze can still discover what happened afterwards.
  fs.writeFileSync(
    path.join(clone, template),
    templateBody.replace('RULE-OF-THE-DAY: ALPHA', 'RULE-OF-THE-DAY: BRAVO')
  );
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'the rule changes after the brief was rendered']);
  const supersedingCommit = git(clone, ['rev-parse', '--short', 'HEAD']);
  git(clone, ['push', '--quiet', 'origin', 'main']);

  runEmbedded(commands[0]);
  const whenMoved = runEmbedded(commands[1]);
  const movedShas = whenMoved.split('\n').map((l) => l.trim()).filter(Boolean);
  check(
    "the frozen brief's command now reports two DIFFERENT blob shas",
    movedShas.length === 2 && movedShas[0] !== movedShas[1],
    `expected two differing shas, got:\n${whenMoved || '(empty — the check did not fire)'}`
  );
  // The discriminating half: the FIRST sha must still be the blob the brief was
  // rendered from. A command that simply printed origin/main twice would differ
  // from nothing and would pass a looser assertion.
  check(
    'and the first is still the blob the frozen brief was rendered from',
    movedShas[0] === git(clone, ['rev-parse', `${templateShort}:${template}`]) &&
      movedShas[1] === git(clone, ['rev-parse', `origin/main:${template}`]),
    `got:\n${whenMoved}`
  );

  // The diff command the block offers for reading what moved. It is blob-to-blob
  // for the same reason the check is: a range diff cannot be walked on a
  // shallow clone (KAN-523).
  const diffMatch = block.match(/`git -C (\S+) diff (\S+):(\S+) origin\/main:(\S+)`/);
  check('the block also offers a diff command', Boolean(diffMatch), block);
  if (diffMatch) {
    const diff = execFileSync(
      'git',
      ['-C', diffMatch[1], 'diff', `${diffMatch[2]}:${diffMatch[3]}`, `origin/main:${diffMatch[4]}`],
      { encoding: 'utf8' }
    );
    check(
      'and that diff shows the agent the old rule and the new one',
      diff.includes('-RULE-OF-THE-DAY: ALPHA') && diff.includes('+RULE-OF-THE-DAY: BRAVO'),
      diff
    );
  }

  // A re-render now names the new commit — the property that makes a RESTARTED
  // agent correct, and the one that says nothing about a running one.
  const reRendered = renderProvenanceBlock(templateProvenance(clone, template));
  check(
    're-rendering after the change stamps the superseding commit',
    reRendered.includes(supersedingCommit),
    reRendered
  );

  // -------------------------------------------------------------------------
  console.log('\n== 4. where git cannot answer, it says so and claims nothing ==\n');
  // -------------------------------------------------------------------------
  const notARepo = path.join(scratch, 'plain');
  fs.mkdirSync(path.join(notARepo, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(notARepo, template), templateBody);

  const p2 = templateProvenance(notARepo, template);
  const degraded = renderProvenanceBlock(p2);
  check('provenance from a non-checkout reports no commit', p2.commit === null, JSON.stringify(p2));
  check(
    'and gives a reason rather than an empty field',
    typeof p2.unavailable === 'string' && p2.unavailable.length > 0,
    p2.unavailable
  );
  check(
    'the rendered block says the commit could not be determined',
    /could not be determined/i.test(degraded),
    degraded
  );
  check(
    'and tells the reader to go to origin/main instead of implying it is current',
    /must not assume it is current/i.test(degraded) && /origin\/main/.test(degraded),
    degraded
  );
  check(
    'and embeds no git command that would print nothing and be read as "fine"',
    embeddedCommands(degraded).length === 0,
    embeddedCommands(degraded).join('\n')
  );

  const degradedBrief = new PromptLoader(notARepo).loadAndRender(template, { KEY: 'K', URL: '' });
  check(
    'a brief from a non-checkout still renders (an activation is never lost to git)',
    degradedBrief.includes('RULE-OF-THE-DAY') &&
      !degradedBrief.includes(`{{${PROVENANCE_VARIABLE}}}`),
    degradedBrief
  );

  // -------------------------------------------------------------------------
  console.log('\n== 5. a `$` in a substituted value survives into the brief ==\n');
  // -------------------------------------------------------------------------
  // Not hypothetical for the provenance block: it is generated multi-line text
  // built from a filesystem path, and `String.replace` reads `$&`, `$'` and
  // `$1` out of a STRING replacement. A path containing one would corrupt the
  // brief in a way nothing downstream could detect — the file would simply say
  // something other than what the daemon composed.
  const dollarBrief = new PromptLoader(clone).loadAndRender(template, {
    KEY: "KAN-$&-$'-$1",
    URL: ''
  });
  check(
    'a value containing $& , $\' and $1 is inserted literally',
    dollarBrief.includes("KAN-$&-$'-$1"),
    dollarBrief.split('\n').find((l) => l.includes('KAN-')) ?? dollarBrief
  );

  // -------------------------------------------------------------------------
  console.log('\n== 6. the SHIPPED prompts and the renderer agree on the token ==\n');
  // -------------------------------------------------------------------------
  // ADDED IN REVIEW BY `epic/KAN-39`, AND IT CAUGHT A REAL HOLE IN SECTIONS 1-5.
  //
  // Everything above builds its own fixture, and the fixture's placeholder was
  // spelled `{{${PROVENANCE_VARIABLE}}}` — derived from the constant. So the
  // fixture moved with the constant and the two could never disagree. Renaming
  // `PROVENANCE_VARIABLE`'s value to `PROMPT_PROVENANCE_X` and rebuilding left
  // this script, `verify-operative-rules-are-carried.mjs` and
  // `sweep-verify-exit-paths.mjs` **all exiting 0** — while every brief the
  // daemon writes shipped the literal, unsubstituted `{{PROMPT_PROVENANCE}}`:
  // no commit, no check command, the whole feature dead on the page an agent
  // reads, and nothing red anywhere.
  //
  // That is KAN-145 exactly — *a proof that supplies its own input has not
  // tested that the input arrives* — committed in the script whose header
  // quotes the rule. Section 4's case 20 is the nearest existing case and does
  // not cover it: it proves rendering survives a missing git, not that the
  // token in the shipped files is the token the code substitutes.
  //
  // THREE ASSERTIONS, EACH INDEPENDENTLY SUFFICIENT, BECAUSE THE POINT IS THAT
  // NOTHING HERE IS DERIVED FROM THE CODE UNDER TEST:
  //   1. the constant equals a literal spelled out in this file. Renaming it
  //      now forces whoever renames it to update the prompts and this line —
  //      which is the coupling, not an inconvenience.
  //   2. each shipped `prompts/*.md`, read off disk, carries that literal.
  //   3. each shipped prompt, rendered through the real loader, has NO `{{…}}`
  //      left in it. This is the end-to-end one and it is spelling-agnostic:
  //      it would fail on a renamed constant, a typo'd placeholder, a dropped
  //      `KEY`, or any future variable somebody adds to a template and forgets
  //      to supply.
  //
  // The fourth assertion stops (3) being satisfiable by deleting the
  // placeholder from the prompts — no braces left, and no stamp either.
  const LITERAL_TOKEN = 'PROMPT_PROVENANCE';
  const SHIPPED = ['task', 'story', 'epic', 'confluence'].map((t) => `prompts/${t}.md`);

  check(
    `the renderer's variable is literally ${LITERAL_TOKEN}`,
    PROVENANCE_VARIABLE === LITERAL_TOKEN,
    `PROVENANCE_VARIABLE is '${PROVENANCE_VARIABLE}'. If this rename is intended, ` +
      `update all four prompts/*.md AND the literal in this file — that is the point of it.`
  );

  const shippedLoader = new PromptLoader(repoRoot);
  for (const rel of SHIPPED) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    check(
      `${rel} carries the literal {{${LITERAL_TOKEN}}}`,
      new RegExp(`\\{\\{\\s*${LITERAL_TOKEN}\\s*\\}\\}`).test(src),
      `no {{${LITERAL_TOKEN}}} in ${rel}`
    );

    const rendered = shippedLoader.loadAndRender(rel, {
      KEY: 'KAN-242',
      URL: 'https://wroosbit.atlassian.net/browse/KAN-242'
    });
    const leftovers = [...new Set(rendered.match(/\{\{[^}\n]*\}\}/g) ?? [])];
    check(
      `${rel} renders with every placeholder substituted`,
      leftovers.length === 0,
      `a real brief would ship these unsubstituted: ${leftovers.join(', ')}`
    );
    check(
      `${rel} renders an actual provenance block`,
      /- \*\*Rendered\*\* /.test(rendered),
      'no "- **Rendered**" line — the placeholder may have been deleted rather than substituted'
    );
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join(', ')}`
    : `\nALL PASS — ${caseNumber - 1} asserted cases, every verdict as specified.`
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
