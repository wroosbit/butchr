// KAN-357: read-path contract v7's `standing`, behind a door that refuses it
// below v7, and joined on `claimsPath` rather than on `identity`.
//
// WHAT FAILURE THIS WOULD CATCH: a consumer reading `standing` off a peer too
// old to publish it, and reporting the resulting `undefined` as a verdict about
// the ROW. A peer below v7 sends no `standing` at all; an implementation that
// read that absence as "no standing recorded" would pass every test written
// against such a peer, ship, and be wrong the moment it was upgraded — because
// it cannot distinguish THIS PEER CANNOT TELL ME from THIS ROW HAS NO STANDING.
// It would also catch the join being keyed on `identity`, which is in the row's
// own vocabulary and matches nothing in a path-keyed list, so a failed match
// reads as a genuinely absent agent and the alarm fires on the ordinary case.
//
// CI-RUNNABLE: partial — sections 1-5 assert in CI. They import the built
// daemon modules and run over frames this script constructs and two committed
// captures, and need no peer, no herdr, no PTY, no credential and no network.
// Section 6 reads a live CrabCast socket and SKIPS without one; a skip is
// printed as a skip and never counted as a pass.
//
// KAN-373 — AND THE EXIT CODE NOW CARRIES THAT SENTENCE. It did not. This
// script ended `process.exit(failures ? 1 : 0)`, which consults the skip
// tally not at all, so a skipped live section exited 0 and a caller reading
// the exit code could not tell a proved peer from an absent one. The prose
// above was true of the PRINTING and false of the process. Now:
//
//   0  every section ran, and every assertion passed
//   1  at least one assertion failed
//   2  nothing failed, and something did not run
//
// Pass `--allow-skipped` to assert that an incomplete run is acceptable to
// THIS caller and get 0 back. See `lib/verdict-exit.mjs`.
//
// ── THE SECTIONS ARE NOT ALL PROVED THE SAME WAY ───────────────────────────
//
// This is the honest scope, stated here rather than left to a reader to infer,
// because the sections have different evidence behind them:
//
//   §1-§3  THE REFUSAL AND THE JOIN, over frames this script CONSTRUCTS. A
//          proof that supplies its own input has not tested that the input
//          arrives (KAN-145), so on its own this proves the branching is right
//          and NOT that a real peer sends what it is branched on.
//
//   §4     THE COMMITTED v6 CAPTURE — `fixtures/crabcast-v6-tombstone-census.json`,
//          raw off the live socket via `probe-crabcast-raw-frames.mjs`, not
//          hand-written. Closes the §1-§3 gap for the BELOW-v7 case: the absent
//          `standing` and the null `claimsPath` in it are what a real CrabCast
//          actually sent. **That peer no longer exists** — the machine deployed
//          on 2026-08-14 — which is exactly why the capture was taken. DO NOT
//          DELETE IT: it is now the only evidence of the below-door case there
//          is, and the refusal remains reachable by any peer that lags.
//
//   §5     THE COMMITTED v8 CAPTURE — the same, for the ABOVE-door case, and
//          the section that closes KAN-357's AC1. Until 2026-08-14 nothing had
//          ever served these fields and this header said so.
//
//   §6     THE LIVE WIRE, when a peer is reachable. Re-reads off the socket at
//          run time so that a capture which has drifted from the world is
//          visible rather than quietly authoritative.
//
// ── WHAT THIS STILL DOES NOT COVER, NAMED BECAUSE THE LIST LOOKS COMPLETE ──
//
// **The `claims-an-agent` arm has never been seen on a real wire.** Both
// captures hold exactly one unreadable row and it reads `retired` in the only
// version that could render a verdict on it. So the branch this ticket exists
// to enable — go and look at a row claiming an agent nothing readable covers —
// is exercised against constructed frames ONLY, in §3.
//
// That is not fixable by waiting: it needs a registry to acquire a second
// unreadable row that claims an agent, which is a fault nobody wants and
// nobody can schedule. **The honest position is that the machinery is proved
// and the alarming path is not**, and this paragraph is where that is said
// rather than left for somebody to discover from a green run.
//
// **And `matched` has never been seen either**, for the same reason plus a
// second: our one specimen's `claimsPath` is `null`, so it could not join even
// if it claimed an agent.
//
// ── MADE TO GO RED ─────────────────────────────────────────────────────────
//
// Four mutations. Three are this script's and one is the compiler's, and the
// difference between those two kinds of red is the point of listing them apart:
//
//   1. THE COMPILER'S, not this script's. Collapsing the reading to a bare
//      string — `standing: RowStanding` instead of `StandingReading` — does not
//      compile, because a consumer cannot reach `.verdict` without narrowing
//      on `available` first:
//
//        # in daemon/src/herdr.ts, replace the StandingReading union with
//        #   export type StandingReading = RowStanding;
//        cd daemon && npx tsc --noEmit     # errors in crabcast-runtime.ts
//
//      That is the type doing the work, and it is worth being precise about who
//      caught it: THE BUILD FAILS, so this script never sees that mutation and
//      must not be credited with it. A proof run after a failed build ran on the
//      previous `dist` (H-22).
//
//   2. THIS SCRIPT'S. All three of these COMPILE, so the proof actually sees
//      them — which is the whole reason they were chosen over the tempting
//      one-line edits that fail to build:
//
//        # (a) remove the door: read `standing` regardless of peer version
//        #     in readUnreadableDisclosure, replace the `standingAvailable`
//        #     computation with `const standingAvailable = true;`
//        cd daemon && npm run build && cd .. \
//          && node daemon/scripts/verify-crabcast-standing.mjs   # §2 red
//
//        # (b) collapse could-not-run into ran-found-nothing, which is the
//        #     alarm-on-the-boring-case defect: in joinSupersession, replace
//        #       if (claimsPath === null) return { outcome: 'could-not-run', identity };
//        #     with
//        #       if (claimsPath === null) return { outcome: 'ran-found-nothing', claimsPath: identity ?? '' };
//        cd daemon && npm run build && cd .. \
//          && node daemon/scripts/verify-crabcast-standing.mjs   # §3 red
//
//        # (c) leak the v7 quotations onto the below-v7 arm — THE DEFECT THIS
//        #     TICKET'S OWN FIRST IMPLEMENTATION SHIPPED, caught in self-review
//        #     rather than by anything mechanical. Append to the available:false
//        #     arm in readUnreadableDisclosure:
//        #       claimsAt: str(r.claimsAt), claimsEvent: str(r.claimsEvent)
//        #     (it needs an `as StandingReading` to compile, which is itself the
//        #     point: the union refuses the accidental form and only a cast gets
//        #     past it)
//        cd daemon && npm run build && cd .. \
//          && node daemon/scripts/verify-crabcast-standing.mjs   # §2 red
//
// Real output of all three is pasted in the PR body.
//
// Sections:
//   1. the vocabulary narrows, and an unrecognised value never becomes `retired`
//   2. the door — below v7 is "this peer cannot tell me", not a row verdict
//   3. the join — three outcomes, and `could-not-run` is not `ran-found-nothing`
//   4. the committed v6 capture — the real below-door peer, off the wire
//   5. the committed v8 capture — the v7 FIELDS off a real peer. AC1.
//   6. the live wire, when a peer is reachable
//
// Usage: node daemon/scripts/verify-crabcast-standing.mjs [--verbose]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { reportAndExit, EXIT_INCOMPLETE } from './lib/verdict-exit.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = path.join(repoRoot, 'daemon', 'dist');
const verbose = process.argv.includes('--verbose');

// Exit 2, never 1: a missing build is this script being run before `npm run
// build`, and reporting that as a verdict would say the code is wrong when
// nothing has been measured. A guard, not a verdict — see the sweep's own
// distinction in sweep-verify-exit-paths.mjs.
//
// KAN-373 gave 2 a name — EXIT_INCOMPLETE, "this run did not prove what a 0
// would claim" — and this guard is spelled with it rather than as a literal.
// The two uses AGREE: a missing build measured nothing, a skipped section
// measured part, and a caller's correct response to either is the same, which
// is to decline to treat the run as cover. That agreement was accidental until
// this line named it, and an accidental agreement is one refactor from being a
// silent collision. It stays a GUARD for the sweep's purposes — its value is a
// constant reached before anything is measured, not a verdict.
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(EXIT_INCOMPLETE);
}

const { readUnreadableDisclosure } = await import(path.join(distDir, 'crabcast-runtime.js'));

const FIXTURE_PATH = path.join(scriptDir, 'fixtures', 'crabcast-v6-tombstone-census.json');
const FIXTURE_V8_PATH = path.join(scriptDir, 'fixtures', 'crabcast-v8-tombstone-census.json');

let failures = 0;
let skipped = 0;

function section(title) {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
}

/**
 * `whyFailed` prints only on failure and `whyPassed` only under --verbose, kept
 * as separate arguments for the reason verify-doc-constant-pins.mjs gives: one
 * shared `detail` prints a failure explanation next to the word PASS, which is
 * the same claim-outruns-mechanism defect this fleet keeps re-finding.
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

function skip(label, why) {
  skipped++;
  console.log(`   SKIP  ${label}`);
  console.log(`         ${why}`);
}

/** A `list_agents` frame carrying one unreadable row with the given overrides. */
function frameWith(row, agents = []) {
  return {
    action: 'list_agents_response',
    success: true,
    agents,
    unreadableRecordsTotal: 1,
    unreadableRecords: [
      {
        line: 1,
        problem: 'pre-migration',
        identity: 'crabcast-shell-demo',
        reason: 'constructed for this proof',
        raw: '{}',
        rawTruncated: false,
        promptRedacted: false,
        claimsPath: null,
        ...row
      }
    ]
  };
}

const pathsOf = (...p) => new Set(p);
const only = (reading) => reading.unreadableRecords[0];

// =============================================================================
section('1. THE VOCABULARY — an unrecognised standing is `unknown`, never `retired`');
// Their contract: the must-ignore clause bites hardest here, because reading
// "not a word I know" as "harmless" is the wrong-conclusion-from-a-short-list
// defect arriving one level up.
{
  for (const [sent, expected] of [
    ['retired', 'retired'],
    ['claims-an-agent', 'claims-an-agent'],
    ['unknown', 'unknown']
  ]) {
    const r = only(readUnreadableDisclosure(frameWith({ standing: sent }), 7, pathsOf()));
    check(
      `\`${sent}\` survives narrowing as \`${expected}\``,
      r.standing.available === true && r.standing.verdict === expected,
      `got ${JSON.stringify(r.standing)}`,
      `standing=${expected}`
    );
  }

  // The one that matters: a member v8 might add.
  for (const hostile of ['harmless', 'RETIRED', '', null, 42, undefined]) {
    const r = only(readUnreadableDisclosure(frameWith({ standing: hostile }), 7, pathsOf()));
    check(
      `unrecognised standing ${JSON.stringify(hostile)} → \`unknown\`, not \`retired\``,
      r.standing.available === true && r.standing.verdict === 'unknown',
      `got ${JSON.stringify(r.standing)} — collapsing an unknown member to \`retired\` is the all-clear this must never give`,
      'narrowed to unknown'
    );
  }
}

// =============================================================================
section('2. THE DOOR — below v7 is "this peer cannot tell me", not a row verdict');
// THE SECTION THAT GOES RED ON MUTATION (a). This is the absence-versus-zero
// distinction at the project boundary: `unknown` is a verdict about a row, a v6
// peer is a fact about the connection, and no member of their vocabulary can
// carry the second.
{
  // A v6 peer that sends no standing at all — the real case on this machine.
  const v6 = only(readUnreadableDisclosure(frameWith({}), 6, pathsOf()));
  check(
    'v6 peer, standing absent → {available:false, because:"peer-below-v7"}',
    v6.standing.available === false && v6.standing.because === 'peer-below-v7',
    `got ${JSON.stringify(v6.standing)}`,
    JSON.stringify(v6.standing)
  );
  check(
    'the refusal names its own evidence — peerContractVersion: 6',
    v6.standing.available === false && v6.standing.peerContractVersion === 6,
    `got ${JSON.stringify(v6.standing)}`
  );

  // The trap, stated as an assertion: a v6 peer must NOT read as `unknown`.
  check(
    'a v6 peer does NOT report `unknown` — the collapse this ticket exists to prevent',
    !(v6.standing.available === true),
    `got ${JSON.stringify(v6.standing)} — "this peer cannot tell me" has been collapsed into a verdict about the row`
  );

  // A v6 peer that DOES send a standing — a shape nobody should see, and the
  // door still refuses it. Reading it would be trusting a field the peer's own
  // published version says it does not have.
  const v6Lying = only(readUnreadableDisclosure(frameWith({ standing: 'retired' }), 6, pathsOf()));
  check(
    'v6 peer sending `standing` anyway is still refused — the gate reads the version, not the field',
    v6Lying.standing.available === false,
    `got ${JSON.stringify(v6Lying.standing)} — inferring the version from the field's presence makes a v7 peer that omitted it indistinguishable from a v6 peer`
  );

  // A peer that publishes no version at all.
  const vNone = only(readUnreadableDisclosure(frameWith({ standing: 'retired' }), null, pathsOf()));
  check(
    'peer publishing no contractVersion → refused, peerContractVersion: null',
    vNone.standing.available === false && vNone.standing.peerContractVersion === null,
    `got ${JSON.stringify(vNone.standing)}`
  );

  // And v7+ opens it.
  for (const v of [7, 8]) {
    const open = only(readUnreadableDisclosure(frameWith({ standing: 'retired' }), v, pathsOf()));
    check(
      `v${v} peer → the door opens and the verdict is read`,
      open.standing.available === true && open.standing.verdict === 'retired',
      `got ${JSON.stringify(open.standing)}`
    );
  }

  // The v4 disclosure must be UNAFFECTED by the door. Refusing the whole census
  // on a version mismatch would delete KAN-324's disclosure against the only
  // peer that actually exists.
  const stillReads = readUnreadableDisclosure(frameWith({ claimsPath: '/w/x' }), 6, pathsOf());
  check(
    'the door is in front of the v7 GROUP only — a v6 peer still discloses total and claimsPath',
    stillReads.unreadableRecordsTotal === 1 && only(stillReads).claimsPath === '/w/x',
    `got total=${stillReads.unreadableRecordsTotal} claimsPath=${JSON.stringify(only(stillReads).claimsPath)} — the v4 disclosure has been lost to the v7 gate`,
    'total=1, claimsPath read at v6'
  );

  // ALL THREE v7 fields are behind the door, not just `standing`.
  //
  // This assertion exists because the first implementation of this ticket got
  // it wrong: `standing` was gated and `claimsAt`/`claimsEvent` were read in
  // front of the gate. Against a v6 peer that yields `claimsAt: null` — and
  // their contract guarantees `null` means THE ROW NAMED NONE, never "we could
  // not see it", because a line that does not parse never becomes one of these
  // rows at all. So an ungated `claimsAt` publishes the forbidden second
  // meaning under the first one's name: the same collapse as `standing`, one
  // field over, and invisible for exactly the same reason.
  check(
    'claimsAt and claimsEvent are NOT reachable on a v6 reading — they are v7, like `standing`',
    !('claimsAt' in v6.standing) && !('claimsEvent' in v6.standing) && v6.standing.available === false,
    `got ${JSON.stringify(v6.standing)} — a v7 quotation is being reported off a peer that cannot send one`
  );
  const v6WithClaims = only(
    readUnreadableDisclosure(
      frameWith({ claimsAt: '2026-08-03T20:37:38.900Z', claimsEvent: 'deactivated' }),
      6,
      pathsOf()
    )
  );
  check(
    'even when a v6 frame carries them, the reading refuses rather than widening `null`',
    v6WithClaims.standing.available === false,
    `got ${JSON.stringify(v6WithClaims.standing)}`
  );
  const v7Claims = only(
    readUnreadableDisclosure(
      frameWith({
        standing: 'retired',
        claimsAt: '2026-08-03T20:37:38.900Z',
        claimsEvent: 'deactivated'
      }),
      7,
      pathsOf()
    )
  );
  check(
    'at v7 the verdict arrives WITH its evidence — claimsEvent beside the verdict it explains',
    v7Claims.standing.available === true &&
      v7Claims.standing.verdict === 'retired' &&
      v7Claims.standing.claimsEvent === 'deactivated' &&
      v7Claims.standing.claimsAt === '2026-08-03T20:37:38.900Z',
    `got ${JSON.stringify(v7Claims.standing)} — a verdict nobody can compare against its quote is one nobody can catch being wrong`,
    JSON.stringify(v7Claims.standing)
  );
  check(
    'claimsAt is carried as the STRING it is, never coerced to a date',
    typeof v7Claims.standing.claimsAt === 'string',
    `got ${typeof v7Claims.standing.claimsAt}`
  );
  const v7Garbage = only(
    readUnreadableDisclosure(
      frameWith({ standing: 'unknown', claimsAt: 'not a date at all', claimsEvent: 'nonsense-verb' }),
      7,
      pathsOf()
    )
  );
  check(
    'an unparseable claimsAt survives verbatim — it is a quotation, and a hand-edited row may hold anything',
    v7Garbage.standing.available === true && v7Garbage.standing.claimsAt === 'not a date at all',
    `got ${JSON.stringify(v7Garbage.standing)}`
  );
  check(
    "and an event word we do not know comes back as the word it is, with the verdict abstaining",
    v7Garbage.standing.available === true &&
      v7Garbage.standing.claimsEvent === 'nonsense-verb' &&
      v7Garbage.standing.verdict === 'unknown',
    `got ${JSON.stringify(v7Garbage.standing)}`
  );
}

// =============================================================================
section('3. THE JOIN — three outcomes, and `could-not-run` is not `ran-found-nothing`');
// THE SECTION THAT GOES RED ON MUTATION (b).
{
  // matched — a later readable row supersedes this line. The boring case.
  const matched = only(
    readUnreadableDisclosure(
      frameWith({ standing: 'claims-an-agent', claimsPath: '/w/task/kan-1' }),
      7,
      pathsOf('/w/task/kan-1')
    )
  );
  check(
    'claimsPath present and readable → matched (boring, no alarm)',
    matched.supersession?.outcome === 'matched',
    `got ${JSON.stringify(matched.supersession)}`,
    JSON.stringify(matched.supersession)
  );

  // ran-found-nothing — the case the disclosure exists for.
  const lost = only(
    readUnreadableDisclosure(
      frameWith({ standing: 'claims-an-agent', claimsPath: '/w/task/kan-999' }),
      7,
      pathsOf('/w/task/kan-1')
    )
  );
  check(
    'claimsPath present and absent from the readable list → ran-found-nothing (GO AND LOOK)',
    lost.supersession?.outcome === 'ran-found-nothing',
    `got ${JSON.stringify(lost.supersession)}`,
    JSON.stringify(lost.supersession)
  );

  // could-not-run — the live specimen's state.
  const cannot = only(
    readUnreadableDisclosure(
      frameWith({ standing: 'claims-an-agent', claimsPath: null }),
      7,
      pathsOf('/w/task/kan-1')
    )
  );
  check(
    'claimsPath null → could-not-run, NOT ran-found-nothing',
    cannot.supersession?.outcome === 'could-not-run',
    `got ${JSON.stringify(cannot.supersession)} — a permanently unjoinable row has been put in the "go and look" bucket, which is an alarm that never clears`,
    JSON.stringify(cannot.supersession)
  );
  check(
    'could-not-run carries `identity` for the human, having refused to branch on it',
    cannot.supersession?.identity === 'crabcast-shell-demo',
    `got ${JSON.stringify(cannot.supersession)}`
  );

  // THE HEADLINE ASSERTION — AC3. A tombstone and a genuinely lost agent must
  // not be reported identically.
  const tombstone = only(
    readUnreadableDisclosure({ ...frameWith({ standing: 'retired', claimsPath: null }) }, 7, pathsOf())
  );
  check(
    'a retired tombstone and a lost agent are DISTINGUISHABLE',
    tombstone.standing.available === true &&
      tombstone.standing.verdict === 'retired' &&
      tombstone.supersession === null &&
      lost.standing.verdict === 'claims-an-agent' &&
      lost.supersession?.outcome === 'ran-found-nothing',
    `tombstone=${JSON.stringify({ s: tombstone.standing, j: tombstone.supersession })}\nlost=${JSON.stringify({ s: lost.standing, j: lost.supersession })}\nIf these read the same, the count is back to being a number nobody can act on.`,
    'retired/null vs claims-an-agent/ran-found-nothing'
  );

  // The join is not asked where it is meaningless.
  for (const s of ['retired', 'unknown']) {
    const r = only(
      readUnreadableDisclosure(frameWith({ standing: s, claimsPath: '/w/nope' }), 7, pathsOf())
    );
    check(
      `standing \`${s}\` → no join attempted (null, "not asked")`,
      r.supersession === null,
      `got ${JSON.stringify(r.supersession)}`
    );
  }
  const belowDoor = only(
    readUnreadableDisclosure(frameWith({ claimsPath: '/w/nope' }), 6, pathsOf())
  );
  check(
    'below the door → no join attempted, because no standing licensed one',
    belowDoor.supersession === null,
    `got ${JSON.stringify(belowDoor.supersession)}`
  );

  // The join must key on claimsPath, never identity.
  const identityTrap = only(
    readUnreadableDisclosure(
      frameWith({ standing: 'claims-an-agent', claimsPath: null, identity: 'shell/demo' }),
      7,
      pathsOf('shell/demo')
    )
  );
  check(
    'a readable list containing the IDENTITY string does not produce a match',
    identityTrap.supersession?.outcome === 'could-not-run',
    `got ${JSON.stringify(identityTrap.supersession)} — the join has been keyed on identity, whose vocabulary the readable list does not share`
  );
}

// =============================================================================
section('4. THE COMMITTED v6 CAPTURE — the real below-v7 peer, raw off the wire');
// This is what closes §1-§3's supplies-its-own-input gap for the below-v7 case:
// the absent `standing` and null `claimsPath` here are what a real CrabCast
// SENT, recorded by probe-crabcast-raw-frames.mjs rather than imagined.
{
  if (!fs.existsSync(FIXTURE_PATH)) {
    check('the v6 capture is committed', false, `missing: ${FIXTURE_PATH}`);
  } else {
    const fx = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    const status = fx.daemon_status;
    const rawRow = (status.unreadableRecords ?? [])[0];

    check(
      'the captured peer really is below v7',
      status.contractVersion === 6,
      `contractVersion=${JSON.stringify(status.contractVersion)}`,
      `contractVersion=${status.contractVersion}`
    );
    check(
      'the captured row genuinely lacks `standing` — this is not a hand-made absence',
      rawRow && !('standing' in rawRow) && !('claimsAt' in rawRow) && !('claimsEvent' in rawRow),
      `row keys: ${JSON.stringify(Object.keys(rawRow ?? {}).sort())}`,
      `row keys: ${JSON.stringify(Object.keys(rawRow ?? {}).sort())}`
    );
    check(
      'the captured row carries `claimsPath` as a KEY with `null` as its VALUE',
      rawRow && 'claimsPath' in rawRow && rawRow.claimsPath === null,
      `claimsPath=${JSON.stringify(rawRow?.claimsPath)}`,
      'claimsPath present, null'
    );

    // Now run the real thing over it.
    const reading = readUnreadableDisclosure(status, status.contractVersion, pathsOf());
    const row = only(reading);
    check(
      'the live tombstone reads as "this peer cannot tell me"',
      row.standing.available === false &&
        row.standing.because === 'peer-below-v7' &&
        row.standing.peerContractVersion === 6,
      `got ${JSON.stringify(row.standing)}`,
      JSON.stringify(row.standing)
    );
    check(
      'and its disclosure survives the door — total is still 1',
      reading.unreadableRecordsTotal === 1,
      `got ${JSON.stringify(reading.unreadableRecordsTotal)}`,
      'total=1'
    );
    check(
      'no join is claimed against it',
      row.supersession === null,
      `got ${JSON.stringify(row.supersession)}`
    );
    check(
      '`identity` is still carried for the human who has to find the line',
      row.identity === 'crabcast-shell-demo',
      `got ${JSON.stringify(row.identity)}`,
      row.identity
    );

    // The counterfactual, and the reason this section is not just §2 again:
    // the SAME real bytes, read as if the peer had been deployed. This is the
    // closest anything gets to AC1 without a v7 peer, and it is NOT AC1 — the
    // `standing` value here is one this script inserted, not one CrabCast sent.
    const asIfDeployed = only(
      readUnreadableDisclosure(
        { ...status, unreadableRecords: [{ ...rawRow, standing: 'claims-an-agent' }] },
        7,
        pathsOf()
      )
    );
    check(
      'the same real row, replayed as if v7 had claimed an agent → could-not-run (its claimsPath is null)',
      asIfDeployed.supersession?.outcome === 'could-not-run',
      `got ${JSON.stringify(asIfDeployed.supersession)}`,
      'could-not-run — the live specimen can never take the success path'
    );
  }
}

// =============================================================================
section('5. THE COMMITTED v8 CAPTURE — the v7 FIELDS off a real peer. THIS IS AC1.');
// =============================================================================
//
// **The section that did not exist until 2026-08-14, because until then nothing
// on earth had served these fields.** Every `available: true` assertion above is
// against a frame this script builds; this one is against bytes CrabCast sent.
//
// The gap it closes is the one KAN-145 names and the one this script's own
// header carried as an admission for two days: a proof that supplies its own
// input has not tested that the input ARRIVES. It has now.
{
  if (!fs.existsSync(FIXTURE_V8_PATH)) {
    check('the v8 capture is committed', false, `missing: ${FIXTURE_V8_PATH}`);
  } else {
    const fx = JSON.parse(fs.readFileSync(FIXTURE_V8_PATH, 'utf8'));
    const status = fx.daemon_status;
    const rawRow = (status.unreadableRecords ?? [])[0];

    check(
      'the captured peer is at or above the door',
      status.contractVersion >= 7,
      `contractVersion=${JSON.stringify(status.contractVersion)}`,
      `contractVersion=${status.contractVersion}`
    );
    check(
      'the captured row REALLY carries the v7 fields — this is not a hand-made presence',
      rawRow && 'standing' in rawRow && 'claimsAt' in rawRow && 'claimsEvent' in rawRow,
      `row keys: ${JSON.stringify(Object.keys(rawRow ?? {}).sort())}`,
      `row keys: ${JSON.stringify(Object.keys(rawRow ?? {}).sort())}`
    );

    // The real reading, over real bytes.
    const reading = readUnreadableDisclosure(status, status.contractVersion, pathsOf());
    const row = only(reading);

    check(
      'the door OPENS on a real peer — available: true, from the wire',
      row.standing.available === true,
      `got ${JSON.stringify(row.standing)}`,
      JSON.stringify(row.standing)
    );

    // ── AC1's actual question, answered ────────────────────────────────────
    //
    // `unreadableRecordsTotal` has read 1 on this machine since 2026-08-03 and
    // nothing could say whether it was a tombstone or a lost agent. It is a
    // tombstone. That is what this ticket was filed to find out.
    check(
      'THE ANSWER: the permanently-1 row is `retired` — a tombstone, not a lost agent',
      row.standing.available === true && row.standing.verdict === 'retired',
      `got ${JSON.stringify(row.standing)} — if this is not 'retired', the count that ` +
        `commissioned this ticket means something different and the branch below is wrong`,
      `verdict=retired`
    );
    check(
      'and the verdict is CHECKABLE against its own evidence — claimsEvent says `deactivated`',
      row.standing.available === true && row.standing.claimsEvent === 'deactivated',
      `got claimsEvent=${JSON.stringify(row.standing.available ? row.standing.claimsEvent : null)}. ` +
        `Their contract ships the verdict WITH the quote it was read from precisely so a ` +
        `consumer can catch it being wrong; a disagreement here is a real finding, not noise`,
      `claimsEvent=deactivated, consistent with retired`
    );
    check(
      'claimsAt arrived as the row\'s own quoted timestamp, carried as a STRING',
      row.standing.available === true &&
        typeof row.standing.claimsAt === 'string' &&
        row.standing.claimsAt === '2026-08-03T20:37:38.900Z',
      `got ${JSON.stringify(row.standing.available ? row.standing.claimsAt : null)}`,
      row.standing.available ? row.standing.claimsAt : ''
    );

    // ── The branch taken, which is AC1's other half ────────────────────────
    //
    // `retired` needs no join: nothing was going to be restored from it either
    // way. So `supersession` is null — the question was NOT ASKED — and that is
    // a different null from `could-not-run`, which is asked-and-unanswerable.
    check(
      'THE BRANCH TAKEN: `retired` ⇒ no join attempted at all (supersession null)',
      row.supersession === null,
      `got ${JSON.stringify(row.supersession)} — a join was run against a row that needed none`,
      'supersession=null, the question was not asked'
    );
    check(
      'and the row still carries claimsPath: null, so even had it claimed an agent the join could not have run',
      row.claimsPath === null,
      `got ${JSON.stringify(row.claimsPath)}`,
      'claimsPath=null — the could-not-run case, had it been reached'
    );

    // The disclosure itself is unaffected by the door being open.
    check(
      'the v4 disclosure still reports through an OPEN door — total is 1',
      reading.unreadableRecordsTotal === 1,
      `got ${JSON.stringify(reading.unreadableRecordsTotal)}`,
      'total=1'
    );

    // ── v8's own delta, ruled on rather than consumed wholesale ────────────
    //
    // v8 changed `capacity` only: `measuredTreesSeen` added beside
    // `measuredAgentTrees`, whose POPULATION narrowed. The UnreadableRecord row
    // shape and the rowStanding vocabulary are byte-identical between v7 and
    // v8 in their published contract. This adapter reads no capacity field, so
    // v8 costs us nothing — but that is a claim worth an assertion rather than
    // a sentence, because it is the claim that licensed moving the pin.
    const capacity = fx.list_agents?.capacity ?? null;
    check(
      "v8's changed field is present on the wire we read from",
      capacity !== null && typeof capacity === 'object',
      `list_agents.capacity=${JSON.stringify(capacity)} — if absent, the ruling below is about nothing`,
      `capacity block present, keys: ${JSON.stringify(Object.keys(capacity ?? {}).slice(0, 6))}`
    );
    check(
      'and NOTHING this adapter reads is drawn from it — v8 is additive to us in fact, not by assertion',
      (() => {
        const carried = JSON.stringify(reading);
        return !carried.includes('measuredAgentTrees') && !carried.includes('measuredTreesSeen');
      })(),
      'a v8 capacity field has reached the census reading — rule on it explicitly rather than carrying it'
    );
  }
}

// =============================================================================
section('6. THE LIVE WIRE — re-read now, so a drifted fixture is visible');
// Skips rather than fails when no peer is reachable: the absence of a CrabCast
// is not a defect in this code, and failing CI for it would make the script a
// liability rather than a check.
//
// **Version-aware since the 2026-08-14 deploy.** It used to assert `v === 6`,
// which was a deliberate tripwire for exactly the event that has now happened.
// Keeping that assertion would leave a permanent red on every machine holding a
// deployed peer, reporting news for ever — so it now asserts what is true of
// whichever side of the door the peer is on, and says which it took.
{
  const socketPath =
    process.env.BUTCHR_CRABCAST_SOCKET ||
    path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');

  const live = await new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve(null);
    const sock = net.createConnection(socketPath);
    let buf = '';
    const done = (v) => {
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 4000);
    timer.unref?.();
    sock.on('error', () => done(null));
    sock.on('connect', () => sock.write(JSON.stringify({ action: 'daemon_status', id: 'kan357' }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.action === 'daemon_status_response') {
            clearTimeout(timer);
            return done(frame);
          }
        } catch {}
      }
    });
  });

  if (!live) {
    skip(
      'a live CrabCast is reachable',
      `no peer answered on ${socketPath} — §1-§5 stand on constructed frames and the two committed captures, which is what makes them reproducible without one.`
    );
  } else {
    const v = live.contractVersion;
    console.log(`   ....  live peer: contractVersion=${v}, build ${String(live.build?.commit).slice(0, 12)}`);

    const reading = readUnreadableDisclosure(live, typeof v === 'number' ? v : null, pathsOf());
    const rows = reading.unreadableRecords;

    check(
      'the peer publishes a contract version at all',
      typeof v === 'number',
      `got ${JSON.stringify(v)} — a peer that publishes none is refused at the door, which is ` +
        `correct, but it is also a peer nothing here can say anything else about`,
      `contractVersion=${v}`
    );

    if (typeof v === 'number' && v < 7) {
      // The below-door case. Still the right assertion where it applies — but
      // no longer the expected one, since this machine's peer deployed.
      console.log('   ....  this peer is BELOW the door; asserting the refusal');
      check(
        'every live row reads as "this peer cannot tell me"',
        rows.length > 0 && rows.every((r) => r.standing.available === false),
        `got ${JSON.stringify(rows.map((r) => r.standing))} over ${rows.length} row(s)`,
        `${rows.length} row(s), all refused at the door`
      );
    } else if (typeof v === 'number') {
      // The above-door case — AC1's territory, re-read live rather than off the
      // committed capture, so a fixture that has drifted from the world is
      // visible rather than quietly authoritative.
      console.log('   ....  this peer is AT OR ABOVE the door; asserting the reading');
      check(
        'every live row yields a real verdict',
        rows.length > 0 && rows.every((r) => r.standing.available === true),
        `got ${JSON.stringify(rows.map((r) => r.standing))} over ${rows.length} row(s)`,
        `${rows.length} row(s), all read`
      );
      check(
        'every verdict is a member of the vocabulary, and an unknown one is `unknown` not `retired`',
        rows.every(
          (r) => r.standing.available === true && ['retired', 'claims-an-agent', 'unknown'].includes(r.standing.verdict)
        ),
        `got ${JSON.stringify(rows.map((r) => (r.standing.available ? r.standing.verdict : null)))}`,
        JSON.stringify(rows.map((r) => (r.standing.available ? r.standing.verdict : null)))
      );
      check(
        'the live reading agrees with the committed v8 capture on the tombstone verdict',
        rows.some((r) => r.standing.available === true && r.standing.verdict === 'retired'),
        `got ${JSON.stringify(rows.map((r) => (r.standing.available ? r.standing.verdict : null)))} — ` +
          `if the tombstone has stopped reading 'retired', the capture has drifted from the world ` +
          `and KAN-357's answer needs re-taking rather than re-quoting`,
        'the tombstone still reads retired on the wire'
      );
    }

    check(
      'the live disclosure reports its total through the door, whichever side it is on',
      reading.unreadableRecordsTotal === live.unreadableRecordsTotal,
      `ours=${reading.unreadableRecordsTotal} theirs=${live.unreadableRecordsTotal}`,
      `total=${reading.unreadableRecordsTotal}`
    );
  }
}

// =============================================================================
console.log(`\n${'─'.repeat(74)}\nVerdict\n${'─'.repeat(74)}`);
if (skipped) console.log(`   ${skipped} section(s) skipped for want of a live peer.`);
// KAN-373: guarded on `skipped` as well as `failures`. This paragraph asserts
// that the LIVE tombstone reads `retired` — a claim only the live section can
// make — and it was printed on runs where that section had skipped for want of
// a peer. The exit code was the loud half of this defect; the prose was the
// quiet half, and both said the peer had been read when nothing had read it.
if (failures === 0 && skipped === 0) {
  console.log(
    '   standing is read behind the version door, joined on claimsPath, and a tombstone is\n' +
      '   distinguishable from a lost agent — now against REAL BYTES on both sides of the door.\n' +
      '   The live tombstone reads `retired`, so KAN-357\'s permanently-1 count is answered.\n' +
      '   NOT PROVED HERE: the `claims-an-agent` and `matched` arms, which no real wire has ever\n' +
      '   carried. See the header — that gap needs a registry fault nobody can schedule.'
  );
}
// KAN-373: was `process.exit(failures ? 1 : 0)`, which read a skipped live
// section as a pass — and the prose above it claimed the live tombstone had
// been read, on a run where no peer was there to read it from.
reportAndExit({ failures, skipped });
