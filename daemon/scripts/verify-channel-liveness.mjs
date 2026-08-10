// The scheduled end-to-end channel probe: every outcome it can reach, the two
// false positives it is built around, and the record a supervisor reads it off —
// driven against the SHIPPED decision procedure on a scripted world.
//
// WHAT FAILURE THIS WOULD CATCH: a probe that reports `echoed` without a model
// having read anything. That is the only way this mechanism can be worse than
// having no mechanism, because it would convert "nobody is watching leg 4" into
// "something is watching leg 4 and it is green" — which is this epic's recurring
// defect wearing KAN-252's clothes. It has exactly two routes in, and each is
// closed by the product rather than by a comment:
//
//   1. **The probe's own carrier writes the token.** A send that fell back to
//      the composer would TYPE the token into the pane the probe then reads, and
//      the run would report leg 5 proved having proved nothing but that the
//      daemon can type. Section 3 asserts the refusal is reported and nothing is
//      retried; `ChannelLivenessWorld` has no composer in it at all, and section
//      3 is what would notice one being added.
//   2. **The client renders the frame onto the terminal.** Whether Claude Code
//      does that is not ours to decide, so the token searched for is never in the
//      message: two halves, never adjacent, and the probe looks for them joined.
//      Section 2 asserts that invariant against the REAL composed string with all
//      whitespace removed — the transformation `paneShowsToken` itself applies —
//      so an edit to the message's prose that put the halves together goes red
//      here rather than producing a fleet-wide false green.
//
// And the third failure, which runs the other way and is the one the ticket is
// most explicit about: **a non-answer reported as a failure.** A model that
// reads the probe and declines is behaving as `docs/channel-briefing.md` asks;
// recording that as a fault would make every cautious agent look like a broken
// client, and — worse — would invite somebody to wire it into the transport
// decision. Sections 1 and 4 hold `no-answer` apart from failure at the outcome,
// at the drought counter and in the sentence a reader gets.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// **It writes the pane text it then asserts on.** A proof that supplies its own
// input has not tested that the input arrives (KAN-145), and that is exactly
// what this does: `readPane` here returns a string this file wrote, so nothing
// below proves that a real model, reading a real channel frame, ever prints
// anything. It proves what happens to the answer once it is on the pane.
//
// WHO COVERS THE OTHER HALF: `daemon/scripts/probe-channel-liveness.mjs`, which
// activates a real agent through the shipped launcher, forces a real run through
// the shipped `channel_liveness` action and reads the outcome off the product's
// own record — and whose output is pasted in the KAN-252 pull request. **Neither
// covers a third thing, and it is the honest edge of the whole ticket:** no
// script and no probe can tell a client that silently declined the channel from
// a fleet of models that declined on the merits. The mechanism's claim is
// narrower than that and is stated in `daemon/src/channel-liveness.ts`'s header.
//
// Section 5 is deliberately built the other way round — a real
// `AgentConnectionRegistry`, a real `ChannelSelfCheckStore`, the real
// `routeChannelMessage` — so the eligibility rule it asserts is enforced by the
// code that enforces it in production rather than by a harness agreeing with it.
//
// ---------------------------------------------------------------------------
// THE FLEET'S CHANNEL SWITCH IS NEVER READ AND NEVER WRITTEN
// ---------------------------------------------------------------------------
// Section 5 needs channel emission ON, and the switch is a file under
// `os.homedir()`. `HOME` is relocated to a scratch directory BEFORE the build is
// imported, and the guard below aborts if `CHANNEL_SWITCH_PATH` does not then
// land inside it. Turning the fleet's switch on would put a blocking dialog in
// front of every activation on this machine; a guard that asserts where the file
// is beats a comment promising it.
//
// Usage: node daemon/scripts/verify-channel-liveness.mjs [--blind]
//
//   --blind   patch a COPY of the build so the probe's message carries the
//             assembled token, and watch this proof go red. A guard nobody has
//             seen fail has not been shown to be a guard.
//
// Run it after `npm run build` in daemon/.

import path from 'path';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const blind = process.argv.includes('--blind');

const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'channel-liveness.js'))) {
  console.error('daemon/dist/channel-liveness.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'butchr-liveness-'));

// BEFORE ANY IMPORT. `ipc.ts` computes BUTCHR_DIR from `os.homedir()` at module
// load, and `os.homedir()` reads $HOME, so this has to happen while the build is
// still unloaded.
const fakeHome = path.join(scratch, 'home');
mkdirSync(path.join(fakeHome, '.local', 'share', 'butchr'), { recursive: true });
process.env.HOME = fakeHome;

// ONLY THE MODULE UNDER TEST IS SWAPPED under --blind, and the rest of the build
// is the real one — `routeChannelMessage` and `AgentConnectionRegistry` stay real
// so section 5 keeps its meaning. A wholesale copy of `dist` into /tmp cannot
// resolve `node_modules` anyway.
let livenessModule = path.join(dist, 'channel-liveness.js');

if (blind) {
  const patchedDir = path.join(scratch, 'dist');
  cpSync(dist, patchedDir, { recursive: true });
  const target = path.join(patchedDir, 'channel-liveness.js');
  livenessModule = target;
  const source = readFileSync(target, 'utf8');
  // THE DEFECT, INTRODUCED DELIBERATELY: a message that helpfully spells out the
  // answer. This is the single most plausible edit somebody would make to this
  // prose — "say what we are looking for so the model gets it right" — and it
  // silently turns the probe into a reader of its own frame on any client that
  // renders one. The `composeProbeMessage` guard is what refuses to send it; this
  // removes the guard's teeth by handing it a message that trips it, so a build
  // whose guard had been deleted would go GREEN here and a build with the guard
  // reports `pane-unreadable` and never sends.
  const patched = source.replace(
    /const stripped = message\.replace\(\/\\s\+\/g, ''\);/,
    "const stripped = '';"
  );
  if (patched === source) {
    console.error('--blind could not find the composeProbeMessage guard to patch; the build has moved.');
    process.exit(2);
  }
  // …and put the assembled token into the message, which is what the guard
  // exists to refuse.
  const withLeak = patched.replace(
    /Token part A is "\$\{token\.first\}"/,
    'Token part A is "${token.first}${token.second}"'
  );
  if (withLeak === patched) {
    console.error('--blind could not find the message body to leak the token into; the build has moved.');
    process.exit(2);
  }
  writeFileSync(target, withLeak);
  console.log('--blind: patched a copy of the build so the probe message contains the assembled token.\n');
}

const u = (f) => `file://${path.join(dist, f)}`;

const {
  DROUGHT_THRESHOLD,
  ChannelLivenessProbe,
  ChannelLivenessRecord,
  canonicalAddress,
  chooseCandidate,
  composeProbeMessage,
  mintProbeToken,
  paneShowsToken,
  runChannelLivenessProbe
} = await import(`file://${livenessModule}`);
const { AgentConnectionRegistry } = await import(u('agent-connections.js'));
const { ChannelSelfCheckStore } = await import(u('channel-selfcheck.js'));
const { CHANNEL_SWITCH_PATH, routeChannelMessage, writeChannelSwitch } = await import(u('channel.js'));

// THE GUARD THE HEADER PROMISES. If a future change to how BUTCHR_DIR is
// resolved stopped honouring $HOME, this script would write the real fleet's
// kill switch.
if (!CHANNEL_SWITCH_PATH.startsWith(scratch)) {
  console.error(
    `ABORTING: the channel switch resolved to ${CHANNEL_SWITCH_PATH}, which is OUTSIDE this\n` +
    `script's scratch directory (${scratch}). Writing it would change the REAL fleet's\n` +
    `channel state. Relocating $HOME no longer isolates BUTCHR_DIR; fix that before this runs.`
  );
  process.exit(2);
}

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => say(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${detail}`);
  return ok;
};

const ADDRESS = { type: 'task', key: 'KAN-252' };
const OTHER = { type: 'story', key: 'KAN-150' };

/**
 * A world for one run, plus a record of what it was asked.
 *
 * Everything defaults to the working case so each scenario below states only its
 * own deviation. `answer` decides what the pane shows AFTER the send: `'echo'`
 * assembles the token, `'silent'` never does, `'frame'` renders the probe
 * message verbatim onto the pane — the client behaviour section 2 is about.
 */
function world({
  emission = true,
  candidates = [
    {
      address: ADDRESS,
      connectionId: 'conn-1',
      clientName: 'claude-code',
      clientVersion: '2.1.226',
      clientVersionVerified: true
    }
  ],
  routed = true,
  routeReason = 'no-connection',
  paneBefore = 'a perfectly ordinary terminal\n$ ',
  paneReadable = true,
  /** `true` = the pane stops being readable the moment the frame goes out. */
  paneDiesAfterSend = false,
  /** `n` = the pane is readable for the first `n` reads after the send, then gone. */
  paneReadsBeforeDeath = null,
  answer = 'echo'
} = {}) {
  const state = { sent: [], panes: [], clock: 1_770_000_000_000, logs: [], slept: 0 };
  let message = null;
  let readsAfterSend = 0;
  const pane = () => {
    if (!paneReadable) return null;
    if (message !== null) readsAfterSend += 1;
    if (paneDiesAfterSend && message !== null) return null;
    // The FLICKER: readable for a while, then gone for the rest of the window.
    // This is what the second live run actually did — 8 of ~48 reads succeeded
    // — and it is the shape that slipped past a "never once readable" guard.
    if (paneReadsBeforeDeath !== null && readsAfterSend > paneReadsBeforeDeath) return null;
    if (message === null) return paneBefore;
    if (answer === 'frame') return `${paneBefore}\n${message}\n`;
    if (answer === 'echo') {
      // What a complying model puts on its terminal: the two halves, assembled.
      const token = state.sent[0].token;
      return `${paneBefore}\n${token.first}${token.second}\n`;
    }
    return `${paneBefore}\nI would rather not, and my brief says that is fine.\n`;
  };
  return {
    state,
    get world() {
      return {
        emissionEnabled: () => emission,
        candidates: () => candidates,
        readPane: () => {
          const text = pane();
          state.panes.push(text);
          return text;
        },
        send: (address, content) => {
          message = content;
          // Recover the token from the message the way nothing in production
          // ever would — this harness has to know what to put on the pane, and
          // reading it back off the real message is the closest it can get to
          // not inventing one.
          const halves = [...content.matchAll(/"([A-Z0-9]+)"/g)].map((m) => m[1]);
          state.sent.push({
            address,
            content,
            token: { first: halves[0], second: halves[1], assembled: `${halves[0]}${halves[1]}` }
          });
          return routed ? { routed: true } : { routed: false, reason: routeReason, detail: 'scripted refusal' };
        },
        now: () => state.clock,
        sleep: async (ms) => {
          state.slept += 1;
          state.clock += ms;
        },
        log: (m) => state.logs.push(m)
      };
    }
  };
}

const run = (opts = {}, options = {}) => {
  const w = world(opts);
  return runChannelLivenessProbe({
    world: w.world,
    options: { answerWindowMs: 60_000, panePollMs: 5_000, ...options }
  }).then((result) => ({ result, w }));
};

// ------------------------------------------- 1. every outcome, and its meaning --

rule('1. Every outcome the scheduled probe can reach');

const scenarios = [
  {
    label: 'the model assembles and prints the token',
    opts: {},
    outcome: 'echoed',
    proved: true,
    version: '2.1.226'
  },
  {
    label: 'the frame is delivered and no token appears',
    opts: { answer: 'silent' },
    outcome: 'no-answer',
    proved: false,
    version: '2.1.226'
  },
  {
    label: 'the gate refuses the frame',
    opts: { routed: false, routeReason: 'selfcheck-failed' },
    outcome: 'not-routed',
    proved: false,
    version: '2.1.226'
  },
  {
    label: 'channel emission is switched off fleet-wide',
    opts: { emission: false },
    outcome: 'channel-disabled',
    proved: false,
    version: null
  },
  {
    label: 'no agent is eligible to be asked',
    opts: { candidates: [] },
    outcome: 'no-candidate',
    proved: false,
    version: null
  },
  {
    label: "the chosen agent's terminal cannot be read",
    opts: { paneReadable: false },
    outcome: 'pane-unreadable',
    proved: false,
    version: '2.1.226'
  },
  {
    // FOUND BY THE FIRST LIVE RUN OF THIS PROBE, not reasoned about in advance.
    // The agent's pane died seconds after the frame went out — KAN-24's herdr
    // spawn flakiness — and the run was on course to record a MODEL non-answer
    // for a terminal that no longer existed. A non-answer manufactured by a
    // broken instrument is the same defect as a pass manufactured by one, and
    // it points the reader at a model rather than at the dead pane.
    label: 'the pane dies after the frame goes out and is never readable again',
    opts: { paneDiesAfterSend: true },
    outcome: 'pane-unreadable',
    proved: false,
    version: '2.1.226'
  },
  {
    // THE SECOND LIVE RUN, and the reason "never once readable" was not enough.
    // The pane flickered: it answered a few reads and was gone for the rest, and
    // the run recorded a MODEL non-answer for an agent that had not been there
    // to answer. A blind spot at the START is survivable — an answer that
    // arrived then is still on the pane when it comes back — and a blind spot at
    // the END is not.
    label: 'the pane is readable for two reads and then gone for the rest of the window',
    opts: { paneReadsBeforeDeath: 2, answer: 'silent' },
    outcome: 'pane-unreadable',
    proved: false,
    version: '2.1.226'
  }
];

for (const s of scenarios) {
  const { result, w } = await run(s.opts);
  check(result.outcome === s.outcome, `${s.label} → ${s.outcome}`,
    result.outcome === s.outcome ? '' : `got '${result.outcome}'`);
  check(result.proved === s.proved, `  …proved=${s.proved}`,
    result.proved === s.proved ? '' : `got ${result.proved}`);
  // THE VERSION PIN SURVIVES EVERY OUTCOME THAT HAD ONE. A `no-answer` on a
  // client nobody has measured is a different investigation from the same
  // non-answer on one that has been, and the field that tells them apart is the
  // one most likely to be dropped on the path that is not the happy one.
  check(result.clientVersion === s.version,
    `  …carrying clientVersion ${s.version === null ? 'null' : s.version}`,
    result.clientVersion === s.version ? '' : `got ${JSON.stringify(result.clientVersion)}`);
  check(typeof result.detail === 'string' && result.detail.length > 40,
    '  …with a sentence a reader can act on', result.detail.slice(0, 110) + '…');
  if (s.outcome === 'pane-unreadable' && !s.opts.paneDiesAfterSend && !s.opts.paneReadsBeforeDeath) {
    check(w.state.sent.length === 0,
      '  …and NOTHING was sent at an agent whose answer could not have been seen',
      `${w.state.sent.length} send(s)`);
  }
  if (s.opts.paneDiesAfterSend || s.opts.paneReadsBeforeDeath) {
    check(/NOT a non-answer and is not counted as one/i.test(result.detail),
      '  …and says in as many words that it is NOT a non-answer — the agent went away',
      result.detail.slice(0, 120) + '…');
  }
}

// And the counting half, which is where the misattribution would actually do
// damage: a dead pane must not push the fleet toward a drought that reads as
// "no channel frame has reached a model".
const paneDeathRecord = new ChannelLivenessRecord(60_000);
const { result: died } = await run({ paneDiesAfterSend: true });
paneDeathRecord.record(died);
paneDeathRecord.record(died);
paneDeathRecord.record(died);
check(paneDeathRecord.state().nonAnswersSinceProof === 0,
  'three runs lost to a dead pane count as zero non-answers',
  `nonAnswers=${paneDeathRecord.state().nonAnswersSinceProof} ` +
  `unrun=${paneDeathRecord.state().unrunSinceProof}`);
check(paneDeathRecord.state().drought === false,
  '  …and therefore cannot raise a drought about a model that was never observed');

// A non-answer must not read as a fault, in the words a supervisor actually
// meets. This is prose and it is asserted anyway: the ticket's AC 2 is about
// what a reader concludes, and the sentence is the whole of what they get.
const { result: silent } = await run({ answer: 'silent' });
check(/NON-ANSWER, NOT A FAILURE/.test(silent.detail),
  'a non-answer says in as many words that it is not a failure', silent.detail.slice(0, 140) + '…');
check(!silent.proved && silent.outcome !== 'not-routed',
  '  …and is held apart from a frame that never arrived');

// -------------------------------- 2. the token cannot arrive without a model --

rule('2. The assembled token is never in the message — the client-renders-it false positive');

const token = mintProbeToken(1_770_000_000_000, 7);
const message = composeProbeMessage(token);

check(message !== null, 'the shipped message passes its own guard', message === null
  ? 'composeProbeMessage refused its own text — the two halves are adjacent in it'
  : `${message.length} chars`);

if (message !== null) {
  check(message.includes(token.first) && message.includes(token.second),
    'both halves are in the message (or no model could assemble anything)');
  check(!message.includes(token.assembled),
    'the ASSEMBLED token is not in the message');
  // The transformation `paneShowsToken` itself applies. Asserting the raw string
  // only would leave a message reading `…part A is "X" part B is "Y"…` passing
  // while a whitespace-stripped pane read of the rendered frame matched.
  check(!message.replace(/\s+/g, '').includes(token.assembled),
    '…and is not in it with every whitespace character removed, which is the ' +
    'transformation paneShowsToken applies');
}

// The behaviour that closes it end to end: a client that renders the whole frame
// onto the terminal must produce a NON-ANSWER, not a pass.
const { result: rendered, w: renderedWorld } = await run({ answer: 'frame' });
check(rendered.outcome === 'no-answer',
  'a client that renders the entire probe frame onto the pane yields a non-answer, not a pass',
  `got '${rendered.outcome}'`);
say(`        (the pane carried the whole message and still did not match: ` +
    `${renderedWorld.state.sent.length} send, ${renderedWorld.state.panes.length} pane reads)`);

check(paneShowsToken(`noise ${token.assembled} noise`, token),
  'paneShowsToken finds the token when it IS assembled on the pane');
check(!paneShowsToken(`${token.first} and separately ${token.second}`, token),
  '…and does not find it when the halves are apart, even after whitespace removal');

// ------------------------------------------- 3. never, ever the composer --

rule('3. A refusal is reported and nothing is retried — the probe types nothing');

const { result: refused, w: refusedWorld } = await run({ routed: false, routeReason: 'no-connection' });
check(refused.outcome === 'not-routed', 'a refused frame is `not-routed`', refused.outcome);
check(refusedWorld.state.sent.length === 1,
  'the probe attempted exactly one delivery and did not try a second carrier',
  `${refusedWorld.state.sent.length} attempt(s)`);
check(/nothing was retried on the composer/i.test(refused.detail),
  '…and says why, because the reason is the point rather than the behaviour being incidental');
// The structural half: the world the probe is given has no composer in it. A
// future edit that added one would have to add it here too, which is the point
// at which somebody reads this section.
const worldKeys = Object.keys(world().world).sort();
check(!worldKeys.some((k) => /compose|type|nudge|sendToAgent|interrupt/i.test(k)),
  'ChannelLivenessWorld exposes no composer-shaped capability at all',
  worldKeys.join(', '));

// ------------------------------------ 4. the record: drought, and what it counts --

rule('4. The record — what counts toward a drought and what deliberately does not');

const record = new ChannelLivenessRecord(60_000);
const resultOf = (outcome, extra = {}) => ({
  outcome,
  proved: outcome === 'echoed',
  address: ADDRESS,
  clientName: 'claude-code',
  clientVersion: '2.1.226',
  clientVersionVerified: true,
  connectionId: 'conn-1',
  startedAt: new Date(1_770_000_000_000).toISOString(),
  elapsedMs: 10,
  waitedMs: 5,
  detail: 'scripted',
  ...extra
});

check(record.state().runs === 0 && record.state().lastProof === null && !record.state().drought,
  'a daemon that has not probed yet concludes nothing');
check(/no scheduled channel liveness probe has run/i.test(record.state().detail),
  '  …and says so rather than reading as a fleet with a healthy channel',
  record.state().detail);

for (let i = 0; i < DROUGHT_THRESHOLD; i += 1) record.record(resultOf('no-answer'));
check(record.state().drought === true,
  `${DROUGHT_THRESHOLD} delivered runs with no echo is a drought`,
  `nonAnswersSinceProof=${record.state().nonAnswersSinceProof}`);
check(/not a verdict/i.test(record.state().detail),
  '  …reported as something to go and look at rather than as a verdict',
  record.state().detail.slice(0, 150) + '…');

const quiet = new ChannelLivenessRecord(60_000);
for (let i = 0; i < DROUGHT_THRESHOLD + 4; i += 1) {
  quiet.record(resultOf(i % 3 === 0 ? 'no-candidate' : i % 3 === 1 ? 'channel-disabled' : 'not-routed'));
}
// THE DEFECT THIS ASSERTS AGAINST: a quiet weekend — nobody connected, the
// switch off — manufacturing an alarm about a channel nobody used. Only a run
// that actually reached a model and got nothing back is evidence about a model.
check(quiet.state().drought === false,
  'runs in which no model was ever asked anything do NOT accumulate a drought',
  `nonAnswers=${quiet.state().nonAnswersSinceProof} unrun=${quiet.state().unrunSinceProof}`);
check(quiet.state().unrunSinceProof === DROUGHT_THRESHOLD + 4,
  '  …and are counted separately, so the reason for the silence is legible');

const recovered = new ChannelLivenessRecord(60_000);
recovered.record(resultOf('no-answer'));
recovered.record(resultOf('no-answer'));
recovered.record(resultOf('echoed'));
check(recovered.state().drought === false && recovered.state().nonAnswersSinceProof === 0,
  'one echo clears the count — the record is about the last proof, not a lifetime tally');
check(recovered.state().lastProof?.clientVersion === '2.1.226',
  '  …and the proof it keeps carries the client version it was taken on',
  JSON.stringify(recovered.state().lastProof?.clientVersion));

// Round-robin: the agent asked last time is the last one asked next time.
const both = [
  { address: ADDRESS, connectionId: 'c1', clientName: null, clientVersion: null, clientVersionVerified: null },
  { address: OTHER, connectionId: 'c2', clientName: null, clientVersion: null, clientVersionVerified: null }
];
const asked = new Map([[canonicalAddress(ADDRESS), 2_000], [canonicalAddress(OTHER), 1_000]]);
check(canonicalAddress(chooseCandidate(both, asked).address) === canonicalAddress(OTHER),
  'the least recently asked agent is chosen, so one agent does not carry the whole cost');
check(canonicalAddress(chooseCandidate(both, new Map()).address) === canonicalAddress(OTHER),
  '  …and with nobody asked yet the choice is deterministic rather than random',
  'story/kan-150 sorts before task/kan-252');

// --------------------------- 5. eligibility, against the real gate and the real map --

rule('5. Who is eligible — asked of the REAL routeChannelMessage and the REAL maps');

writeChannelSwitch(true);
const connections = new AgentConnectionRegistry();
const selfChecks = new ChannelSelfCheckStore();
const sockets = {
  ok: { destroyed: false, write: () => true },
  degraded: { destroyed: false, write: () => true }
};
connections.register(sockets.ok, ADDRESS);
connections.register(sockets.degraded, OTHER);
selfChecks.record(OTHER, {
  outcome: 'no-answer',
  transport: 'composer',
  proved: false,
  clientName: null,
  clientVersion: null,
  clientVersionVerified: null,
  connectionId: 'conn-2',
  elapsedMs: 20_000,
  checkedAt: new Date().toISOString(),
  detail: 'scripted failure'
});

check(connections.addresses().length === 2,
  'both agents are in the identity map',
  connections.addresses().map((a) => `${a.type}/${a.key}`).join(', '));

const eligible = connections.addresses().filter((a) => !selfChecks.degraded(a));
check(eligible.length === 1 && eligible[0].key === ADDRESS.key,
  'the agent degraded to the composer by its startup self-check is not asked',
  eligible.map((a) => `${a.type}/${a.key}`).join(', ') || '(none)');

// And the reason it must not be: the real gate would refuse it anyway. Asserted
// through the shipped function rather than restated, so an eligibility rule that
// drifted from the gate shows up here.
const wouldRoute = routeChannelMessage({
  registry: connections,
  address: OTHER,
  content: 'probe',
  selfCheck: selfChecks
});
check(wouldRoute.routed === false && wouldRoute.reason === 'selfcheck-failed',
  '  …and the real gate refuses that agent for exactly that reason',
  JSON.stringify(wouldRoute.reason));

const wouldRouteOk = routeChannelMessage({
  registry: connections,
  address: ADDRESS,
  content: 'probe',
  selfCheck: selfChecks
});
check(wouldRouteOk.routed === true, '  …and routes the eligible one');

writeChannelSwitch(false);
const switchedOff = routeChannelMessage({
  registry: connections,
  address: ADDRESS,
  content: 'probe',
  selfCheck: selfChecks
});
check(switchedOff.routed === false && switchedOff.reason === 'channel-disabled',
  'with the kill switch off the real gate refuses everybody, probe included');

// ------------------------------------------- 6. the scheduler does not overlap --

rule('6. Two runs never overlap, and a request that arrives mid-run is told so');

let inFlight = 0;
let maxInFlight = 0;
const slowWorld = {
  emissionEnabled: () => true,
  candidates: () => [
    { address: ADDRESS, connectionId: 'c1', clientName: 'claude-code', clientVersion: '2.1.226', clientVersionVerified: true }
  ],
  readPane: () => 'idle',
  send: () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return { routed: true };
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  log: () => {}
};
const probe = new ChannelLivenessProbe({
  world: slowWorld,
  answerWindowMs: 40,
  panePollMs: 5
});
const [a, b] = await Promise.all([
  probe.runOnce().then((r) => { inFlight -= 1; return r; }),
  new Promise((r) => setTimeout(r, 2)).then(() => probe.runOnce())
]);
check(maxInFlight === 1, 'only one run was ever in flight', `max=${maxInFlight}`);
const concurrent = [a, b].find((r) => r.outcome === 'already-running');
check(concurrent !== undefined,
  'the second request is refused as `already-running` rather than run alongside the first');
check(concurrent !== undefined && !/no agent is currently eligible/.test(concurrent.detail),
  '  …and is NOT reported as "nobody was eligible", which is a different answer',
  concurrent?.detail?.slice(0, 120));
check(probe.state().runs === 1,
  '  …and a refused request is not recorded, so polling cannot invent a drought',
  `runs=${probe.state().runs}`);
probe.stop();

// ---------------------------------------------------------------- verdict --

rule('VERDICT');
say(`${failures} failure(s).`);
say('');
if (failures === 0) {
  say('PASS: the scheduled probe reaches every outcome it claims, cannot report a pass without');
  say('      an assembled token that only a model could have produced, never falls back to a');
  say('      carrier that would write that token itself, and reports a non-answer as a');
  say('      non-answer both in its outcome and in the sentence a supervisor reads.');
  say('');
  say('      WHAT THIS DID NOT TEST: every pane above was written by this file. That a real');
  say('      model, reading a real channel frame, prints anything at all is covered by');
  say('      daemon/scripts/probe-channel-liveness.mjs and by nothing here.');
} else {
  say('FAIL: read the sections above — the assertions are the evidence, not this line.');
}
process.exit(failures ? 1 : 0);
