// The spawn's channel verdict: composed once by the launcher, carried as a
// verdict rather than sniffed out of a command line, and preserved in all THREE
// of its states across the CrabCast wire (KAN-294).
//
// WHAT FAILURE THIS WOULD CATCH: a two-state read of a three-state fact — the
// `null` that means "no spawn decided this" flattened into the `false` that
// means "decided, and no channel". That failure is SILENT and it is silent in
// the worst available direction: `false` is what a caller branches on to
// conclude the channel is unavailable, and the two values differ only for agents
// nothing ever spawned, so every agent anybody tests with is green. It also
// catches the defect one layer up, which is how the flattening gets in: a
// consumer answering "was this a channel-enabled spawn?" by searching the
// spawned command line for `--dangerously-load-development-channels`. That
// question is right and that route is wrong — it works only for a launcher that
// spells its channel decision as a flag, and against a runtime whose spawn is an
// MCP server entry it does not error, it returns "no channel" for every agent
// forever. `epic/KAN-59`: "CrabCast has no DEV_CHANNELS_FLAG equivalent at all.
// The channel is not a command-line switch here — it is an MCP server entry."
//
// CI-RUNNABLE: yes — imports the built daemon modules, stages its own $HOME and
// its own unix socket in temporary directories, and needs no herdr, no pty, no
// network and no CrabCast. Section 3 creates and removes two probe workspaces
// under the workspaces root, per path and never by reverting a directory.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145, and it is the failure that ticket's two scripts BOTH missed by
// constructing the records they then asserted on). This script supplies:
//
//   * THE SWITCH. Section 1 writes `channel.json` into a temporary $HOME and
//     reads back what the launcher composed under it. So it proves the launcher
//     obeys the switch and records what it obeyed — and nothing at all about
//     whether a real `claude` accepts the flag.
//   * THE WIRE. Section 3 stands up its own unix socket and answers
//     `activate_response` with a `channelEnabled` THIS SCRIPT CHOSE. So it
//     proves the adapter keeps whatever CrabCast sends without flattening it,
//     and it is structurally incapable of noticing that CrabCast sends something
//     else, or nothing, or sends it somewhere else.
//
// WHO COVERS THE ARRIVAL — and this is the gap KAN-145 left between two honest
// scripts, so it is named rather than left to inference:
//
//   * `daemon/scripts/verify-crabcast-runtime-live.mjs` §6 drives a REAL
//     CrabCast daemon at the pin and asserts `channelEnabled` ARRIVES on a real
//     `activate_response`, in all three states, from a spawn nobody here
//     constructed. That is the only thing in the tree that can fail if CrabCast
//     changes. It needs a real daemon and real panes, so it is not CI-safe and
//     its output goes on the pull request.
//   * `daemon/scripts/verify-channel-launch-flag.mjs` owns the command line
//     itself — that the flag lands on both arms of the `||`. Section 1 here
//     asserts the VERDICT agrees with the command; that script asserts the
//     command is right. Neither subsumes the other.
//   * NOBODY covers a real `claude` started from a verdict-driven spawn.
//     `probe-channel-launch.mjs` covers the real-`claude` path and predates this
//     change; it exercises the launcher, not the listener. The listener's one
//     consumer is `superviseChannelStartup`, and no automated proof drives it
//     against a live pane today. That was true before this change and is still
//     true; this script does not narrow it and does not claim to.
//
// ---------------------------------------------------------------------------
// RUNNING IT
// ---------------------------------------------------------------------------
//   node daemon/scripts/verify-channel-spawn-verdict.mjs [--verbose]
//
//   --collapse-tristate  patch a COPY of the build so `readChannelEnabled`
//                        reads `?? false`, and watch sections 2 and 3 go red.
//                        This is the exact mutation the approver said they would
//                        drive by hand; it is here so nobody has to.
//   --restore-sniff      patch a COPY of `src/daemon.ts` so the listener sniffs
//                        the command line again, and watch section 4 go red.
//
// A gate nobody has watched fail has not been shown to be a gate, so both red
// modes are part of the proof rather than a convenience. Each ends by failing
// if it went GREEN, because a mutation that did not take is an assertion that
// is not watching what it claims to watch.
//
// Run it after `npm run build` in daemon/.

import net from 'net';
import { execFileSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');
const collapseTristate = process.argv.includes('--collapse-tristate');
const restoreSniff = process.argv.includes('--restore-sniff');

const FLAG = '--dangerously-load-development-channels';

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('─'.repeat(72));
  say(title);
  say('─'.repeat(72));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) say(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'crabcast-runtime.js'))) {
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan294-verdict-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

let distUnderTest = dist;
let daemonSourceUnderTest = path.join(daemonDir, 'src', 'daemon.ts');

if (collapseTristate) {
  // The damage is done to a COPY. A red run cannot leave a broken build behind,
  // which matters here more than usual: this repo has live agents working in
  // sibling worktrees off the same shared clone.
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  // The copy still has to resolve `node-pty`, which `herdr.js` imports. Node
  // walks up from the importing file, so one symlink beside the copy is enough
  // and is cheaper and less surprising than copying 100+ MB of node_modules.
  symlinkSync(path.join(daemonDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  const target = path.join(distUnderTest, 'crabcast-runtime.js');
  const source = readFileSync(target, 'utf8');
  const patched = source.replace(
    "return typeof value === 'boolean' ? value : null;",
    'return value ?? false;'
  );
  if (patched === source) {
    console.error('--collapse-tristate could not find readChannelEnabled to patch; it has moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  say('--collapse-tristate: patched a copy of the build so `null` reads as `false`.');
}

if (restoreSniff) {
  const copy = path.join(scratch, 'daemon.ts');
  const source = readFileSync(daemonSourceUnderTest, 'utf8');
  const patched = source.replace(
    'herdrBridge.setAgentSpawnedListener((session, spawnedAt, spawn) => {\n  if (spawn.channelEnabled !== true) return;',
    'herdrBridge.setAgentSpawnedListener((session, spawnedAt, spawn) => {\n' +
      '  if (!String(spawn.command).includes(DEV_CHANNELS_FLAG)) return;'
  );
  if (patched === source) {
    console.error('--restore-sniff could not find the listener to patch; it has moved.');
    process.exit(2);
  }
  writeFileSync(copy, patched.replace(
    "import { coreMcpServerDefinitions } from './launchers.js';",
    "import { coreMcpServerDefinitions, DEV_CHANNELS_FLAG } from './launchers.js';"
  ));
  daemonSourceUnderTest = copy;
  say('--restore-sniff: patched a copy of src/daemon.ts back to the command-line sniff.');
}

const fileUrl = (p) => `file://${p}`;
const { readChannelEnabled, CrabCastRuntime } = await import(
  fileUrl(path.join(distUnderTest, 'crabcast-runtime.js'))
);
const { CrabCastLink, CRABCAST_PIN, CRABCAST_CONTRACT_VERSION } = await import(
  fileUrl(path.join(distUnderTest, 'crabcast-link.js'))
);
const { workspaceDirFor } = await import(fileUrl(path.join(distUnderTest, 'herdr.js')));

// ── 1. the launcher records its own verdict ────────────────────────────────
rule('1. the launcher — one call returns the command AND what it decided');

/**
 * What the launcher composes under a given switch state, read in a CHILD
 * process.
 *
 * `CHANNEL_SWITCH_PATH` derives from `os.homedir()` at module load, so it cannot
 * be moved after the fact inside one process. The child prints JSON and nothing
 * else, so a stray `console.log` in the build is a parse failure here rather
 * than silent contamination — the same isolation `verify-channel-launch-flag.mjs`
 * uses, and for the same reason: the fleet's real switch at
 * ~/.local/share/butchr/channel.json is never read and never written here.
 */
function launchUnderSwitch(name, enabled, hasConversation = false) {
  const home = mkdtempSync(path.join(scratch, 'home-'));
  if (enabled !== null) {
    mkdirSync(path.join(home, '.local', 'share', 'butchr'), { recursive: true });
    writeFileSync(
      path.join(home, '.local', 'share', 'butchr', 'channel.json'),
      `${JSON.stringify({ enabled }, null, 2)}\n`
    );
  }
  const mod = fileUrl(path.join(distUnderTest, 'launchers.js'));
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      // KAN-533: `command()` takes a context now. `hasConversation` selects the
      // arm that used to be the right-hand side of the `||`; the cold arm is
      // chosen here because it is the one carrying the prompt, and because a
      // bare `command()` throws rather than defaulting — which is deliberate,
      // an arm chosen by omission is the guess `hasRestorableConversation()`
      // exists to replace.
      `import(${JSON.stringify(mod)}).then((m) => ` +
        `process.stdout.write(JSON.stringify(m.AGENT_LAUNCHERS[${JSON.stringify(name)}]` +
        `.command({ hasConversation: ${hasConversation} }))))`
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: home } }
  );
  return JSON.parse(out);
}

const off = launchUnderSwitch('claude', false);
const on = launchUnderSwitch('claude', true);
const unset = launchUnderSwitch('claude', null);

check(
  typeof off.command === 'string' && 'channelEnabled' in off,
  'command() returns a record: the command line AND the spawn verdict',
  JSON.stringify(off)
);
check(off.channelEnabled === false, 'switch OFF  → channelEnabled === false', JSON.stringify(off.channelEnabled));
check(on.channelEnabled === true, 'switch ON   → channelEnabled === true', JSON.stringify(on.channelEnabled));
check(
  unset.channelEnabled === false,
  'switch ABSENT → channelEnabled === false (fail-closed, as the emission path is)',
  JSON.stringify(unset.channelEnabled)
);

// THE ASSERTION THAT IS NOT CIRCULAR AND IS THE POINT OF SECTION 1.
// It does not re-derive the verdict from the command — it asserts the two halves
// of ONE return value agree. That agreement is precisely what made the deleted
// sniff correct for `claude`, so if this ever parts company the old heuristic and
// the new verdict would disagree about the same spawn, which is the state that
// must be unrepresentable rather than merely untested.
for (const [label, got] of [['off', off], ['on', on], ['unset', unset]]) {
  check(
    got.channelEnabled === got.command.includes(FLAG),
    `switch ${label}: the verdict agrees with the command line it was returned WITH`,
    `channelEnabled=${got.channelEnabled}, command carries the flag=${got.command.includes(FLAG)}`
  );
}

// THE VERDICT IS A PROPERTY OF THE SWITCH, NOT OF THE ARM (KAN-533). The `||`
// put both arms on one command line, so one reading covered both; they are two
// separate spawns now, and a build that read the switch per-arm could return
// `true` for one and `false` for the other while every assertion above passed.
// Asserted here rather than assumed because `launchers.ts` reads the switch off
// disk inside `command()`, so it genuinely is read once per arm.
for (const enabled of [true, false]) {
  const resumed = launchUnderSwitch('claude', enabled, true);
  const cold = launchUnderSwitch('claude', enabled, false);
  check(
    resumed.channelEnabled === cold.channelEnabled && resumed.channelEnabled === enabled,
    `switch ${enabled}: both arms return the SAME verdict, and it is the switch's`,
    `resumed=${resumed.channelEnabled}, cold=${cold.channelEnabled}`
  );
}

// Every launcher answers, and none of them answers `undefined` — which would be
// a fourth state nothing has a meaning for.
//
// THE LIST IS READ OUT OF THE TABLE, NOT TYPED HERE (KAN-395). It was
// `['shell', 'anti-gravity']`, and when KAN-395 deleted `anti-gravity` this
// section did not report a launcher that had stopped answering — it crashed with
// a TypeError on `undefined.command()`, which is a red for the wrong reason and
// would have read as this proof catching the deletion. Deriving the names means
// a launcher ADDED later is covered by this assertion without anyone editing it,
// which is the half a hardcoded list gets wrong silently.
const tableNames = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '-e',
      `import(${JSON.stringify(fileUrl(path.join(distUnderTest, 'launchers.js')))}).then((m) => ` +
        `process.stdout.write(JSON.stringify(Object.keys(m.AGENT_LAUNCHERS))))`
    ],
    { encoding: 'utf8' }
  )
);
check(
  tableNames.includes('claude'),
  'the launcher table read back is the real one — it contains `claude`',
  `AGENT_LAUNCHERS keys=${JSON.stringify(tableNames)}`
);
for (const name of tableNames.filter((n) => n !== 'claude')) {
  const got = launchUnderSwitch(name, true);
  check(
    got.channelEnabled === false,
    `${name} answers false even with the switch on — it composes no channel`,
    JSON.stringify(got)
  );
}

// ── 2. the tri-state read ──────────────────────────────────────────────────
rule('2. readChannelEnabled — three states in, three states out, none merged');

// The wire shapes, and what each MUST read as. Rows 3-5 are the whole ticket:
// every one of them is `null`, and every one of them is what `?? false` breaks.
const WIRE = [
  ['{ channelEnabled: true }', { channelEnabled: true }, true, 'the spawn decided: channel'],
  ['{ channelEnabled: false }', { channelEnabled: false }, false, 'the spawn decided: no channel'],
  ['{ channelEnabled: null }', { channelEnabled: null }, null, 'NO SPAWN TO BE ABOUT — CrabCast said so explicitly'],
  ['{} (field absent)', {}, null, 'a peer that does not publish the field at all'],
  ["{ channelEnabled: 'true' }", { channelEnabled: 'true' }, null, 'an unrecognised type is UNKNOWN, never a guess and never false']
];

for (const [label, frame, want, why] of WIRE) {
  const got = readChannelEnabled(frame);
  check(got === want, `${label} → ${JSON.stringify(want)}`, `${why}; got ${JSON.stringify(got)}`);
}

// THE BUILT-IN POSITIVE CONTROL.
//
// Every assertion above is "this reader gave the right answer", and a broken
// instrument gives right answers too if the table is too weak to tell anything
// apart. So the same table is run through the collapsed reader THIS TICKET
// EXISTS TO FORBID, and the table must reject it. If the collapsed twin passes,
// the rows above prove nothing and this script says so rather than going green.
const collapsedTwin = (frame) => frame.channelEnabled ?? false;
const twinDisagreements = WIRE.filter(([, frame, want]) => collapsedTwin(frame) !== want);
check(
  twinDisagreements.length === 3,
  'the collapsed reader `?? false` FAILS 3 of these rows — so the rows can tell them apart',
  `rows it breaks: ${twinDisagreements.map(([l]) => l).join(', ') || 'NONE — this table is worthless'}`
);
check(
  twinDisagreements.every(([, , want]) => want === null),
  'and every row it breaks is a `null` one — the collapse damages exactly the third state',
  twinDisagreements.map(([l, , want]) => `${l} wants ${JSON.stringify(want)}`).join('; ')
);

// ── 3. the adapter keeps the wire's verdict, unflattened ───────────────────
rule('3. CrabCastRuntime — the verdict survives activate_response into the record');

/**
 * A unix socket that answers the four frames a spawn needs, with a
 * `channelEnabled` this script chooses per activation.
 *
 * Deliberately thin. A richer fake would start encoding beliefs about CrabCast
 * that only the live script is entitled to hold — the same rule
 * `verify-crabcast-runtime-switch.mjs` states for its own.
 */
let nextVerdict = { present: true, value: null };
const socketPath = path.join(scratch, 'crabcast.sock');
const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (body) => socket.write(`${JSON.stringify({ ...body, id: req.id })}\n`);
      if (req.action === 'daemon_status') {
        reply({
          action: 'daemon_status_response',
          success: true,
          build: { commit: CRABCAST_PIN },
          contractVersion: CRABCAST_CONTRACT_VERSION
        });
      } else if (req.action === 'list_agents') {
        // NOTE, AND IT IS A FINDING RATHER THAN A SHORTCUT: the real
        // `list_agents` at 8d7348f does NOT carry `channelEnabled` on any row —
        // checked row by row against a live daemon at the pin. This fake omits
        // it for that reason, which is what makes section 3 a fair test of the
        // adapter's only refresh path: there isn't one.
        reply({ action: 'list_agents_response', success: true, agents: [], foreignPanes: [] });
      } else if (req.action === 'configure_agent') {
        reply({ action: 'configure_response', success: true });
      } else if (req.action === 'activate_agent') {
        reply({
          action: 'activate_response',
          success: true,
          sessionId: `crabcast-${Math.abs(req.path.length)}`,
          ...(nextVerdict.present ? { channelEnabled: nextVerdict.value } : {})
        });
      } else if (req.action === 'deactivate_agent') {
        reply({ action: 'deactivate_response', success: true });
      }
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => server.listen(socketPath, resolve));

const link = new CrabCastLink({ socketPath, log: () => {}, reconnectDelayMs: 50 });
const runtime = new CrabCastRuntime({ link, log: () => {}, censusIntervalMs: 10_000 });
await sleep(400);

const spawned = [];
async function spawnWith(key, verdict) {
  nextVerdict = verdict;
  const session = runtime.spawnSession('task', key, undefined, 'kan-294 verdict probe', 1, false, 'shell');
  spawned.push(session);
  for (let i = 0; i < 60 && session.status === 'initializing'; i++) await sleep(50);
  return session;
}

const yes = await spawnWith('kan-294-verdict-true', { present: true, value: true });
const no = await spawnWith('kan-294-verdict-false', { present: true, value: false });
const nul = await spawnWith('kan-294-verdict-null', { present: true, value: null });
const gone = await spawnWith('kan-294-verdict-absent', { present: false, value: undefined });

check(yes.status === 'active', 'the fake wire activated the probe sessions', yes.spawnError ?? yes.status);
check(runtime.channelEnabledFor(yes.sessionId) === true, 'wire true   → channelEnabledFor === true');
check(runtime.channelEnabledFor(no.sessionId) === false, 'wire false  → channelEnabledFor === false');
check(runtime.channelEnabledFor(nul.sessionId) === null, 'wire null   → channelEnabledFor === null, NOT false');
check(
  runtime.channelEnabledFor(gone.sessionId) === null,
  'field absent → channelEnabledFor === null, NOT false'
);
check(
  runtime.channelEnabledFor('a-session-that-never-existed') === null,
  'an unknown session → null: no verdict is not a negative verdict'
);

const tally = runtime.describe().channelEnabled;
check(
  tally.true === 1 && tally.false === 1 && tally.null === 2,
  'describe() counts the three states separately rather than summing to a boolean',
  JSON.stringify(tally)
);

// A spawn that ended has no verdict, because there is no longer a spawn to be
// about. It must read `null` and not keep answering `true`.
runtime.terminateSession(yes.sessionId);
check(
  runtime.channelEnabledFor(yes.sessionId) === null,
  'after termination the verdict is dropped → null, not a stale true'
);

runtime.dispose();
server.close();

// Butchr owns these directories at both ends; CrabCast never made them. Removed
// per path rather than by reverting a directory — `task/KAN-291` lost three
// uncommitted files to a harness that ran `git checkout -- src/`.
for (const session of spawned) {
  const dir = workspaceDirFor('task', session.key);
  if (dir.includes(`${path.sep}workspaces${path.sep}`) && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. the old heuristic is gone from the source, not merely unused ────────
rule('4. the command-line sniff is deleted — asserted against src/daemon.ts');

const daemonSrc = readFileSync(daemonSourceUnderTest, 'utf8');
const codeLines = daemonSrc
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
const code = codeLines.join('\n');

check(
  !/import\s*\{[^}]*\bDEV_CHANNELS_FLAG\b[^}]*\}\s*from\s*'\.\/launchers\.js'/.test(code),
  'daemon.ts does not import DEV_CHANNELS_FLAG — the symbol is gone, not just unread',
  codeLines.filter((l) => l.includes('DEV_CHANNELS_FLAG')).join('\n')
);
check(
  !/\.includes\(\s*DEV_CHANNELS_FLAG\s*\)/.test(code),
  'and no code line searches a command for it',
  codeLines.filter((l) => l.includes('DEV_CHANNELS_FLAG')).join('\n')
);
check(
  /setAgentSpawnedListener\(\(session, spawnedAt, spawn\) => \{\s*\n\s*if \(spawn\.channelEnabled !== true\) return;/.test(
    daemonSrc
  ),
  'the listener branches on the spawn verdict, and on `!== true`',
  'the guard is not `if (spawn.channelEnabled !== true) return;` — see AgentSpawn on why `=== false` is wrong'
);
check(
  !/spawn\.channelEnabled\s*(\?\?|\|\|)\s*false/.test(code) &&
    !/!!\s*spawn\.channelEnabled/.test(code),
  'and nothing flattens the verdict with `?? false`, `|| false` or `!!` on the way past',
  codeLines.filter((l) => l.includes('spawn.channelEnabled')).join('\n')
);

// The symbol still exists, and must: `launchers.ts` composes the flag with it.
// What must not exist is a SECOND reader. This is the sweep that says so.
const launchersSrc = readFileSync(path.join(daemonDir, 'src', 'launchers.ts'), 'utf8');
check(
  launchersSrc.includes("export const DEV_CHANNELS_FLAG"),
  'DEV_CHANNELS_FLAG still exists in launchers.ts — it composes the flag, and deleting it was never the point'
);

// ── 5. the pin and the contract version ────────────────────────────────────
rule('5. the pin — and the contract version, which is new on the wire at it');

check(
  CRABCAST_PIN === '8d7348fa98201b61642d2454b3a797373361128a',
  'CRABCAST_PIN is 8d7348f — the commit the three landings are at',
  CRABCAST_PIN
);
// Moved 3 → 4 by KAN-324 and 4 → 7 → 8 by KAN-357, and the sentence moved with
// it every time because the number on its own says nothing. v4 added
// `unreadableRecords`/`unreadableRecordsTotal` to `list_agents`; v7 added
// `claimsAt`, `claimsEvent` and `standing` to the row shape; v8 changed
// `capacity` only, which this adapter does not read — ruled on rather than
// consumed wholesale, and asserted in `verify-crabcast-standing.mjs` §5 rather
// than left as a claim. The constant was
// only allowed to move once the census actually read them — a bump without that
// reproduces the defect one release later with a green check on top. What
// proves the v4 reading is `verify-crabcast-census-disclosure.mjs` and the v7
// reading is `verify-crabcast-standing.mjs`; what this line still pins is that
// nobody moves the number again without going through one of them.
//
// **This assertion is a tripwire and it has now fired twice on KAN-357**, which
// is the only evidence that it works: each bump made it red, and clearing it
// meant naming the proof above rather than editing a number. The second firing
// is the more useful one — it caught a bump made a day after the first, by the
// same agent, for a different reason.
check(
  CRABCAST_CONTRACT_VERSION === 8,
  'CRABCAST_CONTRACT_VERSION is 8 — v8 was ruled on field by field, not just the number bumped (KAN-357)',
  String(CRABCAST_CONTRACT_VERSION)
);

// An unconnected link has observed nothing, and must say `null` rather than
// echoing the pinned value back — the same distinction as `channelEnabled`, one
// layer down: not-yet-observed is not agreement.
const freshLink = new CrabCastLink({
  socketPath: path.join(scratch, 'nothing-here.sock'),
  log: () => {},
  reconnectDelayMs: 50
});
const described = freshLink.describe();
check(
  described.peerContractVersion === null,
  'an unconnected link reports peerContractVersion: null, not 0 and not the pinned value',
  JSON.stringify(described)
);
check(
  described.pinnedContractVersion === CRABCAST_CONTRACT_VERSION,
  'and reports what it was pinned to alongside it, so an operator can compare',
  JSON.stringify(described)
);
freshLink.close();

// ── verdict ────────────────────────────────────────────────────────────────
say('');
if (failures > 0) {
  say(`FAILED — ${failures} check(s)`);
  if (collapseTristate) {
    say('');
    say('This is the expected red for --collapse-tristate. The behaviour that made it red:');
    say('`readChannelEnabled` returned `false` where the wire said `null` and where the wire');
    say('said nothing, so an agent nothing ever spawned now reports "decided: no channel".');
    say('Re-run without the flag against the real build to see it green.');
  }
  if (restoreSniff) {
    say('');
    say('This is the expected red for --restore-sniff. The behaviour that made it red: the');
    say('listener went back to searching the spawned command line for the channels flag, so');
    say('a runtime whose spawn carries no command line silently supervises nothing.');
  }
} else {
  say('OK — the launcher records its own verdict, the verdict crosses the wire in all three');
  say('states, and nothing reads a command line to guess it.');
  if (collapseTristate) {
    say('');
    say('BUT --collapse-tristate was requested and this went GREEN, which means the patch did');
    say('not take: these assertions are not watching what they claim to watch.');
    failures += 1;
  }
  if (restoreSniff) {
    say('');
    say('BUT --restore-sniff was requested and this went GREEN, which means the patch did not');
    say('take: section 4 is not watching what it claims to watch.');
    failures += 1;
  }
}

process.exit(failures ? 1 : 0);
