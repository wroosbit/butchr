// KAN-304: the pull requests behind Jira tickets are watched, what changes about
// them is announced over the channel, and a watcher that cannot see GitHub says
// so instead of reporting a clean nothing.
//
// WHAT FAILURE THIS WOULD CATCH: a merged pull request leaving its ticket in In
// Review with nobody told — which happened THREE TIMES on 2026-08-11 (KAN-276,
// KAN-291, KAN-280) because a merge is not a Jira transition and the Jira poller
// only reports transitions. Nothing in `daemon/src` read GitHub at all: `ls
// daemon/src | grep -iE "pr-|pull|github|gh-"` returned nothing, and so did
// `grep -rlE "gh pr |api\.github|pull_request" *.ts`. It would equally catch the
// three failures this fix is most likely to commit instead — announcing a
// green-and-unmerged PR to its author rather than to the approver who is being
// waited on (§4), re-announcing the same fact every sixty seconds until agents
// learn to ignore the channel (§5), and reporting "nothing has changed" while
// GitHub has been unreachable for an hour (§6).
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process, over Unix sockets it creates under a private $HOME in os.tmpdir();
// no live daemon, no herdr, no credential, no peer, no terminal, and no network
// (§1 replays RECORDED `gh` output; §2-6 stub the reader).
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// "A proof that supplies its own input has not tested that the input arrives"
// (KAN-145, and `prompts/task.md` names it as the defect this epic keeps
// re-finding). So, per section, and the gaps are named rather than left to be
// inferred:
//
//   §1 SUPPLIES NOTHING IT INVENTED. `fixtures/gh-pr-list.json` is the VERBATIM
//   output of a real `gh pr list --repo wroosbit/butchr --state all --json …`
//   against the real repository, with only the comment BODIES elided for size —
//   every id, state, branch, sha, `mergeStateStatus` and check-rollup entry is
//   GitHub's own. It is run through the shipped `snapshotFrom`, so the parse leg
//   is tested against GitHub's actual shape rather than against a shape this
//   file imagined. That is what caught the association rule's real defect: the
//   strict `^butchr/KAN-\d+$` this started with fails on `butchr/KAN-306-gate-demo`
//   and `butchr/KAN-295-ci-main`, both of which are real branches in this
//   fixture belonging to the tickets they name.
//   WHAT IT STILL DOES NOT ESTABLISH: that `gh` is installed, authenticated, or
//   invoked correctly by `GhCliGitHubReader.exec` — the fixture is replayed, not
//   fetched. WHO COVERS THAT: nobody automatically, because a CI runner has no
//   `gh` credential. The PR pastes a live `gh pr list` against this repository
//   and its measured rate-limit cost; §6 covers what happens when the call fails.
//
//   §2-6 SUPPLY THE WORLD BUT NOT THE MECHANISM. GitHub is a stub and the agents
//   are addresses this script invents; the CARRIER is the shipped
//   `channelNotifier` over the shipped `routeChannelMessage` over the shipped
//   `AgentConnectionRegistry` over real Unix sockets. So `transport: "channel"`
//   below is the product's verdict rather than a literal written here, and the
//   frame printed is the bytes that came off the far end of a socket. The
//   `herdrBridge` handed to the watcher is a TRIP-WIRE whose every method
//   throws, so "nothing was typed" is enforced rather than asserted.
//   WHAT THEY DO NOT ESTABLISH: that `daemon.ts` wires any of this. WHO COVERS
//   IT: `verify-notifications-never-type.mjs` §AC1b, which asserts that the
//   daemon hands the channel-only carrier to all THREE producers and that this
//   module's health reader is exposed to `butchr_list_agents`. That assertion is
//   load-bearing rather than decorative — it went RED on this branch the first
//   time it ran, with the watcher wired and nothing else wrong, because it had
//   been written to expect exactly two producers.
//
//   WHAT NO SECTION HERE COVERS: that a frame reaches a MODEL. Reading bytes off
//   a socket is C1 and C2 and is the whole of what the channel can establish;
//   C3 is not observable on this carrier at all (`message-claims.ts`). Nor does
//   anything here observe a REAL pull request event reaching a REAL running
//   agent, which needs this build deployed to the fleet's daemon — a restart
//   that drops every agent's channel registration, and therefore the approver's
//   call rather than a task agent's. That is the same boundary KAN-301 drew and
//   it has not moved.
//
// Usage:
//   node daemon/scripts/verify-pr-watch.mjs [dist]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(58)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan304-'));

/**
 * A private `$HOME`, set BEFORE the product is imported.
 *
 * `ipc.ts` computes `BUTCHR_DIR` from `os.homedir()` at module load, and both
 * the channel kill switch and this watcher's own state file live inside it.
 * Without this the script would write the live fleet's `pr-watch.json` and would
 * flip its channel switch — taking every running agent off channels for as long
 * as this proof took to run.
 */
process.env.HOME = TMP;

const load = (mod) => import(path.join(path.resolve(distDir), mod));

const { snapshotFrom, rollupOf, repoFromRemoteUrl, originUrlFromGitConfig, repoForCheckout } =
  await load('github.js');
const { PrWatcher, PrWatchState, issueKeyForBranch } = await load('pr-watch.js');
const { PendingNotifications, channelNotifier } = await load('notify.js');
const { routeChannelMessage, writeChannelSwitch, CHANNEL_SWITCH_PATH } = await load('channel.js');
const { AgentConnectionRegistry } = await load('agent-connections.js');
const net = await import('net');

if (!CHANNEL_SWITCH_PATH.startsWith(TMP)) {
  console.error(
    `REFUSING TO RUN: the channel switch resolved to ${CHANNEL_SWITCH_PATH}, which is outside ` +
    `this proof's private HOME (${TMP}). Writing it would take the live fleet off channels.`
  );
  process.exit(1);
}
writeChannelSwitch(true);

/**
 * A herdr that CANNOT be typed at.
 *
 * Every method throws. If any code path under test reaches for the composer the
 * proof dies with a stack trace naming the method, rather than passing while
 * quietly interrupting an imaginary agent. "Nothing was typed" is therefore
 * enforced by the harness and not asserted by this file.
 */
const tripWireHerdr = new Proxy(
  {},
  {
    get: (_t, prop) => () => {
      throw new Error(
        `TRIP-WIRE: the PR watcher reached herdr.${String(prop)}() — a notification tried to ` +
        'type at a terminal. KAN-301 removed that practice and KAN-304 must not restore it.'
      );
    }
  }
);

/** A channel made of the SHIPPED parts, over real Unix sockets. */
const openChannels = [];
async function realChannel(agents) {
  const sockDir = fs.mkdtempSync(path.join(TMP, 'chan-'));
  const sockPath = path.join(sockDir, 'test.sock');
  const registry = new AgentConnectionRegistry();
  const written = [];
  const serverSide = [];

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    serverSide.push(socket);
  });
  await new Promise((res) => server.listen(sockPath, res));

  const clients = [];
  const bound = new Map();
  for (const address of agents) {
    const client = net.createConnection(sockPath);
    client.on('error', () => {});
    await new Promise((res) => client.once('connect', res));
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          written.push({ address: `${address.type}/${address.key}`, ...JSON.parse(line) });
        }
      }
    });
    clients.push(client);
    await new Promise((res) => setTimeout(res, 20));
    const sock = serverSide[serverSide.length - 1];
    registry.register(sock, address);
    bound.set(`${address.type}/${address.key}`, sock);
  }

  const channel = {
    written,
    close: () => {
      for (const c of clients) c.destroy();
      for (const s of serverSide) s.destroy();
      server.close();
    },
    route: (address, content) =>
      routeChannelMessage({
        registry,
        address,
        content,
        meta: { sender: '[butchr daemon]', workspaceType: address.type, workspaceKey: address.key },
        managed: () => true
      })
  };
  openChannels.push(channel);
  return channel;
}

const settle = () => new Promise((res) => setTimeout(res, 60));

let stateFiles = 0;
const nextStateFile = () => path.join(TMP, `pr-watch-${++stateFiles}.json`);

/** The fleet used by §2-6: a task agent and the epic that approves it. */
const OWN = { agentName: 'task-kan-309', type: 'task', key: 'KAN-309' };
const APPROVER = { agentName: 'epic-kan-39', type: 'epic', key: 'KAN-39' };

/** One pull request, with only the fields a case actually varies spelled out. */
const pr = (over = {}) => ({
  repo: 'wroosbit/butchr',
  number: 133,
  title: 'KAN-309: quarantine the io-stall gate',
  url: 'https://github.com/wroosbit/butchr/pull/133',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'butchr/KAN-309',
  headRefOid: 'a'.repeat(40),
  mergedAt: null,
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  checks: 'pending',
  failingChecks: [],
  approval: 'not-recorded',
  commentIds: [],
  ...over
});

/**
 * A watcher wired to the real carrier, a stub GitHub, and a herdr that bites.
 *
 * `reads` is a list of what each successive tick sees, so a case is written as
 * the sequence of worlds the watcher walks through rather than as mutation.
 */
async function harness({ reads, status = 'In Review', agents = [OWN, APPROVER], quiet = true }) {
  const channel = await realChannel(agents.map(({ type, key }) => ({ type, key })));
  const pending = new PendingNotifications({ log: () => {} });
  const logs = [];
  const log = (...a) => {
    logs.push(a.join(' '));
    if (!quiet) console.log('   ', ...a);
  };

  let tickIndex = 0;
  const watcher = new PrWatcher({
    github: {
      listPullRequests: async () => {
        const read = reads[Math.min(tickIndex, reads.length - 1)];
        return read.fail
          ? { ok: false, error: read.fail, backOff: read.backOff ?? false }
          : { ok: true, prs: read.prs };
      }
    },
    herdrBridge: tripWireHerdr,
    liveAgents: () => agents,
    // KAN-367: a status now arrives as an `ObservedState` — the value AND when
    // it was read. Stamped at `now` here, so these sections go on exercising the
    // FRESH branch, which is what they were always about; the stale branch is
    // `verify-pr-watch-notice-tense.mjs`, deliberately not duplicated here.
    issueFacts: (key) =>
      key === 'KAN-309'
        ? { status: { value: status, observedAt: new Date().toISOString() }, parentKey: 'KAN-39', linkedKeys: [] }
        : { status: { value: 'In Progress', observedAt: new Date().toISOString() }, parentKey: null, linkedKeys: [] },
    supervisorFor: () => null,
    repos: () => ['wroosbit/butchr'],
    state: new PrWatchState(nextStateFile(), () => Date.now()),
    deliver: channelNotifier({ route: channel.route, pending }),
    log
  });

  const ticks = [];
  for (let i = 0; i < reads.length; i++) {
    tickIndex = i;
    ticks.push(await watcher.watchOnce());
    await settle();
  }
  return { watcher, ticks, channel, logs };
}

/** The notices one tick sent, as `relation → kinds`. */
const notified = (tick) =>
  tick.notices.map((n) => `${n.type}/${n.key}(${n.relation}) ← ${n.events.map((e) => e.kind).join('+')}`);

// ===========================================================================
// 1. The association rule, against RECORDED GitHub output
// ===========================================================================

rule('AC4 — the association rule, run against real `gh pr list` output, and the unmatched case');

{
  const fixturePath = path.join(scriptDir, 'fixtures', 'gh-pr-list.json');
  const recorded = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const parsed = recorded.map((rowData) => snapshotFrom('wroosbit/butchr', rowData));

  console.log(`\n  ${recorded.length} pull requests, verbatim from GitHub, through the shipped parser:\n`);
  for (const snapshot of parsed) {
    row(
      `  #${snapshot.number} ${snapshot.state.padEnd(6)} ${snapshot.headRefName}`,
      `→ ${issueKeyForBranch(snapshot.headRefName) ?? '*** UNMATCHED ***'} ` +
        `[checks ${snapshot.checks}${snapshot.failingChecks.length ? ': ' + snapshot.failingChecks.join(',') : ''}` +
        `, approval ${snapshot.approval}, ${snapshot.commentIds.length} comment(s)]`
    );
  }

  const allParsed = parsed.every((s) => s && s.number > 0 && s.headRefName);
  const allMatched = parsed.every((s) => issueKeyForBranch(s.headRefName));

  // The two real branches that refute the strict rule this started with. Named
  // individually because they are the whole argument for the suffix clause.
  const suffixed = [
    ['butchr/KAN-306-gate-demo', 'KAN-306'],
    ['butchr/KAN-295-ci-main', 'KAN-295']
  ];
  const suffixesPresent = suffixed.every(([branch]) =>
    parsed.some((s) => s.headRefName === branch)
  );
  const suffixesMatch = suffixed.every(([branch, key]) => issueKeyForBranch(branch) === key);

  // KAN-306's approval status must be READ, never counted as a failing check.
  // The fixture carries all three real states — SUCCESS on #134/#132, FAILURE on
  // #135/#133, and absent on the four pull requests that predate the gate — so
  // this is asserted against GitHub's own output rather than a state invented
  // here. The failure it guards is loud and wrong: fold `approval-recorded` into
  // the ordinary rollup and every unapproved PR announces `checks-failed` the
  // moment CI goes green, while the deadlock this ticket exists for is never
  // announced at all.
  const approvals = parsed.map((s) => `#${s.number}:${s.approval}`);
  const approvalStatesSeen = new Set(parsed.map((s) => s.approval));
  const approvalNeverFailsAChecK = parsed.every(
    (s) => !s.failingChecks.includes('approval-recorded')
  );
  const recordedIsGreen = parsed
    .filter((s) => s.approval === 'recorded')
    .every((s) => s.checks === 'success');

  console.log('');
  row('the approval status read off each real PR', approvals.join('  '));
  row('all three real approval states are in this fixture', approvalStatesSeen.size === 3 ? `yes (${[...approvalStatesSeen].join(', ')})` : `*** only ${[...approvalStatesSeen].join(', ')} ***`);
  row('approval-recorded is never counted as a failing check', approvalNeverFailsAChecK ? 'yes' : '*** NO ***');
  row('an approved PR reads as checks-green', recordedIsGreen ? 'yes' : '*** NO ***');

  console.log('');
  row('every recorded PR parses to a snapshot', allParsed ? 'yes' : '*** NO ***');
  row('every recorded PR associates to a ticket', allMatched ? 'yes' : '*** NO ***');
  row('the two suffixed branches are really in this fixture', suffixesPresent ? 'yes' : '*** NO ***');
  row('…and both associate to the ticket they name', suffixesMatch ? 'yes' : '*** NO ***');

  // Branches that must NOT associate. Invented, and labelled as such: GitHub has
  // not been asked for a PR from a branch nobody has pushed.
  const rejects = ['main', 'fix-the-thing', 'butchr/notaticket', 'feature/KAN-1', 'butchrKAN-1'];
  const rejected = rejects.filter((b) => issueKeyForBranch(b) === null);
  console.log('');
  row(`branches that must NOT associate (${rejects.join(', ')})`, `${rejected.length}/${rejects.length} rejected`);

  // AC4's second half: an unmatched PR is VISIBLE, not silently unwatched.
  const unmatchedPr = pr({ number: 999, headRefName: 'hotfix-by-hand', title: 'a human PR' });
  const { ticks } = await harness({ reads: [{ prs: [pr(), unmatchedPr] }] });
  const tick = ticks[0];

  console.log('');
  row('the unmatched PR appears in the tick', JSON.stringify(tick.unmatched.map((u) => `#${u.number} ${u.headRefName}`)));
  row('…and is NOT counted as watched', tick.watched.includes('wroosbit/butchr#999') ? '*** IT IS ***' : 'correct');

  verdict(
    allParsed && allMatched && suffixesPresent && suffixesMatch &&
      rejected.length === rejects.length &&
      tick.unmatched.length === 1 && tick.unmatched[0].number === 999 &&
      !tick.watched.includes('wroosbit/butchr#999') &&
      approvalStatesSeen.size === 3 && approvalNeverFailsAChecK && recordedIsGreen,
    'the head branch associates a pull request to its ticket, the optional suffix is required by ' +
      'real branches in this repository, nothing else associates, a PR that matches no ticket is ' +
      "reported by number and branch rather than silently unwatched, and KAN-306's approval " +
      'status is read as an approval rather than counted as a broken build.',
    'the association rule mis-associates a real pull request, an unmatched one disappears — ' +
      'which is this ticket failing in its own subject matter — or `approval-recorded` is being ' +
      'reported as a failing check, which would announce every unapproved PR as a broken build.'
  );
}

// ===========================================================================
// 2. A real event over the real carrier
// ===========================================================================

rule('AC1 — a pull-request event reaches a real recipient over the channel, and nothing is typed');

{
  const { ticks, channel } = await harness({
    reads: [
      { prs: [pr({ checks: 'pending' })] },
      { prs: [pr({ checks: 'failure', failingChecks: ['daemon-typecheck'] })] }
    ]
  });

  const frames = channel.written;
  console.log('\n  The frame that came off the far end of the recipient\'s socket:\n');
  console.log(
    JSON.stringify(frames[0] ?? null, null, 2)
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')
  );

  const notices = ticks[1].notices;
  console.log('');
  for (const notice of notices) {
    row(`${notice.type}/${notice.key} (${notice.relation})`, `delivered=${notice.delivered}`);
  }
  row('carrier verdict (the product\'s, not this file\'s)', frames.length ? 'transport=channel' : '*** NOTHING ROUTED ***');
  row('herdr trip-wire fired (a pane was typed at)', 'no — the proof would have thrown');

  verdict(
    frames.length > 0 &&
      notices.length > 0 &&
      notices.every((n) => n.delivered) &&
      frames.every((f) => typeof f.content === 'string' && f.content.includes('#133')),
    `${frames.length} frame(s) were written to live channel connections by the shipped carrier, ` +
      'every notice reports delivered, and no code path reached herdr — the trip-wire would ' +
      'have thrown before any assertion ran.',
    'nothing reached the channel, or a notice was reported delivered without a frame being ' +
      'written — C1 claimed without C1 being true.'
  );
}

// ===========================================================================
// 3. Merged, and the ticket is still In Review
// ===========================================================================

rule('AC2 — a merge that left its ticket in In Review is announced to the party that can act');

{
  const { ticks, channel } = await harness({
    reads: [{ prs: [pr({ number: 130, headRefName: 'butchr/KAN-309' })] }, { prs: [pr({ number: 130, state: 'MERGED', mergedAt: '2026-08-11T21:40:00Z' })] }],
    status: 'In Review'
  });

  const tick = ticks[1];
  console.log('\n  Who was told what:\n');
  for (const line of notified(tick)) row('  ' + line, '');
  const approverFrame = channel.written.find((f) => f.address === 'epic/KAN-39');
  console.log('\n  What the approver reads:\n');
  console.log(`    ${approverFrame?.content ?? '*** NOTHING ***'}`);

  const toApprover = tick.notices.find((n) => n.relation === 'parent');
  const toOwn = tick.notices.find((n) => n.relation === 'own');
  const saysStillInReview = (approverFrame?.content ?? '').includes('still In Review');

  console.log('');
  row('the approver (board parent) was told', toApprover ? 'yes' : '*** NO ***');
  row('…and the notice names the ticket as still In Review', saysStillInReview ? 'yes' : '*** NO ***');
  row('the task agent was NOT told (it pressed the button)', toOwn ? '*** IT WAS ***' : 'correct');

  // The other half of the conjunction: once the ticket IS Done, the clause goes.
  const done = await harness({
    reads: [{ prs: [pr({ number: 130 })] }, { prs: [pr({ number: 130, state: 'MERGED' })] }],
    status: 'Done'
  });
  const doneFrame = done.channel.written.find((f) => f.address === 'epic/KAN-39');
  console.log('\n  The same merge on a ticket that HAS been transitioned:\n');
  console.log(`    ${doneFrame?.content ?? '*** NOTHING ***'}`);
  const doneIsQuietAboutIt = !(doneFrame?.content ?? '').includes('still');

  console.log('');
  row('…and it does not claim the ticket is untransitioned', doneIsQuietAboutIt ? 'yes' : '*** NO ***');

  verdict(
    Boolean(toApprover) && saysStillInReview && !toOwn && Boolean(doneFrame) && doneIsQuietAboutIt,
    'a merge reaches the approver — the agent that sets Done — carrying the fact that makes it ' +
      'actionable, which is that the board still says In Review. The same merge on a ticket ' +
      'already Done carries no such claim, so the sentence tracks the world rather than being ' +
      'boilerplate.',
    'the merge was not announced, was announced to the wrong party, or claimed a ticket was ' +
      'untransitioned without checking — the failure that happened three times on 2026-08-11, ' +
      'or a noisier restatement of it.'
  );
}

// ===========================================================================
// 4. Green, and nobody is merging it
// ===========================================================================

rule('AC3 — green-with-no-approving-review goes to the approver, once, and re-arms on a new head');

{
  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  const { ticks, channel } = await harness({
    reads: [
      { prs: [pr({ checks: 'pending', headRefOid: first })] },
      { prs: [pr({ checks: 'success', headRefOid: first })] },
      { prs: [pr({ checks: 'success', headRefOid: first })] },
      { prs: [pr({ checks: 'pending', headRefOid: second })] },
      { prs: [pr({ checks: 'success', headRefOid: second })] }
    ]
  });

  const kinds = ticks.map((t) => t.events.filter((e) => e.kind === 'green-idle').length);
  console.log('');
  row('tick 1 (checks pending)          green-idle events', kinds[0]);
  row('tick 2 (checks go green)         green-idle events', kinds[1]);
  row('tick 3 (still green, same head)  green-idle events', kinds[2]);
  row('tick 4 (new head, pending again) green-idle events', kinds[3]);
  row('tick 5 (green on the new head)   green-idle events', kinds[4]);

  const announced = ticks[1].notices;
  console.log('\n  Who was told:\n');
  for (const line of notified(ticks[1])) row('  ' + line, '');
  const greenFrame = channel.written.find((f) => f.content.includes('NO approval recorded'));
  console.log('\n  What the approver reads:\n');
  console.log(`    ${greenFrame?.content ?? '*** NOTHING ***'}`);

  const onlyApprover = announced.length === 1 && announced[0].relation === 'parent';
  // The wording must not overclaim: `reviewDecision` cannot see a comment-borne
  // approval, so the notice may not say "nobody approved".
  // The wording must name the MECHANISM that is red — `approval-recorded` — so a
  // reader can check the claim, rather than asserting a state of mind nobody can.
  const honest =
    (greenFrame?.content ?? '').includes('approval-recorded') &&
    !/nobody (has )?approved/i.test(greenFrame?.content ?? '');

  console.log('');
  row('told to the approver and to nobody else', onlyApprover ? 'yes' : '*** NO ***');
  row('the wording names the required status that is red', honest ? 'yes' : '*** NO ***');

  verdict(
    kinds.join(',') === '0,1,0,0,1' && onlyApprover && honest,
    'the deadlock this board hits most is announced exactly once per head, to the approver who ' +
      'is being waited on and to nobody else, and re-arms when a new head invalidates the ' +
      'approval it was waiting for — `main` is strict, so that is not an optimisation.',
    'it announced every tick (the chattiness that trains agents to ignore this channel), or it ' +
      'told the author instead of the approver, or it stayed silent after a rebase, or the ' +
      'wording claims more than `reviewDecision` can support.'
  );
}

// ===========================================================================
// 4b. The approval landing, which is the row nothing told KAN-263 about
// ===========================================================================

rule('AC — an approval arriving is announced to the agent that merges, and not to the approver');

{
  // THIS SECTION EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY BREAKING THE CODE.
  // Deleting the `pr.approval === 'recorded'` half of the approved test left
  // every other section GREEN — so the ticket's third row ("PR approved: KAN-263
  // stopped and waited; nothing told it the approval had landed") was
  // implemented and unproven, which is the state that reads exactly like being
  // covered. It goes red now.
  const head = 'c'.repeat(40);
  const { ticks, channel } = await harness({
    reads: [
      { prs: [pr({ checks: 'success', approval: 'not-recorded', headRefOid: head })] },
      { prs: [pr({ checks: 'success', approval: 'recorded', headRefOid: head })] }
    ]
  });

  const approvedEvents = ticks[1].events.filter((e) => e.kind === 'approved');
  console.log('\n  Who was told:\n');
  for (const line of notified(ticks[1])) row('  ' + line, '');
  const ownFrame = channel.written.find((f) => f.address === 'task/KAN-309' && f.content.includes('approval'));
  console.log('\n  What the agent that presses merge reads:\n');
  console.log(`    ${ownFrame?.content ?? '*** NOTHING ***'}`);

  const toOwn = ticks[1].notices.find((n) => n.relation === 'own');
  const toParent = ticks[1].notices.find((n) => n.relation === 'parent');
  const fromMarker = approvedEvents[0]?.approvalSource === 'marker';
  // The notice must say the approval is pinned to THIS head, because that is the
  // half an agent acts on wrongly: `main` is strict, so a merge that first runs
  // `update-branch` has invalidated the very approval it is acting on.
  const saysHeadPinned = /invalidates it|current head/.test(ownFrame?.content ?? '');

  console.log('');
  row('an `approved` event was recognised', approvedEvents.length === 1 ? 'yes' : `*** ${approvedEvents.length} ***`);
  row('…from KAN-306\'s marker, not from a review verdict', fromMarker ? 'yes' : '*** NO ***');
  row('the agent that merges was told', toOwn ? 'yes' : '*** NO ***');
  row('the approver was NOT told (it approved)', toParent ? '*** IT WAS ***' : 'correct');
  row('the notice says the approval is pinned to this head', saysHeadPinned ? 'yes' : '*** NO ***');

  // And it is told once: a second tick with the approval still recorded is quiet.
  const again = await harness({
    reads: [
      { prs: [pr({ checks: 'success', approval: 'not-recorded', headRefOid: head })] },
      { prs: [pr({ checks: 'success', approval: 'recorded', headRefOid: head })] },
      { prs: [pr({ checks: 'success', approval: 'recorded', headRefOid: head })] }
    ]
  });
  const secondTickQuiet = again.ticks[2].events.filter((e) => e.kind === 'approved').length === 0;
  row('a still-approved pull request is not re-announced', secondTickQuiet ? 'yes' : '*** NO ***');

  verdict(
    approvedEvents.length === 1 && fromMarker && Boolean(toOwn) && !toParent &&
      saysHeadPinned && secondTickQuiet,
    'an approval recorded by KAN-306\'s head-pinned marker reaches the agent that is waiting to ' +
      'merge, once, saying that it is pinned to this head — and does not reach the approver, ' +
      'which is the agent whose own action caused it.',
    'an approval landed and nobody was told — the row that had KAN-263 stopped and waiting — or ' +
      'it was re-announced every minute, or it was announced back to the approver that gave it.'
  );
}

// ===========================================================================
// 5. Told once, and never a broadcast of history
// ===========================================================================

rule('AC — first sight is silent, an unchanged world is silent, and a restart replays nothing');

{
  const stable = [pr({ number: 128, state: 'MERGED', commentIds: ['IC_1', 'IC_2'] }), pr({ number: 133, checks: 'success' })];
  const stateFile = nextStateFile();

  const build = async () => {
    const channel = await realChannel([
      { type: OWN.type, key: OWN.key },
      { type: APPROVER.type, key: APPROVER.key }
    ]);
    const watcher = new PrWatcher({
      github: { listPullRequests: async () => ({ ok: true, prs: stable }) },
      herdrBridge: tripWireHerdr,
      liveAgents: () => [OWN, APPROVER],
      issueFacts: () => ({ status: { value: 'In Review', observedAt: new Date().toISOString() }, parentKey: 'KAN-39', linkedKeys: [] }),
      supervisorFor: () => null,
      repos: () => ['wroosbit/butchr'],
      // The SAME file across both watchers, which is what makes the second one a
      // restart rather than a fresh install.
      state: new PrWatchState(stateFile, () => Date.now()),
      deliver: channelNotifier({
        route: channel.route,
        pending: new PendingNotifications({ log: () => {} })
      }),
      log: () => {}
    });
    return { watcher, channel };
  };

  const a = await build();
  const t1 = await a.watcher.watchOnce();
  const t2 = await a.watcher.watchOnce();
  await settle();

  // A different PrWatcher over the same state file: a daemon restart.
  const b = await build();
  const t3 = await b.watcher.watchOnce();
  await settle();

  console.log('');
  row('tick 1 — first sight of 2 pull requests, events', t1.events.length);
  row('tick 2 — same world, events', t2.events.length);
  row('tick 3 — after a RESTART on the same state file, events', t3.events.length);
  row('frames written to any agent, all three ticks', a.channel.written.length + b.channel.written.length);
  row('pull requests remembered in the state file', a.watcher.watchState().entries().length);

  verdict(
    t1.events.length === 0 &&
      t2.events.length === 0 &&
      t3.events.length === 0 &&
      a.channel.written.length + b.channel.written.length === 0 &&
      a.watcher.watchState().entries().length === 2,
    'a pull request seen for the first time is recorded without notifying anybody, an unchanged ' +
      'world produces nothing, and a restart diffs against the durable memory rather than ' +
      'announcing forty merged pull requests as news.',
    'the watcher broadcast history — every daemon start would announce every pull request in the ' +
      'repository, which is the fastest way to make the fleet ignore this channel entirely.'
  );
}

// ===========================================================================
// 6. Broken is not the same as quiet
// ===========================================================================

rule('AC5 — a watcher that cannot see GitHub says so, and does not report a clean nothing');

{
  // Driven stage by stage rather than through `harness`, because the SUBJECT
  // here is the health report between ticks rather than what any tick sent.
  const staged = await (async () => {
    const out = [];
    const channel = await realChannel([
      { type: OWN.type, key: OWN.key },
      { type: APPROVER.type, key: APPROVER.key }
    ]);
    let stage = 0;
    const reads = [
      { prs: [pr({ checks: 'success' })] },
      { fail: 'HTTP 403: API rate limit exceeded for user ID 1234', backOff: true },
      { fail: 'HTTP 403: API rate limit exceeded for user ID 1234', backOff: true },
      { prs: [pr({ checks: 'success', state: 'MERGED' })] }
    ];
    const w = new PrWatcher({
      github: {
        listPullRequests: async () => {
          const read = reads[stage];
          return read.fail
            ? { ok: false, error: read.fail, backOff: true }
            : { ok: true, prs: read.prs };
        }
      },
      herdrBridge: tripWireHerdr,
      liveAgents: () => [OWN, APPROVER],
      issueFacts: () => ({ status: { value: 'In Review', observedAt: new Date().toISOString() }, parentKey: 'KAN-39', linkedKeys: [] }),
      supervisorFor: () => null,
      repos: () => ['wroosbit/butchr'],
      state: new PrWatchState(nextStateFile(), () => Date.now()),
      deliver: channelNotifier({
        route: channel.route,
        pending: new PendingNotifications({ log: () => {} })
      }),
      log: () => {}
    });
    for (stage = 0; stage < reads.length; stage++) {
      const tick = await w.watchOnce();
      out.push({ tick, health: w.healthReport(), degraded: w.isDegraded() });
      await settle();
    }
    return { out, channel, w };
  })();

  const [healthy, blind1, blind2, recovered] = staged.out;

  console.log('\n  After a successful look:\n');
  console.log(`    ${healthy.health.detail}`);
  console.log('\n  After two failed looks — the sentence AC5 asks for:\n');
  console.log(`    ${blind2.health.detail}`);
  console.log('\n  After GitHub answers again:\n');
  console.log(`    ${recovered.health.detail}`);

  const distinguishable = healthy.health.detail !== blind2.health.detail;
  const namesTheBlindness = /HAVE NOT BEEN ABLE TO LOOK/.test(blind2.health.detail);
  const namesTheError = blind2.health.detail.includes('rate limit');
  const countsFailures = blind2.health.consecutiveFailures === 2;
  // A failed read must not look like an empty repository: nothing may be
  // forgotten, and no event may be manufactured from the absence.
  const memoryIntact = staged.w.watchState().entries().length === 1;
  const noPhantomEvents = blind1.tick.events.length === 0 && blind2.tick.events.length === 0;
  const degradedNotSilent = blind2.degraded === true;
  // The numbers must not decay either. This assertion exists because the first
  // version of `describeHealth` FAILED it: while GitHub was unreachable the
  // population counts fell to the failed tick's zero and the report read "0 pull
  // request(s) matched a ticket", which a reader takes as "there are none". A
  // count that quietly becomes a clean-looking zero when observation stops is
  // the same silence as a reassuring sentence, told in numbers.
  const countsDoNotDecay =
    blind2.health.watchedCount === healthy.health.watchedCount &&
    blind2.health.watchedCount > 0 &&
    /as of the last successful look/i.test(blind2.health.detail);
  // The merge that happened while it was blind is announced on recovery, not lost.
  const recoveredTheNews = recovered.tick.events.some((e) => e.kind === 'merged');

  console.log('');
  row('the two sentences differ at all', distinguishable ? 'yes' : '*** NO ***');
  row('the failing one names the blindness', namesTheBlindness ? 'yes' : '*** NO ***');
  row('…names the error', namesTheError ? 'yes' : '*** NO ***');
  row('…and counts the consecutive failures', countsFailures ? `yes (${blind2.health.consecutiveFailures})` : '*** NO ***');
  row('a failed read forgot nothing', memoryIntact ? 'yes' : '*** NO ***');
  row('a failed read manufactured no events', noPhantomEvents ? 'yes' : '*** NO ***');
  row('it slowed down rather than stopping', degradedNotSilent ? 'yes' : '*** NO ***');
  row('the population counts did not decay to a clean zero', countsDoNotDecay ? `yes (still ${blind2.health.watchedCount}, labelled)` : '*** NO ***');
  row('the merge that happened while blind is announced on recovery', recoveredTheNews ? 'yes' : '*** NO ***');

  verdict(
    distinguishable && namesTheBlindness && namesTheError && countsFailures &&
      memoryIntact && noPhantomEvents && degradedNotSilent && recoveredTheNews &&
      countsDoNotDecay,
    '"nothing has changed" and "we have not been able to look since 11:04" are different ' +
      'sentences with different words, a failed read is never mistaken for an empty repository, ' +
      'the watcher slows rather than stopping, the population counts hold at their last ' +
      'observed values rather than decaying to a reassuring zero, and news that happened during ' +
      'the blindness is announced when sight returns rather than lost.',
    'a broken watcher is indistinguishable from a quiet one — the failure this board has now ' +
      'rediscovered in KAN-256, KAN-270, KAN-274, KAN-295 and KAN-301, committed by the artifact ' +
      'most able to commit it.'
  );
}

// ===========================================================================
// 7. Repository discovery, without a network or a git binary
// ===========================================================================

rule('AC — repositories are discovered from real worktree layouts, and non-GitHub remotes are not');

{
  const urls = [
    ['https://github.com/wroosbit/butchr.git', 'wroosbit/butchr'],
    ['git@github.com:wroosbit/butchr.git', 'wroosbit/butchr'],
    ['ssh://git@github.com/wroosbit/butchr', 'wroosbit/butchr'],
    ['https://github.com/wroosbit/butchr', 'wroosbit/butchr'],
    ['https://gitlab.com/wroosbit/butchr.git', null],
    ['/home/somebody/local-only', null]
  ];
  console.log('');
  for (const [url, want] of urls) {
    const got = repoFromRemoteUrl(url);
    row(`  ${url}`, `→ ${got ?? 'null'}${got === want ? '' : ` *** want ${want} ***`}`);
  }
  const urlsOk = urls.every(([url, want]) => repoFromRemoteUrl(url) === want);

  // Only `origin`, never a sibling remote — a real config with two remotes.
  const config =
    '[core]\n\trepositoryformatversion = 0\n' +
    '[remote "upstream"]\n\turl = https://github.com/someone-else/fork.git\n' +
    '[remote "origin"]\n\turl = https://github.com/wroosbit/butchr.git\n';
  const onlyOrigin = originUrlFromGitConfig(config) === 'https://github.com/wroosbit/butchr.git';
  row('a config with two remotes yields origin, not upstream', onlyOrigin ? 'yes' : '*** NO ***');

  // A real worktree layout on disk: `.git` as a FILE pointing into the clone,
  // which is what every task agent's checkout actually looks like.
  const clone = path.join(TMP, 'code', 'wroosbit', 'butchr');
  fs.mkdirSync(path.join(clone, '.git', 'worktrees', 'kan-304'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.git', 'config'), config);
  fs.writeFileSync(path.join(clone, '.git', 'worktrees', 'kan-304', 'commondir'), '../..\n');
  const worktree = path.join(TMP, 'workspace', 'butchr');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    path.join(worktree, '.git'),
    `gitdir: ${path.join(clone, '.git', 'worktrees', 'kan-304')}\n`
  );

  const followed = repoForCheckout(worktree);
  row('a worktree `.git` file is followed back to the clone', followed === 'wroosbit/butchr' ? 'yes' : `*** ${followed} ***`);

  // A directory that is not a checkout at all must be silent, not an exception.
  const notACheckout = repoForCheckout(path.join(TMP, 'nothing-here'));
  row('a directory that is not a checkout', notACheckout === null ? 'null (no throw)' : `*** ${notACheckout} ***`);

  // The rollup, against the real check entries recorded in the fixture.
  const recorded = JSON.parse(fs.readFileSync(path.join(scriptDir, 'fixtures', 'gh-pr-list.json'), 'utf8'));
  const realRollups = recorded.map((r) => rollupOf(r.statusCheckRollup).checks);
  row('rollups computed from the recorded check runs', JSON.stringify(realRollups));
  const rollupsSane = realRollups.every((r) => ['success', 'failure', 'pending', 'none'].includes(r));
  // A skipped or neutral check is green to a merge button and must be here too.
  const neutralIsGreen =
    rollupOf([{ status: 'COMPLETED', conclusion: 'SKIPPED', name: 'a' }]).checks === 'success' &&
    rollupOf([{ status: 'COMPLETED', conclusion: 'NEUTRAL', name: 'b' }]).checks === 'success';
  const runningIsNotRed = rollupOf([{ status: 'IN_PROGRESS', name: 'c' }]).checks === 'pending';
  row('SKIPPED and NEUTRAL count as green', neutralIsGreen ? 'yes' : '*** NO ***');
  row('a still-running check is pending, never failure', runningIsNotRed ? 'yes' : '*** NO ***');

  verdict(
    urlsOk && onlyOrigin && followed === 'wroosbit/butchr' && notACheckout === null &&
      rollupsSane && neutralIsGreen && runningIsNotRed,
    'the repositories watched are discovered by following a real worktree layout back to its ' +
      'clone, only `origin` and only GitHub, and the check rollup calls a running job pending ' +
      'rather than red — a false "checks failed" is a notification nobody can act on.',
    'discovery follows the wrong remote, throws on a directory that is not a checkout, or the ' +
      'rollup reports a job that has not finished as a failure.'
  );
}

for (const channel of openChannels) channel.close();

rule(`${failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`}`);
console.log(
  failures === 0
    ? '  Pull requests behind Jira tickets are watched, what changes is announced over the\n' +
      '  channel to the relation that can act on it, and a watcher that cannot see GitHub says\n' +
      '  so. Nothing here typed at a terminal: the herdr handed to the watcher throws on every\n' +
      '  method, so a composer reach would have ended this run rather than passed it.\n'
    : '  See the FAILED sections above.\n'
);

process.exit(failures ? 1 : 0);
