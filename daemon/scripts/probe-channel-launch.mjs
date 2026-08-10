//
// KAN-246 (T3 of KAN-150) — the live proof that a channel-enabled activation
// gets all the way to a reachable agent, and what it looks like when it does
// not.
//
// THE ONE THING THAT MAKES THIS DIFFERENT FROM EVERY CHANNEL PROBE BEFORE IT.
// KAN-217, KAN-219, KAN-244 and KAN-249 all activate as `defaultAgent: 'shell'`
// and then type a `claude` command line into the pane by hand, splicing the
// channels flag into the product's string — because until this ticket the
// product had no way to pass it. **This probe activates as
// `defaultAgent: 'claude'`.** Nothing is spliced, nothing is typed, and no
// command line is constructed here: the daemon resolves the launcher, the
// launcher reads the switch, and whatever it composes is what runs. If the flag
// were on one arm of the `||`, or on neither, this probe would not know how to
// compensate — which is exactly why its result means something.
//
// NOT a `verify-` script, and must never be renamed into that namespace. It
// drives real `claude` processes, a real herdr, real panes and minutes of wall
// clock. The deterministic halves live in `verify-channel-launch-flag.mjs` (the
// command string) and `verify-channel-startup-supervision.mjs` (the watcher's
// outcomes); what only a live run can show is that the strings those two match
// against are the strings a real Claude Code prints, and that two dialogs is
// what a fresh workspace really raises.
//
// ---------------------------------------------------------------------------
// WHAT IT SHOWS, IN THE ORDER THE TICKET ASKS FOR IT
// ---------------------------------------------------------------------------
//   PHASE 1  A FRESH workspace, activated end to end with channels enabled: the
//            `||` runs `claude` twice, the dialog is raised twice, the daemon
//            answers both, the agent reaches its prompt, and its MCP server
//            registers with the daemon that activated it.        (AC 1)
//   PHASE 2  The SAME workspace re-activated, so `--continue` succeeds: one
//            invocation, one dialog, one answer.                  (AC 2)
//   PHASE 3  THE RED. The same activation against a build whose dialog answerer
//            has been removed — a stand-in for `origin/main`, which has the
//            answerer and the flag alike. The agent is left sitting on a
//            full-screen dialog it will never clear. This is the failure this
//            ticket exists to prevent, reproduced rather than described. (AC 3)
//
// ---------------------------------------------------------------------------
// NOTHING HERE TOUCHES THE FLEET, AND HERE IS THE PRECISE EXTENT OF THAT CLAIM
// ---------------------------------------------------------------------------
// The daemon under test runs under a relocated `$HOME`, so it has its own
// socket, its own workspace root and — the reason this route exists —
// **its own `channel.json`. THE FLEET'S CHANNEL SWITCH IS NEVER READ AND NEVER
// WRITTEN.** That matters more here than in any sibling probe: turning the
// fleet's switch on would put `--dangerously-load-development-channels`, and its
// blocking dialog, in front of every activation on this machine. The recipe is
// `verify-send-interrupts-inflight-work.mjs` by way of
// `probe-briefed-channel-compliance.mjs`; `story/KAN-150` named it in KAN-246's
// own comments rather than authorising a restart of the fleet's daemon.
//
// **THE CAVEAT THAT COMES WITH IT, CARRIED IN FULL: a private `$HOME` gives a
// private DAEMON and NOT a private HERDR.** herdr spawns panes from its own
// environment. Three consequences, all of them live in this script:
//
//   1. The agents this probe starts are REAL panes in the REAL herdr, and they
//      take real capacity — which also means the isolated daemon's capacity gate
//      sees the whole fleet and is doing correct arithmetic about a real machine.
//      Every activation here therefore WAITS for a slot rather than taking one,
//      and `override: true` is never passed; every phase stands its agent down in
//      a `finally`, and one agent is up at a time.
//   2. `~/.claude.json` is herdr's, not ours, so folder trust for the isolated
//      workspaces is written into the REAL file and removed again on exit.
//   3. The agent's MCP server is spawned by the CLIENT, which herdr spawned, so
//      it inherits herdr's real `HOME` and `ipc.ts` resolves the FLEET'S socket
//      from `os.homedir()` — the isolated daemon's identity map would stay empty
//      and readiness could never be observed. KAN-249 met this and fixed it by
//      passing `HOME` in the server's `.mcp.json` env; that route needs a
//      post-activation edit to `.mcp.json`, which a `defaultAgent: 'claude'`
//      activation gives no window for. **So the staged `dist/mcp.js` is a shim
//      that sets `HOME` and execs the real server.** It is the one substitution
//      in this probe, and it exists to RESTORE a property production has for
//      free — in the fleet, daemon and agent share a `$HOME` and the server
//      finds the right socket without help. It fakes no result: the shim sets an
//      environment variable and tees stdio, and every fact this probe reports is
//      produced downstream of it by unmodified product code.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUPPLIES ITSELF, AND WHERE ITS EVIDENCE STOPS
// ---------------------------------------------------------------------------
// It supplies the switch (on, in its own `$HOME`) and the brief. It supplies
// NOTHING about the command line, the dialog, the answer, the pane or the
// connection: the launcher composes the command, Claude Code raises the dialog,
// the daemon's own watcher answers it, and readiness is read out of the daemon's
// identity map and its log.
//
// **WHERE THE EVIDENCE STOPS, AND IT STOPS SHORT OF THE HEADLINE.** A registered
// connection proves the agent's MCP server is up and addressable, and the wire
// proves the client spawned it and negotiated with it. **Neither proves the
// client REGISTERED A CHANNEL with it** — that decision is the client's, is
// taken after `initialize`, and is never told to the server. Claude Code 2.1.226
// can decline a channel for six separately-named reasons (`policy`, `era`,
// `provider`, `disabled`, `capability`, `session`) with the flag on the command
// line and the startup banner printed. So this probe fires one addressed
// message at the agent and reports whether the model acted on it, which is the
// only end-to-end evidence available from outside — and reports a non-answer as
// a non-answer rather than as a failure, because a model may decline on the
// merits (KAN-217 measured exactly that, and KAN-249 measured compliance not
// following the brief).
// **WHO COVERS THE REST:** KAN-248 (T5), the per-agent startup self-check, whose
// whole subject is a client that took the flag and declined the channel anyway.
//
// Usage: node daemon/scripts/probe-channel-launch.mjs [--keep] [--only=1,2,3]
//
//   --keep     leave the agents and the scratch directory up for inspection
//   --only=..  run a subset of the phases (default: all three)
//
// Run it after `npm run build` in daemon/.
//

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { connectDaemonRpc, sleep, yn, BUTCHR_DIR, SOCKET_PATH } from './lib/channel-probe.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');
const realHome = os.homedir();

const KEEP = process.argv.includes('--keep');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const PHASES = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => Number(s.trim()))
  : [1, 2, 3];

const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('='.repeat(78));
  say(title);
  say('='.repeat(78));
};

// A run id keeps two runs, and this probe and the fleet, off each other's
// workspaces and herdr agent names.
const runId = `${process.pid}${Math.floor(process.uptime() * 1000) % 1000}`;
const GREEN_KEY = `KAN-9246${runId.slice(-3)}`;
const RED_KEY = `KAN-9247${runId.slice(-3)}`;
const TYPE = 'task';
const NONCE = `CHANNELUP${runId}`;

/**
 * The brief the daemon writes for these agents.
 *
 * The real `prompts/task.md` sends a task agent to Jira for its ticket, and
 * these keys have none — `verify-send-interrupts-inflight-work.mjs` spent a
 * whole run discovering that, and an agent arguing with its brief is not what is
 * being measured. So: a preamble that parks the agent, plus **the real file's
 * channel section, spliced out verbatim**, so what it knows about the channel is
 * what a fleet agent knows, byte for byte.
 */
const PREAMBLE = `# Probe target — KAN-246 channel launch

You are a probe target. There is no Jira ticket for this key and no repository
to clone. **Do not look for either.**

Your entire job is to sit at your prompt and wait. Do not read files, do not run
commands, do not start work of any kind.

If — and only if — a message arrives over your channel asking you to echo a
token, reply with that token as a single line of plain text and nothing else.
Then go back to waiting.

`;

/** The `## Whose voice is this?` section of prompts/task.md, verbatim. */
function channelSection() {
  const src = fs.readFileSync(path.join(repoRoot, 'prompts', 'task.md'), 'utf8');
  const start = src.search(/^## .*Whose voice is this\?/m);
  if (start === -1) throw new Error('no "Whose voice is this?" section in prompts/task.md');
  const rest = src.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * The staged `dist/mcp.js`: set `HOME`, then be the real server, teeing the wire.
 *
 * See the header for why this exists. It is deliberately the smallest thing that
 * restores production's shared-`$HOME` property — it does not import the product,
 * it spawns it, so the server under test is byte-identical to the shipped one.
 */
const MCP_SHIM = (home, realMcp, wireLog, stderrLog) => `
import fs from 'fs';
import { spawn } from 'child_process';
const WIRE = ${JSON.stringify(wireLog)};
const rec = (dir, line) => {
  if (!line.trim()) return;
  let frame; try { frame = JSON.parse(line); } catch { frame = { unparsed: line }; }
  try { fs.appendFileSync(WIRE, JSON.stringify({ t: Date.now(), dir, frame }) + '\\n'); } catch {}
};
const child = spawn(process.execPath, [${JSON.stringify(realMcp)}, ...process.argv.slice(2)], {
  env: { ...process.env, HOME: ${JSON.stringify(home)} },
  stdio: ['pipe', 'pipe', fs.openSync(${JSON.stringify(stderrLog)}, 'a')]
});
child.on('error', (e) => rec('shim-error', JSON.stringify({ error: String(e.message) })));
let up = '';
process.stdin.on('data', (c) => {
  up += c.toString('utf8'); let i;
  while ((i = up.indexOf('\\n')) !== -1) { rec('client->server', up.slice(0, i)); up = up.slice(i + 1); }
  child.stdin.write(c);
});
let down = '';
child.stdout.on('data', (c) => {
  down += c.toString('utf8'); let i;
  while ((i = down.indexOf('\\n')) !== -1) { rec('server->client', down.slice(0, i)); down = down.slice(i + 1); }
  process.stdout.write(c);
});
child.on('exit', (code) => process.exit(code ?? 0));
`;

// ---------------------------------------------------------------- preflight --

if (!fs.existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  say('ABORTING: daemon/dist/daemon.js is missing — run `cd daemon && npm run build`.');
  process.exit(1);
}
if (!fs.existsSync(path.join(daemonDir, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'))) {
  say('ABORTING: node-pty has no compiled native module here, so a staged daemon would die');
  say(`on startup and be reported as a socket that never appeared.  cd ${daemonDir} && npm rebuild node-pty`);
  process.exit(1);
}

let clientVersion = '(unknown)';
try {
  clientVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  say('ABORTING: no `claude` on PATH. This probe drives the real client.');
  process.exit(1);
}

// The fleet's capacity, read from the fleet's own daemon — the isolated one sees
// only its own agent and would never refuse. This is the only thing this script
// asks of the live daemon, and it is a read.
let headroom = null;
try {
  const fleet = await connectDaemonRpc(SOCKET_PATH);
  const cap = await fleet.call('capacity');
  headroom = cap?.headroom ?? null;
  say(`fleet capacity (read from the live daemon): ${cap?.reason ?? '(none)'} ` +
      `[cap=${cap?.cap} running=${cap?.running} headroom=${cap?.headroom}]`);
  fleet.close();
} catch (e) {
  say(`NOTE: could not read the fleet's capacity (${e?.message}); continuing.`);
}
if (typeof headroom === 'number' && headroom < 1) {
  say('NOTE: the machine has no headroom right now. Not aborting on this reading — it is a');
  say('      courtesy check and the binding constraint flips minute to minute on a 4-core');
  say('      box. The real gate is the isolated daemon\'s own, which sees the same fleet');
  say('      through the shared herdr and which this probe WAITS on rather than overrides.');
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-kan246-'));
say(`client version : ${clientVersion}`);
say(`run id         : ${runId}`);
say(`scratch        : ${scratch}`);
say(`phases         : ${PHASES.join(', ')}`);

const daemons = [];
const trustAdded = [];
const results = {};

/** Read-modify-write the REAL ~/.claude.json atomically, or leave it alone. */
function editRealClaudeConfig(mutate) {
  const p = path.join(realHome, '.claude.json');
  try {
    if (!fs.existsSync(p)) return false;
    const config = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!mutate(config)) return false;
    const tmp = `${p}.kan246-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    say(`  (could not edit ${p}: ${e?.message ?? e})`);
    return false;
  }
}

process.on('exit', () => {
  for (const d of daemons) { try { d.proc.kill('SIGKILL'); } catch {} }
  for (const key of trustAdded) {
    editRealClaudeConfig((config) => {
      if (!config.projects?.[key]) return false;
      delete config.projects[key];
      return true;
    });
  }
});

/**
 * Stage one isolated daemon and start it.
 *
 * `removeAnswerer` is phase 3's whole apparatus: it patches the COPIED
 * `daemon.js` so the channel-startup watcher returns immediately. That build is
 * a stand-in for a world in which the flag ships and nothing answers the dialog —
 * which is what `origin/main` plus the flag alone would be, and what this ticket
 * exists to not do.
 */
async function stageDaemon(label, { key, removeAnswerer = false }) {
  const root = path.join(scratch, label);
  const home = path.join(root, 'home');
  const stagedRepo = path.join(root, 'repo');
  const distDir = path.join(stagedRepo, 'daemon', 'dist');
  const wireDir = path.join(root, 'wire');

  fs.mkdirSync(path.join(stagedRepo, 'prompts'), { recursive: true });
  fs.mkdirSync(path.dirname(distDir), { recursive: true });
  fs.mkdirSync(wireDir, { recursive: true });
  fs.cpSync(path.join(daemonDir, 'dist'), distDir, { recursive: true });
  for (const name of ['package.json', 'node_modules']) {
    fs.symlinkSync(path.join(daemonDir, name), path.join(stagedRepo, 'daemon', name));
  }

  // The brief, written by the PRODUCT from the staged prompts at activation.
  fs.writeFileSync(path.join(stagedRepo, 'prompts', 'task.md'), PREAMBLE + channelSection());

  // The mcp.js shim — see the header.
  const wireLog = path.join(wireDir, 'wire.log');
  const stderrLog = path.join(wireDir, 'stderr.log');
  fs.writeFileSync(wireLog, '');
  fs.writeFileSync(stderrLog, '');
  fs.renameSync(path.join(distDir, 'mcp.js'), path.join(distDir, 'mcp.real.js'));
  fs.writeFileSync(
    path.join(distDir, 'mcp.js'),
    MCP_SHIM(home, path.join(distDir, 'mcp.real.js'), wireLog, stderrLog)
  );

  if (removeAnswerer) {
    const target = path.join(distDir, 'daemon.js');
    const source = fs.readFileSync(target, 'utf8');
    // Matched by shape rather than by an exact argument list: the listener's
    // signature has already changed once during this ticket, and a patch that
    // silently found nothing would produce a "red" phase that is really a green
    // build — the worst possible outcome for the section whose whole job is to
    // show the failure. It throws instead.
    const marker = /herdrBridge\.setAgentSpawnedListener\(\([^)]*\) => \{/;
    if (!marker.test(source)) {
      throw new Error('could not find the channel-startup watcher in the built daemon to remove');
    }
    fs.writeFileSync(target, source.replace(marker, (m) => `${m}\n    return;`));
    say(`  [${label}] patched the copied build so NOTHING answers the dialog`);
  }

  fs.mkdirSync(home, { recursive: true });
  for (const name of ['.claude', '.claude.json']) {
    const target = path.join(realHome, name);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(home, name));
  }
  fs.mkdirSync(path.join(home, '.local'), { recursive: true });
  if (fs.existsSync(path.join(realHome, '.local', 'bin'))) {
    fs.symlinkSync(path.join(realHome, '.local', 'bin'), path.join(home, '.local', 'bin'));
  }

  // Credentials COPIED, never symlinked: this run must not be able to write to
  // the real ones. Nothing here reads or prints their contents.
  // `agent-cost.json` is the capacity gate's calibration — copying it is giving
  // a guard its data, not bypassing one (KAN-249's note).
  const fakeButchrDir = path.join(home, '.local', 'share', 'butchr');
  fs.mkdirSync(fakeButchrDir, { recursive: true });
  if (fs.existsSync(BUTCHR_DIR)) {
    for (const name of fs.readdirSync(BUTCHR_DIR)) {
      if (name === 'integrations.json' || name === 'agent-cost.json' || name.endsWith('-credential.json')) {
        fs.copyFileSync(path.join(BUTCHR_DIR, name), path.join(fakeButchrDir, name));
      }
    }
  }

  // herdr reads the REAL ~/.claude.json however isolated this daemon is.
  const ws = path.join(fakeButchrDir, 'workspaces', TYPE, key.toLowerCase());
  fs.mkdirSync(ws, { recursive: true });
  const trustKey = path.normalize(path.resolve(ws));
  if (editRealClaudeConfig((config) => {
    if (config.projects?.[trustKey]?.hasTrustDialogAccepted === true) return false;
    config.projects = { ...config.projects, [trustKey]: { hasTrustDialogAccepted: true } };
    return true;
  })) trustAdded.push(trustKey);

  const socketPath = path.join(fakeButchrDir, 'butchr.sock');
  const daemonLog = path.join(fakeButchrDir, 'daemon.log');
  const proc = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdio = [];
  proc.stdout.on('data', (c) => stdio.push(c.toString()));
  proc.stderr.on('data', (c) => stdio.push(c.toString()));
  daemons.push({ proc, stdio });

  for (let i = 0; i < 120 && !fs.existsSync(socketPath); i += 1) await sleep(250);
  if (!fs.existsSync(socketPath)) {
    throw new Error(`[${label}] daemon never claimed ${socketPath}\n${stdio.join('').slice(-1500)}`);
  }
  const { call, close } = await connectDaemonRpc(socketPath);

  say(`  [${label}] staged dist   : ${distDir}`);
  say(`  [${label}] isolated HOME : ${home}`);
  say(`  [${label}] its socket    : ${socketPath}`);
  return { label, home, distDir, fakeButchrDir, socketPath, call, close, ws, daemonLog, wireDir, key };
}

/** Everything the daemon's channel watcher has said so far, in order. */
function startupLines(side) {
  try {
    return fs.readFileSync(side.daemonLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('[ChannelStartup]'));
  } catch {
    return [];
  }
}

/** The client's own `initialize` result off this agent's wire, if it got that far. */
function negotiated(side) {
  try {
    for (const line of fs.readFileSync(path.join(side.wireDir, 'wire.log'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      const caps = rec?.frame?.result?.capabilities;
      if (rec.dir === 'server->client' && caps) {
        return { up: true, channel: Boolean(caps.experimental?.['claude/channel']), capabilities: caps };
      }
    }
  } catch {}
  return { up: false, channel: false, capabilities: null };
}

const PROMPT_READY = /for shortcuts|Bypassing Permissions|bypass permissions/i;
const DIALOG_ON_PANE = /Loading development channels|I am using this for local development/;

/** Poll until the watcher reports an outcome, or the wait runs out. */
async function awaitStartupOutcome(side, { attempts = 60, intervalMs = 3000, since = 0 } = {}) {
  // `since` is the log length before THIS activation. Without it phase 2 reads
  // phase 1's verdict and reports it as its own — which is exactly what run 2 of
  // this probe did: it announced the resumed path ready having answered zero
  // dialogs, because the `ready` line it matched belonged to the fresh path
  // twenty lines earlier. A probe that reads a stale success is worse than one
  // that reads nothing.
  for (let i = 0; i < attempts; i += 1) {
    const lines = startupLines(side).slice(since);
    const ready = lines.find((l) => /: ready after \d+ms/.test(l));
    const gaveUp = lines.find((l) => /GIVING UP/.test(l));
    if (ready) return { outcome: 'ready', line: ready, lines };
    if (gaveUp) return { outcome: 'gave-up', line: gaveUp, lines };
    await sleep(intervalMs);
  }
  return { outcome: 'timeout', line: null, lines: startupLines(side).slice(since) };
}

/**
 * Activate, waiting for a slot rather than taking one.
 *
 * The isolated daemon can see the fleet — herdr is shared — so its capacity gate
 * is doing correct arithmetic about a real machine, and a refusal here is the
 * guard working. **Never `override: true`**, which `bringUpChannelAgent` bans for
 * two reasons that both apply: it pushes a loaded machine past its own guard
 * while other agents are working, and every timing this probe reads would then
 * be a timing off a machine this probe overloaded. Waiting costs minutes.
 *
 * The wait is needed rather than nice: this machine has four cores and routinely
 * runs six task agents, so the binding constraint flips between memory and CPU
 * minute to minute. A one-shot activation reports "the probe failed" for what is
 * really "come back in five minutes".
 */
async function activateWaitingForRoom(side, key, { budgetMs = 1_200_000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let act = await side.call('activate_by_key', { type: TYPE, key, defaultAgent: 'claude' });
  if (act?.success) return act;
  say(`  refused: ${String(act?.error ?? '').split('\n')[0]}`);
  say(`  waiting for a slot rather than overriding — up to ${Math.round(budgetMs / 60000)} minutes…`);
  while (!act?.success && Date.now() < deadline) {
    await sleep(30000);
    act = await side.call('activate_by_key', { type: TYPE, key, defaultAgent: 'claude' });
    if (!act?.success) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      say(`    still refused (${String(act?.error ?? '').split('\n')[0].slice(0, 100)}…) — ${left}s left`);
    }
  }
  return act;
}

async function tail(side, key, lines = 120) {
  const res = await side.call('tail_agent', { key, type: TYPE, lines });
  return res?.text ?? '';
}

let verdict = { ranToVerdict: false };
const green = { phase1: null, phase2: null, phase3: null };

try {
  // =====================================================================
  if (PHASES.includes(1) || PHASES.includes(2)) {
    rule('STAGING — an isolated daemon from THIS build, with its own channel switch');
    const side = await stageDaemon('green', { key: GREEN_KEY });

    const sw = await side.call('channel_switch', { enabled: true });
    say(`  channel switch: ${JSON.stringify(sw)}`);
    if (sw?.enabled !== true) throw new Error('the isolated switch would not enable');
    say('  (that is a channel.json inside this run\'s own $HOME — the fleet\'s is untouched)');

    // THE COMMAND THIS DAEMON WILL SPAWN, read out of the staged build under the
    // staged $HOME. Printed, not asserted: `verify-channel-launch-flag.mjs` is
    // what asserts it. What matters here is that the reader can see the string
    // this probe did NOT construct.
    const composed = execFileSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(`file://${path.join(side.distDir, 'launchers.js')}`)})` +
        `.then((m) => process.stdout.write(m.AGENT_LAUNCHERS.claude.command()))`],
      { encoding: 'utf8', env: { ...process.env, HOME: side.home } }
    );
    say('');
    say('  the command the LAUNCHER composes for this activation (nothing here spliced it):');
    say(`    ${composed}`);

    if (PHASES.includes(1)) {
      rule('PHASE 1 — a FRESH workspace, activated as `claude`, channels on   (AC 1)');
      say('Fresh means: no conversation on disk, so `claude --continue` exits 1 and the');
      say('`||` runs `claude` a second time — two invocations, and therefore two dialogs.');
      say('');
      const startupLinesBefore = startupLines(side).length;
      const act = await activateWaitingForRoom(side, GREEN_KEY);
      say(`  activate_by_key → success=${act?.success} verified=${act?.verified}`);
      if (!act?.success) throw new Error(`activation refused: ${act?.error ?? JSON.stringify(act)}`);

      const outcome = await awaitStartupOutcome(side, { since: startupLinesBefore });
      say('');
      say('  what the daemon\'s own watcher said, verbatim from its log:');
      for (const l of outcome.lines) say(`    | ${l.trim()}`);

      const dialogs = outcome.lines.filter((l) => /development-channels dialog #/.test(l)).length;
      const paneText = await tail(side, GREEN_KEY);
      const conn = await side.call('connected_agents');
      const neg = negotiated(side);

      say('');
      say(`  blocking dialogs raised and answered BY THE DAEMON : ${dialogs}`);
      say(`  the watcher reported ready                         : ${yn(outcome.outcome === 'ready')}`);
      say(`  the agent reached its prompt                       : ${yn(PROMPT_READY.test(paneText))}`);
      say(`  a dialog is still on the pane                      : ${yn(DIALOG_ON_PANE.test(paneText))}`);
      say(`  the daemon's identity map                          : ${JSON.stringify(conn?.agents ?? [])}`);
      say(`  the client spawned and negotiated with its server  : ${yn(neg.up)}`);
      say(`  that server declared experimental['claude/channel']: ${yn(neg.channel)}`);
      say(`  the "Channels (experimental)" banner is on the pane: ` +
          `${yn(/Channels \(experimental\)/.test(paneText))}   ` +
          `(reported, NOT counted — KAN-217 saw it printed over a crashed server)`);
      say('');
      say('  the last of the pane:');
      for (const l of paneText.split('\n').slice(-25)) say(`    | ${l}`);

      green.phase1 = {
        dialogs,
        ready: outcome.outcome === 'ready',
        reachedPrompt: PROMPT_READY.test(paneText),
        stuck: DIALOG_ON_PANE.test(paneText),
        mapped: (conn?.agents ?? []).some((e) => e.key.toLowerCase() === GREEN_KEY.toLowerCase()),
        negotiated: neg.up,
        declaredChannel: neg.channel
      };

      // ------------------------------------------------ the end-to-end leg --
      rule('PHASE 1b — one addressed message, to see whether the channel is really live');
      say('The daemon-side facts above prove a SERVER is reachable. Only the model can show');
      say('that the CLIENT registered a channel with it, so: one message, over the product\'s');
      say('own send, and whatever the model does with it is reported as-is.');
      say('');
      const send = await side.call('send_to_agent', {
        key: GREEN_KEY,
        type: TYPE,
        message: `Channel check for KAN-246. Please reply with exactly this token on a line ` +
          `of its own and nothing else: ${NONCE}`,
        workspaceType: 'task',
        workspaceKey: 'KAN-246'
      });
      say(`  transport              : ${send?.transport ?? '(none)'}`);
      say(`  transportChosenBecause : ${send?.transportChosenBecause ?? '(none)'}`);
      say(`  licenses               : ${send?.licenses ?? '(none)'}`);

      // THE GUARD THAT MAKES THIS HARNESS SAFE. A composer send from an isolated
      // daemon reaches a REAL pane in the live fleet — herdr is not isolated by
      // $HOME — and its Ctrl+C destroys a working agent's tool call. Abort, never
      // fall back.
      if (send?.transport !== 'channel') {
        say('');
        say('  ABORTING PHASE 1b: the send did not take the channel. A composer send from an');
        say('  isolated daemon types into a REAL fleet pane and kills a working agent\'s tool');
        say('  call, so this stops rather than continuing.');
        green.phase1.echoed = null;
      } else {
        let echoed = false;
        for (let i = 0; i < 24 && !echoed; i += 1) {
          await sleep(5000);
          const t = await tail(side, GREEN_KEY, 160);
          // The nonce is in this script and in the message, never on the agent's
          // disk — so it cannot appear on that pane except by having arrived.
          echoed = t.replace(/\s/g, '').includes(NONCE);
        }
        say('');
        say(`  the model echoed the token back on its pane: ${yn(echoed)}`);
        if (!echoed) {
          say('  A non-answer is reported as a non-answer. KAN-217 measured a session receiving');
          say('  a channel event perfectly and declining to act on it; from outside, that is');
          say('  indistinguishable from a transport that did not deliver. It does not weaken');
          say('  the readiness claim above, which rests on the daemon\'s own map.');
        }
        green.phase1.echoed = echoed;
        const t = await tail(side, GREEN_KEY, 60);
        say('  the last of the pane:');
        for (const l of t.split('\n').slice(-20)) say(`    | ${l}`);
      }
    }

    // =====================================================================
    if (PHASES.includes(2)) {
      rule('PHASE 2 — THE RESUMED PATH: `--continue` succeeds, so ONE dialog   (AC 2)');
      say('The pane is closed and the same workspace re-activated. There is a conversation on');
      say('disk now, so the first arm of the `||` succeeds and the second never runs.');
      say('');
      const before = startupLines(side).length;
      await side.call('deactivate_by_key', { type: TYPE, key: GREEN_KEY });
      await sleep(4000);

      const act = await activateWaitingForRoom(side, GREEN_KEY);
      say(`  activate_by_key → success=${act?.success} verified=${act?.verified}`);
      if (!act?.success) throw new Error(`re-activation refused: ${act?.error ?? JSON.stringify(act)}`);

      const outcome = await awaitStartupOutcome(side, { since: before });
      const fresh = outcome.lines;
      say('');
      say('  what the watcher said about THIS activation:');
      for (const l of fresh) say(`    | ${l.trim()}`);

      const dialogs = fresh.filter((l) => /development-channels dialog #/.test(l)).length;
      const paneText = await tail(side, GREEN_KEY);
      say('');
      say(`  blocking dialogs on the resumed path : ${dialogs}   (one invocation, one dialog)`);
      say(`  the watcher reported ready           : ${yn(outcome.outcome === 'ready')}`);
      say(`  the agent reached its prompt         : ${yn(PROMPT_READY.test(paneText))}`);
      say(`  a dialog is still on the pane        : ${yn(DIALOG_ON_PANE.test(paneText))}`);
      say('');
      say('  the last of the pane:');
      for (const l of paneText.split('\n').slice(-20)) say(`    | ${l}`);

      green.phase2 = {
        dialogs,
        ready: outcome.outcome === 'ready',
        reachedPrompt: PROMPT_READY.test(paneText),
        stuck: DIALOG_ON_PANE.test(paneText)
      };
    }

    if (!KEEP) {
      say('');
      say('  standing the green agent down and deleting its workspace…');
      await side.call('deactivate_by_key', { type: TYPE, key: GREEN_KEY });
      await sleep(2000);
      await side.call('reset_by_key', { type: TYPE, key: GREEN_KEY });
      await sleep(1500);
    }
    side.close();
  }

  // =====================================================================
  if (PHASES.includes(3)) {
    rule('PHASE 3 — THE RED: the flag, and nothing answering the dialog   (AC 3)');
    say('The same activation against a build whose channel-startup watcher has been removed');
    say('from the COPIED dist. That is the world this ticket could have shipped: the flag on');
    say('both arms and nobody to press Enter. It is also what `origin/main` would be if the');
    say('flag were added without the answerer, so it is the pre-fix build the failure needs.');
    say('');
    const side = await stageDaemon('red', { key: RED_KEY, removeAnswerer: true });
    const sw = await side.call('channel_switch', { enabled: true });
    say(`  channel switch: ${JSON.stringify(sw)}`);
    if (sw?.enabled !== true) throw new Error('the isolated switch would not enable');

    const act = await activateWaitingForRoom(side, RED_KEY);
    if (!act?.success) throw new Error(`red activation refused: ${act?.error ?? JSON.stringify(act)}`);
    say('');
    say(`  activate_by_key → success=${act?.success} verified=${act?.verified}`);
    say('  ^ NOTE THIS. The activation reports success and `verified: true`, because herdr');
    say('    can see a live `claude` runtime behind the pane — and it is live. It is');
    say('    rendering a full-screen dialog. `verified` has always meant "a runtime exists"');
    say('    (KAN-58), and this is the case where that is true and useless.');

    // Long enough that "it is just slow" is not an available explanation: the
    // green path above reaches its prompt in well under a minute.
    for (const wait of [30, 60, 90]) {
      await sleep(30000);
      const t = await tail(side, RED_KEY);
      say('');
      say(`  --- t+${wait}s ---`);
      say(`  a dialog is on the pane      : ${yn(DIALOG_ON_PANE.test(t))}`);
      say(`  the agent reached its prompt : ${yn(PROMPT_READY.test(t))}`);
    }

    const t = await tail(side, RED_KEY);
    const conn = await side.call('connected_agents');
    const lines = startupLines(side);
    say('');
    say(`  the watcher said (should be nothing — it was removed): ${lines.length} line(s)`);
    say(`  the daemon's identity map: ${JSON.stringify(conn?.agents ?? [])}`);
    say('  ^ empty: no MCP server was ever spawned, because the client spawns them only');
    say('    after the dialog clears. An addressed frame at this agent would answer');
    say('    `no-connection`, and a channel event fired at it would be lost in silence.');
    say('');
    say('  the pane, in full:');
    for (const l of t.split('\n').slice(-40)) say(`    | ${l}`);

    green.phase3 = {
      stuck: DIALOG_ON_PANE.test(t),
      reachedPrompt: PROMPT_READY.test(t),
      mapped: (conn?.agents ?? []).length > 0,
      watcherLines: lines.length
    };

    if (!KEEP) {
      say('');
      say('  standing the wedged agent down and deleting its workspace…');
      await side.call('deactivate_by_key', { type: TYPE, key: RED_KEY });
      await sleep(2000);
      await side.call('reset_by_key', { type: TYPE, key: RED_KEY });
      await sleep(1500);
    }
    side.close();
  }

  // =====================================================================
  rule('VERDICT');
  const p1 = green.phase1;
  const p2 = green.phase2;
  const p3 = green.phase3;

  if (p1) {
    say(`AC1  fresh activation, channels on: ${p1.dialogs} dialog(s) answered by the daemon, ` +
        `ready=${yn(p1.ready)}, prompt=${yn(p1.reachedPrompt)}, in the identity map=${yn(p1.mapped)}`);
    say(`     the client negotiated with the channel server: ${yn(p1.negotiated)}` +
        `, which declared claude/channel: ${yn(p1.declaredChannel)}`);
    say(`     the model echoed a token sent over the channel: ` +
        `${p1.echoed === null ? 'NOT ASKED (send did not take the channel)' : yn(p1.echoed)}`);
  }
  if (p2) {
    say(`AC2  resumed activation: ${p2.dialogs} dialog(s), ready=${yn(p2.ready)}, ` +
        `prompt=${yn(p2.reachedPrompt)}`);
  }
  if (p3) {
    say(`AC3  with nothing answering: still on the dialog=${yn(p3.stuck)}, ` +
        `reached its prompt=${yn(p3.reachedPrompt)}, any MCP server connected=${yn(p3.mapped)}`);
  }

  const ok =
    (!PHASES.includes(1) || (p1 && p1.dialogs >= 1 && p1.ready && p1.reachedPrompt && !p1.stuck && p1.mapped)) &&
    (!PHASES.includes(2) || (p2 && p2.ready && p2.reachedPrompt && !p2.stuck)) &&
    (!PHASES.includes(3) || (p3 && p3.stuck && !p3.reachedPrompt && !p3.mapped));

  say('');
  if (ok) {
    say('PASS: with the daemon answering, a channel-enabled activation reaches its prompt and');
    say('      becomes addressable on both the fresh and the resumed path. Without it, the');
    say('      agent sits on a dialog it will never clear — which is the whole reason this');
    say('      ticket ships an answerer and a kill switch rather than only a flag.');
  } else {
    say('FAIL: at least one phase did not do what it must. Read the phases above — the pane');
    say('      dumps are the evidence, not this line.');
  }
  verdict = { ranToVerdict: true, ok, ...green };
} catch (e) {
  say('');
  say(`PROBE ERROR: ${e?.stack ?? e}`);
  for (const d of daemons) {
    const tail = d.stdio.join('').slice(-800);
    if (tail) say(`  a daemon's last words: ${tail}`);
  }
  verdict = { ranToVerdict: false, blocked: String(e?.message ?? e) };
} finally {
  for (const d of daemons) { try { d.proc.kill(); } catch {} }
  await sleep(1000);
}

say('');
say(`scratch kept at: ${scratch}`);
say(`client version this result is scoped to: ${clientVersion}`);
if (!verdict.ranToVerdict) {
  say('');
  say(`NOT TRUSTWORTHY: this run did not reach a verdict — ${verdict.blocked ?? 'see above'}.`);
}
process.exit(verdict.ranToVerdict && verdict.ok ? 0 : 1);
