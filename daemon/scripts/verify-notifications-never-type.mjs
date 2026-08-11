// KAN-301: the daemon's own news never arrives as a Ctrl+C, and news it could
// not deliver is visible rather than silent.
//
// WHAT FAILURE THIS WOULD CATCH: a daemon-side notification path delivering by
// pane insertion — the defect this ticket exists for, and the one that had been
// live on every poller notification since 2026-08-04. `jira-poll.ts` and
// `SupervisionNotifier` both called `deliverToAgent`, which opens every send
// with `send-keys <pane> C-c`. herdr.ts says what that costs in its own words:
// "One cancels the recipient's turn — its in-flight tool call with it." This
// fleet's daemon.log records 1,212 confirmed such deliveries between 2026-08-04
// and 2026-08-11, plus 221 unconfirmed first attempts that each bought a SECOND
// Ctrl+C, plus 22 notifications that cost two interrupts each and were dropped
// anyway.
//
// The cost is not the lost turn. A cancelled tool call renders to the recipient
// as a REFUSAL, so an agent cannot tell the poller's interrupt from the human
// declining something. `epic/KAN-39` is the worked example, in the first person
// on this ticket: it read poller interrupts as the human stopping it and told
// the human so, and could not afterwards say which had been which. A build with
// this defect passes every test that only asks "did the notification arrive",
// because it does arrive — that is precisely why it survived KAN-274, which
// fixed the same shape one caller along and was read by the fleet, and by the
// human, as having fixed all of it.
//
// It would equally catch the fix's own failure mode, which is the opposite one:
// dropping the interrupt and silently dropping the news with it. Section 3
// asserts that an undeliverable notification is HELD and retried, section 4
// that one held past its window is ABANDONED LOUDLY and stays counted. An
// agent that was never told must be distinguishable from one that was told and
// had nothing to do — `epic/KAN-39` names that as this board's most-repeated
// failure (KAN-274, KAN-256, KAN-270), and a build that merely stopped typing
// would satisfy the ticket's headline while committing it again.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), so, per section:
//
//   SECTION 1 supplies NOTHING. It reads the shipped `daemon/src/*.ts` off the
//   checkout and asserts that the set of composer call sites equals a declared
//   allowlist, and that daemon.ts hands both notification producers the
//   channel-only carrier. It is the only section that can see the WIRING, and
//   the wiring is exactly what sections 2-4 have to supply for themselves. It
//   needs no build, no daemon, no herdr and no PTY, which is why it is the
//   section that runs in CI (`notification-carrier` in ci.yml) — see the note
//   at the end of this header on why that matters more than usual here.
//
//   SECTIONS 2-4 supply the world: the channel route is a function this script
//   writes, so what they establish is that the SHIPPED producers behave
//   correctly given a carrier, never that the real carrier behaves that way.
//   WHO COVERS THAT: `verify-channel-registration-loss.mjs`, which drives the
//   real `routeChannelMessage`, the real `carrierFor` and a real daemon restart,
//   and is the reason this script does not re-derive the carrier decision.
//
//   WHAT NO SECTION HERE COVERS: that a real Jira change reaches a real agent
//   over a real channel. Nothing in this file talks to Jira or to a client.
//   WHO COVERS IT: the live observation pasted into the PR body — a real ticket
//   moved on the real board, and the poller's own log line naming `transport:
//   channel` for a real recipient. That is an observation rather than a script,
//   and it is named here so the reader is not left inferring a coverage that
//   does not exist.
//
// ---------------------------------------------------------------------------
// ON "IS THIS PROOF EVER INVOKED", WHICH IS A FAIR QUESTION TO ASK OF IT
// ---------------------------------------------------------------------------
// KAN-295 found that CI evaluates the assertions of ONE `verify-*` script out
// of 74. Section 1 of this one is the second, and that is a deliberate design
// choice rather than a happy accident: the property KAN-301 most needs to hold
// FOREVER — "no notification path types at a pane" — is a static property of
// the source, so it was written as static analysis specifically in order to be
// cheap enough to require. Sections 2-4 need a built `dist/` and are NOT run by
// CI; they are run by hand, and the PR says so rather than implying otherwise.
//
// Usage:
//   node daemon/scripts/verify-notifications-never-type.mjs [dist]
//   node daemon/scripts/verify-notifications-never-type.mjs --static-only

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');
const args = process.argv.slice(2);
const STATIC_ONLY = args.includes('--static-only');
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

let failures = 0;

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(56)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// ===========================================================================
// 1. The composer allowlist — static, and the section CI runs
// ===========================================================================

rule('AC1 — no code path in daemon/src delivers by pane insertion, except the declared two');

/**
 * The call sites permitted to type into a terminal, each with the reason it is
 * permitted. A site not on this list is a failure; a site ON this list that has
 * disappeared is also a failure, because a stale allowlist is how a guard comes
 * to permit something nobody has looked at in months.
 *
 * `stop-now` and the resume nudge are the whole of it, and they are not two
 * instances of one exception. `stop-now` types because the caller has ASKED to
 * destroy the recipient's turn and that is the only carrier that can. The
 * resume nudge types because its recipient HAS no turn — a restored Claude Code
 * conversation comes back at an empty prompt and waits forever (KAN-21), so a
 * channel frame would go into a context nothing will ever read. One is a
 * deliberate cost; the other is the absence of one, since `waitForAgentReady`
 * has just read the pane and established there is no work to cancel.
 */
const ALLOWED_COMPOSER_SITES = [
  {
    file: 'nudge.ts',
    symbol: 'nudgeResumedAgent',
    why:
      'a restored conversation sits at an empty prompt with no turn boundary, so a channel ' +
      'frame would never be read (KAN-21). waitForAgentReady has just proved the pane is idle, ' +
      'so the Ctrl+C cancels nothing.'
  },
  {
    file: 'nudge.ts',
    symbol: 'deliverToAgent',
    why:
      'the composer delivery primitive itself. Retained for the seven verify scripts that ' +
      'inject it on purpose — the composer is the only carrier whose delivery can be read back ' +
      'off a pane — and called by nothing in daemon/src, which section 1b asserts.'
  },
  {
    file: 'router.ts',
    symbol: 'handleSendToAgent',
    why:
      "butchr_send_to_agent, governed by KAN-274 and explicitly out of KAN-301's scope. It " +
      'refuses a steer to an unregistered agent rather than interrupting it, and reaches the ' +
      'composer only for stop-now and for addresses that never had a channel.'
  }
];

/** Every `.ts` under daemon/src, read once. */
const sources = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(srcDir, f), 'utf8') }));

/**
 * Which function a source offset falls inside.
 *
 * Matches DECLARATIONS only — `function f(`, a class method at method
 * indentation, or `const f = (` — and takes the last one before the offset.
 * The obvious looser version, "the nearest preceding `name(`", is what the
 * first draft of this used and it is wrong in a way that matters: every
 * ordinary call matches it, so a composer reach inside `nudgeResumedAgent` was
 * labelled `log()` because a `log(` happened to sit above it, and the allowlist
 * then reported three undeclared sites and two vanished ones on a build where
 * nothing had moved. Getting a LABEL wrong is how an allowlist gets widened by
 * somebody making a spurious red go away.
 *
 * Still not a parser, and it does not need to be: the verdict turns on whether
 * a hit exists and where, and a mislabelled hit fails loudly rather than
 * silently passing.
 */
/**
 * The indentation allowance differs per kind, and that is the load-bearing
 * part. A method's body declares local helpers with the same `const f = (`
 * shape as a module's top level — `handleSendToAgent` opens with
 * `const fail = (error: string) => …` — so a rule that accepts `const` at any
 * indentation labels every composer reach in that method as `fail()`. Top-level
 * declarations sit at column 0 and class members at column 2; a local sits at 4
 * or more, and excluding those is what makes the label the enclosing function
 * rather than the nearest closure.
 */
const DECLARATION = new RegExp(
  [
    '(?:^|\\n) {0,2}(?:export )?(?:async )?function ([A-Za-z_]\\w*)',
    '(?:^|\\n)  (?:private|public|protected) (?:readonly )?(?:async )?([A-Za-z_]\\w*)\\s*[(<]',
    '(?:^|\\n)(?:export )?const ([A-Za-z_]\\w*)(?:\\s*:[^=\\n]+)?\\s*=\\s*(?:async\\s*)?[({]'
  ].join('|'),
  'g'
);

function enclosingSymbol(text, index) {
  const before = text.slice(0, index);
  let symbol = '(top level)';
  let m;
  DECLARATION.lastIndex = 0;
  while ((m = DECLARATION.exec(before)) !== null) symbol = m[1] ?? m[2] ?? m[3];
  return symbol;
}

/**
 * Every place a source line actually reaches for the composer.
 *
 * `deliverToAgent`'s own `export async function` line is excluded: a
 * declaration is not a call, and counting it would put the primitive's
 * definition on an allowlist of things that type at terminals — which reads as
 * though defining it were the hazard, when the hazard is calling it.
 */
const COMPOSER_CALL = /\.sendToAgent\s*\(|(?<![A-Za-z0-9_.])deliverToAgent\s*\(/g;
const IS_DECLARATION = /(?:function|const|let)\s+$/;

const found = [];
const deliverCalls = [];
/**
 * Every mention of `deliverToAgent` in production code outside nudge.ts, called
 * or merely named.
 *
 * A REFERENCE rather than a call, because the regression this ticket is about
 * does not look like a call. Restoring it is `?? deliverToAgent` — a bare
 * identifier handed to a delivery seam, invoked later through a variable — and
 * `deliverCalls` above, which looks for `deliverToAgent(`, does not see it. That
 * was not a hypothesis: the first red-drive of this script put exactly that line
 * back and section 1 stayed green while 1b went red. One section catching it is
 * enough to fail the run, and relying on that would leave the strongest-sounding
 * assertion in the file quietly unable to see the defect it names.
 */
const deliverRefs = [];
for (const { file, text } of sources) {
  // Comments AND string literals discuss `deliverToAgent` at length by design —
  // the modules explain why they no longer call it, and `message-claims.ts`
  // names it inside the sentence a response carries to an agent. Neither is a
  // reference. Blanked rather than removed, and newlines kept, so every offset
  // and line number still lines up with the real file.
  //
  // Comments are blanked before strings: a comment may contain an apostrophe
  // ("don't"), which would open a bogus string, and the `[^:]` guard on the
  // line-comment pattern already keeps it off `https://`.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/`(?:[^`\\]|\\.)*`/g, blank);

  for (const m of code.matchAll(COMPOSER_CALL)) {
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    if (IS_DECLARATION.test(code.slice(lineStart, m.index))) continue;

    const hit = {
      file,
      symbol: enclosingSymbol(code, m.index),
      line: code.slice(0, m.index).split('\n').length,
      call: m[0].replace(/\s*\($/, '')
    };
    found.push(hit);
    if (hit.call === 'deliverToAgent') deliverCalls.push(hit);
  }

  // nudge.ts defines it and is allowed to name it; nowhere else in production
  // may, in any form.
  if (file === 'nudge.ts') continue;
  for (const m of code.matchAll(/(?<![A-Za-z0-9_.])deliverToAgent(?![A-Za-z0-9_])/g)) {
    deliverRefs.push({
      file,
      symbol: enclosingSymbol(code, m.index),
      line: code.slice(0, m.index).split('\n').length
    });
  }
}

const isAllowed = (hit) =>
  ALLOWED_COMPOSER_SITES.some((site) => site.file === hit.file && site.symbol === hit.symbol);

const unexpected = found.filter((hit) => !isAllowed(hit));
const missing = ALLOWED_COMPOSER_SITES.filter(
  (site) => !found.some((hit) => hit.file === site.file && hit.symbol === site.symbol)
);

console.log('\n  Every composer reach in daemon/src, and whether it is declared:\n');
for (const hit of found) {
  row(
    `  ${hit.file}:${hit.line} ${hit.symbol}() → ${hit.call}`,
    isAllowed(hit) ? 'declared' : '*** UNDECLARED ***'
  );
}
console.log('');
for (const site of ALLOWED_COMPOSER_SITES) {
  console.log(`  ${site.file} · ${site.symbol}\n      ${site.why}`);
}

console.log('');
row('calls to deliverToAgent anywhere in daemon/src', String(deliverCalls.length));
row('mentions of it outside nudge.ts, called or merely named', String(deliverRefs.length));

if (unexpected.length) {
  console.log('\n  UNDECLARED composer call sites — each of these types into a terminal:');
  for (const hit of unexpected) console.log(`    ${hit.file}:${hit.line} in ${hit.symbol}()`);
}
if (missing.length) {
  console.log('\n  DECLARED sites that no longer exist — the allowlist has gone stale:');
  for (const site of missing) console.log(`    ${site.file} · ${site.symbol}`);
}
if (deliverCalls.length) {
  console.log('\n  deliverToAgent is CALLED in production code:');
  for (const hit of deliverCalls) console.log(`    ${hit.file}:${hit.line} in ${hit.symbol}()`);
}
if (deliverRefs.length) {
  console.log('\n  deliverToAgent is NAMED in production code outside nudge.ts:');
  for (const hit of deliverRefs) console.log(`    ${hit.file}:${hit.line} in ${hit.symbol}()`);
  console.log(
    '    Naming it is enough: `?? deliverToAgent` hands the composer to a delivery seam\n' +
    '    without ever writing a call, which is exactly how this defect is restored.'
  );
}

verdict(
  unexpected.length === 0 &&
    missing.length === 0 &&
    deliverCalls.length === 0 &&
    deliverRefs.length === 0,
  `every one of the ${found.length} composer reaches in daemon/src is one of the ${ALLOWED_COMPOSER_SITES.length} ` +
    'declared sites, every declared site still exists, and no production file outside nudge.ts ' +
    'so much as names deliverToAgent.',
  unexpected.length
    ? `${unexpected.length} undeclared composer call site(s) — a daemon path types at a pane.`
    : deliverCalls.length || deliverRefs.length
      ? `deliverToAgent is reachable from production again (${deliverCalls.length} call(s), ` +
        `${deliverRefs.length} mention(s)) — a notification path has regressed to the composer.`
      : 'the allowlist names a call site that no longer exists; it is describing a build that is gone.'
);

// ---------------------------------------------------------------------------

rule('AC1b — the two notification producers reach for the channel, and daemon.ts wires it');

const pollSrc = sources.find((s) => s.file === 'jira-poll.ts').text;
const nudgeSrc = sources.find((s) => s.file === 'nudge.ts').text;
const daemonSrc = sources.find((s) => s.file === 'daemon.ts').text;

const checks = [
  {
    label: 'jira-poll.ts no longer imports deliverToAgent',
    ok: !/import\s*\{[^}]*\bdeliverToAgent\b[^}]*\}\s*from\s*'\.\/nudge\.js'/.test(pollSrc)
  },
  {
    label: "jira-poll.ts's delivery default is refuseWithoutCarrier",
    ok: /this\.opts\.deliver\s*\?\?\s*refuseWithoutCarrier/.test(pollSrc)
  },
  {
    label: "SupervisionNotifier's delivery default is refuseWithoutCarrier",
    ok: /this\.opts\.deliver\s*\?\?\s*refuseWithoutCarrier/.test(nudgeSrc)
  },
  {
    label: 'daemon.ts builds a channelNotifier',
    ok: /channelNotifier\s*\(/.test(daemonSrc)
  },
  {
    label: 'daemon.ts hands it to BOTH producers (deliver: notifyAgent, twice)',
    ok: (daemonSrc.match(/deliver:\s*notifyAgent/g) ?? []).length === 2
  },
  {
    label: 'daemon.ts flushes held notifications on the sweep',
    ok: /pendingNotifications\.flush\s*\(/.test(daemonSrc)
  },
  {
    label: 'daemon.ts exposes the undelivered record to list_agents',
    ok: /pendingNotifications:\s*\(\)\s*=>\s*pendingNotifications\.report\(\)/.test(daemonSrc)
  },
  {
    label: 'notify.ts contains no composer reach at all',
    ok: !/\.sendToAgent\s*\(|deliverToAgent\s*\(/.test(
      sources.find((s) => s.file === 'notify.ts')?.text ?? ''
    )
  }
];

console.log('');
for (const check of checks) row(check.label, check.ok ? 'yes' : '*** NO ***');

verdict(
  checks.every((c) => c.ok),
  'both producers default to a refusal rather than a pane write, and the running daemon wires ' +
    'the channel carrier into both, flushes what it holds, and reports what it could not deliver.',
  'a producer still defaults to the composer, or the daemon does not wire the channel carrier ' +
    'into both — the seam exists and production does not use it, which is the KAN-145 shape.'
);

if (STATIC_ONLY) {
  rule(`STATIC ONLY — ${failures} failure(s)`);
  console.log('  Sections 2-4 skipped: they need a built dist/. This is what CI runs.\n');
  process.exit(failures ? 1 : 0);
}

// ===========================================================================
// The live harness for sections 2-4
// ===========================================================================

const { PendingNotifications, channelNotifier, refuseWithoutCarrier } = await import(
  path.join(path.resolve(distDir), 'notify.js')
);
const { JiraPoller, JiraPollState } = await import(path.join(path.resolve(distDir), 'jira-poll.js'));
const { SupervisionNotifier } = await import(path.join(path.resolve(distDir), 'nudge.js'));
const { snapshotFrom } = await import(path.join(path.resolve(distDir), 'jira.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan301-'));
let stateFiles = 0;
const nextStateFile = () => path.join(TMP, `jira-poll-${++stateFiles}.json`);

/**
 * A herdr that CANNOT be typed at.
 *
 * This is the strongest assertion in the file and it is worth saying why it is
 * shaped as a throw rather than a counter. A spy that records `sendToAgent`
 * calls proves the composer was reached only if somebody remembers to assert on
 * the recording; a bridge that throws proves it at the moment it happens, in
 * whatever section happens to trip it, including sections written later by
 * somebody who has not read this comment.
 *
 * `tailAgent` throws too. `deliverToAgent` reads the pane BEFORE its first send
 * (`readLandedCount`), so a path that regressed to it would otherwise get one
 * free pane read before tripping the wire.
 */
function tripwireHerdr() {
  const tripped = [];
  const trip = (what) => {
    tripped.push(what);
    throw new Error(
      `TRIPWIRE: a daemon notification path called herdrBridge.${what}() — it tried to type at ` +
      'a pane. This is the defect KAN-301 removed.'
    );
  };
  return {
    tripped,
    sendToAgent: async () => trip('sendToAgent'),
    tailAgent: () => trip('tailAgent')
  };
}

/**
 * A channel that can be switched on and off, in the shape `routeChannelMessage`
 * returns. Not the real router — see the header on who covers that — so it is
 * kept to the two fields the notifier reads, and no more, in order not to look
 * like a reimplementation of a decision it is not making.
 */
function fakeChannel() {
  const written = [];
  let up = true;
  return {
    written,
    up: (on) => {
      up = on;
    },
    route: (address, content) => {
      if (!up) {
        return {
          routed: false,
          reason: 'registration-lost',
          detail: `${address.type}/${address.key}: no channel registration (test)`
        };
      }
      written.push({ address: `${address.type}/${address.key}`, content });
      return { routed: true, connectionId: 'conn-test', address };
    }
  };
}

const jiraBody = (key, issue) => ({
  key,
  fields: {
    status: { name: issue.status, statusCategory: { key: 'indeterminate' } },
    updated: issue.updated ?? '2026-08-11T09:00:00.000-0700',
    comment: {
      comments: issue.comments.map((id) => ({
        id: String(id),
        author: { accountId: '712020:shared', displayName: 'Wroos Bit' },
        created: '2026-08-11T09:00:00.000-0700'
      })),
      total: issue.comments.length,
      maxResults: issue.comments.length,
      startAt: 0
    },
    issuelinks: (issue.links ?? []).map((linked) => ({
      id: '1',
      type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
      outwardIssue: { key: linked, fields: { status: { name: 'To Do' } } }
    }))
  }
});

const stubJira = (issues) => ({
  issues,
  pollIssue: async (key) => {
    const issue = issues[key];
    if (!issue) return { ok: false, backOff: false, status: 404, error: 'no such issue' };
    return { ok: true, snapshot: snapshotFrom(key, jiraBody(key, issue)) };
  }
});

// ===========================================================================
// 2. The poller's notifications ride the channel
// ===========================================================================

rule('AC2 — a real ticket change reaches a real recipient over the channel, and nothing is typed');

{
  const herdr = tripwireHerdr();
  const channel = fakeChannel();
  const pending = new PendingNotifications({ log: () => {} });
  const log = [];

  const agents = [
    { agentName: 'butchr-task-kan-301', type: 'task', key: 'KAN-301' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];

  const jira = stubJira({
    'KAN-301': { status: 'In Progress', comments: [11444], links: ['KAN-39'] },
    'KAN-39': { status: 'In Progress', comments: [], links: ['KAN-301'] }
  });

  const poller = new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents,
    supervisorFor: () => null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(nextStateFile()),
    deliver: channelNotifier({ route: channel.route, pending })
  });

  await poller.pollOnce(); // first sight — baseline, announces nothing
  jira.issues['KAN-301'].status = 'In Review';
  const tick = await poller.pollOnce();

  console.log('');
  row('events recognised', String(tick.events.length));
  row('notifications sent', String(tick.nudges.length));
  for (const n of tick.nudges) {
    row(`  → ${n.type}/${n.key} (${n.relation})`, n.delivered ? 'delivered' : `NOT: ${n.error}`);
  }
  row('frames written to the channel', String(channel.written.length));
  row('the frame KAN-39 received', (channel.written[0]?.content ?? '(none)').slice(0, 66) + '…');
  row('herdrBridge calls (any = it typed at a pane)', String(herdr.tripped.length));
  row('notifications held undelivered', String(pending.report().pending.length));

  verdict(
    tick.events.length === 1 &&
      tick.nudges.length === 1 &&
      tick.nudges.every((n) => n.delivered) &&
      channel.written.length === 1 &&
      channel.written[0].address === 'epic/KAN-39' &&
      herdr.tripped.length === 0 &&
      pending.report().pending.length === 0,
    'the status change was delivered to its linked agent as a channel frame; the tripwire herdr ' +
      'was never called, so nothing was typed and no turn was cancelled.',
    'the poller either failed to deliver over the channel or reached for a pane.'
  );
}

// ===========================================================================
// 3. Undeliverable news is held, visible, and delivered when the channel returns
// ===========================================================================

rule('AC4 — with the channel down the news is HELD and VISIBLE, not dropped and not typed');

{
  const herdr = tripwireHerdr();
  const channel = fakeChannel();
  const pending = new PendingNotifications({ log: () => {} });

  const agents = [
    { agentName: 'butchr-task-kan-301', type: 'task', key: 'KAN-301' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];
  const jira = stubJira({
    'KAN-301': { status: 'In Progress', comments: [11444], links: ['KAN-39'] },
    'KAN-39': { status: 'In Progress', comments: [], links: ['KAN-301'] }
  });

  const poller = new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents,
    supervisorFor: () => null,
    log: () => {},
    state: new JiraPollState(nextStateFile()),
    deliver: channelNotifier({ route: channel.route, pending })
  });

  await poller.pollOnce();

  // The registration drops — a daemon restart, a socket error, a client reload.
  channel.up(false);
  jira.issues['KAN-301'].status = 'In Review';
  const downTick = await poller.pollOnce();

  const heldReport = pending.report();
  console.log('');
  row('channel state', 'DOWN (registration-lost)');
  row('notifications the poller attempted', String(downTick.nudges.length));
  row('  …reported as delivered', String(downTick.nudges.filter((n) => n.delivered).length));
  row('herdrBridge calls (any = it fell back to typing)', String(herdr.tripped.length));
  console.log('');
  row('list_agents would show pending for', String(heldReport.pending.length) + ' agent(s)');
  row('  recipient', heldReport.pending[0]?.type + '/' + heldReport.pending[0]?.key);
  row('  notices held', String(heldReport.pending[0]?.count));
  row('  why the channel refused', String(heldReport.pending[0]?.lastReason));
  row('  subject a reader can see', (heldReport.pending[0]?.subjects[0] ?? '').slice(0, 58) + '…');

  // A second event arrives while it is still down. It is a COMMENT, so the
  // poller's recipient set widens: a comment reaches the issue's own agent as
  // well as its linked one, where a status change does not. That is what makes
  // this the right second event to use — coalescing has to hold per recipient,
  // and a case with only one recipient could not tell the difference.
  jira.issues['KAN-301'].comments.push(11500);
  await poller.pollOnce();

  const both = pending.report().pending;
  const forEpic = both.find((p) => p.key === 'KAN-39');
  const forTask = both.find((p) => p.key === 'KAN-301');
  console.log('');
  row('after a second (comment) event — recipients held for', String(both.length));
  row('  epic/KAN-39, told of the status change AND the comment', String(forEpic?.count));
  row('  task/KAN-301, told only of the comment on its own ticket', String(forTask?.count));

  // The agents' MCP servers re-announce. KAN-274 measured this at seconds.
  channel.up(true);
  pending.flush(channel.route);
  const afterFlush = pending.report();

  console.log('');
  row('channel state', 'BACK UP — daemon sweep flushes');
  row('frames written on redelivery', String(channel.written.length));
  row('  …one per recipient, not one per notice', String(channel.written.length === both.length));
  row('  …still held afterwards', String(afterFlush.pending.length));
  row('  …abandoned', String(afterFlush.abandoned.length));
  console.log('');
  console.log("  What epic/KAN-39 — which missed two events — actually reads:\n");
  const epicFrame = channel.written.find((w) => w.address === 'epic/KAN-39')?.content ?? '';
  for (const line of epicFrame.split('\n')) console.log(`      ${line.slice(0, 92)}`);

  verdict(
    downTick.nudges.length === 1 &&
      downTick.nudges.every((n) => !n.delivered) &&
      herdr.tripped.length === 0 &&
      heldReport.pending.length === 1 &&
      heldReport.pending[0].count === 1 &&
      heldReport.pending[0].lastReason === 'registration-lost' &&
      both.length === 2 &&
      forEpic?.count === 2 &&
      forTask?.count === 1 &&
      // Three notices, two recipients, TWO frames — the coalescing claim.
      channel.written.length === 2 &&
      /DELAYED/.test(epicFrame) &&
      /status changed to In Review/.test(epicFrame) &&
      /new comment/.test(epicFrame) &&
      afterFlush.pending.length === 0 &&
      afterFlush.abandoned.length === 0,
    'with no channel the news was held rather than typed, was visible in the report with its ' +
      'recipient, count, reason and subject, and came back as one frame PER RECIPIENT carrying ' +
      "everything that recipient had missed — three notices, two frames — each saying how late it was.",
    'undeliverable news was dropped, typed at a pane, delivered as one frame per notice, or was ' +
      'invisible while it waited.'
  );
}

// ===========================================================================
// 4. News held too long is abandoned LOUDLY and stays counted
// ===========================================================================

rule('AC4b — an agent that was never told is distinguishable from one told and idle');

{
  const channel = fakeChannel();
  const loud = [];
  let clock = 1_000_000;
  const pending = new PendingNotifications({
    log: (...a) => loud.push(a.join(' ')),
    ttlMs: 60_000,
    now: () => clock
  });

  channel.up(false);
  pending.hold({ type: 'task', key: 'KAN-301' }, '[butchr daemon] KAN-301 has a new comment.', 'registration-lost');

  const whileWaiting = pending.report();
  row('immediately after the channel refused it', `pending=${whileWaiting.pending.length} abandoned=${whileWaiting.abandoned.length}`);

  // Time passes and the registration never returns — the agent was stood down.
  clock += 61_000;
  pending.flush(channel.route);
  const gaveUp = pending.report();

  console.log('');
  row('after the TTL, with the channel still down', `pending=${gaveUp.pending.length} abandoned=${gaveUp.abandoned.length}`);
  row('  abandoned for', gaveUp.abandoned[0]?.type + '/' + gaveUp.abandoned[0]?.key);
  row('  count (never reset)', String(gaveUp.abandoned[0]?.count));
  row('  subject nobody was told', (gaveUp.abandoned[0]?.lastSubject ?? '').slice(0, 56));
  console.log('');
  console.log('  The log line a human reads:\n');
  for (const line of loud) console.log(`      ${line.slice(0, 92)}`);
  console.log('');
  console.log('  The sentence list_agents carries:\n');
  console.log(`      ${gaveUp.detail}`);

  // And a later delivery to somebody else does not scrub the record.
  channel.up(true);
  pending.hold({ type: 'epic', key: 'KAN-39' }, '[butchr daemon] KAN-39 has a new comment.', 'no-connection');
  pending.flush(channel.route);
  const afterSuccess = pending.report();
  console.log('');
  row('after a LATER successful delivery to another agent', `pending=${afterSuccess.pending.length} abandoned=${afterSuccess.abandoned.length}`);
  row('  the abandoned count is still', String(afterSuccess.abandoned[0]?.count));

  verdict(
    whileWaiting.pending.length === 1 &&
      gaveUp.pending.length === 0 &&
      gaveUp.abandoned.length === 1 &&
      gaveUp.abandoned[0].count === 1 &&
      /ABANDONED/.test(loud.join('\n')) &&
      /was NOT told/.test(loud.join('\n')) &&
      /ABANDONED/.test(gaveUp.detail) &&
      afterSuccess.abandoned.length === 1 &&
      afterSuccess.abandoned[0].count === 1,
    'giving up is loud in the log, permanent in the report, and survives later successes — so ' +
      'an agent that was never told cannot be read as one that was told and had nothing to do.',
    'abandonment was silent, or the record was scrubbed by a later delivery — which is the ' +
      "board's most-repeated failure committed again in a new costume."
  );
}

// ===========================================================================
// 5. The supervision notifier, same carrier, same guarantees
// ===========================================================================

rule('AC3 — the supervision notifier rides the channel too');

{
  const herdr = tripwireHerdr();
  const channel = fakeChannel();
  const pending = new PendingNotifications({ log: () => {} });

  const notifier = new SupervisionNotifier({
    herdrBridge: herdr,
    supervisorFor: (agentName) =>
      agentName === 'butchr-task-kan-301' ? { type: 'epic', key: 'KAN-39' } : null,
    log: () => {},
    deliver: channelNotifier({ route: channel.route, pending })
  });

  const census = (status) => ({
    agents: [
      { agentName: 'butchr-task-kan-301', type: 'task', key: 'KAN-301', herdrStatus: status },
      { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39', herdrStatus: 'working' }
    ],
    missing: []
  });

  await notifier.onSweep(census('working'));
  const blocked = await notifier.onSweep(census('blocked'));

  console.log('');
  row('transitions recognised', String(blocked.changes.length));
  row('  delivered', String(blocked.delivered));
  row('frames written to the channel', String(channel.written.length));
  row('  addressed to', channel.written[0]?.address ?? '(none)');
  row('herdrBridge calls (any = it typed at a pane)', String(herdr.tripped.length));
  row('the frame epic/KAN-39 received', (channel.written[0]?.content ?? '').slice(0, 62) + '…');

  // And with the channel down it holds rather than interrupting.
  channel.up(false);
  const down = new SupervisionNotifier({
    herdrBridge: herdr,
    supervisorFor: () => ({ type: 'epic', key: 'KAN-39' }),
    log: () => {},
    deliver: channelNotifier({ route: channel.route, pending })
  });
  await down.onSweep(census('working'));
  const downSweep = await down.onSweep(census('blocked'));

  console.log('');
  row('with the channel down — recognised', String(downSweep.changes.length));
  row('  delivered', String(downSweep.delivered));
  row('  skipped, with a reason', String(downSweep.skipped.length));
  row('  held for redelivery', String(pending.report().pending.length));
  row('herdrBridge calls', String(herdr.tripped.length));

  verdict(
    blocked.changes.length === 1 &&
      blocked.delivered === 1 &&
      channel.written.length === 1 &&
      channel.written[0].address === 'epic/KAN-39' &&
      herdr.tripped.length === 0 &&
      downSweep.changes.length === 1 &&
      downSweep.delivered === 0 &&
      downSweep.skipped.length === 1 &&
      pending.report().pending.length === 1,
    'a working → blocked transition reached its supervisor as a channel frame, and with no ' +
      'channel it was held and reported rather than typed at a supervisor mid-tool-call.',
    'the supervision notifier still types at a pane, or drops a transition silently.'
  );
}

// ===========================================================================

rule(`${failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`}`);
console.log(
  failures === 0
    ? '\n  No daemon notification path types at a terminal. Undeliverable news is held,\n' +
      '  retried, and — when it is finally given up on — said so loudly and permanently.\n'
    : '\n  See the FAILED lines above.\n'
);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
