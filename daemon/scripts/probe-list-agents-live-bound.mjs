// KAN-423, the live half: the REAL MCP server, answering the REAL tool call,
// off the REAL running daemon's census — bounded, and saying so.
//
// WHAT FAILURE THIS WOULD CATCH: a fitter that is correct and is not what the
// tool calls. `verify-list-agents-answer-is-bounded.mjs` beside this file
// exercises `fitListAgentsResponse` against a captured fixture and proves the
// reduction is right; what it cannot prove is that a real `butchr_list_agents`
// call reaches it, because it supplies its own input. THAT IS THE KAN-145 HOLE
// EXACTLY — two verify scripts asserted the daemon carried `activatedBy`
// correctly, by constructing registry records that already had the field in
// them, while `activatedBy` was `null` for every agent in production and both
// scripts stayed green. Nothing was wrong with either script; the gap was
// between them and no script owned it. This script owns it here: nothing below
// constructs a response. It spawns the built MCP server as a subprocess, speaks
// the real JSON-RPC to it, and reads what a client would have received.
//
// CI-RUNNABLE: no — it needs a live daemon holding a real fleet, which no CI
// runner has. Run it by hand and paste the output into the PR; that paste is
// what covers the gap the CI-runnable sibling declares in its own header.
//
// WHAT IS REAL HERE AND WHAT IS NOT
//
// Real: the built `daemon/dist/mcp.js` as its own process, the MCP initialize
// handshake, a `tools/call` for `butchr_list_agents`, the daemon socket, and
// the live census with however many agents are running at the moment you run
// it. The comparison figure — what the old code would have emitted — is taken
// from the same daemon over its own socket in the same run, so the before and
// after are the same census rather than two censuses minutes apart.
//
// Not real: the client's truncation. Nothing here makes somebody else's
// truncator run; the cap is quoted from the measurement recorded in
// `mcp-response-budget.ts` and the assertion is that we now stay under it.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const mcpEntry = path.join(daemonDir, 'dist', 'mcp.js');
const SOCKET_PATH = path.join(os.homedir(), '.local', 'share', 'butchr', 'butchr.sock');

// Setup guards exit 2, never 1: they say the probe could not run, which is a
// different claim from the thing under test being broken.
if (!fs.existsSync(mcpEntry)) {
  console.error(`no built MCP server at ${mcpEntry} — run: npm run build --prefix daemon`);
  process.exit(2);
}
if (!fs.existsSync(SOCKET_PATH)) {
  console.error(`no daemon socket at ${SOCKET_PATH} — this probe needs a live daemon`);
  process.exit(2);
}

const { MEASURED_CLIENT_CAP_CHARS } = await import('../dist/mcp-response-budget.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`         ${detail}`);
};
const rule = (t) => console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`);

// ---- what the daemon actually holds, over its own socket -------------------
function socketListAgents() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    let buffer = '';
    const fail = (e) => { socket.destroy(); reject(e); };
    socket.setTimeout(15_000, () => fail(new Error('daemon socket did not answer in 15s')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'list_agents' }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.action === 'list_agents_response') { socket.destroy(); resolve(msg); return; }
      }
    });
  });
}

// ---- the real MCP server, as a real client would drive it ------------------
function mcpCall(toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    let buffer = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; child.kill(); fn(v); } };
    const timer = setTimeout(() => done(reject, new Error('MCP server did not answer in 30s')), 30_000);
    timer.unref?.();

    child.on('error', (e) => done(reject, e));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: toolName, arguments: args ?? {} }
          }) + '\n');
        } else if (msg.id === 2) {
          clearTimeout(timer);
          done(resolve, msg);
        }
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kan-423-live-probe', version: '1' }
      }
    }) + '\n');
  });
}

rule('1. WHAT THE DAEMON HOLDS — the census, over its own socket, unbounded');

const raw = await socketListAgents();
const oldWayChars = JSON.stringify(raw, null, 2).length;
const fleet = raw.agents.length;
console.log(`   agents running:                    ${fleet}`);
console.log(`   JSON.stringify(res, null, 2):      ${oldWayChars} chars   <- what the tool used to emit`);
console.log(`   measured client cap:               ${MEASURED_CLIENT_CAP_CHARS} chars`);
console.log(
  `   over cap by:                       ${Math.max(0, oldWayChars - MEASURED_CLIENT_CAP_CHARS)} chars`
);

rule('2. WHAT THE TOOL NOW ANSWERS — through the real MCP server, real protocol');

const reply = await mcpCall('butchr_list_agents', {});
const text = reply?.result?.content?.[0]?.text ?? '';
console.log(`   tools/call answered:               ${text.length} chars`);

check('the MCP server answered the tool call at all', text.length > 0, JSON.stringify(reply).slice(0, 300));

let parsed = null;
try { parsed = JSON.parse(text); } catch { parsed = null; }
check('the answer parses as JSON', parsed !== null, 'JSON.parse threw on the delivered text');

check(
  `the answer is inside the measured client cap (${text.length} <= ${MEASURED_CLIENT_CAP_CHARS})`,
  text.length <= MEASURED_CLIENT_CAP_CHARS,
  `${text.length} chars would still be cut by the client`
);

check(
  '`completeness` is present and is the first key',
  Object.keys(parsed ?? {})[0] === 'completeness',
  `first key is ${Object.keys(parsed ?? {})[0]}`
);

check(
  `the answer states the true fleet size (agentsTotal ${parsed?.agentsTotal} === ${fleet} running)`,
  parsed?.agentsTotal === fleet,
  `agentsTotal ${parsed?.agentsTotal} vs ${fleet} agents on the socket`
);

console.log(`\n   completeness.kind:                 ${parsed?.completeness?.kind}`);
console.log(`   completeness.chars / budget:       ${parsed?.completeness?.chars} / ${parsed?.completeness?.budgetChars}`);
if (parsed?.completeness?.kind === 'clipped') {
  console.log(`   completeness.unclippedChars:       ${parsed.completeness.unclippedChars}`);
  console.log('   what it gave up:');
  for (const c of parsed.completeness.clipped) {
    console.log(`     - ${String(c.field).padEnd(26)} ${String(c.reduction).padEnd(18)} -> ${c.readTheRest}`);
  }
  check(
    'the clipped verdict names at least one field',
    parsed.completeness.clipped.length > 0,
    'clipped array is empty'
  );
  check(
    'every agent is still named despite the reduction',
    Array.isArray(parsed.agents) && parsed.agents.length === fleet,
    `agents.length ${parsed?.agents?.length} vs agentsTotal ${parsed?.agentsTotal}`
  );
} else {
  check(
    'a complete verdict carries no `clipped` key',
    !('clipped' in (parsed?.completeness ?? {})),
    `complete verdict carries: ${Object.keys(parsed?.completeness ?? {}).join(', ')}`
  );
}

rule('3. THE RECIPES THE ANSWER GIVES OUT ACTUALLY WORK');

// A `readWith` recipe that does not resolve is a disclosure that sends its
// reader nowhere, which is worse than no disclosure: it reads as covered.
const stubbed = Object.entries(parsed ?? {}).find(
  ([, v]) => v && typeof v === 'object' && v.omitted === 'for-budget'
);
if (stubbed) {
  const [field] = stubbed;
  const back = await mcpCall('butchr_list_agents', { section: field });
  const sectionText = back?.result?.content?.[0]?.text ?? '';
  let sectionParsed = null;
  try { sectionParsed = JSON.parse(sectionText); } catch { sectionParsed = null; }
  console.log(`   asked for section '${field}': ${sectionText.length} chars`);
  check(
    `\`section: '${field}'\` returns that field for real`,
    sectionParsed?.section === field && sectionParsed?.[field] !== undefined,
    JSON.stringify(Object.keys(sectionParsed ?? {}))
  );
  check(
    'the section answer is also inside the cap',
    sectionText.length <= MEASURED_CLIENT_CAP_CHARS,
    `${sectionText.length} chars`
  );
} else {
  console.log('   (nothing was reduced to a stub on this fleet — no recipe to follow)');
}

const summaryReply = await mcpCall('butchr_list_agents', { view: 'summary' });
const summaryText = summaryReply?.result?.content?.[0]?.text ?? '';
let summaryParsed = null;
try { summaryParsed = JSON.parse(summaryText); } catch { summaryParsed = null; }
console.log(`   view: 'summary' answered:          ${summaryText.length} chars`);
check(
  'summary view names every running agent',
  Array.isArray(summaryParsed?.agents) && summaryParsed.agents.length === fleet,
  `${summaryParsed?.agents?.length} of ${fleet}`
);
check(
  'summary view is inside the cap',
  summaryText.length <= MEASURED_CLIENT_CAP_CHARS,
  `${summaryText.length} chars`
);

rule('VERDICT');
console.log(`   fleet ${fleet} agents: ${oldWayChars} chars before, ${text.length} chars after, cap ${MEASURED_CLIENT_CAP_CHARS}`);
console.log(`   ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)`);

process.exit(failures ? 1 : 0);
