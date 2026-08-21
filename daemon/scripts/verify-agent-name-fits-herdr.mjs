// KAN-541: Butchr refuses an agent name herdr would refuse, and says why.
//
// WHAT FAILURE THIS WOULD CATCH: a name herdr's `agent start` will reject —
// too long, or carrying a character outside its class — reaching herdr, so that
// the first anybody hears of it is herdr's own getopt failing at ACTIVATION
// TIME, in herdr's words, naming a constraint no Butchr document mentions. That
// is the state this repository was in when KAN-541 was filed: `agentNameFor`
// built `butchr-<type>-<key>` and validated nothing, and nothing between it and
// herdr did either. It was found by accident, on a fixture key, by
// `task/KAN-533`:
//
//     [HerdrBridge] Could not start herdr agent butchr-probe-kan533-claude-281967:
//       agent name must start with a lowercase letter and contain only lowercase
//       letters, digits, '-' or '_' (1-32 characters)
//
// It also catches the three ways the fix rots, and §5 is the one written from a
// failure this ticket CAUSED rather than one it found. The first draft put the
// refusal in `agentNameFor` and CI failed five existing proofs: `reset_by_key`
// stopped broadcasting (so an over-long key would have been UNRESETTABLE), a
// spawn-failure LOG line threw inside the error path it was diagnosing, and
// `describeAgent` threw for the one address shape it exists to describe. §5
// holds both halves of what that taught: `agentNameFor` stays TOTAL, and every
// argv that hands herdr a name sits in a function that asked first. §3 catches
// the fleet-wide loop being made to THROW on one bad row instead of reporting
// it — which would turn "one ticket is unstaffable" into "board control is
// down", a strictly worse failure that nobody would attribute to a long project
// key. §4 catches the number 32 being written down a second time, in a doc or a
// second check, where the two copies can drift; that is KAN-541 AC3 and it is
// the reason the cap is an exported constant rather than a literal.
//
// CI-RUNNABLE: yes — imports `daemon/dist` and reads `daemon/src` as text, both
// in process. No live daemon, no herdr, no credential, no network, no
// terminal, no peer, and it writes nothing outside memory. §1-§3 exercise pure
// exported functions (`agentNameProblem`, `assertAgentNameFitsHerdr`,
// `computeBoardDiff`); §4 and §5 read the tree; none of them spawns anything. §6 DOES shell out to
// herdr and is therefore behind `--against-herdr`, which CI never passes and
// which is not a default: without the flag it prints SKIP and asserts nothing,
// so the classification above is a claim about the run CI performs.
//
// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT MEASURED HERE — AND §6 IS WHY THIS SECTION SHRANK
// ---------------------------------------------------------------------------
// §1-§5 assert that BUTCHR refuses. On their own they say nothing about whether
// herdr would refuse the SAME name, and that gap is the whole risk of a
// constant copied out of somebody else's error message: it can be copied wrong,
// or right and then superseded, and a green suite would look identical either
// way.
//
// §6 closes it, and it is off by default. `--against-herdr` puts the same names
// through the LIVE `herdr agent start` on this machine and asserts the two
// rules agree in BOTH directions. It costs nothing and creates nothing: herdr
// validates the name before it resolves the pane, so a probe aimed at a pane
// that does not exist gets `invalid_agent_name` for a name it hates and
// `agent_pane_not_found` for a name it accepts — a discriminating pair with no
// pane started on either arm. §6 refuses to run at all unless it has first
// confirmed, with `herdr pane get`, that its sentinel pane is absent.
//
// ⚠ IT IS NOT CI-RUNNABLE AND MUST NOT BECOME SO. CI has no herdr, which is why
// the flag is opt-in and why the default run says SKIP rather than passing. A
// green WITHOUT `--against-herdr` means Butchr stops before herdr is asked, and
// nothing more.
//
// ⚠ AND THE VERSION IS A READING WITH A DATE ON IT. §6 prints `herdr --version`
// with its verdict for that reason: this fleet ran **0.8.2** on 2026-08-20, and
// an earlier draft of this header confidently said 0.6.4 — which was true when
// somebody measured it and false by the time it was quoted. The rule it stated
// as "0.6.4 has no such rule at all" is retired rather than softened: its
// second leg read the 33-character `crabcast-*` strings out of `herdr agent
// list`'s `agent` field, which is the agent KIND and not the validated `name`
// (a Butchr-started pane reads `"agent":"claude", "name":"butchr-epic-kan-39"`),
// so it was never evidence about the cap in the first place. What replaces it
// is §6, which asks the running binary instead of reasoning about a released
// one.
//
// ---------------------------------------------------------------------------
// MADE TO GO RED
// ---------------------------------------------------------------------------
// §4 and §5 mutate an in-memory copy of the source, so their red drives are
// self contained and leave the tree untouched. One per assertion, each tripping
// its own section alone and each asserting that its own edit took:
//
//   node daemon/scripts/verify-agent-name-fits-herdr.mjs --second-cap
//   node daemon/scripts/verify-agent-name-fits-herdr.mjs --second-spelling
//   node daemon/scripts/verify-agent-name-fits-herdr.mjs --unguarded-spawn
//   node daemon/scripts/verify-agent-name-fits-herdr.mjs --against-herdr --wrong-cap
//
// §1-§3 assert the behaviour of the BUILD, so the only honest way to watch them
// fail is to remove the check and rebuild — a stand-in with the rule deleted
// would prove the assertions discriminate and NOT that they are bound to the
// real code, which is the "a proof that supplies its own input" trap. So the
// baseline is supplied from outside, exactly as
// `verify-prompt-write-refusal.mjs` does:
//
//   cd daemon && npm run build
//   cp src/herdr.ts /tmp/kan541-herdr-fixed.ts
//   # put back the one-line producer KAN-541 was filed against
//   npx tsc --outDir dist-unfixed
//   cp /tmp/kan541-herdr-fixed.ts src/herdr.ts
//   node scripts/verify-agent-name-fits-herdr.mjs --baseline dist-unfixed
//
// With `--baseline`, §0 additionally asserts that the baseline build MINTS the
// name this branch refuses — a baseline that also refused would mean the
// mutation never took, and the red drive would be reporting strength it had not
// exercised. Without it, §0 says so and is skipped; it is not silently passed.
//
// Going GREEN under `--second-cap` is counted as a failure.

import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');
const distDir = path.join(repoRoot, 'daemon', 'dist');

const verbose = process.argv.includes('--verbose');
const secondCap = process.argv.includes('--second-cap');
const secondSpelling = process.argv.includes('--second-spelling');
const unguardedSpawn = process.argv.includes('--unguarded-spawn');
const againstHerdr = process.argv.includes('--against-herdr');
const wrongCap = process.argv.includes('--wrong-cap');
const baselineArg = (() => {
  const i = process.argv.indexOf('--baseline');
  return i >= 0 && process.argv[i + 1] ? path.resolve(repoRoot, 'daemon', process.argv[i + 1]) : null;
})();

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('-'.repeat(76));
  say(title);
  say('-'.repeat(76));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) {
    say(`        ${String(detail).split('\n').slice(0, 10).join('\n        ')}`);
  }
  return ok;
};

// -- setup guards (NOT verdicts) -------------------------------------------
if (!fs.existsSync(path.join(distDir, 'herdr.js'))) {
  console.error(`Missing ${distDir}/herdr.js - run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}
if (!fs.existsSync(srcDir)) {
  console.error(`Missing ${srcDir} - §4 reads the tree, not a build.`);
  process.exit(2);
}

const {
  agentNameFor,
  agentNameProblem,
  assertAgentNameFitsHerdr,
  HERDR_AGENT_NAME_MAX_LENGTH,
  HERDR_AGENT_NAME_PATTERN,
  InvalidAgentNameError
} = await import(path.join(distDir, 'herdr.js'));
const { computeBoardDiff } = await import(path.join(distDir, 'board-reconcile.js'));

const CAP = HERDR_AGENT_NAME_MAX_LENGTH;

/**
 * A Jira-shaped key whose agent name overruns the cap by `over` characters.
 *
 * Derived from the cap rather than typed out, so this fixture follows a herdr
 * that moves the limit instead of quietly becoming a test of nothing. It must
 * stay Jira-shaped (`JIRA_KEY` in `keys.ts`) or §3's reconciler would discard
 * it for an unrelated reason and report a pass that measured the wrong thing.
 */
function overlongKey(over = 1) {
  const suffix = '-541';
  const width = CAP + over - 'butchr-task-'.length - suffix.length;
  return `${'A'.repeat(width)}${suffix}`;
}

/** The longest key that still fits, for the boundary that must NOT be refused. */
function exactlyFittingKey() {
  const suffix = '-541';
  const width = CAP - 'butchr-task-'.length - suffix.length;
  return `${'A'.repeat(width)}${suffix}`;
}

const thrownBy = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

say('KAN-541 - an agent name Butchr cannot spell is refused before herdr sees it');
say(`cap read from the build: HERDR_AGENT_NAME_MAX_LENGTH = ${CAP}`);
say(`class read from the build: ${HERDR_AGENT_NAME_PATTERN}`);

// -- §0 ---------------------------------------------------------------------
rule('§0  the baseline actually lacks the check (skipped without --baseline)');
if (!baselineArg) {
  say('  SKIP  no --baseline supplied, so nothing is claimed about the pre-fix build.');
  say('        This section asserts the red drive s mutation took. See the header');
  say('        for the four commands that produce the baseline dist.');
} else if (!fs.existsSync(path.join(baselineArg, 'herdr.js'))) {
  check(false, `--baseline ${baselineArg} has no herdr.js`, 'the baseline build is missing or incomplete');
} else {
  const baseline = await import(path.join(baselineArg, 'herdr.js'));
  const key = overlongKey(2);
  const minted = thrownBy(() => baseline.agentNameFor('task', key));
  check(
    minted === null,
    'the baseline build MINTS the over-long name rather than refusing it',
    minted ? `it threw: ${minted.message}` : ''
  );
  const name = baseline.agentNameFor('task', key);
  check(
    name.length > CAP,
    `and the name it minted is ${name.length} characters, over the cap of ${CAP}`,
    name
  );
  say('');
  say('  That is the defect KAN-541 was filed for, reproduced from the pre-fix build:');
  say(`  a ${name.length}-character name handed to herdr, which refuses it at activation.`);
}

// -- §1 ---------------------------------------------------------------------
rule('§1  agentNameProblem - the rule itself, asserted at its boundary');
{
  const fits = `butchr-task-${'a'.repeat(CAP - 'butchr-task-'.length)}`;
  check(fits.length === CAP, `the fixture is exactly ${CAP} characters`, `${fits.length}`);
  check(
    agentNameProblem(fits) === null,
    `a name of exactly ${CAP} characters is accepted - the cap is inclusive`,
    String(agentNameProblem(fits))
  );

  const over = `${fits}a`;
  const overProblem = agentNameProblem(over);
  check(
    typeof overProblem === 'string' && overProblem.length > 0,
    `a name of ${CAP + 1} characters is refused`,
    `agentNameProblem returned ${JSON.stringify(overProblem)}`
  );
  check(
    typeof overProblem === 'string' && overProblem.includes(String(CAP)),
    'and the refusal names the limit, rather than only reporting a fault',
    String(overProblem)
  );

  check(
    typeof agentNameProblem('') === 'string',
    'the empty name is refused - herdr requires at least one character',
    String(agentNameProblem(''))
  );

  // The nearer miss of the two: no key needs to be long to carry one of these.
  for (const bad of ['butchr-task-kan 541', 'butchr-task-kan.541', 'butchr-task-KAN-541', 'butchr-task-kan/541']) {
    const problem = agentNameProblem(bad);
    check(
      typeof problem === 'string' && problem.includes('lowercase'),
      `character class refuses ${JSON.stringify(bad)}`,
      `agentNameProblem returned ${JSON.stringify(problem)}`
    );
  }
  check(
    agentNameProblem('butchr-task-kan-541') === null,
    'and today s ordinary name is untouched by both halves',
    String(agentNameProblem('butchr-task-kan-541'))
  );
}

// -- §2 ---------------------------------------------------------------------
rule('§2  assertAgentNameFitsHerdr - the boundary refuses, and the message is usable');
{
  const key = overlongKey(3);
  const err = thrownBy(() => assertAgentNameFitsHerdr('task', key));
  check(err instanceof Error, 'the boundary form throws rather than handing herdr an unusable name', String(err));
  check(
    err instanceof InvalidAgentNameError,
    'and it throws the named error, so a caller can tell this from any other failure',
    err ? `${err.name}: ${err.constructor.name}` : '(nothing thrown)'
  );

  const message = err ? String(err.message) : '';
  check(message.includes(String(CAP)), `the message names the limit (${CAP})`, message);
  check(
    message.includes(`butchr-task-${key.toLowerCase()}`),
    'the message quotes the offending name in full',
    message
  );
  check(message.includes(key), 'the message names the key, which is the caller s actual lever', message);
  check(
    message.includes('butchr-<type>-<key>'),
    'and it explains the budget, so a reader need not do the arithmetic',
    message
  );

  // The OTHER half of herdr's rule, and the half whose message must NOT carry a
  // budget: a key with a space in it is not one character too long, and an
  // error that tells its author how many characters they have left sends them
  // to shorten a key that was never the wrong length.
  {
    const classErr = thrownBy(() => assertAgentNameFitsHerdr('task', 'kan 541'));
    check(
      classErr instanceof InvalidAgentNameError,
      'a key outside herdr’s character class is refused too — the nearer miss of the two',
      String(classErr)
    );
    const classMessage = classErr ? String(classErr.message) : '';
    check(
      classMessage.includes('lowercase'),
      'and its message names the class rule rather than a length',
      classMessage
    );
    check(
      !classMessage.includes('characters for the key'),
      'and it does NOT quote a budget, which would send the reader to shorten a key that fits',
      classMessage
    );
  }

  // The boundary from the producer's side, not just the rule's.
  const fitting = exactlyFittingKey();
  const ok = thrownBy(() => assertAgentNameFitsHerdr('task', fitting));
  check(ok === null, `a key that exactly fills the budget still mints (${fitting})`, ok ? ok.message : '');
  check(
    ok === null && assertAgentNameFitsHerdr('task', fitting).length === CAP,
    `and the name it mints is exactly ${CAP} characters`,
    ok ? '(threw)' : String(assertAgentNameFitsHerdr('task', fitting).length)
  );

  // Every real address on this board, so the fix cannot have broken the fleet.
  const live = [
    ['task', 'KAN-541'],
    ['epic', 'KAN-39'],
    ['story', 'KAN-150'],
    ['confluence', '196787'],
    ['crabcast', 'KAN-203']
  ];
  const broke = live.filter(([t, k]) => thrownBy(() => assertAgentNameFitsHerdr(t, k)) !== null);
  check(
    broke.length === 0,
    'every address shape this fleet actually uses still mints',
    broke.map(([t, k]) => `${t}/${k}`).join(', ')
  );
}

// -- §3 ---------------------------------------------------------------------
rule('§3  computeBoardDiff - one bad row is REPORTED, and does not abort the cycle');
{
  const badKey = overlongKey(4);
  const issues = [
    { key: badKey, statusName: 'In Progress', issueTypeName: 'Task', assignee: 'someone' },
    { key: 'KAN-39', statusName: 'In Progress', issueTypeName: 'Epic', assignee: 'someone' },
    { key: 'KAN-541', statusName: 'In Progress', issueTypeName: 'Task', assignee: 'someone' }
  ];
  // An agent already running on the bad key - staffed before the rule tightened.
  const running = [{ agentName: `butchr-task-${badKey.toLowerCase()}`, type: 'task', key: badKey }];

  const thrown = thrownBy(() => computeBoardDiff(issues, running));
  check(
    thrown === null,
    'the fleet-wide loop does not throw on the row it cannot name',
    thrown ? `${thrown.name}: ${thrown.message}` : ''
  );

  if (thrown === null) {
    const diff = computeBoardDiff(issues, running);

    const row = diff.unresolved.find((u) => u.key === badKey.toUpperCase());
    check(Boolean(row), 'the bad row is reported as unresolved', JSON.stringify(diff.unresolved));
    check(
      Boolean(row) && row.reason.includes(String(CAP)),
      'and its reason names the limit, so the board log says why',
      row ? row.reason : '(no row)'
    );

    check(
      !diff.desired.some((d) => d.key.toUpperCase() === badKey.toUpperCase()),
      'nothing is desired for it, so no activation is attempted',
      diff.desired.map((d) => d.agentName).join(', ')
    );
    check(
      !diff.toStop.some((s) => s.key.toUpperCase() === badKey.toUpperCase()),
      'and nothing running on that key is stood down - an unnameable row is an unanswered question',
      diff.toStop.map((s) => s.agentName).join(', ')
    );

    // The half that matters most: the OTHER rows survived the bad one.
    const survivors = diff.desired.map((d) => d.key.toUpperCase()).sort();
    check(
      survivors.includes('KAN-39') && survivors.includes('KAN-541'),
      'every other row on the board was still resolved - the cycle converged',
      survivors.join(', ')
    );
  }
}

// -- §4 ---------------------------------------------------------------------
rule('§4  the cap has ONE home in daemon/src (KAN-541 AC3)');
{
  /** Every `.ts` under daemon/src, discovered rather than listed. */
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) out.push(...walk(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out.sort();
  };

  const files = walk(srcDir);
  check(files.length > 0, 'the sweep found .ts files to read', `${files.length} files`);

  const sources = new Map();
  for (const full of files) {
    const rel = path.relative(repoRoot, full);
    let text = fs.readFileSync(full, 'utf8');
    if (secondCap && rel.endsWith('board-reconcile.ts')) {
      // The mutation: a second copy of the NUMBER, in a second check, exactly
      // as it would arrive if somebody "helpfully" guarded the reconciler
      // inline instead of reading the constant. Deliberately spelled with a
      // variable this section's spelling regex does not match, so it trips the
      // rival-literal assertion alone and the two mutations stay separable.
      text = text.replace(
        'const named = tryAgentNameFor(',
        'const tooLong = agentLabel.length > 32;\n    const named = tryAgentNameFor('
      );
    }
    if (secondSpelling && rel.endsWith('board-reconcile.ts')) {
      // The other half: a second copy of the SPELLING. This is the mutation
      // that reproduces what the first draft of KAN-541 actually shipped —
      // the reconciler rebuilding the name by hand to ask about it.
      text = text.replace(
        'const named = tryAgentNameFor(',
        'const candidate = `butchr-${type}-${key.toLowerCase()}`;\n    const named = tryAgentNameFor('
      );
    }
    sources.set(rel, text);
  }

  for (const [flag, marker, label] of [
    [secondCap, 'const tooLong =', '--second-cap'],
    [secondSpelling, 'const candidate = `butchr-', '--second-spelling']
  ]) {
    if (!flag) continue;
    const mutated = sources.get('daemon/src/board-reconcile.ts');
    check(
      typeof mutated === 'string' && mutated.includes(marker),
      `the ${label} mutation took (a mutation that matched nothing proves nothing)`,
      'board-reconcile.ts was not rewritten in memory'
    );
  }

  // Comments and doc blocks legitimately DISCUSS the number - the constant's
  // own docblock quotes herdr's message, and must be free to. So strip comments
  // before counting, exactly as verify-agent-name-brands-have-one-home.mjs
  // does: a check that counted prose would go red when somebody improved a
  // comment, which is the same shape of wrong as not checking at all.
  //
  // ⚠ Newlines are PRESERVED through the strip. A block comment replaced by a
  // single space collapses every line it spanned, and every line number
  // reported after it is then wrong — which this script did on its first run,
  // pointing at `herdr.ts:210` for a template on line 668. A verify script that
  // reports the wrong location is worse than one that reports none: the reader
  // goes to the named line, finds nothing, and disbelieves the finding.
  const stripComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  const declaration = /HERDR_AGENT_NAME_MAX_LENGTH\s*=\s*(\d+)/g;
  const declared = [];
  for (const [rel, text] of sources) {
    const code = stripComments(text);
    let m;
    while ((m = declaration.exec(code)) !== null) declared.push({ rel, value: Number(m[1]) });
  }
  check(
    declared.length === 1,
    `the cap is declared exactly once in daemon/src (found ${declared.length})`,
    declared.map((d) => `${d.rel} = ${d.value}`).join('\n')
  );
  check(
    declared.length === 1 && declared[0].value === CAP,
    'and the declaration is the value the build exports',
    declared.map((d) => `${d.rel} = ${d.value}, build says ${CAP}`).join('\n')
  );

  // Any OTHER literal compared against a `.length` is a second cap by another
  // name. This is the assertion --second-cap exists to trip.
  const rival = new RegExp(`\\.length\\s*[<>]=?\\s*${CAP}\\b|\\b${CAP}\\s*[<>]=?\\s*[A-Za-z_$][\\w$]*\\.length`, 'g');
  const rivals = [];
  for (const [rel, text] of sources) {
    const code = stripComments(text);
    let m;
    while ((m = rival.exec(code)) !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      rivals.push(`${rel}:${line}  ${m[0].trim()}`);
    }
  }
  check(
    rivals.length === 0,
    `no second literal ${CAP} is compared against a length anywhere in daemon/src`,
    rivals.join('\n')
  );

  // The same property one level down, and it is the one this ticket's own first
  // draft got wrong: the SPELLING must have one home too. A hand-written
  // `butchr-${type}-` is a second derivation of the name — the defect KAN-346
  // and KAN-397 each fixed once, one function apart — and a length rule that
  // reads a differently-built string is checking something other than the name
  // that will be handed to herdr.
  //
  // ⚠ NOT every `butchr-${...}` template: `crabcast-link.ts` builds a request
  // id as `butchr-${process.pid}-${this.nextId++}`, which is the same SHAPE and
  // is not an agent name. Shape alone cannot separate them, so what is matched
  // is the agent-name spelling specifically — a first interpolation named
  // `type`, or a key put through `toLowerCase()`. Both halves of the realistic
  // duplication (a copy-paste of the real line, or a check written from memory)
  // carry one of those.
  //
  // WHAT THAT LEAVES UNCOVERED, said rather than implied: a second spelling
  // that renames the variable AND drops the lower-casing — `butchr-${t}-${k}` —
  // is invisible here. It would also be a different bug, since it loses the
  // case fold that makes the name herdr-legal in the first place, and §1 is
  // what catches that one.
  const spelling = /`butchr-\$\{\s*type\s*\}-|`butchr-\$\{[^}]*\}-\$\{[^}]*toLowerCase\(\)/g;
  const spellings = [];
  for (const [rel, text] of sources) {
    const code = stripComments(text);
    let m;
    while ((m = spelling.exec(code)) !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      spellings.push(`${rel}:${line}  ${m[0].trim()}`);
    }
  }
  check(
    spellings.length === 1,
    `the name template is written exactly once in daemon/src (found ${spellings.length})`,
    spellings.join('\n')
  );
  check(
    spellings.length === 1 && spellings[0].startsWith('daemon/src/herdr.ts:'),
    'and it lives in herdr.ts, beside the rule that validates it',
    spellings.join('\n')
  );
}

// -- §5 ---------------------------------------------------------------------
rule('§5  nothing hands herdr a name without asking first');
{
  // WHY THIS SECTION EXISTS, AND IT IS THE LESSON OF A RED CI RUN RATHER THAN
  // A PRECAUTION. The first draft of KAN-541 put the refusal in `agentNameFor`,
  // reading the ticket's "before herdr is called" as "in the producer". CI
  // failed five proofs: `reset_by_key` stopped broadcasting (so an over-long
  // key would have been UNRESETTABLE), a spawn-failure LOG line threw inside
  // the error path it was diagnosing, and `describeAgent` threw for the one
  // address shape it exists to describe. All three compute a name to say
  // something about an agent, not to start one.
  //
  // So `agentNameFor` is total again and the refusal sits at the boundary. This
  // section is what makes that boundary a mechanism rather than a decision
  // somebody remembers: EVERY argv that hands herdr a NAME must sit in a
  // function that called `assertAgentNameFitsHerdr`.
  //
  // ⚠ `agent rename` is on the list as well as `agent start`, and leaving it
  // off would have been the comfortable mistake: the no-kind (shell) route
  // never calls `agent start` at all — it declares the pane with `pane
  // report-agent` and then NAMES it with `agent rename`, which herdr validates
  // identically. A rule that watched only `agent start` would have been green
  // for a route that reaches the same getopt.
  //
  // ⚠ WHAT THIS DOES NOT DO: it attributes each site to the nearest preceding
  // function declaration rather than brace-matching a full parse. That is exact
  // for the shape here — one method, no nested declarations between the check
  // and the argv — and it is why the red drive below removes the CALL rather
  // than moving the argv: the drive proves the attribution discriminates, and
  // a reader should not take a green here as a claim about a nesting shape
  // nobody has written yet.
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) out.push(...walk(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out.sort();
  };

  // Comments legitimately QUOTE these argvs — `agentNameFor`'s own docblock
  // names `'agent', 'start'` to explain where the check went — so a check that
  // counted prose would go red when somebody improved a comment. Newlines are
  // preserved so a reported line number is the line in the file.
  const strip = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  const HANDS_HERDR_A_NAME = [
    { label: "agent start", re: /'agent',\s*'start'/g },
    { label: "agent rename", re: /'agent',\s*'rename'/g }
  ];
  const DECLARATION = /(?:^|\s)(?:(?:export\s+)?(?:async\s+)?function\s+|private\s+|public\s+|protected\s+)([A-Za-z_$][\w$]*)\s*\(/g;
  const GUARD = 'assertAgentNameFitsHerdr(';

  const sites = [];
  const unguarded = [];
  for (const full of walk(srcDir)) {
    const rel = path.relative(repoRoot, full);
    let text = fs.readFileSync(full, 'utf8');
    if (unguardedSpawn && rel.endsWith('herdr.ts')) {
      // The mutation: the boundary check deleted, exactly as it would arrive if
      // somebody "simplified" the signature back to taking a name. The argv
      // stays, so this is a spawn path that reaches herdr's getopt unasked —
      // which is the state KAN-541 was filed against.
      text = text.replace(
        'const agentName = assertAgentNameFitsHerdr(address.type, address.key);',
        'const agentName = agentNameFor(address.type, address.key);'
      );
    }
    const code = strip(text);

    const declarations = [];
    DECLARATION.lastIndex = 0;
    let d;
    while ((d = DECLARATION.exec(code)) !== null) declarations.push({ at: d.index, name: d[1] });

    for (const { label, re } of HANDS_HERDR_A_NAME) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        const owner = [...declarations].reverse().find((x) => x.at < m.index);
        const line = code.slice(0, m.index).split('\n').length;
        const where = `${rel}:${line}  ${label} in ${owner ? owner.name : '(top level)'}`;
        sites.push(where);
        // The guard must be inside the SAME function: after its declaration and
        // before this argv.
        const from = owner ? owner.at : 0;
        if (!code.slice(from, m.index).includes(GUARD)) unguarded.push(where);
      }
    }
  }

  check(
    sites.length > 0,
    'the sweep found argvs that hand herdr a name',
    sites.join('\n') || 'none found — this section would be vacuous, which is itself the failure'
  );
  if (unguardedSpawn) {
    check(
      unguarded.length > 0,
      'the --unguarded-spawn mutation took (a mutation that matched nothing proves nothing)',
      'herdr.ts was not rewritten in memory'
    );
  }
  check(
    unguarded.length === 0,
    `every one of them is inside a function that called ${GUARD.slice(0, -1)}`,
    unguarded.join('\n')
  );

  // AND THE OTHER HALF OF THE LESSON, ASSERTED RATHER THAN TRUSTED TO PROSE:
  // `agentNameFor` must stay TOTAL. This is the assertion that would have
  // caught the first draft before CI did.
  const spellings = [
    ['task', 'a'.repeat(64)],
    ['?', 'KAN-541'],
    ['task', 'KAN-9005-NO-SUCH-WORKSPACE'],
    ['task', 'kan 541']
  ];
  const threw = spellings.filter(([t, k]) => thrownBy(() => agentNameFor(t, k)) !== null);
  check(
    threw.length === 0,
    'agentNameFor is TOTAL — it spells a name for every address, including ones herdr would refuse',
    threw.map(([t, k]) => `${t}/${k}`).join(', ')
  );
  check(
    agentNameFor('task', 'KAN-9005-NO-SUCH-WORKSPACE') === 'butchr-task-kan-9005-no-such-workspace',
    'and the name it spells for the key that broke reset_by_key is the one it always spelled',
    agentNameFor('task', 'KAN-9005-NO-SUCH-WORKSPACE')
  );
  check(
    thrownBy(() => assertAgentNameFitsHerdr('task', 'KAN-9005-NO-SUCH-WORKSPACE')) !== null,
    'while the boundary form DOES refuse it — the two answer different questions',
    'assertAgentNameFitsHerdr accepted a 38-character name'
  );
}

// -- §6 ---------------------------------------------------------------------
rule('§6  the LIVE herdr agrees, in both directions (needs --against-herdr)');
if (!againstHerdr) {
  say('  SKIP  not asked. §1-§5 say Butchr refuses; they do not say herdr would.');
  say('        Re-run with --against-herdr on a machine that has herdr, and see the');
  say('        header for why this is opt-in rather than part of the CI set.');
} else {
  // A pane id herdr's own grammar allows and this session does not hold. It is
  // CHECKED rather than assumed, and the check is a safety interlock rather
  // than diligence: `agent start` at a pane that DOES exist would start claude
  // in somebody's terminal. If the sentinel resolves, this section refuses to
  // probe and says so.
  const SENTINEL_PANE = 'w9:pZZ';

  // ⚠ BOTH STREAMS, AND THIS IS NOT DEFENSIVENESS. herdr answers a SUCCESS on
  // stdout with exit 0 and a REFUSAL on stderr with exit 1 — measured, after
  // the first draft of this section read stdout alone and got an empty string
  // for a refusal that was sitting on the other stream. It then reported
  // "herdr answered null" and refused to probe, which is the right failure and
  // the wrong reason. A reader who kept only stdout would have concluded the
  // sentinel pane might exist.
  const herdr = (args) => {
    try {
      const out = execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return out;
    } catch (e) {
      // A non-zero exit is herdr's ordinary way of saying no, so this is the
      // expected path for every refusal. It is also the path a missing binary
      // takes, which is why the caller checks for a parseable answer rather
      // than for a thrown error.
      return `${e?.stdout ?? ''}${e?.stderr ?? ''}` || null;
    }
  };

  const codeOf = (out) => {
    if (typeof out !== 'string') return null;
    try {
      return JSON.parse(out.trim().split('\n').pop())?.error?.code ?? 'NO_ERROR';
    } catch {
      return null;
    }
  };

  const version = (herdr(['--version']) ?? '').trim();
  if (!version) {
    check(false, 'herdr answered --version', 'no herdr on PATH, or the server could not be reached');
  } else {
    say(`  herdr reports: ${version}`);
    say('  (a version is a reading with a date on it — this verdict is about THIS binary)');

    const sentinel = codeOf(herdr(['pane', 'get', SENTINEL_PANE]));
    const sentinelAbsent = sentinel === 'pane_not_found';
    check(
      sentinelAbsent,
      `the sentinel pane ${SENTINEL_PANE} does not exist — safe to probe`,
      sentinelAbsent
        ? `herdr answered ${JSON.stringify(sentinel)}`
        : `herdr answered ${JSON.stringify(sentinel)} — refusing to run \`agent start\` at a pane ` +
          'that may be live, because that would start claude in a terminal somebody is using'
    );

    if (sentinelAbsent) {
      // Both arms of the rule, and both arms of the ANSWER. A probe set where
      // every name is illegal cannot tell "herdr refuses everything" from
      // "herdr refuses these" — so the legal names are the positive control and
      // they are in the same list, asserted the same way.
      const probes = [
        'b',
        'butchr-task-kan-541',
        'butchr_task_kan_541',
        `butchr-task-${'a'.repeat(CAP - 'butchr-task-'.length)}`,
        `butchr-task-${'a'.repeat(CAP - 'butchr-task-'.length + 1)}`,
        'butchr-task-kan 541',
        'butchr-task-KAN-541',
        'butchr-task-kan.541',
        'butchr-?-kan-541',
        '1butchr-task',
        '_butchr-task',
        ''
      ];

      let agreed = 0;
      let herdrRefused = 0;
      const disagreements = [];
      for (const name of probes) {
        const code = codeOf(herdr(['agent', 'start', name, '--kind', 'claude', '--pane', SENTINEL_PANE]));
        if (code === null) {
          disagreements.push(`${JSON.stringify(name)}: herdr gave no parseable answer`);
          continue;
        }
        const herdrSaysNo = code === 'invalid_agent_name';
        if (herdrSaysNo) herdrRefused += 1;
        // The rule under test. `--wrong-cap` swaps in a rule that is off by one
        // at the top, which is the only realistic way this constant goes wrong:
        // somebody reads `(1-32 characters)` as "31 plus the first", or copies
        // `{0,31}` across as 33. If §6 is watching what it claims to, that one
        // character turns the boundary probe into a disagreement.
        const butchrSaysNo = wrongCap
          ? name.length > CAP + 1 || !name.length || !HERDR_AGENT_NAME_PATTERN.test(name)
          : agentNameProblem(name) !== null;
        if (herdrSaysNo === butchrSaysNo) {
          agreed += 1;
          if (verbose) {
            say(`        ${herdrSaysNo ? 'both refuse' : 'both accept'}  ${JSON.stringify(name)} (herdr: ${code})`);
          }
        } else {
          disagreements.push(
            `${JSON.stringify(name)}: herdr ${herdrSaysNo ? 'REFUSES' : `accepts (${code})`}, ` +
            `Butchr ${butchrSaysNo ? 'REFUSES' : 'accepts'}`
          );
        }
      }

      check(
        disagreements.length === 0,
        `Butchr's rule and this herdr agree on all ${probes.length} probes (${agreed} agreed)`,
        disagreements.join('\n')
      );
      // The control, stated as its own assertion rather than left implicit: a
      // herdr that refused every name would have "agreed" with nothing, and a
      // herdr that accepted every name would have agreed with the legal half by
      // accident. Both arms have to be non-empty for the line above to mean
      // anything.
      check(
        herdrRefused > 0 && herdrRefused < probes.length,
        'and the probe set discriminates — herdr refused some of these names and accepted others',
        `herdr refused ${herdrRefused} of ${probes.length}`
      );
    }
  }
}

// -- verdict ----------------------------------------------------------------
say('');
say('='.repeat(76));
if (failures) {
  say(`FAILED - ${failures} assertion${failures === 1 ? '' : 's'} did not hold.`);
  if (secondCap) {
    say('');
    say('This is the expected red for --second-cap. The behaviour that made it red: a');
    say(`second literal ${CAP} guarding a length, in board-reconcile.ts, where it can drift`);
    say('away from the constant the build actually reads. §4 only.');
  }
  if (wrongCap) {
    say('');
    say('This is the expected red for --wrong-cap. The behaviour that made it red: a cap');
    say(`of ${CAP + 1} instead of ${CAP}, so a ${CAP + 1}-character name Butchr would have accepted`);
    say('is one the LIVE herdr refuses. §6 only, and it needs --against-herdr too.');
  }
  if (unguardedSpawn) {
    say('');
    say('This is the expected red for --unguarded-spawn. The behaviour that made it red:');
    say('the boundary check deleted from the one function that builds the `agent start`');
    say('argv, so a name reaches herdr unasked — the state KAN-541 was filed against.');
    say('§5 only.');
  }
  if (secondSpelling) {
    say('');
    say('This is the expected red for --second-spelling. The behaviour that made it red:');
    say('the reconciler rebuilding `butchr-<type>-<key>` by hand rather than asking the');
    say('one producer — a second derivation of the name, which is what makes a length');
    say('rule check a string other than the one herdr will be handed. §4 only.');
  }
} else {
  say('  OK - the herdr BOUNDARY refuses a name herdr would refuse and the producer');
  say('  stays total, the message names the limit and the key, the board loop reports');
  say('  instead of aborting, and the cap has one home.');
  say('');
  if (againstHerdr) {
    say('');
    say('  And §6 asked the running herdr the same questions and got the same answers,');
    say('  in both directions, with a positive control that could have said otherwise.');
  } else {
    say('');
    say('  This says NOTHING about a live herdr refusing the same name — that is §6,');
    say('  and it is off. Re-run with --against-herdr on a machine that has herdr.');
  }
  for (const [flag, label] of [
    [secondCap, '--second-cap'],
    [secondSpelling, '--second-spelling'],
    [unguardedSpawn, '--unguarded-spawn'],
    [wrongCap && againstHerdr, '--wrong-cap --against-herdr']
  ]) {
    if (!flag) continue;
    say('');
    say(`  BUT ${label} was requested and this went GREEN, which means the mutation`);
    say('  did not move the verdict: §4 is not watching what it claims to.');
    failures += 1;
  }
}

process.exit(failures ? 1 : 0);
