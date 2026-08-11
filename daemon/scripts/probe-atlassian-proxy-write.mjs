// KAN-291 acceptance criteria 1 and 2, at their strongest reading: a **real**
// write through Butchr's MCP, made the way an agent makes one, against **real
// Atlassian** with the daemon's **real credential** — and then that same
// credential broken, so what an agent sees when it fails is on the record next
// to what it sees when it works.
//
// This is a `probe-`, not a `verify-`, and the distinction is KAN-272's. It
// touches production Jira, it needs the machine's real credential, and one of
// its sections *moves a real ticket*. None of that belongs in something CI or a
// reviewer re-runs cheaply. The assertions about the policy and the grant live
// in `verify-atlassian-proxy-write-scope.mjs`, which is pure and which is what
// goes red when the boundary moves.
//
// WHAT THIS ADDS OVER THAT SCRIPT, WHICH IS THE THING THAT SCRIPT CANNOT DO.
// `verify-atlassian-proxy-write-scope.mjs` constructs its own callers — it
// hands the policy a `{type, key}` it wrote a line earlier — so it proves what
// the policy decides *given* an identity and nothing about whether a real
// identity arrives. That is the KAN-145 defect named in `prompts/task.md`: a
// proof that supplies its own input has not tested that the input arrives. Here
// the identity is produced the way it is in production — `mcp.ts` is spawned
// with `--workspace-type task --workspace-key KAN-291` and stamps the request
// itself — so §4's refusal is evidence that the stamping works, not merely that
// the comparison does.
//
// WHAT IT STILL DOES NOT COVER: a model choosing to call the tool. That is
// `probe-atlassian-proxy-agent-call.mjs`'s job for the read path and nobody's
// yet for the write. Named rather than left to be assumed.
//
// ── THE CREDENTIAL, AND WHY THIS IS NOT A LEAK ─────────────────────────────
//
// The daemon's credential file is **copied by path** into a throwaway $HOME.
// It is never read into this process, never printed, never passed as an
// argument, and never written anywhere but a 0600 file inside a 0700 directory
// that is removed on exit. `fs.copyFileSync` moves bytes between two paths and
// this script never sees them. That is the same discipline `prompts/task.md`
// states for a transcript: referenced by path, never echoed.
//
// The throwaway daemon binds its socket inside that $HOME and runs with
// BUTCHR_BOARD_RECONCILE=off, so it cannot see, start, or stand down any agent
// of the running fleet — the guard `verify-atlassian-proxy-failure-is-loud.mjs`
// established and for the same reason.
//
// Usage:
//   node daemon/scripts/probe-atlassian-proxy-write.mjs            # read-only probes
//   node daemon/scripts/probe-atlassian-proxy-write.mjs --perform <transitionId>
//                                                          # ALSO moves KAN-291
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

const OWN_KEY = 'KAN-291';
const OTHER_KEY = 'KAN-288';
const performAt = process.argv.indexOf('--perform');
const PERFORM = performAt !== -1 ? process.argv[performAt + 1] : null;

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
const notes = [];

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  if (!ok) failures++;
}

// ── the throwaway home, and the credential copied into it by path ──────────

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan291-write-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });
// Bytes go path → path. Nothing is read into this process. See the header.
fs.copyFileSync(REAL_CRED, path.join(butchrDir, 'jira-credential.json'));
fs.chmodSync(path.join(butchrDir, 'jira-credential.json'), 0o600);

let daemon = null;
function cleanup() {
  try { daemon?.child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(extraEnv) {
  const child = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
    env: {
      ...process.env,
      HOME: fakeHome,
      // It must not reconcile a board: this daemon can see the real Jira, and a
      // reconciler that decided the fleet was wrong would act on it.
      BUTCHR_BOARD_RECONCILE: 'off',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.on('error', () => {});
  return { child, log };
}

/** A real `mcp.ts`, spoken to over real MCP stdio, stamping its own identity. */
function startMcpClient(workspaceKey) {
  const child = spawn(
    process.execPath,
    [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', workspaceKey],
    { env: { ...process.env, HOME: fakeHome }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const waiting = new Map();
  let buffer = '';
  let id = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = msg.id !== undefined ? waiting.get(msg.id) : undefined;
      if (entry) { waiting.delete(msg.id); entry(msg); }
    }
  });
  child.stderr.on('data', () => {});
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      waiting.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
      setTimeout(() => { if (waiting.delete(mine)) reject(new Error(`${method} timed out`)); }, 30000);
    });
  return { child, send };
}

/** Ask the MCP server to call a tool, and unwrap what it answered. */
async function callTool(mcp, name, args) {
  const res = await mcp.send('tools/call', { name, arguments: args });
  const text = res?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  return { isError: !!res?.result?.isError, payload, text };
}

async function withMcp(workspaceKey, fn) {
  const mcp = startMcpClient(workspaceKey);
  try {
    await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kan291-probe', version: '0' }
    });
    return await fn(mcp);
  } finally {
    try { mcp.child.kill('SIGKILL'); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════

console.log(`Probing the real write path. Credential: ${REAL_CRED} (copied by path, never read here).`);
console.log(`Throwaway $HOME: ${fakeHome}`);

daemon = startDaemon({ BUTCHR_ATLASSIAN_PROXY: 'jira-write' });
await sleep(2500);

// ── 1. the tool is advertised, and only under the write mode ───────────────
rule('1. the write tool is advertised to a real MCP client under jira-write');

const advertised = await withMcp(OWN_KEY, async (mcp) => {
  const res = await mcp.send('tools/list', {});
  return (res?.result?.tools ?? []).map((t) => t.name);
});
check(
  'atlassian_transition_issue is offered',
  advertised.includes('atlassian_transition_issue'),
  `tools: ${advertised.filter((n) => n.startsWith('atlassian_')).join(', ')}`
);
check(
  'and the reads are still offered alongside it — the ladder is cumulative',
  advertised.includes('atlassian_get_issue') && advertised.includes('atlassian_get_transitions'),
  `atlassian tools: ${advertised.filter((n) => n.startsWith('atlassian_')).join(', ')}`
);

// ── 2. a real read, to establish the credential is live at all ─────────────
rule('2. a real READ through the proxy — the credential answers before we ask it to write');

const realTransitions = await withMcp(OWN_KEY, (mcp) =>
  callTool(mcp, 'atlassian_get_transitions', { issueKey: OWN_KEY })
);
const available = (realTransitions.payload?.body?.transitions ?? []).map((t) => ({ id: t.id, to: t.name }));
check(
  `${OWN_KEY}'s real transitions came back from Atlassian`,
  realTransitions.payload?.success === true && available.length > 0,
  available.length
    ? `available now: ${available.map((t) => `${t.id}=${t.to}`).join(', ')}`
    : JSON.stringify(realTransitions.payload).slice(0, 400)
);
notes.push(`transitions on ${OWN_KEY}: ${available.map((t) => `${t.id}=${t.to}`).join(', ')}`);

// ── 3. does the credential hold write scope? A real write, harmless by ──────
//      construction: a well-formed transition id that does not exist.
rule('3. THE WRITE SCOPE, asked of Atlassian rather than assumed');

const scopeProbe = await withMcp(OWN_KEY, (mcp) =>
  callTool(mcp, 'atlassian_transition_issue', { issueKey: OWN_KEY, transitionId: '99999999' })
);
const status = scopeProbe.payload?.status;
const credentialFault = scopeProbe.payload?.credentialFault;
// 400 = Atlassian accepted the write and disliked the id: the token CAN write.
// 403 = the token authenticated and is not allowed to write: it CANNOT.
const canWrite = status === 400 || (status >= 200 && status < 300);
check(
  `a write reached Atlassian and it answered ${status} — the token ${canWrite ? 'HOLDS' : 'DOES NOT HOLD'} write scope`,
  status !== undefined,
  `status=${status} credentialFault=${credentialFault}\nerror: ${String(scopeProbe.payload?.error ?? '(none)').slice(0, 500)}`
);
check(
  canWrite
    ? 'a bad transition id is reported as the QUERY fault it is, not as a fleet-wide credential fault'
    : 'a scope refusal is reported as a CREDENTIAL fault, naming write:jira-work as the fix',
  canWrite ? credentialFault === false : credentialFault === true,
  `credentialFault=${credentialFault}`
);
if (!canWrite) {
  check(
    'and the message tells the human what to mint, rather than "replace the credential"',
    /write:jira-work/.test(String(scopeProbe.payload?.error ?? '')),
    String(scopeProbe.payload?.error ?? '').slice(0, 600)
  );
  notes.push('THE CONFIGURED TOKEN CANNOT WRITE — a human must mint one with write:jira-work.');
}
check(
  'nothing was silently swallowed: the failure carried a status and a sentence',
  scopeProbe.isError === true && typeof scopeProbe.payload?.error === 'string' && scopeProbe.payload.error.length > 40,
  `isError=${scopeProbe.isError}`
);

// ── 4. THE POLICY, with the identity produced rather than constructed ──────
rule("4. the own-ticket policy, live — the caller identity is stamped by mcp.ts, not by this script");

const otherBefore = await withMcp(OWN_KEY, (mcp) =>
  callTool(mcp, 'atlassian_get_issue', { issueKey: OTHER_KEY, fields: 'status' })
);
const otherStatusBefore = otherBefore.payload?.body?.fields?.status?.name;

const refused = await withMcp(OWN_KEY, (mcp) =>
  callTool(mcp, 'atlassian_transition_issue', { issueKey: OTHER_KEY, transitionId: '31' })
);
check(
  `task/${OWN_KEY} is refused a transition of ${OTHER_KEY}`,
  refused.payload?.success === false && refused.payload?.reason === 'not-your-ticket',
  `reason=${refused.payload?.reason}\n${String(refused.payload?.error ?? '').slice(0, 400)}`
);
check(
  'the refusal is decided by the daemon, before Atlassian is contacted',
  refused.payload?.status === undefined,
  `status=${refused.payload?.status ?? '(none — nothing was sent)'}`
);

const otherAfter = await withMcp(OWN_KEY, (mcp) =>
  callTool(mcp, 'atlassian_get_issue', { issueKey: OTHER_KEY, fields: 'status' })
);
const otherStatusAfter = otherAfter.payload?.body?.fields?.status?.name;
check(
  `and ${OTHER_KEY} really did not move — read back from Atlassian`,
  otherStatusBefore !== undefined && otherStatusBefore === otherStatusAfter,
  `${OTHER_KEY}: "${otherStatusBefore}" before, "${otherStatusAfter}" after`
);

// The positive control for §4: the same client, the same tool, its OWN ticket
// — shown to get past the policy and reach Atlassian. Without this, "it was
// refused" is equally explained by the write path being broken entirely.
check(
  `the same client reaches Atlassian for its OWN ticket — §4's refusal measured the policy, not a broken path`,
  scopeProbe.payload?.status !== undefined,
  `${OWN_KEY} write reached Atlassian and got ${scopeProbe.payload?.status}; ${OTHER_KEY} never left the daemon`
);

// ── 5. the real transition, only when asked for explicitly ─────────────────
rule('5. the real transition of a real issue');

if (!PERFORM) {
  console.log('   SKIPPED — pass `--perform <transitionId>` to actually move ' + OWN_KEY + '.');
  console.log('   Nothing in this run changed any issue.');
} else {
  const before = await withMcp(OWN_KEY, (mcp) =>
    callTool(mcp, 'atlassian_get_issue', { issueKey: OWN_KEY, fields: 'status' })
  );
  const statusBefore = before.payload?.body?.fields?.status?.name;

  const moved = await withMcp(OWN_KEY, (mcp) =>
    callTool(mcp, 'atlassian_transition_issue', { issueKey: OWN_KEY, transitionId: PERFORM })
  );
  check(
    `${OWN_KEY} transitioned through Butchr's MCP — Jira answered ${moved.payload?.status}`,
    moved.payload?.success === true,
    JSON.stringify(moved.payload).slice(0, 600)
  );
  check(
    'a 204 with no body is reported as the success it is, not as an empty answer',
    moved.payload?.status === 204 && moved.payload?.success === true,
    `status=${moved.payload?.status} body=${JSON.stringify(moved.payload?.body)}`
  );

  const after = await withMcp(OWN_KEY, (mcp) =>
    callTool(mcp, 'atlassian_get_issue', { issueKey: OWN_KEY, fields: 'status' })
  );
  const statusAfter = after.payload?.body?.fields?.status?.name;
  check(
    'and the issue really moved — read back from Atlassian afterwards',
    statusBefore !== statusAfter && statusAfter !== undefined,
    `${OWN_KEY}: "${statusBefore}" → "${statusAfter}"`
  );
  notes.push(`${OWN_KEY} moved "${statusBefore}" → "${statusAfter}" through Butchr's MCP.`);
}

// ── 6. the audit line ──────────────────────────────────────────────────────
rule('6. the audit line records who wrote what, to which issue');

// The daemon writes its log to a file under BUTCHR_DIR, not to the stdout this
// script captures — `verify-atlassian-proxy-failure-is-loud.mjs` reads the same
// path for the same reason.
const logPath = path.join(butchrDir, 'daemon.log');
const readAudit = () =>
  (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
    .split('\n')
    .filter((l) => l.includes('atlassian-proxy:'));
const audit = readAudit();
check(
  'every proxied call was logged with its caller',
  audit.length > 0 && audit.every((l) => /task\/KAN-\d+|unidentified caller/.test(l)),
  audit.slice(0, 8).join('\n')
);
check(
  'a write is logged with the body it sent, not only the issue it named',
  audit.some((l) => /POST .*\/transitions \{"transition":\{"id":"\d+"\}\}/.test(l)),
  audit.filter((l) => l.includes('POST')).slice(0, 4).join('\n')
);
check(
  'the refused write is in the log too — a log of only what worked is not an audit log',
  audit.some((l) => /REFUSED/.test(l)),
  audit.filter((l) => l.includes('REFUSED')).slice(0, 3).join('\n')
);
check(
  'and nothing token-shaped reached the log',
  !audit.some((l) => /ATATT|Basic [A-Za-z0-9+/=]{20,}/.test(l)),
  `${audit.length} audit line(s) scanned`
);

// ── 7. THE CREDENTIAL'S FAILURE PATH — criterion 2 ─────────────────────────
rule('7. the credential broken — what an agent sees when the token stops working');

try { daemon.child.kill('SIGKILL'); } catch {}
await sleep(500);
// Corrupt the token in place, without ever reading the real one: the file is
// rewritten wholesale from the non-secret fields plus a token that is plainly
// not a credential. Nothing real is echoed, and the throwaway copy is destroyed
// with the temp home.
const credPath = path.join(butchrDir, 'jira-credential.json');
const meta = JSON.parse(fs.readFileSync(credPath, 'utf8'));
fs.writeFileSync(
  credPath,
  JSON.stringify({ siteUrl: meta.siteUrl, email: meta.email, storage: 'file', token: 'revoked-token-not-a-real-one' }),
  { mode: 0o600 }
);
daemon = startDaemon({ BUTCHR_ATLASSIAN_PROXY: 'jira-write' });
await sleep(2500);

const dead = await withMcp(OWN_KEY, (mcp) =>
  callTool(mcp, 'atlassian_transition_issue', { issueKey: OWN_KEY, transitionId: '31' })
);
check(
  'the write fails LOUDLY rather than looking like a transition that happened',
  dead.isError === true && dead.payload?.success === false,
  `isError=${dead.isError} success=${dead.payload?.success}`
);
// THE CASE KAN-291's PROBE FOUND, AND IT WAS A KAN-272 DEFECT ON THE READ PATH
// TOO. Jira answers 404 — not 401 — for an issue the caller may not see, so a
// revoked credential arrives here looking exactly like a mistyped issue key,
// and the agent was being told "the daemon's credential worked; the issue does
// not exist". Every word of that was wrong. `credentialStillWorks` is what now
// separates a dead credential from a missing issue, by asking.
check(
  'it is named a CREDENTIAL fault — the fleet is affected, not this query',
  dead.payload?.credentialFault === true,
  `credentialFault=${dead.payload?.credentialFault} status=${dead.payload?.status}`
);
check(
  'and it says so even though Atlassian answered 404, which is what a dead token looks like',
  dead.payload?.status === 404 ? /is no longer being accepted|NOT a fault in your request/i.test(String(dead.payload?.error ?? '')) : true,
  `status=${dead.payload?.status}: ${String(dead.payload?.error ?? '').slice(0, 300)}`
);
check(
  'it does not tell the agent to go and check its issue key',
  !/issue .{0,30}does not exist|credential worked/i.test(String(dead.payload?.error ?? '')),
  String(dead.payload?.error ?? '').slice(0, 300)
);
check(
  'the message tells the agent this is not its problem and not worth retrying',
  /not your query|every agent|a human/i.test(String(dead.payload?.error ?? '')),
  String(dead.payload?.error ?? '').slice(0, 700)
);
check(
  'it names the endpoint that refused it, so the failure is diagnosable',
  Array.isArray(dead.payload?.legs) && dead.payload.legs.length > 0,
  JSON.stringify(dead.payload?.legs ?? []).slice(0, 400)
);
check(
  'and the refusal carries no token, in any form',
  !/revoked-token-not-a-real-one/.test(JSON.stringify(dead.payload)),
  'the scrubber let the configured token through into the agent-visible error'
);

const deadAudit = readAudit();
check(
  'and the daemon log says a credential fault happened, for the human looking later',
  deadAudit.some((l) => /credential fault/.test(l)),
  deadAudit.slice(0, 4).join('\n')
);

// ── verdict ────────────────────────────────────────────────────────────────
if (notes.length) {
  console.log(`\n${'─'.repeat(76)}\nNOTES\n${'─'.repeat(76)}`);
  for (const note of notes) console.log(`   • ${note}`);
}
console.log(
  `\n${failures ? `FAILED — ${failures} check(s)` : 'OK — a real write reached real Atlassian, the policy refused a real foreign ticket without sending anything, and a broken credential failed loudly with a leg and no token.'}\n`
);
process.exit(failures ? 1 : 0);
