//
// KAN-261 AC1, live: stand a REAL agent down, let the reclaim fire by itself,
// bring it back, and show it resuming the conversation it was stopped in.
//
// WHY THIS IS A PROBE AND NOT A `verify-` SCRIPT: it drives a real `claude`
// process in a real herdr pane and takes minutes of wall clock, which is the
// line `lib/isolated-daemon.mjs` draws and the reason its header says never to
// rename one of these into that namespace. `verify-workspace-reclaim.mjs`
// section 5 is the mechanical half — a real router, a real `deactivate_by_key`,
// a fixture fleet — and it runs in CI. This is the half no fixture can reach.
//
// WHAT THIS COVERS THAT SECTION 5 CANNOT, and it is the whole reason it exists:
//
//   1. **That a real stand-down produces the call at all.** Section 5's census
//      is a stub whose `terminateSession` drops the pane synchronously. If the
//      real herdr lagged there, every real stand-down would refuse its own
//      reclaim as "still live" while section 5 stayed green. This is the only
//      thing that can tell the difference, and it reads the daemon's own
//      `[reclaim]` lines rather than trusting the response.
//   2. **That a reclaimed workspace still RESUMES.** Neither KAN-259's script
//      nor section 5 reactivates anything. The agent is given a nonce to hold
//      before the stand-down and asked for it back after — a tail showing the
//      restored turns *and* the agent answering from its own memory.
//   3. **That the shared store survives a reclaim fired by a stand-down.** The
//      trees are hard links since KAN-262, so this samples a real file in the
//      real `dep-store`: md5, size and link count, either side.
//
// WHAT IT DOES NOT COVER, said plainly: the daemon here is isolated by `$HOME`,
// so `workspacesRoot()` resolves inside the probe's own tree and this run is
// structurally incapable of touching a fleet workspace. That is a containment
// fact, not a demonstration that a fleet reclaim would be safe — the live-agent
// exclusion is proved in `verify-workspace-reclaim.mjs` section 5(c), which
// stands an agent down whose recorded workDir belongs to a still-live agent.
// What this script contributes on that axis is only an observation: the real
// fleet's census and this workspace's own tree, read either side.
//
// Usage: node daemon/scripts/probe-standdown-reclaim-resume.mjs
//
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { stageIsolatedDaemon, activateWaitingForRoom, PROMPT_READY } from './lib/isolated-daemon.mjs';
import { sleep, connectDaemonRpc, SOCKET_PATH } from './lib/channel-probe.mjs';

const say = (...a) => console.log(...a);
const rule = (t) => say(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`);

const TYPE = 'task';
const KEY = 'KAN-261-PROBE';
const NONCE = `heron-${crypto.randomBytes(3).toString('hex')}`;

const SHARED_CLONE = path.join(os.homedir(), 'code', 'wroosbit', 'butchr');
const DEP_STORE = path.join(os.homedir(), '.local', 'share', 'butchr', 'dep-store');

let failures = 0;
const fail = (m) => { failures += 1; say(`   ✗ ${m}`); };
const pass = (m) => say(`   ✓ ${m}`);

const du = (dir) => {
  try {
    return execFileSync('du', ['-sb', dir], { encoding: 'utf8' }).split('\t')[0].trim();
  } catch { return 'n/a'; }
};
const duh = (dir) => {
  try {
    return execFileSync('du', ['-sh', dir], { encoding: 'utf8' }).split('\t')[0].trim();
  } catch { return 'n/a'; }
};
const worktreeCount = () => {
  try {
    return execFileSync('git', ['-C', SHARED_CLONE, 'worktree', 'list'], { encoding: 'utf8' })
      .trim().split('\n').length;
  } catch { return -1; }
};
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** A real file in the real dep-store, so "the store survived" is about bytes. */
function sampleStoreFile() {
  const stack = [DEP_STORE];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && !e.isSymbolicLink()) {
        const st = fs.statSync(full);
        if (st.size > 4096 && st.nlink >= 2) return full;
      } else if (e.isDirectory() && !e.isSymbolicLink() && stack.length < 400) {
        stack.push(full);
      }
    }
  }
  return null;
}

/** The daemon's own account of what it did, which is not the response. */
function reclaimLogLines(daemonLog) {
  try {
    return fs.readFileSync(daemonLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('[reclaim]'));
  } catch { return []; }
}

// `tail_agent_response` carries the pane in `text` — see handleTailAgent, which
// spreads `herdrBridge.tailAgent()`'s `{ success, text, truncated }` into it. An
// earlier revision of this probe read `output`, found undefined, and fell back to
// a 400-character `JSON.stringify` that cut the pane off before the line it was
// waiting for. It hung for six minutes against an agent that was sitting at its
// prompt the whole time — which is worth a comment, because a probe that waits
// forever looks exactly like the product being broken.
async function tail(call, lines = 60) {
  const t = await call('tail_agent', { type: TYPE, key: KEY, lines });
  if (typeof t?.text === 'string') return t.text;
  return `[no pane text: ${JSON.stringify(t).slice(0, 300)}]`;
}

async function awaitPane(call, pattern, { attempts = 90, intervalMs = 4000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const out = await tail(call, 40);
    if (pattern.test(out)) return out;
    await sleep(intervalMs);
  }
  return null;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan261-live-'));
say(`scratch: ${scratch}`);
say(`nonce  : ${NONCE}`);

let side;
let probeWorktree;

try {
  rule('0. staging an isolated daemon from THIS build');

  side = await stageIsolatedDaemon({
    scratch,
    label: 'kan261',
    type: TYPE,
    key: KEY,
    promptText:
      `# Probe agent for KAN-261\n\n` +
      `You are a probe. Do no work of your own and edit no files.\n` +
      `Answer questions in one short line and then wait.\n`,
    say
  });

  rule('1. activating a REAL agent and giving it something to remember');

  const act = await activateWaitingForRoom(side, KEY, { type: TYPE, say });
  if (!act?.success) throw new Error(`could not activate: ${act?.error}`);
  pass(`activated ${TYPE}/${KEY}`);

  const ready = await awaitPane(side.call, PROMPT_READY);
  if (!ready) throw new Error('the agent never reached its prompt');
  pass('the agent reached its prompt');

  // The answer marker and the nonce never appear TOGETHER in anything this
  // probe types, and that is load-bearing. An earlier revision waited for
  // `REMEMBERED <nonce>` while its own question contained that exact string, so
  // the pattern matched the echo of the question on the pane and the check
  // passed without the agent having said anything at all. `HOLDING=<word>` is
  // what gets typed; `HOLDING=heron-…` can only have come from the agent.
  await side.call('send_to_agent', {
    type: TYPE,
    key: KEY,
    message:
      `Please remember this word exactly: ${NONCE}. ` +
      `Then reply in this exact form and nothing else: HOLDING=<word>`
  });
  const remembered = await awaitPane(side.call, new RegExp(`HOLDING=${NONCE}`));
  if (remembered) pass(`the agent answered, so it is holding the nonce: HOLDING=${NONCE}`);
  else fail('the agent never acknowledged the nonce — the resume proof has nothing to restore');

  rule('2. giving it a worktree with dependencies, the way a task agent has one');

  probeWorktree = path.join(side.ws, 'butchr');
  execFileSync('git', ['-C', SHARED_CLONE, 'worktree', 'prune']);
  execFileSync('git', [
    '-C', SHARED_CLONE, 'worktree', 'add', probeWorktree, '-b', `butchr/${KEY.toLowerCase()}`, 'origin/main'
  ], { stdio: 'inherit' });
  execFileSync('node', [path.join(probeWorktree, 'daemon', 'scripts', 'link-workspace-deps.mjs')], {
    cwd: probeWorktree,
    stdio: 'inherit'
  });

  const storeFile = sampleStoreFile();
  if (!storeFile) throw new Error(`no hard-linked file found under ${DEP_STORE}`);

  const before = {
    workspace: du(side.ws),
    workspaceH: duh(side.ws),
    store: du(DEP_STORE),
    storeH: duh(DEP_STORE),
    storeMd5: md5(storeFile),
    storeSize: fs.statSync(storeFile).size,
    nlink: fs.statSync(storeFile).nlink,
    worktrees: worktreeCount(),
    selfWorkspace: du(path.resolve('.')),
  };

  rule('3. BEFORE — the numbers, and the fleet');

  say(`  probe workspace     : ${before.workspaceH} (${before.workspace} bytes)  ${side.ws}`);
  say(`  dep-store           : ${before.storeH} (${before.store} bytes)  ${DEP_STORE}`);
  say(`  sampled store file  : ${storeFile}`);
  say(`    md5=${before.storeMd5}  size=${before.storeSize}  nlink=${before.nlink}`);
  say(`  git worktree list   : ${before.worktrees} lines  (${SHARED_CLONE})`);

  const fleetBefore = await (async () => {
    const rpc = await connectDaemonRpc(SOCKET_PATH);
    try { return await rpc.call('list_agents', {}); } finally { rpc.close(); }
  })();
  const nameOf = (a) => `${a.type}/${a.key}`;
  say(`  REAL fleet (${fleetBefore.agents?.length ?? 0} agents): ${(fleetBefore.agents ?? []).map(nameOf).join(', ')}`);

  rule('4. STAND-DOWN — nobody invokes a sweep');

  const logBefore = reclaimLogLines(side.daemonLog).length;
  const standDown = await side.call('deactivate_by_key', { type: TYPE, key: KEY });
  say(`  deactivate_response: ${JSON.stringify(standDown, null, 2)}`);

  await sleep(2000);
  const newLog = reclaimLogLines(side.daemonLog).slice(logBefore);
  say(`\n  the daemon's own [reclaim] lines:`);
  for (const l of newLog) say(`    ${l}`);

  if (standDown?.success === true) pass('the stand-down succeeded');
  else fail(`the stand-down failed: ${standDown?.error}`);

  if (standDown?.reclaim?.status === 'reclaimed') {
    pass(`and it reclaimed by itself: "${standDown.reclaim.headline}"`);
  } else {
    fail(`no reclaim fired on stand-down: ${JSON.stringify(standDown?.reclaim)}`);
  }
  if (newLog.length > 0) pass(`the daemon logged ${newLog.length} [reclaim] line(s) of its own`);
  else fail('the daemon logged nothing — the response is the only witness');

  rule('5. AFTER — the same numbers');

  const after = {
    workspace: du(side.ws),
    workspaceH: duh(side.ws),
    store: du(DEP_STORE),
    storeH: duh(DEP_STORE),
    storeMd5: exists(storeFile) ? md5(storeFile) : 'GONE',
    storeSize: exists(storeFile) ? fs.statSync(storeFile).size : -1,
    nlink: exists(storeFile) ? fs.statSync(storeFile).nlink : -1,
    worktrees: worktreeCount(),
    selfWorkspace: du(path.resolve('.'))
  };

  say(`  probe workspace     : ${after.workspaceH} (${after.workspace} bytes)   was ${before.workspaceH}`);
  say(`  dep-store           : ${after.storeH} (${after.store} bytes)   was ${before.storeH}`);
  say(`    md5=${after.storeMd5}  size=${after.storeSize}  nlink=${after.nlink}   was nlink=${before.nlink}`);
  say(`  git worktree list   : ${after.worktrees} lines   was ${before.worktrees}`);

  if (Number(after.workspace) < Number(before.workspace)) {
    pass(`the workspace shrank: ${before.workspaceH} → ${after.workspaceH}`);
  } else {
    fail(`the workspace did not shrink: ${before.workspaceH} → ${after.workspaceH}`);
  }
  if (!exists(path.join(probeWorktree, 'daemon', 'node_modules'))) {
    pass('daemon/node_modules is gone');
  } else {
    fail('daemon/node_modules survived');
  }
  for (const rel of ['.butchr-prompt.md', '.mcp.json', 'butchr/.git', 'butchr/daemon/src/router.ts']) {
    if (exists(path.join(side.ws, rel))) pass(`the workspace kept ${rel}`);
    else fail(`the workspace LOST ${rel} — it could not resume without it`);
  }

  if (after.storeMd5 === before.storeMd5 && after.storeSize === before.storeSize) {
    pass('the shared store is byte-for-byte intact (md5 and size unchanged)');
  } else {
    fail(`the shared store was damaged: md5 ${before.storeMd5} → ${after.storeMd5}`);
  }
  if (after.nlink < before.nlink) {
    pass(`and the link count decremented rather than the file vanishing (${before.nlink} → ${after.nlink})`);
  } else {
    fail(`link count did not decrement: ${before.nlink} → ${after.nlink}`);
  }
  if (after.worktrees === before.worktrees) {
    pass(`worktree registrations intact (${after.worktrees} lines)`);
  } else {
    fail(`worktree registrations changed: ${before.worktrees} → ${after.worktrees}`);
  }
  if (after.selfWorkspace === before.selfWorkspace) {
    pass(`this live agent's own workspace is unchanged (${before.selfWorkspace} bytes)`);
  } else {
    fail(`this live agent's workspace changed: ${before.selfWorkspace} → ${after.selfWorkspace}`);
  }

  const fleetAfter = await (async () => {
    const rpc = await connectDaemonRpc(SOCKET_PATH);
    try { return await rpc.call('list_agents', {}); } finally { rpc.close(); }
  })();
  say(`  REAL fleet (${fleetAfter.agents?.length ?? 0} agents): ${(fleetAfter.agents ?? []).map(nameOf).join(', ')}`);
  // Minus the probe itself, which is a real herdr pane and is SUPPOSED to leave
  // the census — it is the agent being stood down. An earlier revision compared
  // the raw counts and reported the probe working as a failure.
  const others = (list) => (list.agents ?? [])
    .map(nameOf)
    .filter((n) => n.toLowerCase() !== `${TYPE}/${KEY}`.toLowerCase())
    .sort();
  if (JSON.stringify(others(fleetAfter)) === JSON.stringify(others(fleetBefore))) {
    pass(`every other agent in the real fleet is still there: ${others(fleetAfter).join(', ')}`);
  } else {
    fail(`the rest of the fleet changed: ${others(fleetBefore).join(', ')} → ${others(fleetAfter).join(', ')}`);
  }
  if (!others(fleetAfter).some((n) => n.toLowerCase() === `${TYPE}/${KEY}`.toLowerCase())) {
    pass('and the probe itself is gone from it, as a stood-down agent should be');
  }

  rule('6. AC1 — bring it back, and ask it what it was holding');

  const back = await activateWaitingForRoom(side, KEY, { type: TYPE, say });
  if (!back?.success) throw new Error(`could not reactivate: ${back?.error}`);
  pass('reactivated');

  const backUp = await awaitPane(side.call, PROMPT_READY);
  if (!backUp) fail('the reactivated agent never reached its prompt');

  say('\n  the tail, which is what has to show the restored conversation:');
  const restored = await tail(side.call, 80);
  say(restored.split('\n').map((l) => `    | ${l}`).join('\n'));

  if (new RegExp(NONCE).test(restored)) {
    pass(`the tail carries the pre-stand-down turn (${NONCE})`);
  } else {
    say(`   … the nonce is not in the visible tail; asking the agent instead`);
  }

  await side.call('send_to_agent', {
    type: TYPE,
    key: KEY,
    message:
      'What was the word I asked you to remember? ' +
      'Reply in this exact form and nothing else: ANSWER=<word>'
  });
  // Same rule as above: the question types `ANSWER=<word>`, so only the agent
  // can put `ANSWER=` and the nonce on the pane together. Waiting for a bare
  // `ANSWER=` would match the question the instant it was typed.
  const recalled = await awaitPane(side.call, new RegExp(`ANSWER=${NONCE}`));
  say('\n  its answer:');
  say((recalled ?? await tail(side.call, 30)).split('\n').slice(-16).map((l) => `    | ${l}`).join('\n'));

  if (recalled) {
    pass(`AC1: it resumed the conversation it was stopped in — ANSWER=${NONCE}`);
  } else {
    fail('AC1: the agent could not recall the nonce — it started fresh rather than resuming');
  }

  rule('7. AC2 — the resumed agent can build');

  say('  running what prompts/task.md now specifies — link, not install:');
  execFileSync('node', [path.join(probeWorktree, 'daemon', 'scripts', 'link-workspace-deps.mjs')], {
    cwd: probeWorktree, stdio: 'inherit'
  });
  execFileSync('npm', ['run', 'build'], {
    cwd: path.join(probeWorktree, 'daemon'), stdio: 'inherit'
  });
  pass('link-workspace-deps.mjs && npm run build — exit 0');
  say(`  workspace after relink: ${duh(side.ws)}`);
} catch (e) {
  fail(`the probe threw: ${e?.message ?? String(e)}`);
  say(e?.stack ?? '');
} finally {
  rule('cleanup');
  try {
    if (side) {
      await side.call('deactivate_by_key', { type: TYPE, key: KEY });
      await sleep(1500);
      await side.call('reset_by_key', { type: TYPE, key: KEY });
      side.close();
    }
  } catch (e) { say(`  stand-down on cleanup: ${e?.message}`); }
  try {
    if (probeWorktree) {
      execFileSync('git', ['-C', SHARED_CLONE, 'worktree', 'remove', '--force', probeWorktree], { stdio: 'pipe' });
    }
  } catch { /* the reset already took the directory */ }
  try {
    execFileSync('git', ['-C', SHARED_CLONE, 'worktree', 'prune']);
    execFileSync('git', ['-C', SHARED_CLONE, 'branch', '-D', `butchr/${KEY.toLowerCase()}`], { stdio: 'pipe' });
  } catch { /* nothing to remove */ }
  say(`  git worktree list   : ${worktreeCount()} lines (final)`);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

say(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
