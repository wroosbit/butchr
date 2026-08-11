// The launcher's command line, asserted at the string the fleet actually
// spawns: byte-identical to the pre-channels command while the switch is off,
// and carrying the channels flag on BOTH ARMS OF THE `||` while it is on.
//
// WHAT FAILURE THIS WOULD CATCH: a HALF-FLAGGED command line — the channels flag
// on `claude --continue` and not on the `claude '<prompt>'` that runs when
// `--continue` exits 1. That is the failure KAN-217's own harness produced on
// itself, and it is the worst-shaped one available here, because it *works on
// the resumed path*. Every re-activated agent gets a channel; every agent
// starting in a fresh workspace does not, silently, and the fleet looks like it
// has channels until the first cold start needs one. The mirror failure is
// caught too: a build where the switch is not consulted at all, or is consulted
// and ignored, ships `--dangerously-load-development-channels` to every agent on
// the machine and puts a blocking full-screen dialog in front of every
// activation — the brick this whole ticket exists to be careful about.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// It also catches the quieter thing the flag could take with it: section 3
// derives the switch-off string from the switch-on one by deleting the flag, so
// any *other* edit to the command — a lost `--permission-mode`, a changed
// prompt, a restructured `||` — fails here even though both of the obvious
// assertions still pass.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145). THIS SCRIPT SUPPLIES THE SWITCH: it writes `channel.json` into a
// temporary $HOME and then reads the command line the build produces under it.
// So it proves the launcher OBEYS the switch, and nothing whatever about
//
//   * whether a real `claude` accepts the flag it composes,
//   * whether the dialog that flag raises is answered,
//   * whether a channel ever connects.
//
// WHO COVERS THOSE: `probe-channel-launch.mjs`, which activates real agents
// through a real daemon on the shipped `claude` launcher and reads the client's
// own negotiated capabilities off its wire. It is a `probe-` and not a
// `verify-` precisely because it needs a live model, a real herdr and minutes of
// wall clock. Its output is pasted into the KAN-246 PR.
//
// Isolation is by $HOME. `CHANNEL_SWITCH_PATH` derives from `os.homedir()` at
// module load (ipc.ts), so each reading is taken in a CHILD PROCESS under a
// temporary HOME — the fleet's switch at ~/.local/share/butchr/channel.json is
// never read and never written by this script, which matters because writing it
// would turn channels on for every agent on the machine.
//
// Usage: node daemon/scripts/verify-channel-launch-flag.mjs [--one-arm]
//
//   --one-arm   patch a COPY of the build so the flag lands on the first arm
//               only, and watch this proof go red. AC: a gate nobody has seen
//               fail has not been shown to be a gate.
//
// Run it after `npm run build` in daemon/.

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const oneArm = process.argv.includes('--one-arm');

/**
 * The command Butchr spawned before KAN-246, frozen as a literal.
 *
 * Deliberately not imported, derived or reconstructed. The claim being made is
 * "the switch-off path is what it always was", and a claim checked against
 * something the build under test also produces is a claim about self-consistency
 * rather than about history. This string was read off `origin/main` at d869b59.
 */
const PRE_CHANNELS_COMMAND =
  "claude --permission-mode bypassPermissions --continue || " +
  "claude --permission-mode bypassPermissions " +
  "'Please read and follow the instructions in .butchr-prompt.md to begin.'";

const FLAG = '--dangerously-load-development-channels';
const SERVER = 'butchr';
const FLAG_WITH_SERVER = `${FLAG} server:${SERVER}`;

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${detail}`);
  return ok;
};

const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'launchers.js'))) {
  console.error('daemon/dist/launchers.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'butchr-launch-flag-'));
let distUnderTest = dist;

if (oneArm) {
  // The damage is done to a COPY, so a red run cannot leave a broken build
  // behind. It reproduces the specific historical defect: the flag spliced onto
  // the text `claude --permission-mode` only where it is followed by
  // `--continue`, i.e. the resumed arm and not the cold-start one.
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  const target = path.join(distUnderTest, 'launchers.js');
  const source = readFileSync(target, 'utf8');
  const patched = source.replace(
    'return `claude ${flags} --continue || claude ${flags} ${shellQuote(promptCommand)}`;',
    'return `claude ${flags} --continue || claude ' +
      '--permission-mode bypassPermissions ${shellQuote(promptCommand)}`;'
  );
  if (patched === source) {
    console.error('--one-arm could not find the command template to patch; the build has moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  say('--one-arm: patched a copy of the build so only the `--continue` arm is flagged.');
  say('');
}

/**
 * The command line this build produces, read under a private $HOME.
 *
 * A child process because BUTCHR_DIR — and therefore the switch path — is
 * computed from `os.homedir()` when ipc.ts is first imported, so it cannot be
 * changed after the fact inside one process. The child prints nothing but the
 * command, so a stray console.log in the build would be a parse failure here
 * rather than silent contamination of the string being asserted on.
 */
function commandWithSwitch(enabled) {
  const home = mkdtempSync(path.join(scratch, 'home-'));
  if (enabled !== null) {
    mkdirSync(path.join(home, '.local', 'share', 'butchr'), { recursive: true });
    writeFileSync(
      path.join(home, '.local', 'share', 'butchr', 'channel.json'),
      `${JSON.stringify({ enabled }, null, 2)}\n`
    );
  }
  const launchers = pathToUrl(path.join(distUnderTest, 'launchers.js'));
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `import(${JSON.stringify(launchers)}).then((m) => ` +
        `process.stdout.write(m.AGENT_LAUNCHERS.claude.command().command))`
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: home } }
  );
  return out;
}

function pathToUrl(p) {
  return `file://${p}`;
}

say('== 1. switch OFF — the shipped state, and the state this ticket leaves the fleet in ==');
say('');

const off = commandWithSwitch(false);
const absent = commandWithSwitch(null);
say(`  with {"enabled": false}: ${off}`);
say('');
check(
  off === PRE_CHANNELS_COMMAND,
  'byte-identical to the pre-KAN-246 command',
  off === PRE_CHANNELS_COMMAND ? '' : `expected: ${PRE_CHANNELS_COMMAND}`
);
check(
  absent === PRE_CHANNELS_COMMAND,
  'a MISSING switch file is off too, not a crash and not on',
  absent === PRE_CHANNELS_COMMAND ? '' : `got: ${absent}`
);
check(!off.includes(FLAG), 'no channels flag anywhere in it');

say('');
say('== 2. switch ON — both arms of the `||`, independently ==');
say('');

const on = commandWithSwitch(true);
say(`  with {"enabled": true}: ${on}`);
say('');

const arms = on.split(' || ');
check(arms.length === 2, 'the `||` is still exactly one `||` — the structure is not restructured',
  `split into ${arms.length} arm(s)`);

if (arms.length === 2) {
  const [resumed, cold] = arms;
  // Asserted per arm rather than by counting occurrences across the whole
  // string: two flags in one arm and none in the other would satisfy a count.
  check(resumed.includes(FLAG_WITH_SERVER), 'arm 1 (`--continue`) carries the flag', resumed);
  check(cold.includes(FLAG_WITH_SERVER), 'arm 2 (the cold-start prompt) carries the flag', cold);
  check(resumed.trimEnd().endsWith('--continue'), 'arm 1 is still the `--continue` resume attempt');
  check(
    cold.includes("'Please read and follow the instructions in .butchr-prompt.md to begin.'"),
    'arm 2 still carries the shell-quoted bootstrap prompt'
  );
  check(
    resumed.includes('--permission-mode bypassPermissions') &&
      cold.includes('--permission-mode bypassPermissions'),
    'both arms still carry --permission-mode bypassPermissions'
  );
  check(
    resumed.indexOf(FLAG) < resumed.indexOf('--permission-mode'),
    'the flag precedes --permission-mode, the ordering KAN-217 configuration D measured'
  );
}

say('');
say('== 3. the ONLY difference between the two is the flag ==');
say('');

// Delete every occurrence of the flag from the switch-on string and require what
// remains to be the frozen pre-channels literal. This is the assertion that
// catches an unrelated edit riding along with the flag — sections 1 and 2 would
// both still pass if the prompt text changed in both states at once.
const stripped = on.split(`${FLAG_WITH_SERVER} `).join('');
check(
  stripped === PRE_CHANNELS_COMMAND,
  'switch-on minus the flag == the pre-KAN-246 command, exactly',
  stripped === PRE_CHANNELS_COMMAND ? '' : `stripped: ${stripped}`
);

say('');
say('== 4. the flag names the server that carries the channel ==');
say('');

// `server:butchr` and not a probe server or a plugin: the capability KAN-244 put
// on the core MCP server is the one the daemon writes addressed frames to, so a
// flag naming anything else would load a channel nothing ever emits on.
check(on.includes(`${FLAG} server:${SERVER}`), `the flag names \`server:${SERVER}\``);
check(
  !on.includes('server:butchrprobe'),
  'and not the KAN-217 probe server, which no production build should ever name'
);

rmSync(scratch, { recursive: true, force: true });

say('');
if (failures > 0) {
  say(`FAIL: ${failures} check(s) failed.`);
  if (oneArm) {
    say('');
    say('This is the expected red for --one-arm: the cold-start arm lost its flag, so a');
    say('fresh workspace would start a session with no channel while every resumed agent');
    say('kept one. Re-run without --one-arm against the real build to see it green.');
  }
} else {
  say('PASS: the switch is obeyed in both directions and the flag lands on both arms.');
  if (oneArm) {
    say('');
    say('BUT --one-arm was requested and this went GREEN, which means the patch did not');
    say('take: the assertions are not watching what they claim to watch.');
    failures += 1;
  }
}

process.exit(failures ? 1 : 0);
