// KAN-357: read-path contract v7's `standing`, behind a door that refuses it
// below v7, and joined on `claimsPath` rather than on `identity`.
//
// WHAT FAILURE THIS WOULD CATCH: a consumer reading `standing` off a peer too
// old to publish it, and reporting the resulting `undefined` as a verdict about
// the ROW. The CrabCast serving this machine answers `contractVersion: 6`, so
// `standing` is absent on every row it sends; an implementation that read that
// absence as "no standing recorded" would pass every test written against this
// peer, ship, and be wrong the moment somebody deploys them — because it cannot
// distinguish THIS PEER CANNOT TELL ME from THIS ROW HAS NO STANDING. It would
// also catch the join being keyed on `identity`, which is in the row's own
// vocabulary and matches nothing in a path-keyed list, so a failed match reads
// as a genuinely absent agent and the alarm fires on the ordinary case.
//
// CI-RUNNABLE: partial — sections 1-4 assert in CI. They import the built
// daemon modules and run over frames this script constructs and a committed
// capture, and need no peer, no herdr, no PTY, no credential and no network.
// Section 5 reads a live CrabCast socket and SKIPS without one; a skip is
// printed as a skip and never counted as a pass.
//
// ── THE TWO HALVES OF THIS SCRIPT ARE NOT PROVED THE SAME WAY ──────────────
//
// This is the honest scope, stated here rather than left to a reader to infer,
// because the halves have different evidence behind them and the difference is
// the whole story of this ticket:
//
//   §1-§3  THE REFUSAL AND THE JOIN, over frames this script CONSTRUCTS or
//          takes from a committed capture. A proof that supplies its own input
//          has not tested that the input arrives (KAN-145), so on its own this
//          proves the branching is right and NOT that a real peer sends what it
//          is branched on.
//
//   §4     THE COMMITTED v6 CAPTURE — `fixtures/crabcast-v6-tombstone-census.json`,
//          raw off the live socket via `probe-crabcast-raw-frames.mjs`, not
//          hand-written. This is what closes the §1-§3 gap for the BELOW-v7
//          case: the absent `standing` and the null `claimsPath` in it are what
//          a real CrabCast actually sent, not what we imagined it would.
//
//   §5     THE LIVE WIRE, when a peer is reachable. Re-reads the same facts off
//          the socket at run time so that a fixture that has drifted from the
//          world is visible rather than quietly authoritative.
//
// ── WHAT NONE OF THEM COVERS, NAMED BECAUSE THE LIST LOOKS COMPLETE ────────
//
// **No live peer at v7 has ever been read, by this script or by anything.** The
// `available: true` arm of every section below is exercised against constructed
// frames ONLY. That is not a choice: as of 2026-08-13 the CrabCast on this
// machine started ~10 hours before v7 merged and execs a checkout's `dist/`, so
// serving v7 needs a pull, a build and a restart — a deploy, and the human's
// call rather than ours.
//
// So this script CANNOT tell you that a real v7 peer's `standing` arrives in
// the shape branched on here. What covers that: nothing yet. It is KAN-357's
// AC1, it is explicitly still open, and the ticket says so rather than letting
// a green run here look like it closed it. `verify-crabcast-runtime-live.mjs`
// §4b independently reports the peer/pin version gap and is red against this
// daemon by design.
//
// ── MADE TO GO RED ─────────────────────────────────────────────────────────
//
// Two mutations, and they are different KINDS of red, which matters:
//
//   1. THE COMPILER'S, not this script's. Collapsing the reading to a bare
//      string — `standing: RowStanding` instead of `StandingReading` — does not
//      compile, because a consumer cannot reach `.standing` without narrowing
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
//   2. THIS SCRIPT'S. Both of these COMPILE, so the proof actually sees them:
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
// Real output of both is pasted in the PR body.
//
// Sections:
//   1. the vocabulary narrows, and an unrecognised value never becomes `retired`
//   2. the door — below v7 is "this peer cannot tell me", not a row verdict
//   3. the join — three outcomes, and `could-not-run` is not `ran-found-nothing`
//   4. the committed v6 capture — the real below-v7 peer, off the wire
//   5. the live wire, when a peer is reachable
//
// Usage: node daemon/scripts/verify-crabcast-standing.mjs [--verbose]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = path.join(repoRoot, 'daemon', 'dist');
const verbose = process.argv.includes('--verbose');

// Exit 2, never 1: a missing build is this script being run before `npm run
// build`, and reporting that as a verdict would say the code is wrong when
// nothing has been measured. A guard, not a verdict — see the sweep's own
// distinction in sweep-verify-exit-paths.mjs.
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const { readUnreadableDisclosure } = await import(path.join(distDir, 'crabcast-runtime.js'));

const FIXTURE_PATH = path.join(scriptDir, 'fixtures', 'crabcast-v6-tombstone-census.json');

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
      r.standing.available === true && r.standing.standing === expected,
      `got ${JSON.stringify(r.standing)}`,
      `standing=${expected}`
    );
  }

  // The one that matters: a member v8 might add.
  for (const hostile of ['harmless', 'RETIRED', '', null, 42, undefined]) {
    const r = only(readUnreadableDisclosure(frameWith({ standing: hostile }), 7, pathsOf()));
    check(
      `unrecognised standing ${JSON.stringify(hostile)} → \`unknown\`, not \`retired\``,
      r.standing.available === true && r.standing.standing === 'unknown',
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
      open.standing.available === true && open.standing.standing === 'retired',
      `got ${JSON.stringify(open.standing)}`
    );
  }

  // The v4 disclosure must be UNAFFECTED by the door. Refusing the whole census
  // on a version mismatch would delete KAN-324's disclosure against the only
  // peer that actually exists.
  const stillReads = readUnreadableDisclosure(frameWith({ claimsPath: '/w/x' }), 6, pathsOf());
  check(
    'the door is in front of `standing` ONLY — a v6 peer still discloses total and claimsPath',
    stillReads.unreadableRecordsTotal === 1 && only(stillReads).claimsPath === '/w/x',
    `got total=${stillReads.unreadableRecordsTotal} claimsPath=${JSON.stringify(only(stillReads).claimsPath)} — the v4 disclosure has been lost to the v7 gate`,
    'total=1, claimsPath read at v6'
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
      tombstone.standing.standing === 'retired' &&
      tombstone.supersession === null &&
      lost.standing.standing === 'claims-an-agent' &&
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
section('5. THE LIVE WIRE — re-read now, so a drifted fixture is visible');
// Skips rather than fails when no peer is reachable: the absence of a CrabCast
// is not a defect in this code, and failing CI for it would make the script a
// liability rather than a check.
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
      `no peer answered on ${socketPath} — §1-§4 stand on constructed frames and the committed capture, and AC1 is untouched either way.`
    );
  } else {
    const v = live.contractVersion;
    console.log(`   ....  live peer: contractVersion=${v}, build ${String(live.build?.commit).slice(0, 12)}`);

    const reading = readUnreadableDisclosure(live, typeof v === 'number' ? v : null, pathsOf());
    const rows = reading.unreadableRecords;

    check(
      'the live reading agrees with the committed capture on the peer version',
      v === 6,
      `live peer answers contractVersion=${JSON.stringify(v)} but the capture records 6.\n` +
        `If this says 7, THE PEER HAS BEEN DEPLOYED: KAN-357's AC1 is now satisfiable and this\n` +
        `assertion is what noticed. Re-capture the fixture and read the real \`standing\` values.`,
      `contractVersion=${v}, as captured`
    );

    if (v === 6) {
      check(
        'every live row reads as "this peer cannot tell me"',
        rows.length > 0 && rows.every((r) => r.standing.available === false),
        `got ${JSON.stringify(rows.map((r) => r.standing))} over ${rows.length} row(s)`,
        `${rows.length} row(s), all refused at the door`
      );
      check(
        'the live disclosure still reports its total through the door',
        reading.unreadableRecordsTotal === live.unreadableRecordsTotal,
        `ours=${reading.unreadableRecordsTotal} theirs=${live.unreadableRecordsTotal}`,
        `total=${reading.unreadableRecordsTotal}`
      );
    }
  }
}

// =============================================================================
console.log(`\n${'─'.repeat(74)}\nVerdict\n${'─'.repeat(74)}`);
if (skipped) console.log(`   ${skipped} section(s) skipped for want of a live peer.`);
console.log(
  failures
    ? `   ${failures} failure(s).`
    : '   standing is read behind the version door, joined on claimsPath, and a tombstone is\n' +
      '   distinguishable from a lost agent. NOT PROVED HERE: that a real v7 peer sends what\n' +
      '   this branches on — no v7 peer exists. That is AC1 and it remains open.'
);
process.exit(failures ? 1 : 0);
