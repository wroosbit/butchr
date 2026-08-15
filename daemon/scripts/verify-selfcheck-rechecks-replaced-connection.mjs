// A startup self-check whose connection was replaced under it is re-run ONCE
// against the replacement — and the re-run is bounded, is able to reach a WORSE
// verdict than the swap it replaced, and leaves `connection-replaced` reachable.
//
// WHAT FAILURE THIS WOULD CATCH: an agent left permanently unproved by a swap
// nobody looked at again (`connection-replaced, proved: false`, for the life of
// the daemon, in exactly the population whose channel nobody has checked) — and,
// from the other direction, a re-run that fixes that by never stopping, or by
// laundering every swap into a pass so that a genuinely broken replacement
// reports as healthy.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them in
// process; no live daemon, no herdr, no credential, no peer, no terminal. §4
// opens a Unix socket inside its own scratch directory.
//
// ---------------------------------------------------------------------------
// WHAT KAN-435 LEFT, AND WHY IT IS NOT NOTHING
// ---------------------------------------------------------------------------
// KAN-435 stopped a replaced connection from degrading a healthy agent. It did
// it by noticing the swap and declining to conclude anything — which is honest,
// and leaves the connection the agent is ACTUALLY holding measured by nobody.
// The row reads `outcome: connection-replaced, transport: channel, proved:
// false` and nothing ever asks again. Two of eight agents were measured in the
// state that produces it on 2026-08-15.
//
// So KAN-450 re-runs the check once, against the replacement.
//
// ---------------------------------------------------------------------------
// THE THREE WAYS A RETRY GOES WRONG, AND WHICH SECTION HOLDS EACH
// ---------------------------------------------------------------------------
// Asking "what would have to be true for this proof to pass while the feature is
// broken?" gives three answers, and only the first is the obvious one:
//
//   1. THE RETRY NEVER HAPPENS. §1 — a swapped world must end in a verdict about
//      the SECOND connection, with `attempts: 2`.
//   2. THE RETRY NEVER STOPS, or stops only because the world happened to settle.
//      §2 — a world that swaps on EVERY resolve must terminate, must report
//      `connection-replaced`, and must have written exactly two probe frames.
//      This is the control for the BOUND rather than for the retry, and a proof
//      without it tests the cheap half: `connection-replaced` becoming
//      unreachable-in-practice is a state nothing can reach and therefore a state
//      nobody maintains.
//   3. THE RETRY LAUNDERS. A re-run that can only ever improve the verdict is not
//      a measurement, it is a way of not having one. §1's control C is the sharp
//      case: a swap whose REPLACEMENT does not answer must come back `no-answer`
//      → composer. If that control is missing, a retry that unconditionally
//      returned `passed` would satisfy every other assertion in this file.
//
// §3 is the cost as an ASSERTION (exactly one extra probe write and one extra
// ack arm, never two), and §4 is the cost as a MEASUREMENT (a real Unix-socket
// round trip, printed, not gated — see its own note on why it is not a check).
// §5 is the supervisor-facing row.
//
// ---------------------------------------------------------------------------
// NO TIMING DEPENDENCE IN ANY CHECK, DELIBERATELY (the rule KAN-416 paid for)
// ---------------------------------------------------------------------------
// The defect is an ordering, so it is expressed as one. `runChannelSelfCheck`
// takes its whole world as injected functions, so "the connection was replaced
// while this attempt was waiting for its answer" is a PHASE, not a call count
// and not a sleep. The clock is a constant. §4 is the one section that measures
// real time, and it asserts nothing about the number it prints.
//
// **The phase is keyed to the ack having been armed AND awaited**, which is one
// step more faithful than the harness in `verify-selfcheck-verdict-outlives-
// connection.mjs`: there the swap lands before `writeProbe` re-resolves, so the
// probe is recorded as going to the connection that replaced the one the check
// resolved. Here `expectAck` advances the generation on a microtask, so the
// probe genuinely goes to the connection that was current when the check
// started, which is what production does.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST (KAN-145)
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives, and
// this one supplies the world entirely: the connections, the acks, the clock. It
// therefore does NOT prove that a real bring-up replaces a connection — that is
// a fact about `claude --continue || claude`, and no harness can hold it.
//
// WHO COVERS THAT: the two daemon-log timelines read off the live fleet in
// `verify-selfcheck-verdict-outlives-connection.mjs`'s header and pasted into the
// KAN-435 pull request, and `probe-channel-selfcheck.mjs` for the live
// activation path. NOBODY YET COVERS a live activation whose swap is re-run — the
// population is rare by construction and this ticket did not staff a live probe
// for it. That gap is named here rather than left to be inferred, and it is the
// honest edge of this file.
//
// §5 is built the other way round — a real `MessageRouter`, a real
// `ChannelSelfCheckStore` — so the row it asserts is rendered by the code that
// renders it in production.
//
// Usage: node daemon/scripts/verify-selfcheck-rechecks-replaced-connection.mjs [--no-retry] [--retry-until-stable]
//
//   --no-retry             patch a COPY of the build so a swap is never re-run —
//                          the pre-KAN-450 behaviour. §1 and §3 must FAIL.
//   --retry-until-stable   patch a COPY so the re-run loops until the world
//                          settles. §2 must FAIL: the ceiling world never
//                          settles, so the check does not terminate and
//                          `connection-replaced` has become unreachable.
//
// Run it after `npm run build` in daemon/.

import net from 'net';
import path from 'path';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');
const noRetry = process.argv.includes('--no-retry');
const retryUntilStable = process.argv.includes('--retry-until-stable');
const redMode = noRetry || retryUntilStable;

const dist = path.join(daemonDir, 'dist');
// A SETUP GUARD, NOT A VERDICT: exit 2 so it can never be mistaken for a check
// that ran and found something.
if (!existsSync(path.join(dist, 'channel-selfcheck.js'))) {
  console.error('daemon/dist/channel-selfcheck.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'butchr-recheck-'));

// BEFORE ANY IMPORT. `ipc.ts` computes BUTCHR_DIR from `os.homedir()` at module
// load, so this has to happen while the build is still unloaded.
const fakeHome = path.join(scratch, 'home');
mkdirSync(path.join(fakeHome, '.local', 'share', 'butchr'), { recursive: true });
process.env.HOME = fakeHome;

// Only the module under test is swapped; the rest of the build is the real one,
// so §5's router stays real under both red modes.
let selfCheckModule = path.join(dist, 'channel-selfcheck.js');

if (redMode) {
  const patchedDir = path.join(scratch, 'dist');
  cpSync(dist, patchedDir, { recursive: true });
  const target = path.join(patchedDir, 'channel-selfcheck.js');
  selfCheckModule = target;
  let source = readFileSync(target, 'utf8');

  const GUARD = "if (first.outcome !== 'connection-replaced')\n        return first;";

  if (noRetry) {
    // THE DEFECT, INTRODUCED DELIBERATELY: the first attempt's verdict is final,
    // whatever it says. This is exactly what shipped between KAN-435 and
    // KAN-450, so the red mode reproduces a state the fleet was really in.
    const before = source;
    source = source.replace(GUARD, 'if (true)\n        return first;');
    if (source === before) {
      console.error(
        '--no-retry could not find the `connection-replaced` guard in the copied ' +
        'channel-selfcheck.js. The patch did not apply, so this run would report an honest ' +
        'build for the wrong reason. Refusing to continue.'
      );
      process.exit(2);
    }
    console.log('--no-retry: patched the copy so a swap is never re-run (pre-KAN-450).');
    console.log('            Sections 1 and 3 are expected to FAIL.\n');
  }

  if (retryUntilStable) {
    // THE OPPOSITE DEFECT: a re-run with no ceiling. It fixes §1 and destroys
    // §2 — `connection-replaced` stops being reachable, and against a world that
    // keeps swapping the check never returns at all. The dead `return` left
    // behind keeps the emitted object literal syntactically intact.
    const before = source;
    source = source.replace(
      GUARD,
      GUARD + `
    let prev = first;
    while (prev.outcome === 'connection-replaced') {
        prev = await attemptChannelSelfCheck({
            address: opts.address,
            world: opts.world,
            startupOutcome: opts.startupOutcome,
            timeoutMs,
            startedAt,
            attempt: 2,
            replacedConnectionId: prev.connectionId
        });
    }
    return prev;`
    );
    if (source === before) {
      console.error(
        '--retry-until-stable could not find the `connection-replaced` guard in the copied ' +
        'channel-selfcheck.js. The patch did not apply. Refusing to continue.'
      );
      process.exit(2);
    }
    console.log('--retry-until-stable: patched the copy so the re-run loops until the world settles.');
    console.log('                      Section 2 is expected to FAIL.\n');
  }

  writeFileSync(target, source);
}

const u = (f) => `file://${path.join(dist, f)}`;
const { ChannelSelfCheckStore, runChannelSelfCheck } = await import(`file://${selfCheckModule}`);
const { MessageRouter } = await import(u('router.js'));
const { WorkspaceRegistry } = await import(u('registry.js'));
const { PromptLoader } = await import(u('prompt.js'));
const { HerdrBridge } = await import(u('herdr.js'));

let failures = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const rule = (t) => {
  console.log('\n' + '='.repeat(78));
  console.log(t);
  console.log('='.repeat(78));
};

const ADDRESS = { type: 'task', key: 'KAN-450' };
const ANSWER = {
  nonce: 'n',
  emitted: true,
  pingAnswered: true,
  clientName: 'claude-code',
  clientVersion: '2.1.226'
};

/**
 * A world whose connection is replaced under an attempt that is waiting.
 *
 * `swaps` is how many attempts get their subject replaced: 0 never, 1 the first
 * attempt only, Infinity every attempt — the ceiling §2 drives.
 *
 * `resolveBudget` is what turns "does not terminate" into a FAIL rather than a
 * hang. A patched build that loops forever would otherwise take CI's timeout
 * instead of this script's verdict, and a proof that can only fail by timing out
 * is a proof whose red nobody can read.
 */
function makeWorld({ swaps, ack = null, resolveBudget = 24 }) {
  let armed = 0;
  let resolves = 0;
  const probeWrites = [];
  const acksArmed = [];
  const logLines = [];
  const idFor = () => {
    resolves += 1;
    if (resolves > resolveBudget) {
      throw new Error(
        `resolveConnection was called ${resolves} times (budget ${resolveBudget}) — ` +
        `this check is not terminating`
      );
    }
    return `conn-${String.fromCharCode(65 + Math.min(armed, swaps))}`;
  };
  return {
    probeWrites,
    acksArmed,
    logLines,
    resolveCount: () => resolves,
    world: {
      emissionEnabled: () => true,
      resolveConnection: () => ({ id: idFor() }),
      // THE PHASE. The generation advances on a microtask, so `writeProbe` —
      // which runs synchronously after this returns — still sees the connection
      // the attempt resolved, and the replacement is visible only to the
      // post-await `resolveConnection`. That is the production ordering.
      expectAck: (nonce) => {
        acksArmed.push(nonce);
        return Promise.resolve().then(() => {
          armed += 1;
          return ack;
        });
      },
      writeProbe: (nonce) => {
        probeWrites.push({ nonce, to: idFor() });
        return true;
      },
      now: () => 0,
      log: (m) => logLines.push(m)
    }
  };
}

async function run({ swaps, ack, resolveBudget }) {
  const w = makeWorld({ swaps, ack, resolveBudget });
  try {
    const report = await runChannelSelfCheck({ address: ADDRESS, ackTimeoutMs: 1, world: w.world });
    return { ...w, report, threw: null };
  } catch (err) {
    return { ...w, report: null, threw: err };
  }
}

// ---------------------------------------------------------------- section 1 --

rule('1. A swap is re-run once, against the connection that replaced it');

const swapped = await run({ swaps: 1, ack: ANSWER });
check(
  swapped.report?.outcome === 'passed',
  'a swapped bring-up ends in a verdict about the LIVE connection, not in `connection-replaced`',
  `outcome=${swapped.report?.outcome ?? `threw: ${swapped.threw?.message}`}`
);
check(
  swapped.report?.attempts === 2,
  '  …and says it took two attempts',
  `attempts=${swapped.report?.attempts}`
);
check(
  swapped.report?.connectionId === 'conn-B',
  '  …with the verdict pinned to the REPLACEMENT connection',
  `connectionId=${swapped.report?.connectionId}`
);
check(
  swapped.report?.proved === true,
  '  …and the agent is now actually proved, which is the whole point of the ticket',
  `proved=${swapped.report?.proved}`
);
check(
  typeof swapped.report?.detail === 'string' &&
    swapped.report.detail.includes('conn-A') &&
    swapped.report.detail.includes('SECOND attempt'),
  '  …and the detail a supervisor reads names the connection that was replaced',
  (swapped.report?.detail ?? '').slice(-120)
);
check(
  swapped.probeWrites.length === 2 &&
    swapped.probeWrites[0].to === 'conn-A' &&
    swapped.probeWrites[1].to === 'conn-B',
  '  …and the two probe frames went to the two different connections, in order',
  swapped.probeWrites.map((p) => p.to).join(' → ')
);

// CONTROL A — the ordinary case is untouched. A change that made every check
// take two attempts would pass everything above.
const clean = await run({ swaps: 0, ack: ANSWER });
check(
  clean.report?.outcome === 'passed' && clean.report?.attempts === 1,
  'CONTROL: an unswapped bring-up still takes exactly ONE attempt',
  `outcome=${clean.report?.outcome} attempts=${clean.report?.attempts}`
);

// CONTROL B — a failure that is not a swap is not retried. `no-answer` is a
// reading of the connection the agent is holding; re-asking a wedged server the
// same question is not evidence, it is patience.
const silent = await run({ swaps: 0, ack: null });
check(
  silent.report?.outcome === 'no-answer' &&
    silent.report?.transport === 'composer' &&
    silent.report?.attempts === 1,
  'CONTROL: silence with no swap is still `no-answer` → composer, on one attempt',
  `outcome=${silent.report?.outcome} transport=${silent.report?.transport} ` +
    `attempts=${silent.report?.attempts}`
);

// CONTROL C — THE SHARP ONE. The re-run must be able to come back WORSE than the
// swap it replaced. A retry that could only ever improve the verdict would
// satisfy every assertion above while quietly putting unproven agents on the
// channel, which is the fail-open direction.
const swappedThenSilent = await run({ swaps: 1, ack: null });
check(
  swappedThenSilent.report?.outcome === 'no-answer' &&
    swappedThenSilent.report?.transport === 'composer' &&
    swappedThenSilent.report?.attempts === 2,
  'CONTROL: a swap whose REPLACEMENT does not answer degrades — the re-run can reach a worse verdict',
  `outcome=${swappedThenSilent.report?.outcome} transport=${swappedThenSilent.report?.transport}`
);

// ---------------------------------------------------------------- section 2 --

rule('2. THE BOUND: a world that swaps on every resolve terminates, and says `connection-replaced`');

const ceiling = await run({ swaps: Infinity, ack: ANSWER });
check(
  ceiling.threw === null,
  'the check TERMINATES against a world that never settles',
  ceiling.threw ? ceiling.threw.message : `${ceiling.resolveCount()} resolveConnection calls`
);
check(
  ceiling.report?.outcome === 'connection-replaced',
  '`connection-replaced` is still REACHABLE — a state nothing can reach is a state nobody maintains',
  `outcome=${ceiling.report?.outcome ?? '(none — the check did not return)'}`
);
check(
  ceiling.report?.attempts === 2,
  '  …reached on the second attempt, which is the last one',
  `attempts=${ceiling.report?.attempts}`
);
check(
  ceiling.probeWrites.length === 2,
  '  …after exactly TWO probe frames, never a third',
  `probe writes=${ceiling.probeWrites.length}`
);
check(
  ceiling.report?.transport === 'channel' && ceiling.report?.proved === false,
  '  …and the agent is still NOT degraded by it, and still claims nothing (KAN-435, unchanged)',
  `transport=${ceiling.report?.transport} proved=${ceiling.report?.proved}`
);
check(
  typeof ceiling.report?.detail === 'string' &&
    ceiling.report.detail.includes('already the re-run'),
  '  …and the detail says the re-run was already spent, so a reader is not told to wait for one',
  (ceiling.report?.detail ?? '').slice(-110)
);

// ---------------------------------------------------------------- section 3 --

rule('3. WHAT IT COSTS, as a count: one extra probe frame and one extra ack, and no more');

check(
  clean.probeWrites.length === 1 && clean.acksArmed.length === 1,
  'an unswapped check costs one probe frame and one armed ack',
  `probes=${clean.probeWrites.length} acks=${clean.acksArmed.length}`
);
check(
  swapped.probeWrites.length === 2 && swapped.acksArmed.length === 2,
  'a swapped check costs exactly one MORE of each — the retry is one round trip, not a loop',
  `probes=${swapped.probeWrites.length} acks=${swapped.acksArmed.length}`
);
check(
  new Set(swapped.acksArmed).size === 2,
  '  …on a fresh nonce, so the second attempt cannot resolve the first one\'s answer',
  swapped.acksArmed.join(', ')
);
// The nonce is what makes the two attempts independent; without a fresh one the
// re-run could be resolved by a LATE answer from the connection that closed —
// which is the stale reading this whole pair of tickets exists to stop.

// ---------------------------------------------------------------- section 4 --

rule('4. WHAT IT COSTS, as a measurement: one real round trip over a Unix socket');

// ⚠ THIS SECTION ASSERTS NOTHING, AND THAT IS DELIBERATE RATHER THAN LAZY.
// A wall-clock threshold on shared CI is an intermittent waiting to happen
// (KAN-416), and a threshold loose enough never to flake is a threshold that
// could not go red — which is worse than no check at all, because it looks like
// one. §3 is where the cost is CHECKED, as a count of round trips; this is where
// it is MEASURED, so that "one round trip" has a number beside it.
//
// WHAT IT MEASURES: the daemon→agent→daemon leg over a real Unix domain socket,
// with the real newline-delimited-JSON framing, for the real probe frame shape.
// WHAT IT DOES NOT: a real `mcp.js` emitting a real notification and waiting on a
// real client's ping. That is a fact about Claude Code, it is what KAN-435
// measured live at 13 ms and 17 ms for a whole self-check, and no harness here
// can hold it.
const sock = path.join(scratch, 'probe.sock');
const N = 200;
const server = net.createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      c.write(JSON.stringify({ action: 'channel_selfcheck_result', nonce: msg.nonce }) + '\n');
    }
  });
});
await new Promise((res) => server.listen(sock, res));

const samples = [];
await new Promise((done) => {
  const c = net.createConnection(sock, () => {
    let n = 0;
    let t0 = process.hrtime.bigint();
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        buf = buf.slice(i + 1);
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        n += 1;
        if (n >= N) {
          c.end();
          server.close(done);
          return;
        }
        t0 = process.hrtime.bigint();
        c.write(JSON.stringify({ action: 'channel_selfcheck', nonce: `sc-${n}` }) + '\n');
      }
    });
    c.write(JSON.stringify({ action: 'channel_selfcheck', nonce: 'sc-0' }) + '\n');
  });
});

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const p95 = samples[Math.floor(samples.length * 0.95)];
console.log(`  MEASURED  ${samples.length} probe→ack round trips over a Unix socket`);
console.log(`  MEASURED  median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${samples[samples.length - 1].toFixed(3)} ms`);
console.log('  NOTE      this is the retry\'s marginal cost in the ordinary swapped case. The');
console.log('            FIRST attempt has already spent the full ack timeout (20 s in');
console.log('            production) waiting on the connection that closed, so the re-run is');
console.log('            noise beside it. The worst case is the other one: a replacement that');
console.log('            also never answers costs a SECOND full timeout — ~40 s rather than');
console.log('            ~20 s. All of it is off the activation\'s critical path (daemon.ts');
console.log('            fires the chain behind a `void`), and what it delays is the VERDICT,');
console.log('            never the routing: an agent with no verdict yet is `unchecked`, and');
console.log('            unchecked routes.');

// ---------------------------------------------------------------- section 5 --

rule('5. The supervisor-facing row carries `attempts`, so a doubled elapsedMs is explicable');

const bin = path.join(scratch, 'bin');
mkdirSync(bin, { recursive: true });
const census = JSON.stringify({
  id: 'cli:agent:list',
  result: {
    type: 'agent_list',
    agents: [
      { name: 'butchr-task-kan-450', agent: 'claude', agent_status: 'working', cwd: scratch },
      { name: 'butchr-task-kan-999', agent: 'claude', agent_status: 'working', cwd: scratch }
    ]
  }
});
writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncat <<'EOF'\n${census}\nEOF\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const store = new ChannelSelfCheckStore();
store.record(ADDRESS, swapped.report ?? { ...ANSWER, outcome: 'passed' });

let response;
const router = new MessageRouter(
  new WorkspaceRegistry(),
  new PromptLoader(repoRoot),
  new HerdrBridge(),
  (msg) => {
    response = msg;
  },
  () => {},
  { channelSelfCheck: (address) => store.get(address) ?? null }
);
router.handle({ action: 'list_agents' });
const rows = new Map((response?.agents ?? []).map((a) => [a.key.toLowerCase(), a]));
const retriedRow = rows.get('kan-450');
const uncheckedRow = rows.get('kan-999');

check(
  retriedRow?.channel?.attempts === 2,
  'the re-run agent\'s row reports `attempts: 2`',
  JSON.stringify(retriedRow?.channel?.attempts)
);
check(
  retriedRow?.channel?.outcome === 'passed' && retriedRow?.channel?.proved === true,
  '  …beside a verdict that is now a real pass rather than a permanent unknown',
  `outcome=${retriedRow?.channel?.outcome} proved=${retriedRow?.channel?.proved}`
);
check(
  uncheckedRow?.channel?.attempts === null && 'attempts' in (uncheckedRow?.channel ?? {}),
  'an unchecked agent answers `attempts: null` rather than omitting the key',
  'absent means "this daemon cannot say"; null means "answered, with nothing"'
);

// ----------------------------------------------------------------- verdict --

rule('VERDICT');
console.log(`  probe round trips measured  ${samples.length} (median ${median.toFixed(3)} ms)`);
console.log(`  ceiling world resolves      ${ceiling.resolveCount()}`);
console.log('');
if (failures === 0) {
  console.log('ALL CHECKS PASSED — a replaced connection is re-run once against its');
  console.log('replacement, the re-run can reach a WORSE verdict as well as a better one,');
  console.log('and a world that never settles still terminates in `connection-replaced`');
  console.log('after exactly two probe frames.');
  if (redMode) {
    console.log('');
    console.log('BUT A RED MODE WAS PASSED AND NOTHING WENT RED. The patch did not take, or');
    console.log('this proof is not testing what it claims to. Treat this as a failure.');
    failures += 1;
  }
} else {
  console.log(`${failures} CHECK(S) FAILED.`);
  if (noRetry) {
    console.log('');
    console.log('--no-retry was passed, so this is the expected result: with the swap never');
    console.log('re-run, a bring-up that replaced its connection is left `connection-replaced`');
    console.log('and `proved: false` for the life of the daemon. That is what shipped between');
    console.log('KAN-435 and KAN-450.');
  }
  if (retryUntilStable) {
    console.log('');
    console.log('--retry-until-stable was passed, so this is the expected result: with no');
    console.log('ceiling, a world that keeps swapping is never given a verdict at all, and');
    console.log('`connection-replaced` has become unreachable-in-practice while remaining in');
    console.log('the type — a state nothing can reach is a state nobody maintains.');
  }
}

process.exit(failures ? 1 : 0);
