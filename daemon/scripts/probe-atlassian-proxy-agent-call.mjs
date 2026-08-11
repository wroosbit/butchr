// KAN-272 acceptance criterion 1, at its strongest reading: **a real agent** —
// a real Claude Code session with a real model in the loop — calling a real
// proxied tool through the real `mcp.ts`, against a real daemon.
//
// This is a `probe-`, not a `verify-`, and the distinction is deliberate. It
// spends tokens, it needs a logged-in `claude` on PATH, and its verdict depends
// on a model choosing to call a tool — none of which belongs in a proof that CI
// or a reviewer is meant to be able to re-run cheaply. The *assertions* about
// the proxy live in `verify-atlassian-proxy-failure-is-loud.mjs`, which drives
// the identical chain over the identical protocol with the model taken out.
//
// WHAT THIS ADDS OVER THAT SCRIPT, WHICH IS ONE THING AND WORTH SAYING EXACTLY:
// that a model, handed only these tool descriptions, can find and successfully
// use the proxy — and that what comes back is legible to it. The verify script
// proves the transport; this proves the surface. Neither proves the other.
//
// HOW THE TWO HOMES WORK, BECAUSE IT LOOKS LIKE A TRICK AND IS NOT. `claude`
// runs under your real $HOME, because that is where its own credentials are.
// The `butchr` MCP server it spawns is given `HOME=<temp>` through the mcp
// config's `env`, and `ipc.ts` derives BUTCHR_DIR from `os.homedir()` — so the
// agent's MCP server talks to THIS script's throwaway daemon and never to the
// one running your fleet. `--strict-mcp-config` means the session has no
// Atlassian MCP server at all, so a result it reports cannot have come from the
// ordinary OAuth path.
//
// The far end is a stub in this process and the credential is fabricated here.
// No real token is read or written and nothing reaches api.atlassian.com.
//
// Usage: node daemon/scripts/probe-atlassian-proxy-agent-call.mjs
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

if (!fs.existsSync(path.join(daemonDir, 'dist', 'mcp.js'))) {
  console.error('daemon/dist/mcp.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan272-agent-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });

const FAKE_TOKEN = 'kan272-probe-not-a-real-token-000000000000';
const seen = [];

const stub = http.createServer((req, res) => {
  seen.push(req.url);
  if (req.url.startsWith('/_edge/tenant_info')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (!String(req.headers.authorization ?? '').startsWith('Basic ')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessages: ['Client must be authenticated to access this resource.'] }));
    return;
  }
  if (/^\/rest\/api\/3\/issue\/KAN-272\?/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        key: 'KAN-272',
        fields: {
          summary: 'Host Jira and Confluence MCP tools as a daemon-side proxy',
          status: { name: 'In Progress' },
          issuetype: { name: 'Task' },
          parent: { key: 'KAN-39' },
          // A sentinel the model cannot know except by making the call. If it
          // appears in the transcript, a request really was served.
          description: 'PROXY-SENTINEL-7Q4W2'
        }
      })
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ errorMessages: ['Not found'] }));
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${stub.address().port}`;

fs.writeFileSync(
  path.join(butchrDir, 'jira-credential.json'),
  JSON.stringify({ siteUrl, email: 'probe@example.invalid', storage: 'file', token: FAKE_TOKEN }, null, 2) + '\n',
  { mode: 0o600 }
);

const daemon = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
  env: { ...process.env, HOME: fakeHome, BUTCHR_ATLASSIAN_PROXY: 'jira-read', BUTCHR_BOARD_RECONCILE: 'off' },
  stdio: ['ignore', 'ignore', 'ignore']
});

function cleanup() {
  try { daemon.kill('SIGKILL'); } catch {}
  try { stub.close(); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

await new Promise((r) => setTimeout(r, 2000));

const mcpConfig = path.join(fakeHome, 'agent-mcp.json');
fs.writeFileSync(
  mcpConfig,
  JSON.stringify(
    {
      mcpServers: {
        butchr: {
          command: process.execPath,
          args: [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', 'KAN-272'],
          env: { HOME: fakeHome, PATH: process.env.PATH }
        }
      }
    },
    null,
    2
  )
);

const PROMPT =
  'Use the atlassian_get_issue tool to read Jira issue KAN-272, then reply with exactly two ' +
  'lines: the first is the value of the issue\'s description field, and the second is the ' +
  'value of `via.servedBy` from the tool result. Nothing else.';

console.log('─'.repeat(76));
console.log('A real Claude Code agent, given only the proxy tool, asked to read KAN-272');
console.log('─'.repeat(76));
console.log(`prompt: ${PROMPT}\n`);

const agent = spawn(
  'claude',
  [
    '-p',
    PROMPT,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--allowed-tools',
    'mcp__butchr__atlassian_get_issue'
  ],
  { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
);

let out = '';
let err = '';
agent.stdout.on('data', (b) => (out += b));
agent.stderr.on('data', (b) => (err += b));

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    agent.kill('SIGKILL');
    resolve('timeout');
  }, 180_000);
  agent.on('close', (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});

console.log('the agent answered:\n');
console.log(out.split('\n').map((l) => `   ${l}`).join('\n'));
if (err.trim()) console.log(`\nstderr:\n${err.split('\n').slice(0, 12).map((l) => `   ${l}`).join('\n')}`);

console.log('\n' + '─'.repeat(76));
console.log('what the stub actually served:');
for (const url of seen) console.log(`   ${url}`);
console.log('─'.repeat(76));

// Three facts, and the sentinel is the load-bearing one: a model could
// hallucinate "servedBy: butchr-daemon" from the tool description, and it
// cannot invent PROXY-SENTINEL-7Q4W2, which exists nowhere but in a response
// this daemon fetched.
const served = seen.some((u) => u.startsWith('/rest/api/3/issue/KAN-272?fields='));
const sentinel = out.includes('PROXY-SENTINEL-7Q4W2');
const attributed = out.includes('butchr-daemon');

console.log(`\n   the daemon made the request      : ${served ? 'yes' : 'NO'}`);
console.log(`   the agent reported the sentinel  : ${sentinel ? 'yes' : 'NO'}`);
console.log(`   the agent saw who served it      : ${attributed ? 'yes' : 'NO'}`);
console.log(`   claude exit                      : ${code}`);

const failures = [served, sentinel, attributed].filter((ok) => !ok).length;
console.log(
  `\n${failures ? `INCONCLUSIVE — ${failures} of 3 facts missing` : 'OK — a real agent called the proxy and read back what the daemon fetched'}\n`
);
process.exit(failures ? 1 : 0);
