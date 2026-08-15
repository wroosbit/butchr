// KAN-429: adoption answers `expectsRuntime` only for launcher names Butchr has.
//
// WHAT FAILURE THIS WOULD CATCH: `adoptFromCensus` reading CrabCast's
// `config.launcher` as `row.launcher !== 'shell'` — a join across two
// vocabularies. An agent CrabCast configured ITSELF inside Butchr's workspace
// tree is adopted (the filter is `addressForPath`, not who configured the row),
// and its launcher is CrabCast's string. A runtime-less launcher of theirs
// spelled anything but `shell` was therefore adopted as EXPECTING a runtime, and
// `expectsRuntime` is read as fact one layer up: `router.ts`'s
// `confirmActivation` passes `session.expectsRuntime ?? true` into
// `confirmAgentPresent`, and an `absent` answer calls `abandonSession`. So the
// defect is not a mislabelled field — it is a LIVE PANE torn out of Butchr's
// session map and reported a failed activation, which is the KAN-397 harm shape
// exactly. It fails silently and in the comfortable direction: the wrong join
// answers plausibly, and nothing is visible without a live peer running a
// launcher Butchr does not have.
//
// It also catches the second half, which is a copy going stale. The vocabulary
// is spelled in `crabcast-runtime.ts` rather than imported from `launchers.ts`,
// for a reason §2 states and checks; §1 is what stops the copy drifting from
// `AGENT_LAUNCHERS`.
//
// CI-RUNNABLE: partial — §1-§5 assert in CI. They read source as text and stand
// up their own Unix socket under os.tmpdir(); they need no peer, no herdr, no
// PTY, no credential and no network. §6 needs a live CrabCast daemon and SKIPS
// without one. A skip is printed as a skip and never counted as a pass.
//
// ── WHICH SECTIONS READ WHAT, AND WHY THAT MATTERS BEFORE THE VERDICT ──────
//
// THIS SCRIPT IS A BLEND, so read the SECTION and never the exit code alone
// (KAN-314's third case). §1 and §2 read `daemon/src/*.ts` as TEXT — they tested
// what you wrote, and their verdict survives a failed build. §3-§6 IMPORT FROM
// `dist` — after a failed build they are testing the previous build and both
// outcomes mislead. Each section title says which it is.
//
// ── WHAT SUPPLIES ITS OWN INPUT, AND WHO COVERS WHAT THAT LEAVES ───────────
//
// §3-§5 answer their own `list_agents` frames, so they are structurally
// incapable of noticing that a real CrabCast sends something different. That is
// the KAN-145 shape and it is owned here rather than left to inference:
//
//   - The frame is NOT hand-written. It is
//     `fixtures/crabcast-owned-running-census.json`, captured verbatim off a
//     live CrabCast socket while two agents CrabCast itself had started were
//     RUNNING. Paths are rewritten from its `capturedWorkspacesRoot` to this
//     machine's `workspacesRoot()`, exactly as
//     `verify-crabcast-session-restore.mjs` does and for the same reason.
//   - ONE FURTHER EDIT IS MADE, AND IT IS THE POINT OF §3: one row's
//     `config.launcher` is rewritten to a name Butchr does not have. **No
//     committed fixture contains one** — every captured row carries `claude` or
//     `shell`, because every captured row was configured by Butchr. That is the
//     population the guard is a no-op on (§4), and it is exactly why the
//     hazardous population has to be synthesised to be exercised at all.
//   - WHAT THAT LEAVES UNCOVERED: that a real CrabCast can produce such a row.
//     Nothing here demonstrates it and §6 cannot either — creating one would
//     mean configuring a foreign-launcher agent on the live peer inside Butchr's
//     own workspace tree, where the running daemon would adopt it. §6 covers the
//     other half instead, and it is the half that matters for regression: that
//     every adoptable row a REAL peer is serving right now carries a launcher
//     Butchr has, so this guard refuses nothing that exists today.
//   - WHO COVERS THE REST: nobody, and it is not a gap this script can close.
//     `CensusRow.launcher`'s docblock is where that limit is written down.
//
// ── DRIVING IT RED (three mutations, three independent mechanisms) ─────────
//
//   1. THE GUARD. Delete the `if (!isButchrLauncher(launcher))` block in
//      `adoptFromCensus` and put `expectsRuntime: row.launcher !== 'shell'`
//      back. §3 goes red — the foreign-launcher row is adopted, with
//      `expectsRuntime: true`, which is the defect in one line of output. §1,
//      §2, §4, §5 stay green, which is the evidence that §4's no-op claim is
//      not the same assertion wearing a different hat.
//   2. THE COPY. Add a launcher to `AGENT_LAUNCHERS` in `launchers.ts` without
//      adding it to `BUTCHR_LAUNCHERS`. §1 goes red naming the missing name;
//      everything else stays green, because nothing else reads `launchers.ts`.
//   3. THE PREMISE. Add `import type { LauncherName } from './launchers.js';`
//      to `crabcast-runtime.ts` — the edit §2 exists to refuse. §2 goes red
//      here and `verify-crabcast-channel-startup-disablement.mjs` goes red
//      independently, which is the correct division: that script OWNS the
//      premise, this one records that this file's copy depends on it.
//
// A FOURTH RED IS NOT AVAILABLE TO THIS SCRIPT AND IS PROVEN BY THE COMPILER
// INSTEAD: deleting `'shell'` from `BUTCHR_LAUNCHERS` makes
// `launcher !== 'shell'` in `adoptFromCensus` `error TS2367`, so that mutation
// never produces a binary to test. The transcript is on the pull request. That
// is the intended division of labour — an unrepresentable state beats an
// assertion a later author can delete (KAN-301).
//
// Usage: node daemon/scripts/verify-crabcast-adopt-launcher-vocabulary.mjs [--verbose]
//        BUTCHR_DIST=<path to a daemon/dist>    to point at another build
//        BUTCHR_CRABCAST_SOCKET=<path>          for §6

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const verbose = process.argv.includes('--verbose');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');
const distDir = process.env.BUTCHR_DIST
  ? path.resolve(process.env.BUTCHR_DIST)
  : path.join(repoRoot, 'daemon', 'dist');

let failures = 0;
let skipped = 0;

function rule(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function ok(message) {
  console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
}
function bad(message, detail) {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${message}`);
  if (detail !== undefined) console.log(`       ${detail}`);
}
function check(condition, message, detail) {
  if (condition) ok(message);
  else bad(message, detail);
}
function skip(message, why) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${message}`);
  console.log(`       ${why}`);
}

/**
 * Run one section, counting a throw as that section's failure.
 *
 * Copied from `verify-crabcast-session-restore.mjs` for its stated reason: a red
 * drive that CRASHES at §3 says nothing about whether §4-§6 catch the defect,
 * and an exit code that comes from an uncaught TypeError is not a verdict.
 */
async function section(title, body) {
  rule(title);
  try {
    await body();
  } catch (err) {
    bad(
      'this section could not run to completion',
      `${err instanceof Error ? err.message : String(err)} — counted as a failure of this ` +
        `section, not swallowed.`
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, budgetMs, stepMs = 200) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

// ── §1 and §2 read source as text and need no build ────────────────────────
const runtimeSrc = fs.readFileSync(path.join(srcDir, 'crabcast-runtime.ts'), 'utf8');
const launchersSrc = fs.readFileSync(path.join(srcDir, 'launchers.ts'), 'utf8');

console.log(`src             : ${srcDir}`);
console.log(`dist            : ${distDir}`);

// ───────────────────────────────────────────────────────────────────────────
await section(
  "1. the copy has not drifted from `AGENT_LAUNCHERS`  [reads source as text]",
  async () => {
    // Both sides read as TEXT. Importing either would be the very thing §2
    // refuses, and importing `launchers.ts` here would make this script the
    // route the premise forbids rather than the check that it holds.
    const listed = runtimeSrc.match(/const BUTCHR_LAUNCHERS = \[([^\]]*)\] as const;/);
    check(
      !!listed,
      'crabcast-runtime.ts declares BUTCHR_LAUNCHERS as a literal tuple',
      'no `const BUTCHR_LAUNCHERS = [...] as const;` found — if it was renamed, rename it here too'
    );
    if (!listed) return;
    const copy = [...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    const table = launchersSrc.match(
      /export const AGENT_LAUNCHERS: Record<LauncherName, AgentLauncher> = \{([\s\S]*?)\n\};/
    );
    check(
      !!table,
      'launchers.ts still declares AGENT_LAUNCHERS as an object literal keyed by LauncherName',
      'the table could not be located, so this section cannot compare against it'
    );
    if (!table) return;
    // Top-level keys only: `  shell: {` / `  claude: {` at one indent.
    const truth = [...table[1].matchAll(/^ {2}([a-zA-Z][\w-]*):\s*\{/gm)].map((m) => m[1]).sort();

    console.log(`       AGENT_LAUNCHERS : ${truth.join(', ')}`);
    console.log(`       BUTCHR_LAUNCHERS: ${copy.join(', ')}`);

    check(
      truth.length > 0,
      'and the table is non-empty, so an empty match cannot pass this section trivially',
      `parsed ${truth.length} keys out of AGENT_LAUNCHERS`
    );
    const missing = truth.filter((n) => !copy.includes(n));
    const extra = copy.filter((n) => !truth.includes(n));
    check(
      missing.length === 0,
      'every launcher Butchr HAS is one adoption will accept',
      `missing from BUTCHR_LAUNCHERS: ${missing.join(', ')} — adoption would refuse a row ` +
        `Butchr itself configured, which is a live agent left sessionless`
    );
    check(
      extra.length === 0,
      'and adoption accepts no name Butchr does not have',
      `in BUTCHR_LAUNCHERS but not in AGENT_LAUNCHERS: ${extra.join(', ')} — the guard would ` +
        `admit a name whose meaning nothing on this side defines, which is the defect it exists to stop`
    );
  }
);

// ───────────────────────────────────────────────────────────────────────────
await section(
  '2. the premise the copy rests on — crabcast-runtime.ts imports nothing from launchers.js  [reads source as text]',
  async () => {
    // OWNERSHIP: `verify-crabcast-channel-startup-disablement.mjs` owns this
    // premise — it is KAN-393's, and its consequences there are about channel
    // startup supervision, not about launcher names. It is re-read here because
    // it is the entire reason BUTCHR_LAUNCHERS is a copy: if the premise is ever
    // deliberately retired, the copy should become an import in the same change,
    // and this section is what puts that decision in front of whoever does it.
    const launchersImport = /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*'\.\/launchers\.js'/.test(
      runtimeSrc
    );
    check(
      !launchersImport,
      'no import from launchers.js, so the copy is still the right shape',
      runtimeSrc
        .split('\n')
        .filter((l) => l.includes('launchers'))
        .join('\n') ||
        '(no line mentions launchers) — if the premise was retired on purpose, replace ' +
          'BUTCHR_LAUNCHERS with `import type { LauncherName }` and delete §1'
    );
    check(
      /function isButchrLauncher\(name: string \| null\): name is ButchrLauncher/.test(runtimeSrc),
      'and the admission is a type guard, so the narrowing is the enforcement rather than a comment',
      'isButchrLauncher is not declared as a `name is ButchrLauncher` predicate — without the ' +
        'predicate, `launcher !== \'shell\'` is a string comparison again and TS2367 can never fire'
    );
    check(
      /expectsRuntime: launcher !== 'shell'/.test(runtimeSrc) &&
        !/expectsRuntime: row\.launcher !== 'shell'/.test(runtimeSrc),
      'and adoption compares the NARROWED local, never `row.launcher` — the join is unspellable here',
      "`expectsRuntime: row.launcher !== 'shell'` is back in crabcast-runtime.ts"
    );
  }
);

// ── setup guard for §3-§6, NOT a verdict ───────────────────────────────────
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error(`\nNo build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));
const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { workspacesRoot } = await import(path.join(distDir, 'herdr.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan429-'));
const cleanups = [];

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-owned-running-census.json'), 'utf8')
);

/** Rewrite the captured workspace root to this machine's. See the header. */
function localise(value) {
  return JSON.parse(
    JSON.stringify(value).split(FIXTURE.capturedWorkspacesRoot).join(workspacesRoot())
  );
}

const CENSUS = localise(FIXTURE.list_agents);
const STATUS = FIXTURE.daemon_status;

/** A CrabCast that answers exactly the frames it is handed. */
async function fakeCrabCast(name, listFrame, statusFrame = STATUS) {
  const socketPath = path.join(TMP, `${name}.sock`);
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const frame =
          req.action === 'daemon_status'
            ? statusFrame
            : req.action === 'list_agents'
              ? listFrame
              : null;
        if (frame) socket.write(JSON.stringify({ ...frame, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  cleanups.push(() => server.close());
  return socketPath;
}

/** A runtime pointed at a fake peer, with its census already read once. */
async function runtimeOn(socketPath) {
  const link = new CrabCastLink({ socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 150, log: () => {} });
  cleanups.push(() => runtime.dispose());
  await until(() => runtime.herdrReachable(), 5_000);
  await sleep(400); // one more census tick, so adoption has run
  return runtime;
}

/** The address a fixture row maps to, in Butchr's terms. */
function addressOf(row) {
  const rel = path.relative(workspacesRoot(), row.workDir ?? row.path).split(path.sep);
  return { type: rel[0], key: rel[1] };
}

/** A census with one row's launcher rewritten. Returns [frame, address, row]. */
function censusWithLauncher(value) {
  const frame = JSON.parse(JSON.stringify(CENSUS));
  const row = frame.agents[0];
  if (value === undefined) delete row.config.launcher;
  else row.config.launcher = value;
  return [frame, addressOf(row), row];
}

console.log(
  `fixture         : crabcast-owned-running-census.json (${FIXTURE.capturedAt}), ` +
    `${CENSUS.agents.length} owned rows`
);

// ───────────────────────────────────────────────────────────────────────────
await section(
  "3. a launcher Butchr does not have is NOT adopted, and is still listed  [imports dist]",
  async () => {
    // `zsh` stands for the whole class: a runtime-less launcher of CrabCast's,
    // spelled anything but `shell`. Under the old comparison this row adopted
    // with `expectsRuntime: true` — a guess, in a field read as fact.
    const [frame, address, row] = censusWithLauncher('zsh');
    const runtime = await runtimeOn(await fakeCrabCast('foreign', frame));

    const session = runtime.getSessionByAddress(address.key, address.type);
    check(
      !session,
      `${address.type}/${address.key} with launcher "zsh" is not adopted`,
      `adopted anyway, as ${JSON.stringify(session?.sessionId)} with ` +
        `expectsRuntime=${JSON.stringify(session?.expectsRuntime)} — that boolean is a GUESS ` +
        `about a launcher Butchr has never heard of, and confirmActivation reads it as fact`
    );

    // The refusal must not hide the agent. `censusRecords()` reads the census
    // and not `this.sessions`, which is what makes skipping cheap: the row goes
    // on being reported, honestly, as an agent no session of ours holds.
    const records = runtime.listHerdrAgents();
    const listed = records.find((r) => (r.workDir ?? '') === (row.workDir ?? row.path));
    check(
      !!listed,
      'and the refused row is STILL in the fleet listing — nothing is hidden by not adopting it',
      `no census record for ${row.workDir ?? row.path}; a refusal that deletes an agent from ` +
        `the listing would be strictly worse than the defect it replaced`
    );
    if (verbose && listed) console.log(`       listed as ${listed.name}`);
  }
);

// ───────────────────────────────────────────────────────────────────────────
await section(
  '4. and the guard is a NO-OP on the population adoption exists for  [imports dist]',
  async () => {
    // Every row `provision` produces carries `launcher: defaultAgent ?? 'claude'`
    // — Butchr's own string. This is the claim that the fix costs the restart
    // repair nothing, asserted rather than argued.
    const runtime = await runtimeOn(await fakeCrabCast('ours', CENSUS));

    let checked = 0;
    for (const row of CENSUS.agents) {
      const address = addressOf(row);
      const launcher = row.config?.launcher;
      const session = runtime.getSessionByAddress(address.key, address.type);
      check(
        !!session,
        `${address.type}/${address.key} (launcher ${JSON.stringify(launcher)}) is still adopted`,
        'the guard refused a row Butchr itself configured — a live agent left sessionless'
      );
      if (!session) continue;
      checked++;
      check(
        session.expectsRuntime === (launcher !== 'shell'),
        `and expectsRuntime is ${JSON.stringify(launcher !== 'shell')}, as the launcher says`,
        `expectsRuntime === ${JSON.stringify(session.expectsRuntime)}`
      );
      check(session.adopted === true, 'and it is marked adopted', `adopted === ${session.adopted}`);
    }
    // A section that asserted nothing because the fixture was empty would pass
    // trivially, which is the failure this repository keeps finding.
    check(
      checked > 0,
      'and at least one owned row was actually examined',
      `${checked} rows adopted — the fixture supplied none, so nothing above was tested`
    );

    // ── THE `true` BRANCH, WHICH NO CAPTURED FIXTURE REACHES ──────────────
    //
    // Every owned row in every committed fixture carries `shell`, so the loop
    // above exercises `expectsRuntime === false` twice and `true` never.
    // `verify-crabcast-session-restore.mjs` names that gap in its own header
    // ("WHAT NOBODY COVERS: the `claude` launcher") and it matters more here
    // than there: `true` is the value the old comparison handed to a foreign
    // launcher, so a guard that admitted `claude` and then computed the wrong
    // boolean for it would pass everything above. The row is synthesised, and
    // that is disclosed rather than dressed up as a capture.
    const [claudeFrame, claudeAddress] = censusWithLauncher('claude');
    const claudeRuntime = await runtimeOn(await fakeCrabCast('claude', claudeFrame));
    const claudeSession = claudeRuntime.getSessionByAddress(claudeAddress.key, claudeAddress.type);
    check(
      !!claudeSession,
      `a row with launcher "claude" is adopted`,
      'the guard refused the launcher the whole fleet runs'
    );
    check(
      claudeSession?.expectsRuntime === true,
      'and its expectsRuntime is true — the branch no captured fixture reaches',
      `expectsRuntime === ${JSON.stringify(claudeSession?.expectsRuntime)}; a pane with no ` +
        `runtime behind it must not be excused for a launcher that delivers one (KAN-58)`
    );
  }
);

// ───────────────────────────────────────────────────────────────────────────
await section(
  '5. a row carrying NO launcher is refused too — `null` is not a name  [imports dist]',
  async () => {
    // The census maps a missing/non-string `config.launcher` to `null`. Under
    // the old comparison `null !== 'shell'` is `true`, so a row that said
    // nothing about its launcher was adopted as expecting a runtime — the same
    // guess, reached without any foreign vocabulary at all.
    const [frame, address] = censusWithLauncher(undefined);
    const runtime = await runtimeOn(await fakeCrabCast('nolauncher', frame));
    const session = runtime.getSessionByAddress(address.key, address.type);
    check(
      !session,
      `${address.type}/${address.key} with no launcher field is not adopted`,
      `adopted with expectsRuntime=${JSON.stringify(session?.expectsRuntime)} — derived from ` +
        `\`null !== 'shell'\`, which is a claim about a row that made none`
    );
  }
);

// ───────────────────────────────────────────────────────────────────────────
await section(
  '6. against a LIVE peer: every adoptable row it is serving carries a launcher Butchr has  [imports dist, needs a peer]',
  async () => {
    const socketPath =
      process.env.BUTCHR_CRABCAST_SOCKET ||
      path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');
    if (!fs.existsSync(socketPath)) {
      skip(
        'no live CrabCast peer',
        `no socket at ${socketPath}. Sections 1-5 are unaffected; this one asserts nothing.`
      );
      return;
    }

    const link = new CrabCastLink({ socketPath, log: () => {} });
    cleanups.push(() => link.dispose?.());
    link.connect();
    const up = await until(() => link.connected, 5_000);
    if (!up) {
      skip('peer socket present but the link did not come up', `socket ${socketPath}`);
      return;
    }

    const res = await link.request({ action: 'list_agents' });
    check(
      res?.success === true,
      'the live peer answered list_agents',
      `success=${JSON.stringify(res?.success)} error=${JSON.stringify(res?.error)}`
    );
    if (res?.success !== true) return;

    const rows = Array.isArray(res.agents) ? res.agents : [];
    // Adoptable means: CrabCast OWNS the row and it maps into Butchr's tree.
    // Foreign panes are excluded by adoptFromCensus before any launcher is read.
    const root = workspacesRoot();
    const inTree = rows.filter((r) => {
      const dir = r.workDir ?? r.path ?? '';
      const rel = path.relative(root, dir);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).length === 2;
    });

    console.log(`       peer socket   : ${socketPath}`);
    console.log(`       owned rows    : ${rows.length}`);
    console.log(`       in Butchr tree: ${inTree.length}`);
    for (const r of inTree) {
      console.log(
        `         ${r.workDir ?? r.path} launcher=${JSON.stringify(r.config?.launcher)} ` +
          `state=${JSON.stringify(r.state)}`
      );
    }

    if (inTree.length === 0) {
      // A NULL RESULT IS A CLAIM ABOUT THE SEARCH, NOT ABOUT THE WORLD. Had the
      // peer been serving an adoptable row, the loop above would have printed
      // its path and launcher and the check below would have run on it. It
      // printed nothing, so there is nothing here to pass or fail, and calling
      // that a pass would be a green nothing could have turned red.
      skip(
        'the peer is serving no row that adoption would reach',
        `${rows.length} owned row(s), none of them under ${root} at <type>/<key>. This section ` +
          `asserted nothing about launcher vocabulary; §3-§5 are what carry that on fixtures.`
      );
      return;
    }

    const vocabulary = [...runtimeSrc.matchAll(/const BUTCHR_LAUNCHERS = \[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)])
      .map((m) => m[1]);
    for (const r of inTree) {
      const launcher = r.config?.launcher ?? null;
      check(
        vocabulary.includes(launcher),
        `a real row at ${r.workDir ?? r.path} carries launcher ${JSON.stringify(launcher)}, ` +
          `which Butchr has`,
        `not in ${vocabulary.join(', ')} — this guard would refuse to adopt a row the live ` +
          `fleet is actually serving, which is a regression and not a defence`
      );
    }
  }
);

// ───────────────────────────────────────────────────────────────────────────
for (const fn of cleanups.reverse()) {
  try {
    fn();
  } catch {
    /* teardown */
  }
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* teardown */
}

console.log(
  `\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}` +
    `${skipped ? ` (${skipped} skipped)` : ''}`
);
process.exit(failures ? 1 : 0);
