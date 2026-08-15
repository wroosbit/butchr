// Proof for KAN-471: the Jira comment read is a WINDOW on the newest end, and
// what that does — and does not do — to the poller that reads it.
//
// WHAT FAILURE THIS WOULD CATCH: a poller that loses a comment it was told
// about. The read it depends on is capped — measured on KAN-39, 2026-08-15,
// `/rest/api/3/issue/{key}?fields=comment` returned **100 of 211** comments —
// and `snapshotFrom` takes `fields.comment.comments` as though it were the
// whole history, discarding `total`, `maxResults` and `startAt` without
// reading them. That is safe for one reason only, and the reason is not
// written down anywhere else: the window is the NEWEST end, so a comment that
// has just arrived is always in it. This script pins that reason by driving
// the real poller across a capped window (§1), and then finds the exact bound
// at which it stops holding (§2, §3) — because a safety property nobody has
// located the edge of is a belief, not a measurement.
//
// The defect it would catch, concretely: someone "fixes" the parser to read
// the oldest page, or Jira's ordering changes, or a caller pages with
// `startAt=0` and hands the poller the FIRST 100 comments. Every one of those
// leaves §1 red — the poller stops seeing new comments at all — while nothing
// else in the suite notices, because no other script builds a capped body.
// `verify-jira-nudge-coalescing.mjs`'s stub sets `total` to the returned
// length, so the capped case has never been exercised anywhere.
//
// CI-RUNNABLE: yes — imports the built daemon modules and drives the real
// JiraPoller, JiraPollState and snapshotFrom. No network, no panes, no Jira.
//
// Sections:
//
//   1. the window is the newest end — a capped body (100 of 211, startAt 111)
//      and a new comment on top of it. The poller must see the new one. This
//      is the property production actually rests on.
//   2. the exact bound — a burst that exactly fills the window loses nothing;
//      a burst of window+1 loses exactly one, silently. This is the failure
//      the ticket asked to be established rather than assumed.
//   3. the loss is silent — §2's dropped comment produces no event, no
//      `skipped` entry and no log line. Nothing downstream can tell.
//   4. the parser drops the completeness fields — characterisation, so that
//      making the snapshot carry `total` is a deliberate act that turns this
//      red rather than a silent change of contract.
//
// WHERE THIS PROOF SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Real: the JiraPoller, JiraPollState on a real file, and the real
// `snapshotFrom` parser.
//
// Supplied by this script: the Jira response bodies, including the cap itself.
// **So this script cannot prove that Jira caps at 100, that the cap selects the
// newest comments, or that `startAt + returned === total`.** It assumes all
// three and proves what the daemon does GIVEN them. That assumption is the
// whole basis of §1's safety argument, so it is not a footnote.
//
// WHO COVERS IT: nobody mechanically, and nothing can from CI — it is a fact
// about a live third-party API, and a script that asked Jira would be asserting
// against the network on every PR. It is covered instead by the measurement
// pasted into KAN-471's PR body and recorded on the ticket: three tickets read
// live (KAN-39 capped at 100 of 211 with startAt 111, KAN-467 complete at 8 of
// 8 with startAt 0, KAN-471 empty at 0 of 0), plus the JQL route capping at 20
// of 211. If Jira's behaviour changes, this script keeps passing and the rule
// in `prompts/*.md` goes quietly wrong. That is a real hole and it is named
// here rather than left to be inferred.
//
// Usage: node daemon/scripts/verify-jira-comment-window.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

const { JiraPoller, JiraPollState } = await import(path.join(distDir, 'jira-poll.js'));
const { snapshotFrom } = await import(path.join(distDir, 'jira.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${String(label).padEnd(56)} ${value}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan471-'));
let files = 0;
const nextStateFile = () => path.join(TMP, `jira-poll-${++files}.json`);

// --------------------------------------------------------------- the harness --

const KEY = 'KAN-9471';
const AGENT = { agentName: 'butchr-task-kan-9471', type: 'task', key: KEY };

/**
 * The cap Jira applies to the comment field on the issue endpoint.
 *
 * 100 is the measured value (KAN-39, 2026-08-15). It is a constant here rather
 * than imported because the daemon does not know about it — that it does not is
 * §4's finding.
 */
const WINDOW = 100;

/**
 * A Jira body carrying the LAST `WINDOW` of `allIds`, in the shape the real API
 * returns it: oldest-first within the window, with the container reporting the
 * cap honestly.
 *
 * `startAt + returned === total` is asserted here rather than hard-coded, so a
 * future edit that builds an inconsistent fixture fails loudly instead of
 * proving something about a body Jira would never send.
 */
function cappedBody(key, allIds, status = 'In Progress') {
  const window = allIds.slice(-WINDOW);
  const startAt = allIds.length - window.length;
  if (startAt + window.length !== allIds.length) {
    throw new Error('fixture is inconsistent: startAt + returned !== total');
  }
  return {
    key,
    fields: {
      status: { name: status, statusCategory: { key: 'indeterminate' } },
      updated: '2026-08-15T06:00:00.000-0700',
      comment: {
        comments: window.map((id) => ({
          id: String(id),
          author: {
            accountId: '712020:619ec5ec-2e92-492f-8979-91ccda318230',
            displayName: 'Wroos Bit'
          },
          created: '2026-08-15T06:00:00.000-0700'
        })),
        self: `https://api.atlassian.com/ex/jira/c4c5/rest/api/3/issue/10481/comment`,
        maxResults: window.length,
        total: allIds.length,
        startAt
      },
      issuelinks: []
    }
  };
}

/** A jira stub whose issue is whatever `ids()` currently returns. */
function stubJira(ids) {
  return {
    pollIssue: async (key) => {
      if (key.toUpperCase() !== KEY) {
        return { ok: false, backOff: false, status: 404, error: 'no such issue' };
      }
      return { ok: true, snapshot: snapshotFrom(key, cappedBody(key, ids())) };
    }
  };
}

/** A herdr with one live agent and a pane that accepts anything. */
function stubHerdr() {
  const sent = [];
  return {
    sent,
    tailAgent: () => ({ success: true, text: '❯ \n  ⏵⏵ bypass permissions on' }),
    sendToAgent: async (key, message, type) => {
      sent.push({ key, type, message });
      return { success: true };
    }
  };
}

function newPoller(jira, herdr, log) {
  return new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => [AGENT],
    supervisorFor: () => null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(nextStateFile()),
    confirmTimeoutMs: 400,
    confirmPollMs: 50,
    deliver: async () => ({ success: true })
  });
}

/** Comment ids 1..n, as Jira's global counter produces them. */
const idsUpTo = (n) => Array.from({ length: n }, (_, i) => String(11000 + i + 1));

// --------------------------------------------------------------------------- //

rule('1. the window is the NEWEST end — the property production rests on');

{
  // 211 comments, of which the poller can only ever see the last 100. This is
  // KAN-39's real shape on the day the ticket was filed.
  let all = idsUpTo(211);
  const log = [];
  const poller = newPoller(stubJira(() => all), stubHerdr(), log);

  const first = await poller.pollOnce();
  row('first sight — comments in the payload', 100);
  row('first sight — total the container reports', 211);
  row('first sight — events (must be none)', JSON.stringify(first.events.map((e) => e.kind)));

  // One new comment arrives. It lands at the newest end, so it enters the
  // window and the oldest one falls off the back.
  all = [...all, '11212'];
  const second = await poller.pollOnce();
  const commentEvents = second.events.filter((e) => e.kind === 'comment');

  row('after 1 new comment — oldest in window moved', 'yes (11101 -> 11102)');
  row('after 1 new comment — comment events', JSON.stringify(commentEvents.map((e) => e.newComments)));
  row('after 1 new comment — ids reported new', JSON.stringify(commentEvents[0]?.newCommentIds ?? []));

  verdict(
    first.events.length === 0 &&
      commentEvents.length === 1 &&
      commentEvents[0].newComments === 1 &&
      commentEvents[0].newCommentIds.join() === '11212',
    'a capped window still delivers a new comment — because the window is the newest end',
    'the poller missed a new comment on a capped ticket, which is production today'
  );
}

rule('2. the exact bound — where that stops holding');

{
  // Exactly a window's worth arrives between two ticks. Every one of them is
  // still in the window, so nothing is lost.
  let all = idsUpTo(211);
  const log = [];
  const poller = newPoller(stubJira(() => all), stubHerdr(), log);
  await poller.pollOnce();

  const burst = Array.from({ length: WINDOW }, (_, i) => String(12000 + i));
  all = [...all, ...burst];
  const tick = await poller.pollOnce();
  const ev = tick.events.find((e) => e.kind === 'comment');

  row('burst size', WINDOW);
  row('new comments reported', ev?.newComments ?? 0);
  verdict(
    ev?.newComments === WINDOW,
    `a burst of exactly ${WINDOW} loses nothing — the window still holds all of them`,
    `a burst of exactly ${WINDOW} lost comments, so the bound is tighter than the window`
  );
}

{
  // One more than a window's worth. The oldest of the burst is pushed out of
  // the window before the poller ever reads it, and is lost.
  let all = idsUpTo(211);
  const log = [];
  const poller = newPoller(stubJira(() => all), stubHerdr(), log);
  await poller.pollOnce();

  const burst = Array.from({ length: WINDOW + 1 }, (_, i) => String(12000 + i));
  all = [...all, ...burst];
  const tick = await poller.pollOnce();
  const ev = tick.events.find((e) => e.kind === 'comment');
  const reported = new Set(ev?.newCommentIds ?? []);
  const missing = burst.filter((id) => !reported.has(id));

  row('burst size', WINDOW + 1);
  row('new comments reported', ev?.newComments ?? 0);
  row('comments never reported', JSON.stringify(missing));
  verdict(
    ev?.newComments === WINDOW && missing.length === 1 && missing[0] === burst[0],
    `a burst of ${WINDOW + 1} loses exactly the oldest one — the bound is the window, exactly`,
    'the bound is not where this script says it is; the numbers above are the finding'
  );
}

rule('3. and the loss is SILENT — nothing downstream can tell');

{
  let all = idsUpTo(211);
  const log = [];
  const poller = newPoller(stubJira(() => all), stubHerdr(), log);
  await poller.pollOnce();
  log.length = 0;

  all = [...all, ...Array.from({ length: WINDOW + 1 }, (_, i) => String(12000 + i))];
  const tick = await poller.pollOnce();

  const complains = log.filter((l) => /total|truncat|window|cap|startAt|missed|drop/i.test(l));
  row('skipped entries recording the drop', JSON.stringify(tick.skipped.map((s) => s.reason)));
  row('log lines mentioning the cap', JSON.stringify(complains));

  verdict(
    complains.length === 0 && tick.skipped.length === 0,
    'the drop leaves no trace — which is why it is written down here and in the prompts',
    'something now reports the drop; if that is deliberate, this section is what to update'
  );
}

rule('4. the parser drops the completeness fields — characterisation');

{
  // Not a defect on its own: the poller does not need `total`, and §1 is why.
  // Pinned so that a change of contract is a deliberate red rather than silent.
  const snap = snapshotFrom(KEY, cappedBody(KEY, idsUpTo(211)));
  const keys = Object.keys(snap);

  row('snapshot keys', JSON.stringify(keys));
  row('commentIds carried', snap.commentIds.length);
  row('total carried anywhere?', keys.some((k) => /total|maxResults|startAt/i.test(k)) ? 'yes' : 'no');

  // Two separate claims, deliberately not one `&&`. The red drive for this
  // script (M1: `snapshotFrom` slicing the newest comment off) failed this
  // section on the COUNT while the combined message blamed the completeness
  // fields — a red crediting the wrong mechanism, which is the failure mode
  // this repository has spent a whole ticket on. Split so each red names its
  // own cause.
  verdict(
    snap.commentIds.length === WINDOW,
    `the snapshot carries all ${WINDOW} ids the window held`,
    `the snapshot carries ${snap.commentIds.length} of the ${WINDOW} ids the window held — ` +
      'the parser is dropping comments before the poller ever compares them'
  );
  verdict(
    !keys.some((k) => /total|maxResults|startAt/i.test(k)),
    'and not the fact that it is a window — deliberate, and now pinned',
    'the snapshot now carries a completeness field; update §4 and say what reads it'
  );
}

console.log(
  failures
    ? `\n✗ ${failures} check(s) failed.\n`
    : '\n✓ the comment read is a window on the newest end; the poller is safe up to a\n' +
      `  burst of ${WINDOW} between ticks, loses exactly the overflow beyond that, and says\n` +
      '  nothing when it does.\n'
);
process.exit(failures ? 1 : 0);
