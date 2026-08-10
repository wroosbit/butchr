//
// Standing up a REAL Butchr daemon that is not the fleet's, and activating a
// REAL channel-enabled agent against it.
//
// EXTRACTED FROM `probe-channel-launch.mjs` BY KAN-248, NOT REWRITTEN. KAN-246
// built this staging to prove that a channel-enabled activation reaches its
// prompt; KAN-248 needs the identical bring-up in order to prove the next thing
// along — that a message crosses the socket that activation produced. Copying
// 150 lines of it into a second probe would have made a second place for the
// `HOME` shim, the trust editing and the credential handling to drift, which is
// the KAN-145 shape and is exactly the reason KAN-219 extracted
// `lib/channel-probe.mjs` rather than copying `probe-channel-delivery.mjs`.
//
// The one thing that did NOT come across is `removeAnswerer`: patching the
// copied build is each probe's own business, so `stageIsolatedDaemon` takes a
// `patchDist` callback and knows nothing about what any caller does to it.
//
// WHAT THIS MODULE IS NOT: it is not a `verify-` script and must never be
// renamed into that namespace. It drives real `claude` processes, real herdr
// panes and minutes of wall clock. It has no top-level side effects — a probe
// must be able to import it without something starting.
//
// ---------------------------------------------------------------------------
// THE CAVEAT, CARRIED IN FULL BECAUSE IT IS LOAD-BEARING AND EASY TO FORGET
// ---------------------------------------------------------------------------
// **A private `$HOME` gives a private DAEMON and NOT a private HERDR.** herdr
// spawns panes from its own environment, so:
//
//   1. The agents a probe starts here are REAL panes in the REAL herdr and take
//      real capacity. Use {@link activateWaitingForRoom} and never
//      `override: true`; stand every agent down in a `finally`.
//   2. `~/.claude.json` is herdr's, not ours, so folder trust for an isolated
//      workspace is written into the REAL file — and removed again on exit.
//   3. The agent's MCP server is spawned by the CLIENT, which herdr spawned, so
//      it inherits herdr's real `HOME` and `ipc.ts` resolves the FLEET'S socket
//      from `os.homedir()`. The isolated daemon's identity map would stay empty
//      and nothing about reachability could be observed. **That is what
//      {@link MCP_SHIM} exists to fix**: the staged `dist/mcp.js` sets `HOME` and
//      execs the real server. It RESTORES a property production has for free —
//      in the fleet, daemon and agent share a `$HOME` — and fakes no result: it
//      sets an environment variable and tees stdio, and everything downstream of
//      it is unmodified product code.
//   4. **A composer send from an "isolated" daemon reaches the live fleet.**
//      Every caller that sends must check `transport` on the response and abort
//      rather than fall back, or its Ctrl+C destroys a working agent's tool call.
//
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { connectDaemonRpc, sleep, BUTCHR_DIR } from './channel-probe.mjs';

const libDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(libDir, '..', '..', '..');
export const daemonDir = path.join(repoRoot, 'daemon');
const realHome = os.homedir();

/** A Claude Code session sitting at its prompt, as it appears on a pane. */
export const PROMPT_READY = /for shortcuts|Bypassing Permissions|bypass permissions/i;
/** The blocking development-channels dialog, as it appears on a pane. */
export const DIALOG_ON_PANE = /Loading development channels|I am using this for local development/;

/**
 * The staged `dist/mcp.js`: set `HOME`, then be the real server, teeing the wire.
 *
 * Deliberately the smallest thing that restores production's shared-`$HOME`
 * property — it does not import the product, it spawns it, so the server under
 * test is byte-identical to the shipped one.
 */
export const MCP_SHIM = (home, realMcp, wireLog, stderrLog) => `
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

/** Every daemon this process staged, so an exit handler can kill them all. */
const staged = [];
/** Trust entries written into the REAL ~/.claude.json, to be removed on exit. */
const trustAdded = [];
let exitHookInstalled = false;

/** Read-modify-write the REAL ~/.claude.json atomically, or leave it alone. */
export function editRealClaudeConfig(mutate, say = () => {}) {
  const p = path.join(realHome, '.claude.json');
  try {
    if (!fs.existsSync(p)) return false;
    const config = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!mutate(config)) return false;
    const tmp = `${p}.probe-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    say(`  (could not edit ${p}: ${e?.message ?? e})`);
    return false;
  }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const d of staged) {
      try {
        d.proc.kill('SIGKILL');
      } catch {}
    }
    for (const key of trustAdded) {
      editRealClaudeConfig((config) => {
        if (!config.projects?.[key]) return false;
        delete config.projects[key];
        return true;
      });
    }
  });
}

/** Everything a staged daemon's own log has said with `marker` in it, in order. */
export function daemonLogLines(side, marker) {
  try {
    return fs
      .readFileSync(side.daemonLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes(marker));
  } catch {
    return [];
  }
}

/** Everything the channel-startup watcher has said so far, in order. */
export const startupLines = (side) => daemonLogLines(side, '[ChannelStartup]');

/**
 * The server's own `initialize` result off this agent's teed wire.
 *
 * Reports what OUR server declared and that the client got far enough to
 * negotiate with it. It says nothing about what the CLIENT decided to do with
 * that declaration — see `channel-selfcheck.ts` on why that is unobservable.
 */
export function negotiated(side) {
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

/** The client's own `initialize` REQUEST off the wire — who it says it is. */
export function clientHandshake(side) {
  try {
    for (const line of fs.readFileSync(path.join(side.wireDir, 'wire.log'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.dir === 'client->server' && rec?.frame?.method === 'initialize') {
        return {
          clientInfo: rec.frame.params?.clientInfo ?? null,
          capabilities: rec.frame.params?.capabilities ?? null,
          protocolVersion: rec.frame.params?.protocolVersion ?? null
        };
      }
    }
  } catch {}
  return null;
}

/** Every frame of a given method that left our server on this agent's wire. */
export function outboundFrames(side, method) {
  const out = [];
  try {
    for (const line of fs.readFileSync(path.join(side.wireDir, 'wire.log'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.dir === 'server->client' && rec?.frame?.method === method) out.push(rec.frame);
    }
  } catch {}
  return out;
}

/** Poll a staged daemon's log until its channel watcher reports an outcome. */
export async function awaitStartupOutcome(side, { attempts = 60, intervalMs = 3000, since = 0 } = {}) {
  // `since` is the log length before THIS activation. Without it a second
  // activation reads the first one's verdict and reports it as its own.
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
 * guard working. **Never `override: true`**: it pushes a loaded machine past its
 * own guard while other agents are working, and every timing a probe then reads
 * is a timing off a machine the probe overloaded.
 */
export async function activateWaitingForRoom(
  side,
  key,
  { type = 'task', budgetMs = 1_200_000, say = () => {} } = {}
) {
  const deadline = Date.now() + budgetMs;
  let act = await side.call('activate_by_key', { type, key, defaultAgent: 'claude' });
  if (act?.success) return act;
  say(`  refused: ${String(act?.error ?? '').split('\n')[0]}`);
  say(`  waiting for a slot rather than overriding — up to ${Math.round(budgetMs / 60000)} minutes…`);
  while (!act?.success && Date.now() < deadline) {
    await sleep(30000);
    act = await side.call('activate_by_key', { type, key, defaultAgent: 'claude' });
    if (!act?.success) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      say(`    still refused (${String(act?.error ?? '').split('\n')[0].slice(0, 100)}…) — ${left}s left`);
    }
  }
  return act;
}

/**
 * Stage one isolated daemon from the current build and start it.
 *
 * `patchDist(distDir)` is called after the build is copied and before the daemon
 * starts, for a probe that needs a deliberately broken build to demonstrate a
 * failure. It is the caller's business entirely: this function neither knows nor
 * checks what was patched.
 */
export async function stageIsolatedDaemon({
  scratch,
  label,
  type = 'task',
  key,
  promptText,
  promptName = `${type}.md`,
  patchDist,
  say = () => {}
}) {
  installExitHook();

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
  fs.writeFileSync(path.join(stagedRepo, 'prompts', promptName), promptText);

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

  if (patchDist) patchDist(distDir);

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
  // a guard its data, not bypassing one.
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
  const ws = path.join(fakeButchrDir, 'workspaces', type, key.toLowerCase());
  fs.mkdirSync(ws, { recursive: true });
  const trustKey = path.normalize(path.resolve(ws));
  if (
    editRealClaudeConfig((config) => {
      if (config.projects?.[trustKey]?.hasTrustDialogAccepted === true) return false;
      config.projects = { ...config.projects, [trustKey]: { hasTrustDialogAccepted: true } };
      return true;
    }, say)
  ) {
    trustAdded.push(trustKey);
  }

  const socketPath = path.join(fakeButchrDir, 'butchr.sock');
  const daemonLog = path.join(fakeButchrDir, 'daemon.log');
  const proc = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdio = [];
  proc.stdout.on('data', (c) => stdio.push(c.toString()));
  proc.stderr.on('data', (c) => stdio.push(c.toString()));
  staged.push({ proc, stdio });

  for (let i = 0; i < 120 && !fs.existsSync(socketPath); i += 1) await sleep(250);
  if (!fs.existsSync(socketPath)) {
    throw new Error(`[${label}] daemon never claimed ${socketPath}\n${stdio.join('').slice(-1500)}`);
  }
  const { call, close } = await connectDaemonRpc(socketPath);

  say(`  [${label}] staged dist   : ${distDir}`);
  say(`  [${label}] isolated HOME : ${home}`);
  say(`  [${label}] its socket    : ${socketPath}`);
  return { label, home, distDir, fakeButchrDir, socketPath, call, close, ws, daemonLog, wireDir, key, type };
}

/** Every daemon staged by this process, for a caller that wants their stderr. */
export const stagedDaemons = staged;
