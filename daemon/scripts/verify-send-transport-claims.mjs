// Live proof for KAN-247 (T4 of KAN-150): `butchr_send_to_agent` routes over
// the channel when the daemon has one for that recipient, falls back to the
// composer when it does not, SAYS WHICH IT USED, and never claims more than the
// transport it used can establish.
//
// WHAT FAILURE THIS WOULD CATCH: a response that asserts more than its carrier
// measured — the defect KAN-150 is named for, arriving in its next costume. The
// original was a `success: true` meaning *typed, and Enter attempted*, read by
// every caller as *the recipient got it*. The costume this ticket exists to
// refuse is a `delivered: true` that means *handed to a socket*: a channel
// write resolves the instant the bytes leave the daemon, so a response that
// reported delivery on that basis would be green on every run, for every
// recipient, including one whose model never received a word — and nothing
// anywhere would look different. It would equally catch the transport becoming
// INVISIBLE: a send that routed over a channel while the response still
// described a composer interrupt would have callers reasoning about an
// interrupt that never happened, and callers deciding not to send because they
// believed they would destroy work that was never at risk.
//
// CI-RUNNABLE: no — the switch-off and stop-now legs spawn herdr, and it
// counts their absence as failures rather than skipping them, so it is red in
// CI by its own honest design.
//
// And it catches the loss design §5.1 says we would otherwise take "without
// noticing": a router that always preferred the channel once one existed would
// silently delete the fleet's only stop-now signal. Nothing would fail; agents
// would simply stop being able to stop each other, and the first time anybody
// found out would be the first time it mattered.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), so, section by section:
//
//   SECTION 1 supplies everything and touches no daemon. It calls `sealClaims`
//   directly to show the over-claim check refusing and permitting. It tests the
//   GUARD and says nothing about whether any response is built through it.
//
//   SECTIONS 2-5 supply none of the routing. A real daemon from the build under
//   test, two real `dist/mcp.js` servers launched by the PRODUCTION writers
//   (`coreMcpServerDefinitions` → `withWorkspaceIdentity` →
//   `materializeMcpServers`), identities bound by the servers' own `hello`, and
//   the send made by calling the REAL `send_to_agent` action — the same action
//   `butchr_send_to_agent` reaches through `callDaemonAPI`. The transport
//   decision, the claim block and the frame on the wire are all produced by
//   product code. What this script supplies is the message text and the choice
//   of recipient, which is what any caller supplies.
//
//   WHAT NO SECTION HERE COVERS: whether a MODEL receives the channel frame.
//   The edge of this script is the MCP server's stdout — Claude Code is not run
//   and no model is involved, so nothing here licenses a claim about an agent
//   reading anything. That is the same edge `verify-channel-emission-gate.mjs`
//   stops at, and deliberately: it is the C4 this ticket's own response reports
//   as `null`, so a proof that claimed it would be committing the defect it is
//   measuring.
//   WHO COVERS IT: `probe-addressed-channel-delivery.mjs` (KAN-244), which
//   fires an addressed frame at one of two live channel-enabled Butchr agents
//   and reads both models' answers off their own panes. It covers the frame
//   reaching a model; it predates this ticket and so does NOT cover
//   `butchr_send_to_agent` being what produced the frame. Between the two, the
//   chain is complete and no single script owns it — said here rather than left
//   for a reader to assume.
//
//   AND THE ONE THIS SCRIPT DOES NOT CLOSE: that the composer, when chosen,
//   still KILLS an in-flight tool call. Section 4 proves `stop-now` selects the
//   composer and writes no channel frame; it does not run a Claude Code agent,
//   so it does not watch a call die.
//   WHO COVERS IT: `verify-send-interrupts-inflight-work.mjs` (KAN-156), which
//   puts a real agent inside a real 90-second command and reads the corpse off
//   its pane. Re-run it on this branch; the two together are AC 4, and neither
//   is AC 4 alone.
//
// ---------------------------------------------------------------------------
// !! THE ISOLATION IS PARTIAL, AND THIS IS THE DANGEROUS PART OF THIS FILE !!
// ---------------------------------------------------------------------------
// $HOME gives this run a private daemon: BUTCHR_DIR, the socket and the switch
// file all derive from `os.homedir()`, so the fleet's daemon is untouched.
//
// **`herdr` is NOT isolated by $HOME.** Measured on this machine while writing
// this script: `HOME=/tmp/... herdr agent list` returned the REAL fleet — every
// live agent, by name, including the one running this ticket. herdr reaches a
// running server, and that server is the machine's, not this run's.
//
// So a composer send from an "isolated" daemon reaches a REAL agent's REAL pane
// and opens with a REAL Ctrl+C. Every composer-path section below therefore
// addresses a key chosen to exist nowhere, and `assertNoRealAgent` asserts that
// against herdr's own list before the send rather than trusting the naming
// convention. If that guard cannot run, the section is SKIPPED and counted as
// unrun — never assumed safe. A proof that destroys a colleague's work to
// demonstrate that sends are honest has failed at the thing it is measuring.
//
// (This also corrects the open question in KAN-150 comment 11186 in one
// direction and leaves the other open: a private $HOME gives a private daemon,
// and it does not give a private herdr.)
//
// ---------------------------------------------------------------------------
// SHOWING THE FAILURE — two red runs, because a proof that only passes is not one
// ---------------------------------------------------------------------------
//   node daemon/scripts/verify-send-transport-claims.mjs
//       green: the seal holds and every response is within its transport.
//
//   node daemon/scripts/verify-send-transport-claims.mjs --overclaim
//       The COPIED build's router is patched to assert C3 and C4 on the channel
//       path — the naive implementation this ticket forbids. RED, with 8
//       failures, and every one of them in section 3: the seal throws, so the
//       channel path can no longer answer at all. Section 5 then reads the
//       refusal and confirms it named the transport and the claim.
//       THIS IS "the check that now prevents it".
//
//   node daemon/scripts/verify-send-transport-claims.mjs --overclaim --unseal
//       The same patch, plus the guard removed from `sealClaims`. RED, with 7
//       failures — a DIFFERENT set. The channel send now succeeds, and the
//       response it returns claims the text entered the transcript and the
//       model read it, over a carrier that touched neither.
//       THIS IS "the response asserting more than the transport supports".
//
//   THE EVIDENCE IS THE DIFFERENCE BETWEEN THOSE TWO RED SETS, and it is worth
//   stating because a reader who sees "both are red" has learned nothing. With
//   the guard in, an over-claiming build DELIVERS NOTHING and says why. With the
//   guard out, the same build DELIVERS AND LIES — `success: true`, a frame
//   genuinely on the recipient's wire, and two claims underneath it that no
//   mechanism established. The second is shippable and looks healthy, which is
//   the whole reason the guard is a throw rather than a comment.
//
// Run it after `npm run build` in daemon/.

import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const OVERCLAIM = process.argv.includes('--overclaim');
const UNSEAL = process.argv.includes('--unseal');

// Setup guards. Reasons this script COULD NOT RUN, not verdicts about the
// daemon — which is why they exit before the failure counter exists.
if (!existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}
if (UNSEAL && !OVERCLAIM) {
  console.error('--unseal only means anything with --overclaim: it removes the guard that the');
  console.error('patched call site would otherwise hit. Refusing to run a half-configured red.');
  process.exit(1);
}

function resolveNodeModules() {
  const candidates = [
    path.join(daemonDir, 'node_modules'),
    path.join(process.env.HOME, 'code', 'wroosbit', 'butchr', 'daemon', 'node_modules')
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, '@modelcontextprotocol'))) return dir;
  }
  console.error(
    'No daemon/node_modules with @modelcontextprotocol installed. Run `npm install` in daemon/ ' +
      `(checked: ${candidates.join(', ')}).`
  );
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan247-transport-'));
const installDir = path.join(scratch, 'install', 'daemon');
const distDir = path.join(installDir, 'dist');
mkdirSync(installDir, { recursive: true });
cpSync(path.join(daemonDir, 'dist'), distDir, { recursive: true });
symlinkSync(resolveNodeModules(), path.join(installDir, 'node_modules'));

const spawned = [];
process.on('exit', () => {
  for (const c of spawned) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- verdicts ---------------------------------------------------------------
const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const rule = (t) => { console.log('\n' + '='.repeat(78)); console.log(t); console.log('='.repeat(78)); };
const show = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)}`);

// --- the deliberate breaks, applied to the COPY and asserted -----------------
//
// Asserted rather than assumed, for the reason `verify-channel-emission-gate.mjs
// --misaddress` records: a patch that silently misses produces a healthy run
// that reads as "this proof cannot go red", which is the opposite of what it
// means.
if (OVERCLAIM) {
  const target = path.join(distDir, 'router.js');
  const before = readFileSync(target, 'utf8');
  // The channel path's own observation block. Anchored on both silent claims at
  // once so it can only match the channel branch — the composer branch below it
  // has a different first line (`transportAccepted: result.success === true`).
  const needle = `                transportAccepted: true,
                sessionPresent: true,
                enteredTranscript: 'not-measured',
                modelRead: 'not-measured'`;
  if (!before.includes(needle)) {
    console.error(`--overclaim could not find the channel path's observation block in ${target};`);
    console.error('refusing to continue rather than reporting a red that was never armed.');
    process.exit(1);
  }
  // Exactly once, asserted. `verify-channel-emission-gate.mjs --misaddress`
  // records what an unanchored patch costs: its needle appeared three times,
  // the first hit was the wrong method, and the run went red for a reason its
  // own banner did not describe. A break that damages something other than what
  // it names is a proof lying about its own control.
  if (before.split(needle).length - 1 !== 1) {
    console.error(`--overclaim needle matches ${before.split(needle).length - 1} places in ${target}, not 1.`);
    console.error('Refusing to patch something other than the channel path.');
    process.exit(1);
  }
  const after = before.replace(
    needle,
    `                transportAccepted: true,
                sessionPresent: true,
                enteredTranscript: true,
                modelRead: true`
  );
  writeFileSync(target, after);
  console.log('!! --overclaim: the copied build\'s CHANNEL path now asserts C3 and C4 —');
  console.log('   the naive "delivered: true means handed to a socket" this ticket forbids.\n');
  if (after.includes("enteredTranscript: 'not-measured'") === false && !after.includes('enteredTranscript: true')) {
    console.error('--overclaim patch did not land as intended; refusing to continue.');
    process.exit(1);
  }
}

if (UNSEAL) {
  const target = path.join(distDir, 'message-claims.js');
  const before = readFileSync(target, 'utf8');
  const needle = `        if (typeof value === 'boolean' && !claimable) {
            throw new OverClaimError(transport, claim, value);
        }`;
  if (!before.includes(needle)) {
    console.error(`--unseal could not find the guard in ${target}; refusing to continue.`);
    process.exit(1);
  }
  writeFileSync(target, before.replace(needle, '        // guard removed by --unseal'));
  console.log('!! --unseal: the over-claim guard is GONE from the copied build. Nothing now');
  console.log('   stops the patched call site, so the assertions below are EXPECTED TO FAIL.\n');
}

// ============================================================================
rule('1. the SEAL: what a transport may claim, and what it is refused');
// ============================================================================
// No daemon here. This section is about the guard itself, and it is the only
// section whose input this script supplies — see the header.
const claimsModule = await import(pathToFileURL(path.join(distDir, 'message-claims.js')).href);
const { sealClaims, licenceFor, OverClaimError, isClaimable } = claimsModule;

const bases = {
  transportAccepted: 'b1', sessionPresent: 'b2', enteredTranscript: 'b3', modelRead: 'b4'
};
/** Did this throw an OverClaimError? Any other error is a different bug. */
const refused = (fn) => {
  try { fn(); return { threw: false }; }
  catch (e) { return { threw: e instanceof OverClaimError || e?.name === 'OverClaimError', message: e?.message }; }
};

const c3OnChannel = refused(() =>
  sealClaims('channel', {
    transportAccepted: true, sessionPresent: true, enteredTranscript: true, modelRead: 'not-measured'
  }, bases));
check(
  'the channel may NOT claim C3 (the text entered the transcript)',
  c3OnChannel.threw === true,
  c3OnChannel.message ?? 'it was accepted'
);
const c4OnChannel = refused(() =>
  sealClaims('channel', {
    transportAccepted: true, sessionPresent: true, enteredTranscript: 'not-measured', modelRead: true
  }, bases));
check(
  'the channel may NOT claim C4 (the model read it)',
  c4OnChannel.threw === true,
  c4OnChannel.message ?? 'it was accepted'
);
const c4OnComposer = refused(() =>
  sealClaims('composer', {
    transportAccepted: true, sessionPresent: true, enteredTranscript: true, modelRead: true
  }, bases));
check(
  'the composer may NOT claim C4 either',
  c4OnComposer.threw === true,
  c4OnComposer.message ?? 'it was accepted'
);

// THE OTHER DIRECTION, and it is what separates a guard from a blanket refusal.
// A seal that threw on everything would pass all three checks above and be
// useless: C3 IS observable on the composer (`deliverToAgent` reads the pane),
// so it must be permitted there.
const c3OnComposer = refused(() =>
  sealClaims('composer', {
    transportAccepted: true, sessionPresent: true, enteredTranscript: true, modelRead: 'not-measured'
  }, bases));
check(
  'the composer MAY claim C3 — the guard is per-transport, not a blanket refusal',
  c3OnComposer.threw === false,
  'deliverToAgent reads the pane, so C3 is observable there'
);
check(
  'isClaimable agrees with what the seal enforced',
  isClaimable('composer', 'enteredTranscript') === true &&
    isClaimable('channel', 'enteredTranscript') === false &&
    isClaimable('channel', 'modelRead') === false,
  'one table, and the throw reads from it'
);

// A claim nobody mentioned must not default to silence — see message-claims.ts.
const omitted = (() => {
  try {
    sealClaims('channel', { transportAccepted: true, sessionPresent: true, enteredTranscript: 'not-measured' }, bases);
    return false;
  } catch { return true; }
})();
check('an unmentioned claim is refused rather than defaulted to null', omitted, 'every claim must be named');

// Silence must be distinguishable from a negative, and the two silences from
// each other — the distinction the whole module exists for.
const sealed = sealClaims('channel', {
  transportAccepted: true, sessionPresent: true, enteredTranscript: 'not-measured', modelRead: 'not-measured'
}, bases);
show('a sealed channel block', sealed);
check(
  'a null claim says WHY it is null, and says it is not observable here',
  sealed.enteredTranscript.value === null &&
    sealed.enteredTranscript.why === 'not-observable-on-this-transport',
  `why=${sealed.enteredTranscript.why}`
);
const composerSealed = sealClaims('composer', {
  transportAccepted: true, sessionPresent: true, enteredTranscript: 'not-measured', modelRead: 'not-measured'
}, bases);
check(
  'the SAME claim on the composer is null for a DIFFERENT reason, and says so',
  composerSealed.enteredTranscript.why === 'not-measured-by-this-path',
  `channel=${sealed.enteredTranscript.why} vs composer=${composerSealed.enteredTranscript.why} — ` +
    'one can never be filled in, the other was simply not looked at'
);
check(
  'the licence sentence is derived from the block, not written beside it',
  licenceFor('channel', sealed).includes('the transport accepted the bytes (C1)') &&
    licenceFor('channel', sealed).includes('You may NOT state') &&
    licenceFor('channel', sealed).includes('the model read it (C4)'),
  licenceFor('channel', sealed)
);

// ============================================================================
rule('2. a REAL daemon and two REAL MCP servers');
// ============================================================================
const home = path.join(scratch, 'home');
mkdirSync(home, { recursive: true });
const butchrDir = path.join(home, '.local', 'share', 'butchr');
const socketPath = path.join(butchrDir, 'butchr.sock');

const daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'ignore', 'inherit']
});
spawned.push(daemon);
for (let i = 0; i < 80 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}
console.log(`  daemon up on its own socket: ${socketPath}`);

/** Newline-delimited JSON on the daemon socket — the caller `mcp.ts` is. */
async function rpc(label) {
  const socket = net.connect(socketPath);
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
  socket.on('error', () => {});
  const pending = new Map();
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const r = m.id !== undefined ? pending.get(m.id) : undefined;
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let n = 0;
  const call = (body) => new Promise((resolve) => {
    const id = `${label}-${++n}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ ...body, id }) + '\n');
    setTimeout(() => { if (pending.delete(id)) resolve({ timedOut: true }); }, 30_000);
  });
  return { call, close: () => socket.destroy() };
}

/** An MCP client over stdio, reading the BYTES the server wrote. */
function mcpClient(proc) {
  const frames = [];
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { frames.push(JSON.parse(line)); } catch { frames.push({ unparsed: line }); }
    }
  });
  proc.stderr.on('data', () => {});
  const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
  return {
    frames,
    notifications: (method) => frames.filter((f) => f.method === method),
    async initialize() {
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kan247-verify', version: '0' } }
      });
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const hit = frames.find((f) => f.id === 1);
        if (hit) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); return hit; }
        await sleep(100);
      }
      return null;
    }
  };
}

const diag = await rpc('diag');
const launchers = await import(pathToFileURL(path.join(distDir, 'launchers.js')).href);
const { coreMcpServerDefinitions, withWorkspaceIdentity, materializeMcpServers, CORE_MCP_SERVER } = launchers;
const { CHANNEL_NOTIFICATION_METHOD } = await import(pathToFileURL(path.join(distDir, 'channel.js')).href);

// Keys chosen to exist nowhere. See the header: herdr is NOT isolated by $HOME,
// so a composer send from this daemon reaches a real pane if one answers to the
// name. `assertNoRealAgent` is what makes that a checked fact.
const AGENT_A = { type: 'task', key: 'KAN-9471-CHANNELLED' };
const AGENT_B = { type: 'task', key: 'KAN-9472-BYSTANDER' };
const NO_CHANNEL = { type: 'task', key: 'KAN-9473-NO-CHANNEL-NO-PANE' };

/**
 * That no real herdr agent answers to this address — checked against herdr's
 * own list, not inferred from the key looking made-up.
 *
 * Returns false when herdr cannot be asked at all, and the caller SKIPS rather
 * than proceeding: "I could not check" is not "it is safe", and the cost of
 * getting that backwards is somebody else's tool call.
 */
function assertNoRealAgent({ type, key }) {
  const name = `butchr-${type}-${key.toLowerCase()}`;
  const res = spawnSync('herdr', ['agent', 'list'], { encoding: 'utf8', timeout: 15_000 });
  if (res.error || res.status !== 0) return { checked: false, name, why: res.error?.message ?? `exit ${res.status}` };
  return { checked: true, name, clear: !res.stdout.includes(`"${name}"`) };
}

async function launchAgent(identity) {
  const defs = materializeMcpServers(withWorkspaceIdentity(coreMcpServerDefinitions(), identity));
  const flags = defs[CORE_MCP_SERVER].args.slice(1);
  const proc = spawn(process.execPath, [path.join(distDir, 'mcp.js'), ...flags], {
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  spawned.push(proc);
  const client = mcpClient(proc);
  await client.initialize();
  console.log(`  launched ${identity.type}/${identity.key} with the production flags: ${flags.join(' ')}`);
  return client;
}

const agentA = await launchAgent(AGENT_A);
const agentB = await launchAgent(AGENT_B);

let connected = { agents: [] };
for (let i = 0; i < 60; i++) {
  connected = await diag.call({ action: 'connected_agents' });
  if ((connected.agents ?? []).length >= 2) break;
  await sleep(250);
}
show('connected_agents', connected.agents);
check(
  'both agents bound an identity through their own `hello`',
  (connected.agents ?? []).length === 2,
  `${(connected.agents ?? []).length} identified — the map KAN-243 built, populated by product code`
);

// ============================================================================
rule('3. AC 1 — a real send to a CHANNEL-CONNECTED agent');
// ============================================================================
const onState = await diag.call({ action: 'channel_switch', enabled: true });
check('channel emission switched on for this run', onState.enabled === true, 'runtime, nothing restarted');

const MSG_A = 'KAN247-CHANNEL-ROUTED-MESSAGE';
const sendA = await diag.call({
  action: 'send_to_agent',
  key: AGENT_A.key, type: AGENT_A.type, message: MSG_A,
  // The sender identity `mcp.ts` stamps on every request off its own argv.
  workspaceType: 'story', workspaceKey: 'KAN-150'
});
console.log('\n  THE RESPONSE, verbatim:');
console.log(JSON.stringify(sendA, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));

check('the response NAMES its transport', sendA.transport === 'channel', `transport=${sendA.transport}`);
check(
  'and says WHY that transport was chosen, in terms only the daemon knows',
  typeof sendA.transportChosenBecause === 'string' &&
    sendA.transportChosenBecause.includes(`${AGENT_A.type}/${AGENT_A.key}`),
  sendA.transportChosenBecause
);
// KAN-527. The needle was `sendA.connectionId ?? '<a raw NUL byte>'`, and the
// sentinel is what that ticket is about: it made this whole file `data` to
// `file(1)`, so no text tool would print a line of 800 lines of proof without
// `-a` — AND it was one normalisation away from `?? ''`, which would have made
// this assertion unfalsifiable, because `''` is a substring of every string in
// existence.
//
// KAN-515's shape rather than an escaped byte: require the operand instead of
// defaulting it, so THERE IS NO SENTINEL LEFT TO STRIP. Behaviour is unchanged
// on both arms — a missing `connectionId` failed the old form too, since a basis
// string does not contain a NUL — and the detail now says which half went.
check(
  'C1 (bytes accepted) is asserted, and its basis names the connection',
  sendA.claims?.transportAccepted?.value === true &&
    typeof sendA.connectionId === 'string' &&
    sendA.connectionId.length > 0 &&
    String(sendA.claims.transportAccepted.basis).includes(sendA.connectionId),
  `connectionId=${JSON.stringify(sendA.connectionId)} basis=${sendA.claims?.transportAccepted?.basis}`
);
check(
  'C2 (a live session exists) is asserted off the identity map',
  sendA.claims?.sessionPresent?.value === true,
  sendA.claims?.sessionPresent?.basis
);
// THE TWO THAT MATTER. This is the whole ticket: a carrier that cannot see a
// transcript must not report one, and `delivered: true` meaning `handed to a
// socket` is the thing being refused.
check(
  'C3 (entered the transcript) is NULL — a channel never touches a pane',
  sendA.claims?.enteredTranscript?.value === null &&
    sendA.claims.enteredTranscript.why === 'not-observable-on-this-transport',
  `value=${sendA.claims?.enteredTranscript?.value} why=${sendA.claims?.enteredTranscript?.why}`
);
check(
  'C4 (the model read it) is NULL — no ack exists to establish it',
  sendA.claims?.modelRead?.value === null &&
    sendA.claims.modelRead.why === 'not-observable-on-this-transport',
  `value=${sendA.claims?.modelRead?.value} why=${sendA.claims?.modelRead?.why}`
);
check(
  'the response does not report the recipient as interrupted',
  sendA.interrupted === false,
  'a channel event waits for the turn boundary (design §4) — nothing was cancelled'
);
check(
  'the licence sentence refuses the two claims the block left null',
  typeof sendA.licenses === 'string' &&
    sendA.licenses.includes('You may NOT state') &&
    sendA.licenses.includes('(C3)') && sendA.licenses.includes('(C4)'),
  sendA.licenses
);

// AND IT ACTUALLY WENT SOMEWHERE — off the wire, not off the response. A
// response describing a channel send is not a channel send.
await sleep(2000);
const onA = agentA.notifications(CHANNEL_NOTIFICATION_METHOD).filter((f) => String(f.params?.content ?? '').includes(MSG_A));
const onB = agentB.notifications(CHANNEL_NOTIFICATION_METHOD).filter((f) => String(f.params?.content ?? '').includes(MSG_A));
show("agent A's wire", onA);
check('the frame reached the intended recipient\'s own MCP server', onA.length === 1, `${onA.length} frame(s)`);
check(
  'and NOT the other agent connected at the same moment',
  onB.length === 0,
  `${onB.length} frame(s) on B's wire — this is what separates routing from broadcast`
);
// KAN-149 coexists with the channel (design §3): the daemon's sender tag is
// inside the payload on this carrier too, so provenance did not fall off the
// new transport.
check(
  "the daemon's sender tag rode inside the channel payload",
  String(onA[0]?.params?.content ?? '').includes('[from story/KAN-150]'),
  String(onA[0]?.params?.content ?? '').slice(0, 90)
);

// ============================================================================
rule('4. AC 2 — a real send to an agent with NO channel falls back, and says so');
// ============================================================================
// TWO WAYS TO HAVE NO CHANNEL, and both must fall back rather than fail: an
// agent that holds no connection, and a fleet whose switch is off. The second
// is the state design §5.4 step 1 says this feature ships in, so it is the one
// every agent will actually meet first.
const safety = assertNoRealAgent(NO_CHANNEL);
show('herdr safety check on the composer target', safety);

if (!safety.checked) {
  console.log('  SKIPPED: herdr could not be asked whether a real agent answers to');
  console.log(`  ${safety.name} (${safety.why}). Not assumed safe — see the header.`);
  failures.push('AC2 could not run: herdr unavailable for the safety check');
} else if (!safety.clear) {
  console.log(`  SKIPPED: a REAL agent named ${safety.name} exists on this machine.`);
  console.log('  Sending would Ctrl+C somebody\'s live work. Rename the constant and re-run.');
  failures.push('AC2 could not run: the composer target names a real agent');
} else {
  const sendNo = await diag.call({
    action: 'send_to_agent',
    key: NO_CHANNEL.key, type: NO_CHANNEL.type, message: 'KAN247-COMPOSER-FALLBACK',
    workspaceType: 'story', workspaceKey: 'KAN-150'
  });
  console.log('\n  THE RESPONSE, verbatim:');
  console.log(JSON.stringify(sendNo, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));

  check('it fell back to the composer', sendNo.transport === 'composer', `transport=${sendNo.transport}`);
  check(
    'and SAYS SO — the reason names the missing connection rather than a generic fallback',
    typeof sendNo.transportChosenBecause === 'string' &&
      sendNo.transportChosenBecause.includes('no live channel connection'),
    sendNo.transportChosenBecause
  );
  // This recipient has no pane either, so herdr honestly refuses. That makes
  // C1 and C2 measured FALSE — which is the third value the block exists to
  // carry, and it must not read the same as the nulls above it.
  check(
    'C1/C2 are FALSE here — measured, not silent',
    sendNo.claims?.transportAccepted?.value === false && sendNo.claims?.sessionPresent?.value === false,
    `${sendNo.claims?.sessionPresent?.basis}`
  );
  check(
    'C3 is null for the COMPOSER reason — observable there, simply not looked at',
    sendNo.claims?.enteredTranscript?.value === null &&
      sendNo.claims.enteredTranscript.why === 'not-measured-by-this-path',
    sendNo.claims?.enteredTranscript?.basis
  );
}

// The switch off: a connected agent, and still the composer.
await diag.call({ action: 'channel_switch', enabled: false });
const safetyA = assertNoRealAgent(AGENT_A);
if (!safetyA.checked || !safetyA.clear) {
  console.log(`  SKIPPED the switch-off leg: ${safetyA.checked ? 'a real agent holds that name' : safetyA.why}`);
  failures.push('AC2 switch-off leg could not run safely');
} else {
  const framesBefore = agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length;
  const sendOff = await diag.call({
    action: 'send_to_agent',
    key: AGENT_A.key, type: AGENT_A.type, message: 'KAN247-WHILE-SWITCH-OFF',
    workspaceType: 'story', workspaceKey: 'KAN-150'
  });
  show('switch off, agent still connected → transport', sendOff.transport);
  show('  reason', sendOff.transportChosenBecause);
  check(
    'a connected agent gets the COMPOSER when the fleet switch is off',
    sendOff.transport === 'composer' &&
      String(sendOff.transportChosenBecause).includes('switched off'),
    'the kill switch governs routing, not just the raw channel_send action'
  );
  await sleep(1500);
  check(
    'and no channel frame left its server while off',
    agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length === framesBefore,
    `${agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length - framesBefore} new frame(s)`
  );
}

// ============================================================================
rule('5. AC 4 — the stop-now path survives, and AC 3 — the over-claim check');
// ============================================================================
await diag.call({ action: 'channel_switch', enabled: true });

// STOP-NOW. Design §5.1 case 5: a channel event waits for the turn boundary, so
// it CANNOT stop an agent now. If routing always preferred the channel, this
// capability would be gone with nothing to show for its absence.
const safetyStop = assertNoRealAgent(AGENT_A);
if (!safetyStop.checked || !safetyStop.clear) {
  console.log(`  SKIPPED the stop-now leg: ${safetyStop.checked ? 'a real agent holds that name' : safetyStop.why}`);
  failures.push('AC4 routing leg could not run safely');
} else {
  const framesBefore = agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length;
  const stop = await diag.call({
    action: 'send_to_agent',
    key: AGENT_A.key, type: AGENT_A.type, message: 'KAN247-STOP-NOW',
    intent: 'stop-now',
    workspaceType: 'story', workspaceKey: 'KAN-150'
  });
  show('stop-now, to a CHANNEL-CONNECTED agent, with the switch ON → transport', stop.transport);
  show('  reason', stop.transportChosenBecause);
  check(
    'stop-now takes the composer even though a channel route exists',
    stop.transport === 'composer',
    'the interrupt is the only carrier that can stop an agent now (design §4, §5.1 case 5)'
  );
  check(
    'the reason says that is why, rather than reporting a missing channel',
    String(stop.transportChosenBecause).includes('stop the recipient now'),
    stop.transportChosenBecause
  );
  await sleep(1500);
  check(
    'and NO channel frame was written for it',
    agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length === framesBefore,
    'a stop-now that quietly became a channel event would be a steer wearing its label'
  );
  check(
    'the response echoes the intent it acted on',
    stop.intent === 'stop-now',
    `intent=${stop.intent}`
  );
}

// A bad intent is refused rather than silently treated as a steer — the failure
// mode being avoided is a typo'd `stop_now` arriving as an ordinary message
// while the sender believes it has preempted somebody.
const badIntent = await diag.call({
  action: 'send_to_agent', key: AGENT_A.key, type: AGENT_A.type, message: 'x', intent: 'stop_now'
});
check(
  "a misspelled intent is refused, not silently downgraded to 'steer'",
  badIntent.success === false && String(badIntent.error).includes('Invalid intent'),
  badIntent.error
);

// --- AC 3: the over-claim, and the check ------------------------------------
console.log('');
if (OVERCLAIM && !UNSEAL) {
  // The call site was patched to assert C3 and C4 on the channel. The seal
  // throws; the daemon's per-request catch turns that into a loud failure.
  const over = await diag.call({
    action: 'send_to_agent',
    key: AGENT_A.key, type: AGENT_A.type, message: 'KAN247-OVERCLAIM-ATTEMPT',
    workspaceType: 'story', workspaceKey: 'KAN-150'
  });
  console.log('  THE RESPONSE to a patched, over-claiming build:');
  console.log(JSON.stringify(over, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  check(
    'THE CHECK FIRED: an over-claiming send is refused, loudly',
    over.success === false && /over-claim refused/.test(String(over.error)),
    over.error ?? '(no error)'
  );
  check(
    'and the refusal names the transport and the claim it exceeded',
    /channel/.test(String(over.error)) && /enteredTranscript|modelRead/.test(String(over.error)),
    'so whoever reads the log knows which line to fix'
  );
  check(
    'nothing was delivered on the strength of a claim that was refused',
    over.transport === undefined,
    'the response never got built'
  );
} else if (OVERCLAIM && UNSEAL) {
  // Guard gone. The over-claim now reaches the wire, and the ordinary
  // assertions from section 3 are re-run against it — the SAME checks, failing.
  const over = await diag.call({
    action: 'send_to_agent',
    key: AGENT_A.key, type: AGENT_A.type, message: 'KAN247-OVERCLAIM-UNSEALED',
    workspaceType: 'story', workspaceKey: 'KAN-150'
  });
  console.log('  THE RESPONSE with the guard removed — read what it asserts:');
  console.log(JSON.stringify(over.claims, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  check(
    'C3 (entered the transcript) is NULL — a channel never touches a pane',
    over.claims?.enteredTranscript?.value === null,
    `value=${over.claims?.enteredTranscript?.value} — over the CHANNEL, which reaches no pane at all`
  );
  check(
    'C4 (the model read it) is NULL — no ack exists to establish it',
    over.claims?.modelRead?.value === null,
    `value=${over.claims?.modelRead?.value} — nothing acknowledged anything`
  );
  console.log('');
  console.log('  ^ THOSE TWO FAILURES ARE THE POINT OF THIS RUN. The response claims the');
  console.log('    text entered a transcript and a model read it, over a carrier that');
  console.log('    touched neither, and only the removed guard stood between the build and');
  console.log('    saying so. Re-run without --unseal to watch the check refuse it.');
} else {
  console.log('  (run with --overclaim to watch the check fire, and with --overclaim --unseal');
  console.log('   to watch this proof go red. Neither was passed, so neither ran.)');
}

// ============================================================================
rule('VERDICT');
// ============================================================================
diag.close();
if (OVERCLAIM && UNSEAL) {
  console.log('This was an --unseal run: RED IS THE CORRECT OUTCOME. A green run here would');
  console.log('mean the assertions cannot tell an honest response from an over-claiming one.');
  console.log('');
}
console.log(`${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILURE(S)`}`);
for (const f of failures) console.log(`  - ${f}`);

process.exit(failures.length > 0 ? 1 : 0);
