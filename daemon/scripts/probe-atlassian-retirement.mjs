// KAN-288's criterion 6, which lives on KAN-293 and nowhere else:
//
//   "Evidence that `mcp-remote` can actually be retired — an agent operating
//    with `mcp__atlassian__*` absent, doing real ticket work."
//
// This is the criterion that decides whether the whole effort delivered, and it
// is deliberately not answerable by a tool list. **Tool presence has proved
// nothing on this board**: the 2026-08-10 outage lasted twelve hours precisely
// because six dead OAuth proxies kept advertising their tools, and only a real
// call could tell. So this probe does not count tools. It stands up a real
// agent, with a real model, whose MCP configuration **has no Atlassian server
// in it at all**, and gives it real work on a real ticket.
//
// ── WHAT "ABSENT" MEANS HERE, MECHANICALLY ─────────────────────────────────
//
// The agent is launched with `--mcp-config <a file this script writes>` and
// `--strict-mcp-config`. The second flag is what makes this proof rather than
// theatre: without it the CLI merges the user's own `~/.claude.json`, which
// **does** define the Atlassian server, and the agent would quietly have both.
// The config this script writes names exactly one server — Butchr's — and §1
// asserts, from the agent's own reported tool list, that nothing matching
// `mcp__atlassian__*` was reachable.
//
// The Butchr server it does get is spawned with `HOME` pointed at a throwaway
// directory, so it rendezvouses with **this script's** daemon rather than the
// fleet's. That daemon holds the real credential (copied by path, never read
// here) and runs the proxy in `confluence-write`. The `claude` process itself
// keeps the real `HOME`, because that is where its own authentication lives.
//
// ── WHAT WOULD MAKE THIS PROOF WORTHLESS, AND WHAT STOPS IT ────────────────
//
// A proof that supplies its own input has not tested that the input arrives —
// `prompts/task.md`, on KAN-145. The failure shape here would be an agent that
// *claims* to have commented while nothing was written, and a script that
// believed it. So the verdict does not read the agent's account of what it did:
// §3 reads **KAN-293's actual comments**, through a separate connection, and
// requires the run's unique marker to be present. The agent's narration is
// printed for a human and asserted on for nothing.
//
// ── WHAT IT STILL DOES NOT COVER ───────────────────────────────────────────
//
// One agent, one model, one run, one ticket. It shows retirement is *possible*,
// not that every workflow on the board survives it. The honest reading of a
// green run is "an agent with no Atlassian MCP did real ticket work", which is
// exactly what the criterion asks and no more.
//
// Usage: node daemon/scripts/probe-atlassian-retirement.mjs [--keep]
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

const OWN_KEY = 'KAN-293';
const KEEP = process.argv.includes('--keep');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const MARKER = `RETIREMENT-PROOF-${stamp}`;

if (!fs.existsSync(path.join(daemonDir, 'dist', 'mcp.js'))) {
  console.error('daemon/dist/mcp.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}
const REAL_CRED = path.join(os.homedir(), '.local', 'share', 'butchr', 'jira-credential.json');
if (!fs.existsSync(REAL_CRED)) {
  console.error(`No Jira credential at ${REAL_CRED}; this probe needs the machine's real one.`);
  process.exit(1);
}

let failures = 0;
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  if (!ok) failures++;
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan293-retire-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });
fs.copyFileSync(REAL_CRED, path.join(butchrDir, 'jira-credential.json'));
fs.chmodSync(path.join(butchrDir, 'jira-credential.json'), 0o600);

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan293-agent-'));

let daemon = null;
function cleanup() {
  try { daemon?.child.kill('SIGKILL'); } catch {}
  if (!KEEP) {
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon() {
  const child = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
    env: {
      ...process.env,
      HOME: fakeHome,
      BUTCHR_BOARD_RECONCILE: 'off',
      BUTCHR_ATLASSIAN_PROXY: 'confluence-write'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.on('error', () => {});
  return { child, log };
}

// ═══════════════════════════════════════════════════════════════════════════

console.log(`KAN-288 criterion 6: can mcp-remote actually be retired?`);
console.log(`Credential: ${REAL_CRED} (copied by path, never read here).`);
console.log(`Throwaway $HOME: ${fakeHome}`);
console.log(`Agent working dir: ${agentDir}`);
console.log(`Marker for this run: ${MARKER}`);

daemon = startDaemon();
await sleep(2500);

// ── THE CONFIG WITH NO ATLASSIAN SERVER IN IT ──────────────────────────────
//
// One server. The absence is the point, so it is written out here where a
// reviewer can see it rather than achieved by deleting something elsewhere.
const mcpConfigPath = path.join(agentDir, 'retirement-mcp.json');
fs.writeFileSync(
  mcpConfigPath,
  JSON.stringify(
    {
      mcpServers: {
        butchr: {
          command: process.execPath,
          args: [
            path.join(daemonDir, 'dist', 'mcp.js'),
            '--workspace-type',
            'task',
            '--workspace-key',
            OWN_KEY
          ],
          // HOME here and not for the agent: this is what points the MCP server
          // at this script's daemon. The `claude` process keeps the real HOME.
          env: { HOME: fakeHome, PATH: process.env.PATH ?? '' }
        }
      }
    },
    null,
    2
  )
);

const TASK = `You are the Butchr agent for task/${OWN_KEY} on the Jira site wroosbit.atlassian.net.

Do this real ticket work, using only the tools you actually have:

1. Read Jira issue ${OWN_KEY} and report its summary and current status.
2. Post a comment on ${OWN_KEY}. The comment must contain the exact marker ${MARKER}
   on its own line, and must say which MCP server you used to post it.
3. Read the Confluence spaces on this site and name one.

Then answer these three questions explicitly, under a heading "REPORT":
  - TOOLS: do you have any tool whose name starts with "mcp__atlassian__"? Answer yes or no,
    and list the Atlassian-capable tool names you DO have.
  - COMPLETED: which of steps 1-3 did you complete?
  - GAPS: name anything you needed and could not do, and what a caller would have to fall
    back to. If there were none, say "none".

Be concise. Do not ask for confirmation; just do it.`;

rule('running a real agent with no Atlassian MCP server configured');
console.log(`   config: ${mcpConfigPath}`);
console.log(`   (--strict-mcp-config, so the user's own ~/.claude.json is NOT merged)\n`);

const agentOutput = await new Promise((resolve) => {
  const child = spawn(
    'claude',
    [
      '-p',
      TASK,
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
      // Nothing outside the one MCP server: this proof is about what Butchr's
      // tools can do, and an agent that shelled out to `curl` would answer a
      // different question entirely.
      '--disallowedTools',
      'Bash',
      'Edit',
      'Write',
      'WebFetch',
      'WebSearch',
      'Task'
    ],
    { cwd: agentDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
  child.stderr.on('data', (b) => { err += b; });
  child.on('close', () => resolve({ out, err }));
  child.on('error', (e) => resolve({ out, err: String(e) }));
});

// ── 1. the Atlassian server really was absent ──────────────────────────────
rule('1. mcp__atlassian__* was absent, by the agent\'s own account and by the config');

const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
check(
  'the config this agent was launched with names exactly one server, and it is butchr',
  Object.keys(config.mcpServers).length === 1 && !!config.mcpServers.butchr,
  JSON.stringify(Object.keys(config.mcpServers))
);
check(
  'the agent reported having no mcp__atlassian__* tool',
  /TOOLS[\s\S]{0,400}?\bno\b/i.test(agentOutput.out) && !/I (have|can use) mcp__atlassian__/i.test(agentOutput.out),
  agentOutput.out.slice(-1500)
);

// ── 2. it did the work ─────────────────────────────────────────────────────
rule('2. the agent says it did the work');
check(
  'the agent reported completing the steps',
  /COMPLETED/i.test(agentOutput.out),
  agentOutput.out.slice(-1500)
);
check(
  "the agent named the ticket's real summary, so it genuinely read it",
  /slice C/i.test(agentOutput.out),
  agentOutput.out.slice(-1500)
);

// ── 3. THE VERDICT, READ OFF JIRA AND NOT OFF THE AGENT ────────────────────
//
// The only section that decides anything. See the header: an agent's account of
// its own work is exactly the input this must not trust.
rule('3. the comment is really on the ticket — checked independently of the agent');

const verify = spawn(
  process.execPath,
  [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', OWN_KEY],
  { env: { ...process.env, HOME: fakeHome }, stdio: ['pipe', 'pipe', 'pipe'] }
);
const commentFound = await new Promise((resolve) => {
  let buffer = '';
  let stage = 0;
  const timer = setTimeout(() => resolve(null), 40000);
  verify.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === 1 && stage === 0) {
        stage = 1;
        verify.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'atlassian_get_issue', arguments: { issueKey: OWN_KEY, fields: 'comment' } }
          })}\n`
        );
      } else if (msg.id === 2) {
        clearTimeout(timer);
        resolve(msg?.result?.content?.[0]?.text ?? '');
      }
    }
  });
  verify.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } }
    })}\n`
  );
});
try { verify.kill('SIGKILL'); } catch {}

check(
  `${OWN_KEY} carries a comment containing ${MARKER}`,
  typeof commentFound === 'string' && commentFound.includes(MARKER),
  commentFound === null
    ? 'the independent read timed out'
    : `marker not found in the ticket's comments (read ${String(commentFound).length} bytes)`
);

// ── 4. what it could not do ────────────────────────────────────────────────
rule('4. the gaps the agent named — the part that must not be summarised away');
const gaps = /GAPS[:\s]*([\s\S]{0,1200})/i.exec(agentOutput.out);
console.log(gaps ? `   ${gaps[1].trim().split('\n').slice(0, 20).join('\n   ')}` : '   (the agent reported no GAPS section)');
console.log(
  '\n   Read that section before concluding anything. A green run above means an agent did\n' +
    '   real ticket work with no Atlassian MCP server; it does NOT mean the surface is\n' +
    '   complete for every workflow, and whatever is named there is the honest remainder.'
);

console.log(
  `\n${failures ? `FAILED — ${failures} check(s)` : `OK — an agent with no mcp__atlassian__* server read ${OWN_KEY}, commented on it, and read Confluence, and the comment is really there.`}\n`
);
process.exit(failures ? 1 : 0);
