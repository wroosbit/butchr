// The guardian on the Jira board page: that it appears there, that view state
// cannot make it vanish, that identity and reachability do not render the same,
// and that the board is STILL not a workspace afterwards.
//
// WHAT FAILURE THIS WOULD CATCH: a board display that shows WHO the guardian is
// and not WHETHER IT IS REACHABLE — "Guardian: epic/KAN-203" rendering
// identically whether the last poke landed four minutes ago or four hours ago.
// `epic/KAN-39` names that as this epic's most-repeated defect and KAN-284 makes
// it acceptance criterion 5 in as many words: without the distinction "the
// display becomes the reassurance that hides the failure it exists to reveal."
// A guardian whose name is on the board while nothing has reached it all
// afternoon is strictly worse than an empty board, because the board is where
// somebody looks to check.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// It would equally catch three others, all of which look like the feature
// working:
//
//   * A MATCHER KEYED ON VIEW STATE. §1. The human's own link carried
//     `?filter=&groupBy=none`, and `filter`, `groupBy` and friends change as a
//     human USES the board — so a matcher that consulted the query string would
//     make the display vanish at the exact moment somebody was looking hardest.
//     §1 asserts the match survives every one of them.
//   * THE BOARD BECOMING A WORKSPACE. §3, and this is the one that trades an
//     invariant for a UI nicety. Invariant 6: "a board URL is not a workspace."
//     The tempting fix for a display that is not appearing is to make the board
//     resolve to something, and afterwards nothing shows the trade. §3 asserts
//     `supported: false` is unchanged on exactly the URL the guardian renders on.
//   * A SECOND MATCHER IN THE EXTENSION. §4. One fact with two implementations
//     is KAN-145's defect, and the copy nobody routes on is the one that drifts.
//     The extension holds no board pattern at all, and §4 reads the source to
//     prove it rather than trusting a convention.
//
// ---------------------------------------------------------------------------
// HOW TO WATCH IT GO RED — no merge base and no mutation needed
// ---------------------------------------------------------------------------
// Run with `--identity-only`. It replaces ONE thing: the description function is
// wrapped so that every state returns the headline it would have had if the
// renderer only knew the guardian's name — which is what a first implementation
// of "show whatever the guardian agent is" actually looks like.
//
//   node daemon/scripts/verify-guardian-board-display.mjs --identity-only
//
// §2 goes red: a guardian whose pokes have not landed for hours renders exactly
// the same as one whose poke landed a minute ago, and the alarm tone collapses
// into the calm one. Nothing else changes, and everything else stays green —
// which is the point, because that is precisely how this defect ships.
//
// `--drop-invariant` is the second recipe. It makes the board page resolve to a
// workspace, the way an author "fixing" a display that will not appear would,
// and §3 goes red while §1 and §2 stay green.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), so, per section:
//
//   §1 AND §3 SUPPLY A URL AND A REGISTRY. They drive the shipped
//   `boardPageFor` and the shipped `MessageRouter.handleStatus`, so what is
//   tested is the real decision procedure — but the URL comes from this file
//   rather than from a browser. Nothing here proves the extension ever sends the
//   board's URL, or that Jira's own board path has not changed under us. The
//   path was confirmed against the live site on 2026-08-11 by redirect
//   (`/secure/RapidBoard.jspa?rapidView=2` → 302
//   `/jira/software/projects/KAN/boards/2`), and that confirmation is an
//   observation with a date on it, not a test.
//
//   §2 SUPPLIES THE STATE IT THEN DESCRIBES. It hands `describeGuardian` states
//   it constructed. It therefore tests THE RENDERING DECISION and nothing about
//   whether a real overdue guardian ever produces such a state —
//   `verify-guardian-poke.mjs` §2 is what covers that half, from the record's
//   side, and it supplies its own input too.
//
//   WHO COVERS THE GAP BETWEEN THEM: nobody on a schedule. The seam is
//   `daemon.ts`'s wiring plus a browser actually rendering, and the only thing
//   that reaches it is a human looking at the board with the extension loaded.
//   That is why the pull request carries a screenshot rather than a claim, and
//   why the close-out says a human must reload at chrome://extensions — a daemon
//   restart does not deploy an extension change and nothing in the fleet can
//   trigger one.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { boardPageFor } from '../dist/board-page.js';
import { MessageRouter } from '../dist/router.js';
import { GuardianRecord, DEFAULT_POKE_INTERVAL_MS, OVERDUE_INTERVALS } from '../dist/guardian.js';

const identityOnly = process.argv.includes('--identity-only');
const dropInvariant = process.argv.includes('--drop-invariant');

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const failures = [];
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// The extension's own description function, imported as source rather than as a
// module because it is plain ESM in a package this script does not build. Doing
// it this way is deliberate: it means §2 asserts against THE FILE THE EXTENSION
// SHIPS, not a copy of its logic living here.
const guardianLibPath = path.join(repo, 'extension', 'src', 'lib', 'guardian.js');
const { describeGuardian } = await import(guardianLibPath);

const BOARD = 'https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2';

// ---------------------------------------------------------------------------
section('§1 The board path is matched, and view state cannot make it vanish');
// ---------------------------------------------------------------------------
// The canonical form, confirmed against the live site by redirect on
// 2026-08-11. The link the human sent arrived mangled as
// `.../jirKAN/boards/2?filter=&groupBy=none`, which decomposes exactly:
// `/jira/software/projects/KAN/` less `a/software/projects/` is `/jirKAN/`.

check('the canonical board URL matches', boardPageFor(BOARD) !== null, BOARD);
check(
  'and it reports the project and board it matched',
  boardPageFor(BOARD)?.projectKey === 'KAN' && boardPageFor(BOARD)?.boardId === '2',
  `projectKey=${boardPageFor(BOARD)?.projectKey}, boardId=${boardPageFor(BOARD)?.boardId}`
);

// THE VIEW STATE CASES. Each of these is something a human produces by using the
// page, and every one of them must leave the display exactly where it was.
const viewState = [
  '?filter=&groupBy=none',
  '?groupBy=assignee',
  '?filter=myIssues&groupBy=epic',
  '?assignee=abc123&statuses=10005',
  '#board',
  '?filter=&groupBy=none#anchor',
  '/'
];
for (const suffix of viewState) {
  check(
    `survives \`${suffix}\``,
    boardPageFor(`${BOARD}${suffix}`) !== null,
    'the query string and fragment are not consulted at all'
  );
}

// The company-managed spelling, included because the difference is invisible in
// a URL somebody pastes.
check(
  'the company-managed board path also matches',
  boardPageFor('https://x.atlassian.net/jira/software/c/projects/KAN/boards/9') !== null,
  '/jira/software/c/projects/KAN/boards/9'
);
check(
  'the legacy RapidBoard URL matches too',
  boardPageFor('https://wroosbit.atlassian.net/secure/RapidBoard.jspa?rapidView=2') !== null,
  'it 302s to the canonical form; matched for the moment before the redirect lands'
);

// AND WHAT MUST NOT MATCH. A matcher that is too loose puts a fleet-wide notice
// on pages nobody asked about the fleet from.
const notBoards = [
  'https://wroosbit.atlassian.net/browse/KAN-284',
  'https://wroosbit.atlassian.net/jira/software/projects/KAN/boards',
  'https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2/extra',
  'https://wroosbit.atlassian.net/jira/software/projects/KAN/issues/KAN-1',
  'https://github.com/wroosbit/butchr/pull/1',
  'file:///home/x/jira/software/projects/KAN/boards/2',
  'not a url',
  '',
  null,
  undefined
];
for (const url of notBoards) {
  check(
    `does NOT match \`${String(url).slice(0, 52)}\``,
    boardPageFor(url) === null,
    'a board notice on a page nobody asked from is noise'
  );
}

// ---------------------------------------------------------------------------
section('§2 Identity and reachability do not render the same (AC5, AC3)');
// ---------------------------------------------------------------------------

const GUARDIAN = { type: 'epic', key: 'KAN-203' };
let clock = Date.parse('2026-08-11T20:00:00.000Z');
const now = () => clock;

function stateWith({ deliveredAgoMs, undelivered, reason }) {
  const config = {
    address: GUARDIAN,
    intervalMs: DEFAULT_POKE_INTERVAL_MS,
    setBy: null,
    setAt: null
  };
  const record = new GuardianRecord({ readConfig: () => config, now });
  if (deliveredAgoMs !== null) {
    record.record({
      outcome: 'delivered',
      delivered: true,
      address: GUARDIAN,
      connectionId: 'conn-4',
      transport: 'channel',
      interrupted: false,
      reason: null,
      startedAt: new Date(clock - deliveredAgoMs).toISOString(),
      elapsedMs: 1,
      detail: 'delivered'
    });
  }
  for (let i = 0; i < (undelivered ?? 0); i += 1) {
    record.record({
      outcome: 'undelivered',
      delivered: false,
      address: GUARDIAN,
      connectionId: null,
      transport: 'undelivered',
      interrupted: false,
      reason: reason ?? 'no-connection',
      startedAt: new Date(clock).toISOString(),
      elapsedMs: 1,
      detail: 'undelivered'
    });
  }
  return record.state();
}

// THE EXACT PAIR FROM THE TICKET. "Guardian: epic/KAN-203" and "Guardian:
// epic/KAN-203 — last poke landed 4 hours ago" must not render the same.
const landing = stateWith({ deliveredAgoMs: 4 * 60_000, undelivered: 0 });
const stale = stateWith({
  deliveredAgoMs: 4 * 60 * 60_000,
  undelivered: OVERDUE_INTERVALS + 1,
  reason: 'no-connection'
});

// The one line that makes this script go red on demand. Everything else here is
// the shipped code; this is the "show the name and nothing else" implementation.
const describe = identityOnly
  ? (guardian) => {
      const real = describeGuardian(guardian);
      if (!real) return null;
      return { ...real, tone: 'calm', headline: real.name ? `${real.name} is the guardian` : real.headline, detail: '' };
    }
  : describeGuardian;

const landingView = describe(landing);
const staleView = describe(stale);

check(
  'a guardian whose poke landed 4 minutes ago reads calm',
  landingView.tone === 'calm',
  `tone=${landingView.tone}`
);
check(
  'a guardian whose last poke landed 4 HOURS ago does NOT read calm',
  staleView.tone !== 'calm',
  `tone=${staleView.tone}`
);
check(
  'the two do not share a headline',
  landingView.headline !== staleView.headline,
  `"${landingView.headline}" vs "${staleView.headline}"`
);
check(
  'the two do not share a body',
  landingView.detail !== staleView.detail,
  'identity alone would have made these identical'
);
check(
  'the stale one says the fleet is unsupervised',
  /unsupervised/i.test(staleView.detail),
  staleView.detail.slice(0, 60) + '…'
);
check(
  'the stale one tells the reader where to look next',
  typeof staleView.action === 'string' && /butchr_list_agents/.test(staleView.action),
  staleView.action ? staleView.action.slice(0, 60) + '…' : '(no action)'
);

// NO GUARDIAN AT ALL — the quietest failure, and it must be the loudest state.
const none = describe({ configured: false, address: null, proves: 'delivery', provesDetail: 'x' });
check(
  'no guardian configured reads as an alarm, not as an empty panel',
  none.tone === 'alarm' && /No guardian is set/i.test(none.headline),
  `tone=${none.tone}, headline="${none.headline}"`
);
check(
  'and it says nothing is watching the fleet',
  /Nothing is watching this fleet/i.test(none.detail),
  none.detail.slice(0, 60) + '…'
);

// THE LIMIT IS ON SCREEN IN EVERY STATE, INCLUDING THE CALM ONE. The calm state
// is where the overclaim would be made.
for (const [label, view] of [['calm', landingView], ['overdue', staleView], ['none', none]]) {
  check(
    `the \`${label}\` state still carries the limit sentence`,
    typeof view.proves === 'string' && view.proves.length > 0,
    view.proves?.slice(0, 52) + '…'
  );
}
check(
  'and the limit says a heartbeat is not supervision',
  /heartbeat proves the loop turns/.test(landingView.proves),
  'carried from the daemon verbatim, not paraphrased in the UI'
);

// A daemon with no guardian mechanism, and a page that is not a board, are the
// same RENDERING decision — say nothing — and neither may be confused with
// "there is no guardian", which is a described alarm above.
check(
  'a null guardian block renders nothing at all',
  describeGuardian(null) === null && describeGuardian(undefined) === null,
  '"not a board page" and "no guardian set" are different facts'
);

// ---------------------------------------------------------------------------
section('§3 The board is STILL not a workspace afterwards (invariant 6, AC6)');
// ---------------------------------------------------------------------------
// Asserted against the shipped `handleStatus` on exactly the URL the guardian
// renders on. This is the trade the ticket warns about: do not "fix" a display
// that is not appearing by making the board resolve to something.

const guardianState = stateWith({ deliveredAgoMs: 60_000, undelivered: 0 });

async function statusFor(url, { withGuardian = true } = {}) {
  let response = null;
  const router = new MessageRouter(
    {
      // `dropInvariant` is the second red recipe: a registry that resolves the
      // board to a workspace, which is what an author reaching for a URL pattern
      // to make the display appear would produce.
      resolve: async (u) =>
        dropInvariant && boardPageFor(u)
          ? { config: { type: 'task' }, key: 'KAN-BOARD' }
          : null,
      disabledMatch: () => null
    },
    { load: () => '' },
    {
      getSessionByAddress: () => null,
      listAgents: () => [],
      resolveAddress: (key, type) => ({ type, key })
    },
    (msg) => {
      response = msg;
    },
    () => {},
    withGuardian ? { guardian: () => guardianState } : {}
  );
  // `handleStatus` is private; it is reached the way the daemon reaches it —
  // through `handle`, on the action name the extension actually sends
  // (service_worker.js's CHECK_STATUS posts `action: 'status'`). Using the wrong
  // name here would send every assertion below through the router's
  // unknown-action branch and leave them passing on `undefined`, which is how a
  // proof comes to be green about a code path it never reached.
  await router.handle({ action: 'status', url });
  return response;
}

const boardStatus = await statusFor(BOARD);
check(
  'the board page answers `supported: false`',
  boardStatus?.supported === false,
  `supported=${boardStatus?.supported}`
);
check(
  'it names no workspace type and no key',
  // `boardStatus` is asserted non-null FIRST. Without that this passes on an
  // undefined response — which is exactly what it did while this script used
  // the wrong action name, reporting green about a handler it never reached.
  boardStatus !== null &&
    boardStatus.action === 'status_response' &&
    boardStatus.type === undefined &&
    boardStatus.key === undefined,
  'displaying is rendering, not binding'
);
check(
  'AND the guardian block is attached to that same response',
  boardStatus?.guardian?.address?.key === 'KAN-203',
  `guardian=${boardStatus?.guardian?.address?.type}/${boardStatus?.guardian?.address?.key}`
);
check(
  'the block carries the board it is on, so the UI need not re-parse the URL',
  boardStatus?.guardian?.boardId === '2' && boardStatus?.guardian?.projectKey === 'KAN',
  `boardId=${boardStatus?.guardian?.boardId}`
);
check(
  'the block carries `proves` so the surface cannot overclaim',
  boardStatus?.guardian?.proves === 'delivery',
  `proves=${boardStatus?.guardian?.proves}`
);

// The three absences, each of which must render as silence rather than as a
// default.
const unrelated = await statusFor('https://example.com/whatever');
check(
  'a NON-board unsupported page gets no guardian block',
  unrelated?.supported === false && unrelated.guardian === undefined,
  'a fleet notice on an unrelated page is noise'
);
const noPoker = await statusFor(BOARD, { withGuardian: false });
check(
  'a daemon with no poker wired omits the block entirely',
  noPoker?.supported === false && noPoker.guardian === undefined,
  '"this daemon has no mechanism" must not read as "this fleet has no guardian"'
);
const viewStateStatus = await statusFor(`${BOARD}?filter=&groupBy=none`);
check(
  'the board with view state still answers `supported: false` AND still shows the guardian',
  viewStateStatus?.supported === false && viewStateStatus?.guardian !== undefined,
  'both halves survive a human using the page'
);

// ---------------------------------------------------------------------------
section('§4 There is exactly one board matcher, and it is not in the extension');
// ---------------------------------------------------------------------------
// One fact with two implementations is KAN-145's defect, and the copy nobody
// routes on is the one that drifts. The extension renders what it is told.

const extensionSources = [];
for (const dir of ['src', '.']) {
  const base = path.join(repo, 'extension', dir);
  for (const entry of fs.readdirSync(base, { withFileTypes: true, recursive: dir === 'src' })) {
    if (!entry.isFile()) continue;
    if (!/\.(js|jsx)$/.test(entry.name)) continue;
    const full = path.join(entry.parentPath ?? entry.path ?? base, entry.name);
    if (full.includes('node_modules') || full.includes(`${path.sep}dist${path.sep}`)) continue;
    extensionSources.push(full);
  }
}

const offenders = extensionSources.filter((file) => {
  const source = fs.readFileSync(file, 'utf8');
  return /jira\/software|boards\/|RapidBoard|rapidView/.test(source);
});
check(
  'no extension source contains a board URL pattern',
  offenders.length === 0,
  offenders.length ? offenders.map((f) => path.relative(repo, f)).join(', ') : `${extensionSources.length} files read`
);

const daemonMatchers = fs
  .readdirSync(path.join(repo, 'daemon', 'src'))
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /jira\\\/software|boards\\\/\(/.test(fs.readFileSync(path.join(repo, 'daemon', 'src', f), 'utf8')));
check(
  'and exactly one daemon module holds it',
  daemonMatchers.length === 1 && daemonMatchers[0] === 'board-page.ts',
  daemonMatchers.join(', ') || '(none found)'
);

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
if (failures.length) {
  console.log(`FAILED (${failures.length} of ${checks}):`);
  for (const f of failures) console.log(`  - ${f}`);
  if (identityOnly) {
    console.log('\n(--identity-only was passed: §2 failing here is the POINT. A display that');
    console.log(' knows the guardian\'s NAME and not whether it is REACHABLE is the');
    console.log(' reassurance that hides the failure it exists to reveal.)');
  }
  if (dropInvariant) {
    console.log('\n(--drop-invariant was passed: §3 failing here is the POINT. Making the');
    console.log(' board resolve to a workspace is the tempting fix for a display that will');
    console.log(' not appear, and it trades invariant 6 for a UI nicety.)');
  }
} else {
  console.log(`All ${checks} checks passed.`);
}
console.log('='.repeat(78));

process.exit(failures.length ? 1 : 0);
