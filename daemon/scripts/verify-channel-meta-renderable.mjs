// KAN-319: a channel frame the recipient's client will silently discard is
// REFUSED rather than written and reported `delivered`.
//
// WHAT FAILURE THIS WOULD CATCH: a channel producer passing a non-string value
// in `meta` — the defect that left this fleet unsupervised for an evening while
// every instrument read green. `docs/channel-delivery.md` records the client
// contract as `params { content: string, meta?: Record<string,string> }`, each
// meta entry becoming an attribute on the recipient's `<channel>` tag. A
// non-string value fails the client's parse and the client discards THE WHOLE
// FRAME in silence — not the offending attribute, the entire message.
//
// Until this ticket `routeChannelMessage` took `meta?: unknown` and passed it
// through, so `guardian.ts`'s `{ guardianPoke: true }` compiled, was written to
// a live connection, and was recorded `delivered: true` — six times, across two
// agents and three connections, none of which reached a model. The daemon's
// record was never lying: C1 (the frame was written) and C2 (the connection was
// live) were both honestly true, and C3 was never observable. The liveness
// probe's `{ livenessProbe: true }` was losing every frame the same way, and
// reporting it as `no-answer` — the state reserved for a model that DECLINED.
//
// This is the shape that keeps recurring on this board: an artifact whose
// sentence claims more than its mechanism covers, degrading toward looking
// finished. A build with this defect passes everything that asks "was it
// delivered", because it was.
//
// CI-RUNNABLE: yes — reads `daemon/src` as text and imports the built daemon
// modules in process, under a private $HOME in os.tmpdir(). No live daemon, no
// herdr, no credential, no peer, no terminal, no network.
//
// WHICH HALF RAN, WHICH MATTERS AFTER A FAILED BUILD (KAN-314). This script is
// one of the blended kind, so read the SECTION verdicts rather than the exit
// code when the build is not green:
//
//   §1  reads `daemon/src/*.ts` AS TEXT          — tests what you wrote
//   §2  §3  §4  import from `daemon/dist`        — tests the last successful build
//
// Pass `--static-only` to run §1 alone, which is the honest thing to do when
// `dist` is stale or the build failed. `node daemon/scripts/verify-channel-meta-renderable.mjs`
// runs everything.
//
// WHAT THIS PROOF DOES NOT COVER, AND WHO COVERS IT. This script SUPPLIES ITS
// OWN FRAMES and asserts on the daemon's decision to write or refuse one. It
// therefore cannot establish C3 — that a real client renders the frame and a
// model reads it — and nothing in this repository can, because no code here runs
// inside the client. That leg was established BY HAND, from the recipient side,
// and pasted into KAN-319's PR: two frames written to one connection (conn-15)
// in the same instant, differing only in one meta value's type, of which the
// all-string frame entered the receiving agent's context and the boolean one did
// not. If you change the client contract, that observation is what has to be
// repeated; this script will not notice.
//
// THE KEY AXIS (KAN-325) — this paragraph said "uncovered, and by nobody" until
// that ticket reproduced it. `docs/channel-delivery.md` recorded that meta KEYS
// must be identifiers and that others are "silently dropped", sourced from the
// channels reference and never reproduced. It reproduces: on claude-code 2.1.228,
// fourteen key shapes fired at one live agent's connection, every frame reported
// `success: true`, and the keys outside /^[A-Za-z_][A-Za-z0-9_]*$/ arrived MINUS
// THAT ATTRIBUTE. The doc's word "identifier" was also wrong in one direction —
// `$` is a legal JS identifier character and is dropped.
//
// SO THE TWO AXES GET OPPOSITE TREATMENT, and that asymmetry is the ticket's
// decision rather than an oversight:
//
//   a bad VALUE  loses the WHOLE FRAME       -> refused before the write  (§3)
//   a bad KEY    loses ONE ATTRIBUTE         -> written, and NAMED        (§4)
//
// Refusing a bad key would trade a measured partial loss for a certain total one.
// The defect was never that keys are dropped — it was that nothing said so.
//
// WHAT COVERS C3 FOR THE KEY AXIS: the same kind of by-hand recipient-side
// observation KAN-319 used, pasted into KAN-325's PR — a live agent quoting the
// `<channel>` tags that reached its own context, hyphenated key absent and the
// identifier control key present in the same frame. This script cannot establish
// that and does not claim to; §1 and §2 assert the daemon's side of it only.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { sweepTree } from './lib/sweep-sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');
const distDir = path.join(repoRoot, 'daemon', 'dist');
const staticOnly = process.argv.includes('--static-only');

let failures = 0;

const rule = (title) => console.log(`\n${'='.repeat(78)}\n  ${title}\n${'='.repeat(78)}`);

const check = (name, passed, onPass, onFail) => {
  if (passed) {
    console.log(`  PASS  ${name}\n        ${onPass}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${onFail}`);
  }
};

// ===========================================================================
rule('SECTION 1 — the sources, read as text (unaffected by a failed build)');
// ===========================================================================

/**
 * Source with its comments removed.
 *
 * Not fastidiousness: this file's own first run FAILED 1a against a correct
 * build, because channel.ts's header quotes the pre-KAN-319 signature
 * (`meta?: unknown`) in prose while explaining why it is gone. A scanner that
 * reads a comment as code is one that reports the defect it is describing —
 * and, in 1c's direction, one that would go green on a commented-out call site
 * while missing a live one. Both directions are wrong; this removes both.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const readSource = (file) => stripComments(fs.readFileSync(path.join(srcDir, file), 'utf8'));

const channelSrc = readSource('channel.ts');
const routerSrc = readSource('router.ts');

check(
  '1a  the carrier types its meta parameter rather than taking `unknown`',
  /meta\?:\s*ChannelMeta/.test(channelSrc) && !/meta\?:\s*unknown/.test(channelSrc),
  'routeChannelMessage declares `meta?: ChannelMeta`, so a producer writing a boolean is a ' +
    'COMPILE ERROR rather than a silently dropped frame. A type cannot be deleted by a later ' +
    'author without the build going red; an assertion can.',
  'routeChannelMessage takes `meta?: unknown` again. That is the pre-KAN-319 state exactly: ' +
    '`{ guardianPoke: true }` compiles, writes, and reports delivered.'
);

check(
  '1b  the router seam is typed too, so a producer cannot slip in one layer up',
  /meta\?:\s*ChannelMeta/.test(routerSrc),
  "MessageRouterOptions.channelRoute declares `meta?: ChannelMeta`. This seam was `unknown` " +
    'until KAN-319, which is how a producer could hand the carrier a value the type below it ' +
    'would have refused.',
  'channelRoute takes an untyped meta again, reopening the hole one layer above the carrier.'
);

// Every `meta: { ... }` literal in the daemon sources, whatever it is passed to.
// Deliberately broader than "the ones reaching routeChannelMessage": a meta
// literal that is not a channel meta today is one call site away from being one,
// and this is cheap.
//
// SWEPT RECURSIVELY SINCE KAN-465, and it was not before. `fs.readdirSync(srcDir)`
// stood here and enumerated 58 files where `daemon/src` holds 62 — the four in
// `integrations/` were outside 1c for as long as that directory has existed, so
// a `meta: { probe: true }` written there would have shipped past this check
// while it printed a plausible number and passed.
const sweep = sweepTree(srcDir, { label: 'daemon/src' });
console.log(`  ${sweep.coverage}\n`);

check(
  '1s  the sweep behind 1c REACHES every source file, not just the top level',
  sweep.reachedEverything,
  `${sweep.detail}. The count above is not checkable by a reader, so the sweep proves its own ` +
    'reach against a second, independently written recursive walk instead of asking to be ' +
    'believed. A flat enumeration is how four files sat outside this check unnoticed.',
  sweep.detail
);

const metaLiterals = sweep.files.flatMap((file) => {
  const text = readSource(file);
  return [...text.matchAll(/meta:\s*\{([^{}]*)\}/gs)].map((m) => ({ file, body: m[1] }));
});

// The trailing `(?:\s+as\s+\w+)?` is not defensive padding — this scanner was
// written without it and the red drive caught it: `guardianPoke: true as any`
// compiles, ships the defect, and slipped straight past. A cast is exactly how
// this mistake will come back, because the type below it now refuses the plain
// form, so the only way to reintroduce the boolean IS to cast.
const nonStringEntries = metaLiterals.flatMap(({ file, body }) =>
  [...body.matchAll(/(\w+)\s*:\s*(true|false|-?\d+(?:\.\d+)?)(\s+as\s+\w+)?\s*(?:,|$)/g)].map(
    (m) => `${file}: ${m[1]}: ${m[2]}${m[3] ?? ''}`
  )
);

check(
  '1c  no meta literal in daemon/src carries a non-string value',
  nonStringEntries.length === 0,
  `${metaLiterals.length} meta literal(s) scanned across daemon/src, every value a string. ` +
    'This is the assertion that would have caught `guardianPoke: true` and ' +
    '`livenessProbe: true` at authoring time.',
  `a non-string meta value is back: ${nonStringEntries.join(', ')}. That frame will be written, ` +
    'reported delivered, and discarded by the client before any model sees it.'
);

check(
  '1d  the guardian poke, specifically, carries a renderable marker',
  /guardianPoke:\s*'true'/.test(readSource('daemon.ts')),
  "daemon.ts sends `guardianPoke: 'true'` — a string. This is the one quote whose absence was " +
    'six undelivered pokes and an unsupervised fleet.',
  'the guardian poke no longer sends a string marker. If it went back to a boolean, every poke ' +
    'is being dropped by the client again while the record reads `delivered`.'
);

// --------------------------------------------------------------- KAN-325 ---
// The KEY axis. Same treatment as 1a–1d one field over: the type is the
// mechanism, and these read the sources so a failed build cannot mask them.

/** The class the client actually renders, measured in KAN-325. Kept in step by 1e. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

check(
  '1e  the pattern this proof asserts against is the one the product ships',
  new RegExp(
    String.raw`CHANNEL_META_KEY_PATTERN\s*=\s*/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$/`
  ).test(channelSrc),
  'channel.ts exports exactly the class KAN-325 measured, and this file tests against its own ' +
    'copy of it. If the product ever narrows or widens the class, this check fails rather than ' +
    'letting the two drift apart silently — which is the KAN-145 shape (one fact, two copies).',
  'CHANNEL_META_KEY_PATTERN in channel.ts is no longer the measured class, so every other key ' +
    'check in this file is asserting against a pattern the product does not use.'
);

check(
  '1f  ChannelMeta closes the KEY axis with a union, not `Record<string, string>`',
  /ChannelMeta\s*=\s*Partial<Record<ChannelMetaKey,\s*string>>/.test(channelSrc),
  '`ChannelMeta = Partial<Record<ChannelMetaKey, string>>`, so an in-process producer writing ' +
    '`poke-number` is a COMPILE ERROR. Verified by mutation: adding `\'poke-number\': \'3\'` to the ' +
    'guardian poke fails the build with TS2353. Note which mechanism caught it — the compiler, ' +
    'not this script.',
  '`ChannelMeta` takes arbitrary string keys again. A producer can now write a key the client ' +
    'will drop, and the frame will arrive without it while every instrument reads delivered.'
);

// The guard ON the guard. A closed union stops arbitrary keys; nothing in the
// type system stops a later author ADDING a bad one to the union, because
// `'poke-number'` is a perfectly good string literal. This is the check that
// does — and it is static, so it holds even when `dist` is stale.
const unionMembers = (() => {
  const m = channelSrc.match(/export type ChannelMetaKey\s*=([^;]*);/);
  return m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
})();
const badMembers = unionMembers.filter((k) => !KEY_PATTERN.test(k));

check(
  '1g  every member of ChannelMetaKey is itself a key the client will render',
  unionMembers.length > 0 && badMembers.length === 0,
  `${unionMembers.length} member(s) — ${unionMembers.join(', ')} — all match ${KEY_PATTERN.source}. ` +
    'The union stops a producer inventing a bad key; THIS stops somebody adding one to the union, ' +
    'which the type system cannot: a bad key is a valid string literal.',
  unionMembers.length === 0
    ? 'ChannelMetaKey could not be parsed out of channel.ts, so this guard is asserting nothing.'
    : `ChannelMetaKey now admits ${badMembers.join(', ')}, which the client drops. Every frame ` +
      'carrying that attribute arrives without it, silently.'
);

// Parallel to 1c, on the other axis: 1c reads the VALUES of every meta literal
// in daemon/src, this reads their KEYS. Broader than "the ones reaching
// routeChannelMessage" for 1c's stated reason, and cheap for the same one.
const badLiteralKeys = metaLiterals.flatMap(({ file, body }) =>
  [...body.matchAll(/(?:^|,)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((key) => !KEY_PATTERN.test(key))
    .map((key) => `${file}: ${key}`)
);

check(
  '1h  no meta literal in daemon/src carries a key the client will drop',
  badLiteralKeys.length === 0,
  `${metaLiterals.length} meta literal(s) scanned across daemon/src, every KEY renderable. ` +
    'Catches a quoted key — `\'poke-number\': \'3\'` — which is how this mistake reaches a meta ' +
    'literal that is not yet typed as ChannelMeta and is one call site away from being one.',
  `a meta key the client drops is present: ${badLiteralKeys.join(', ')}. That attribute will not ` +
    'reach the recipient, and the frame will arrive looking complete.'
);

if (staticOnly) {
  rule(`${failures === 0 ? 'STATIC SECTIONS PASSED' : `${failures} STATIC SECTION(S) FAILED`}`);
  console.log(
    '\n  --static-only: sections 2 and 3 did NOT run. Nothing here is evidence about the\n' +
      '  built daemon — only about the sources as written.\n'
  );
  process.exit(failures ? 1 : 0);
}

// ===========================================================================
rule('SECTION 2 — the validator, in the built daemon');
// ===========================================================================

if (!fs.existsSync(path.join(distDir, 'channel.js'))) {
  console.log(
    '  daemon/dist is missing. Run `npm run build --prefix daemon`, or pass --static-only.'
  );
  process.exit(1);
}

// A private $HOME, set BEFORE the product is imported: BUTCHR_DIR is derived
// from os.homedir() at module load, and `writeChannelSwitch` WRITES it. Without
// this, section 3 would take the live fleet off channels.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan319-'));
process.env.HOME = TMP;

const {
  routeChannelMessage,
  unrenderableMetaEntries,
  undeliverableMetaKeys,
  writeChannelSwitch,
  CHANNEL_SWITCH_PATH
} = await import(path.join(path.resolve(distDir), 'channel.js'));
const { AgentConnectionRegistry } = await import(
  path.join(path.resolve(distDir), 'agent-connections.js')
);

if (!CHANNEL_SWITCH_PATH.startsWith(TMP)) {
  console.error(
    `refusing to run: CHANNEL_SWITCH_PATH is ${CHANNEL_SWITCH_PATH}, which is not inside this ` +
      `proof's private HOME (${TMP}). Writing it would take the live fleet off channels.`
  );
  process.exit(1);
}
writeChannelSwitch(true);

check(
  '2a  a boolean value is named as unrenderable',
  unrenderableMetaEntries({ sender: '[butchr daemon]', guardianPoke: true }).length === 1,
  'the exact meta the guardian sent for six pokes is reported as one unrenderable entry, and ' +
    'the string half of the same object is not flagged.',
  'a boolean meta value is treated as renderable, which is the defect itself.'
);

check(
  '2b  an all-string meta is left alone',
  unrenderableMetaEntries({
    sender: '[butchr daemon]',
    workspaceType: 'epic',
    workspaceKey: 'KAN-203',
    guardianPoke: 'true'
  }).length === 0,
  'the fixed guardian meta passes cleanly — the check refuses what the client drops and ' +
    'nothing else. A validator that flagged good frames would be its own outage.',
  'a legitimate all-string meta is being rejected, which would refuse every channel message.'
);

check(
  '2c  absent meta is renderable, because most frames carry none',
  unrenderableMetaEntries(undefined).length === 0 && unrenderableMetaEntries(null).length === 0,
  '`undefined` and `null` are the ordinary no-meta case and are not refusals.',
  'a frame with no meta at all is being refused, which would stop the whole channel.'
);

// --------------------------------------------------------------- KAN-325 ---

check(
  '2d  the exact key shapes measured against a live client are classified the same way',
  undeliverableMetaKeys({
    // rendered, observed in a recipient's own <channel> tag
    probeShape: 'x', controlKey: 'x', snake_key: 'x', key2: 'x', _leading: 'x', KEY_NAME: 'x'
  }).length === 0 &&
    undeliverableMetaKeys({
      // dropped, observed absent from a recipient's own <channel> tag
      'hyphen-key': 'x', 'dot.key': 'x', '1leading': 'x', 'space key': 'x',
      $dollar: 'x', 'mid$dollar': 'x', 'ns:key': 'x', 'kéy': 'x', '': 'x'
    }).length === 9,
  'all six keys a live claude-code 2.1.228 rendered pass, and all nine it dropped are named. ' +
    'These are not invented cases: each was fired at a real connection and read back out of the ' +
    "recipient's context. `$dollar` is the one worth noting — a legal JS identifier character " +
    'that the client drops anyway, so "must be identifiers" would have been the wrong check.',
  'the classifier disagrees with what the client was measured to do, so it either drops good ' +
    'attributes or stays silent about lost ones.'
);

check(
  '2e  the daemon\'s own five meta keys are all deliverable',
  undeliverableMetaKeys({
    sender: '[butchr daemon]', workspaceType: 'epic', workspaceKey: 'KAN-203',
    guardianPoke: 'true', livenessProbe: 'true'
  }).length === 0,
  'every key the daemon produces today renders. This is the arm that must stay quiet: a warning ' +
    'on ordinary traffic would be noise on every frame the fleet sends, which is how a real ' +
    'warning stops being read.',
  'the daemon is warning about its own routine meta keys, which would bury the case this exists for.'
);

check(
  '2f  a non-object meta is left to the VALUE check rather than reported twice',
  undeliverableMetaKeys(undefined).length === 0 &&
    undeliverableMetaKeys(null).length === 0 &&
    undeliverableMetaKeys('nope').length === 0 &&
    undeliverableMetaKeys([1, 2]).length === 0,
  'no-meta and wrong-shape-meta both score zero here. `unrenderableMetaEntries` already refuses ' +
    'the wrong shape, and two reports of one fault send the reader looking for two faults.',
  'the key check is also reporting the shape fault, duplicating a refusal that already exists.'
);

// ===========================================================================
rule('SECTION 3 — the carrier refuses the write, rather than making it');
// ===========================================================================

/** A socket that records what was written to it, and nothing else. */
const stubSocket = () => ({ destroyed: false, written: [], write(line) { this.written.push(line); } });

const address = { type: 'epic', key: 'KAN-203' };

const control = stubSocket();
const controlRegistry = new AgentConnectionRegistry();
controlRegistry.register(control, address);

const controlOutcome = routeChannelMessage({
  registry: controlRegistry,
  address,
  content: 'a poke',
  meta: { sender: '[butchr daemon]', workspaceKey: 'KAN-203', guardianPoke: 'true' }
});

check(
  '3a  CONTROL — an all-string meta is still written, exactly once',
  controlOutcome.routed === true && control.written.length === 1,
  `routed to ${controlOutcome.connectionId} and one frame written. This is the arm that must ` +
    'keep working: a fix that refused everything would also produce a silent fleet.',
  'a renderable frame was not written. The fix has broken ordinary channel delivery.'
);

const guarded = stubSocket();
const guardedRegistry = new AgentConnectionRegistry();
guardedRegistry.register(guarded, address);

const refused = routeChannelMessage({
  registry: guardedRegistry,
  address,
  content: 'a poke',
  // The literal shape guardian.ts shipped, and the exact frame the daemon
  // reported `delivered: true` for six times.
  meta: { sender: '[butchr daemon]', workspaceKey: 'KAN-203', guardianPoke: true }
});

check(
  '3b  the pre-fix guardian frame is refused',
  refused.routed === false && refused.reason === 'meta-not-renderable',
  `refused as \`${refused.reason}\` — a sender-visible refusal, in the same shape as every ` +
    'other. Before KAN-319 this call returned `routed: true` and the recipient got nothing.',
  `the frame was accepted (routed: ${refused.routed}, reason: ${refused.reason}). It will be ` +
    'reported delivered and silently dropped, which is the whole defect.'
);

check(
  '3c  and NOTHING was written to the connection',
  guarded.written.length === 0,
  'zero bytes on the socket. The refusal fires before the write, so no downstream record can ' +
    'claim C1 or C2 about a frame that could never satisfy C3.',
  `${guarded.written.length} frame(s) were written anyway. A refusal that still writes is a ` +
    'record that still reads delivered.'
);

check(
  '3d  the refusal names the offending key, so a caller can fix it without this file',
  typeof refused.detail === 'string' && refused.detail.includes('guardianPoke'),
  'the detail names `guardianPoke` and says values must be strings. An agent reading a refusal ' +
    'it has never seen before can act on it.',
  'the refusal does not name which entry was wrong, leaving the caller to guess.'
);

// The caller-argument branch must not depend on fleet state — see channel.ts on
// why this check sits ahead of the kill switch.
writeChannelSwitch(false);
const offOutcome = routeChannelMessage({
  registry: guardedRegistry,
  address,
  content: 'a poke',
  meta: { guardianPoke: true }
});
writeChannelSwitch(true);

check(
  '3e  the refusal is total — it does not depend on the kill switch',
  offOutcome.routed === false && offOutcome.reason === 'meta-not-renderable',
  'with channels switched off fleet-wide the answer is still `meta-not-renderable`, because a ' +
    "caller holding meta the client will drop has a bug whether or not channels are on. " +
    'Reporting `channel-disabled` would send it to debug the fleet for a defect in its own call.',
  `with the switch off the answer was \`${offOutcome.reason}\`, so a producer with bad meta ` +
    'learns about it only when channels happen to be enabled.'
);

// ===========================================================================
rule('SECTION 4 — a bad KEY is written and NAMED, not refused (KAN-325)');
// ===========================================================================
//
// The mirror of section 3, and deliberately the opposite verdict. Section 3
// proves a frame the client would discard entirely is never written. This proves
// a frame the client would deliver MINUS ONE ATTRIBUTE still goes — because
// refusing it would turn a measured partial loss into a certain total one — and
// that the caller is told what it lost.

const keyed = stubSocket();
const keyedRegistry = new AgentConnectionRegistry();
keyedRegistry.register(keyed, address);

const warned = routeChannelMessage({
  registry: keyedRegistry,
  address,
  content: 'a notice',
  // `sender` renders; `poke-number` does not. One frame, both keys — which is
  // the shape KAN-325 measured, so the control travels with the variable rather
  // than in a separate run that could differ for another reason.
  meta: { sender: '[butchr daemon]', 'poke-number': '3' }
});

check(
  '4a  the frame IS written — delivery is preserved',
  warned.routed === true && keyed.written.length === 1,
  `routed to ${warned.connectionId} and one frame written. The recipient gets the body and every ` +
    'renderable attribute. Refusing here would have cost them the whole message to save one ' +
    'attribute, on the carrier that now hauls supervision.',
  'a frame with one bad key was refused. That converts a partial loss into a total one, which is ' +
    'strictly worse than the defect.'
);

check(
  '4b  and the offending key is named back to the sender',
  Array.isArray(warned.droppedMetaKeys) &&
    warned.droppedMetaKeys.length === 1 &&
    warned.droppedMetaKeys[0] === 'poke-number',
  `\`droppedMetaKeys: ${JSON.stringify(warned.droppedMetaKeys)}\` rides on a \`routed: true\`. ` +
    'THIS IS THE DEFECT KAN-325 CLOSES: the keys were always dropped, and nothing anywhere said ' +
    'so — no error, no log line, no field in the reply. A producer got an attribute that simply ' +
    'was not there.',
  `the outcome does not name the dropped key (droppedMetaKeys: ${JSON.stringify(warned.droppedMetaKeys)}). ` +
    'The frame is written and the loss is silent again, which is the whole ticket.'
);

check(
  '4c  and the renderable key is NOT named, so the warning means something',
  !warned.droppedMetaKeys?.includes('sender'),
  '`sender` travelled in the same frame and is not reported. A warning that fired on good keys ' +
    'would be ignored within a day.',
  'a renderable key is being reported as dropped, so the warning cannot be trusted.'
);

const clean = stubSocket();
const cleanRegistry = new AgentConnectionRegistry();
cleanRegistry.register(clean, address);
const quiet = routeChannelMessage({
  registry: cleanRegistry,
  address,
  content: 'a notice',
  meta: { sender: '[butchr daemon]', workspaceKey: 'KAN-203' }
});

check(
  '4d  CONTROL — ordinary traffic carries no warning field at all',
  quiet.routed === true && quiet.droppedMetaKeys === undefined,
  'the field is absent rather than an empty array on every normal frame, so a reader testing ' +
    '`if (outcome.droppedMetaKeys)` is testing the thing it means to.',
  'ordinary traffic is carrying a warning field, which makes the field useless as a signal.'
);

// ===========================================================================

rule(`${failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`}`);
console.log(
  failures === 0
    ? '\n  A frame this client would discard is refused before it is written, and the refusal\n' +
      '  says which entry was wrong. Producers cannot express the mistake at all: `ChannelMeta`\n' +
      '  makes it a compile error, and the runtime check exists for `channel_send`, whose meta\n' +
      '  arrives off the wire where no type can reach it.\n\n' +
      '  On the KEY axis the verdict is deliberately the opposite (KAN-325): the frame is\n' +
      '  WRITTEN and the dropped keys are NAMED, because a bad key costs one attribute where a\n' +
      '  bad value costs the whole frame, and refusing would trade the measured partial loss\n' +
      '  for a certain total one.\n\n' +
      '  This proves the daemon refuses to write one kind of frame and reports honestly on the\n' +
      '  other. It does NOT prove a client renders a good one — see the header for what covers\n' +
      '  that and how.\n'
    : '\n  See the FAILED lines above.\n'
);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
