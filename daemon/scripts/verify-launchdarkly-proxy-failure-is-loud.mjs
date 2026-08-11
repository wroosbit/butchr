// KAN-298, acceptance criteria 1, 2 and 5: a real call through the daemon-side
// LaunchDarkly proxy, made over real MCP stdio by the real `mcp.ts` an agent
// runs — and the same call, on the same instrument, when the credential behind
// it has been revoked.
//
// WHAT FAILURE THIS WOULD CATCH: the proxy inheriting the failure mode it exists
// to remove. The configured official LaunchDarkly server has never worked in
// this fleet — the invocation in `~/.claude.json` omits the `start` subcommand
// and passes `--access-token` where the CLI wants `--api-key`, so it prints
// usage and exits before it ever speaks MCP. What an agent saw was **nothing**:
// a tool list quietly missing twenty entries, with no message, no error and
// nothing to debug. A proxy whose dead credential produces an empty body, a
// bare `success: false`, a message naming no endpoint, or anything an agent
// could mistake for "this project has no flags" has reproduced that defect
// rather than removed it. This script would also catch the proxy serving with
// the switch unset, the tool list being offered while the daemon would refuse
// the call, and a write tool appearing in a listing.
//
// CI-RUNNABLE: yes — spawns the built daemon and mcp server against a loopback
// stub under a temporary $HOME; no herdr, no real credential, no peer, no
// terminal, no network beyond 127.0.0.1.
//
// ── THE POSITIVE CONTROL, AND WHY IT IS SECTION 2 ───────────────────────────
//
// Section 4's finding is "the call fails, loudly". A broken instrument produces
// a failing call too — a daemon that never started, a socket nothing listens
// on, a tool name nothing routes — and every assertion in section 4 would pass
// for a reason with nothing to do with credentials. So section 2 makes the SAME
// call, through the same MCP server, to the same daemon, against the same stub,
// and requires it to come back with real data. Section 4's red is only worth
// something because section 2 was green a moment earlier.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE QUOTING IT ─────────
//
// REAL: `daemon/dist/daemon.js` as its own process; `daemon/dist/mcp.js` as its
// own process, which is byte-for-byte the MCP server every agent runs; the MCP
// stdio protocol, spoken properly — initialize, initialized, tools/list,
// tools/call; the unix socket between them; the whole
// `mcp.ts → router.ts → LaunchDarklyIntegration.proxyRead` chain; the credential
// store reading a real 0600 metadata file.
//
// NOT REAL: LaunchDarkly. The far end is a stub HTTP server in this process and
// the credential is a fabricated string this script writes and deletes — no real
// token is read, written, echoed or involved, and nothing here reaches
// app.launchdarkly.com. The daemon is pointed at the stub with
// `BUTCHR_LAUNCHDARKLY_API_ORIGIN`, which `daemon.ts` clamps to loopback.
//
// Three consequences, stated rather than left to be assumed:
//
//   1. **This does not establish that LaunchDarkly accepts these REST paths.**
//      It establishes that the proxy builds them, sends them, and reports what
//      came back. The live evidence for that leg is
//      `daemon/scripts/probe-launchdarkly-proxy-real-calls.mjs`, which makes all
//      ten calls against the real API with the real stored credential and is
//      not runnable in CI because it needs one. **Neither script covers the
//      other, and the gap between them is real**: this one would stay green if
//      every path in the table were subtly wrong, and that one would stay green
//      if `mcp.ts` never forwarded a call.
//   2. **This script writes the credential it then asserts on** — KAN-145's
//      shape, named here rather than left to be found. What that leaves
//      uncovered is whether a *real* revoked LaunchDarkly token produces the 401
//      this stub produces. Nobody covers that with a script and nobody can: it
//      needs a real token to be revoked. What covers it instead is
//      `validateLdToken`'s own diagnosis path, exercised by
//      `verify-launchdarkly-proxy-scope.mjs` §8 against every status.
//   3. **The plan-limited 403 is stubbed from an observation, not invented.**
//      The body the stub returns for the AI Configs endpoints is verbatim what
//      app.launchdarkly.com returned on 2026-08-11 for this account:
//      `{"code":"forbidden","message":"Plan does not allow this operation"}`.
//
// Usage: node daemon/scripts/verify-launchdarkly-proxy-failure-is-loud.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The daemon's log, read off disk rather than off its stdout.
 *
 * `daemon.ts` redirects `console.log` into `$BUTCHR_DIR/daemon.log`, so a script
 * that tails the child's stdout sees an empty string and every assertion about
 * the log passes vacuously. This script's first run did exactly that: "nothing
 * in the log carries the token" was green against a log it had never read.
 */
function daemonLog() {
  try {
    return fs.readFileSync(path.join(butchrDir, 'daemon.log'), 'utf8');
  } catch {
    return '';
  }
}

// A setup guard, not a verdict: `process.exit(1)` here says the instrument was
// never assembled, which is a different thing from a check failing.
if (!fs.existsSync(path.join(daemonDir, 'dist', 'mcp.js'))) {
  console.error('daemon/dist/mcp.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan298-ldproxy-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });

/**
 * The credential. FABRICATED HERE, BY THIS SCRIPT, and deleted with the temp
 * directory on exit. It is not a token, it has never been a token, and no real
 * credential is read at any point — the whole file lives under a `$HOME` that
 * did not exist a moment ago.
 */
const FAKE_TOKEN = 'kan298-verify-not-a-real-token-000000000000';

/** What the stub does next. Flipped between sections; the daemon sees it live. */
let credentialAccepted = true;
/** Every request the daemon actually made, so absences can be distinguished. */
const requests = [];

const stub = http.createServer((req, res) => {
  requests.push({ url: req.url, apiVersion: req.headers['ld-api-version'] ?? null });
  const auth = req.headers.authorization ?? '';

  // LaunchDarkly takes the token bare in Authorization — no scheme prefix. A
  // request arriving without it is the daemon failing to authenticate at all,
  // which must not read as a data answer.
  if (auth !== FAKE_TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'kan298stubtrace' });
    res.end(JSON.stringify({ code: 'unauthorized', message: 'invalid access token' }));
    return;
  }

  if (!credentialAccepted) {
    // LaunchDarkly's own words for a revoked or expired token — the wording
    // `extractDetail` exists to preserve.
    res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'kan298stubtrace' });
    res.end(JSON.stringify({ code: 'unauthorized', message: 'invalid access token' }));
    return;
  }

  // The plan-gated 403, verbatim from the real API on 2026-08-11.
  if (/^\/api\/v2\/projects\/[^/]+\/ai-configs/.test(req.url)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'forbidden', message: 'Plan does not allow this operation' }));
    return;
  }

  if (/^\/api\/v2\/flags\/butchr\/agent-runner/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'agent-runner', name: 'agent-runner (butchr agent-execution backend)' }));
    return;
  }
  if (/^\/api\/v2\/flags\/butchr/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ key: 'agent-runner', name: 'agent-runner' }] }));
    return;
  }
  if (/^\/api\/v2\/flags\/no-such-project/.test(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'Unknown project key: no-such-project' }));
    return;
  }
  if (/^\/api\/v2\/projects\/butchr\/environments/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ key: 'test' }, { key: 'production' }] }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'not_found', message: 'Not found' }));
});

await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubOrigin = `http://127.0.0.1:${stub.address().port}`;

fs.writeFileSync(
  path.join(butchrDir, 'launchdarkly-credential.json'),
  JSON.stringify({ storage: 'file', token: FAKE_TOKEN }, null, 2) + '\n',
  { mode: 0o600 }
);

let daemon = null;
let mcp = null;

function cleanup() {
  try { mcp?.kill('SIGKILL'); } catch {}
  try { daemon?.kill('SIGKILL'); } catch {}
  try { stub.close(); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ── the two processes, and the protocol between them ───────────────────────

function startDaemon(extraEnv) {
  const child = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
    env: {
      ...process.env,
      HOME: fakeHome,
      BUTCHR_BOARD_RECONCILE: 'off',
      BUTCHR_LAUNCHDARKLY_API_ORIGIN: stubOrigin,
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

/** A real `mcp.ts`, spoken to over real MCP stdio. */
function startMcpClient() {
  const child = spawn(
    process.execPath,
    [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', 'KAN-298'],
    { env: { ...process.env, HOME: fakeHome }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const waiting = new Map();
  const stderr = [];
  let buffer = '';
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
      if (entry) {
        waiting.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });
  child.stderr.on('data', (b) => stderr.push(String(b)));
  child.on('error', () => {});

  let nextId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} did not answer within 25s`));
      }, 25_000);
      waiting.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');

  return { child, request, notify, stderr };
}

async function connectMcp() {
  const client = startMcpClient();
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kan298-verify', version: '1.0.0' }
  });
  client.notify('notifications/initialized');
  return client;
}

/** The text a tool call came back with, parsed. Tool results are JSON strings. */
function toolPayload(response) {
  const text = response?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
}

// ── 1. the proxy is on, and the tool list is what the table says ───────────
rule('1. the daemon is up with BUTCHR_LAUNCHDARKLY_PROXY=launchdarkly-read');

const on = startDaemon({ BUTCHR_LAUNCHDARKLY_PROXY: 'launchdarkly-read' });
daemon = on.child;
await sleep(1800);

let client = await connectMcp();
mcp = client.child;

const listed = await client.request('tools/list');
const toolNames = (listed?.result?.tools ?? []).map((t) => t.name);
const ldTools = toolNames.filter((name) => name.startsWith('launchdarkly_'));

check(
  'the ten read tools are advertised over real MCP',
  ldTools.length === 10,
  JSON.stringify(ldTools)
);
check(
  'and NONE of them is a write — checked on the wire, not in the table',
  !ldTools.some((name) => /_(create|update|delete|patch|put|post|set|remove|archive)_/.test(name)),
  JSON.stringify(ldTools)
);
check(
  'the descriptions say a listed tool is not a working one',
  (listed?.result?.tools ?? [])
    .filter((t) => t.name.startsWith('launchdarkly_'))
    .every((t) => /FAILURE HERE IS ALWAYS LOUD/.test(t.description)),
  JSON.stringify(ldTools)
);

// ── 2. THE POSITIVE CONTROL ────────────────────────────────────────────────
rule('2. positive control — a real proxied read comes back with real data');

const good = await client.request('tools/call', {
  name: 'launchdarkly_get_feature_flag',
  arguments: { projectKey: 'butchr', featureFlagKey: 'agent-runner' }
});
const goodPayload = toolPayload(good);
check(
  'launchdarkly_get_feature_flag succeeds end to end',
  goodPayload?.success === true && goodPayload?.body?.key === 'agent-runner',
  JSON.stringify(goodPayload).slice(0, 400)
);
check(
  'the answer says which credential served it',
  goodPayload?.via?.servedBy === 'butchr-daemon' && typeof goodPayload?.via?.path === 'string',
  JSON.stringify(goodPayload?.via)
);
check(
  'the daemon really made an HTTP request for it',
  requests.some((r) => r.url === '/api/v2/flags/butchr/agent-runner'),
  JSON.stringify(requests.map((r) => r.url))
);
check(
  'a success is not flagged as an error to the client',
  good?.result?.isError !== true,
  JSON.stringify(good?.result?.isError)
);
const list = toolPayload(
  await client.request('tools/call', {
    name: 'launchdarkly_list_feature_flags',
    arguments: { projectKey: 'butchr', limit: 5 }
  })
);
check(
  'launchdarkly_list_feature_flags succeeds end to end',
  list?.success === true && Array.isArray(list?.body?.items),
  JSON.stringify(list).slice(0, 300)
);
check(
  'the bound reached the wire — limit was clamped into the path',
  requests.some((r) => r.url === '/api/v2/flags/butchr?limit=5'),
  JSON.stringify(requests.map((r) => r.url))
);
// The beta header, which only the AI Config operations declare. Asserted on a
// non-AI-Config call so that "it is sent" and "it is sent only where declared"
// are two findings rather than one.
check(
  'the beta API-version header is NOT sent on a flag read',
  requests.filter((r) => r.url.startsWith('/api/v2/flags')).every((r) => r.apiVersion === null),
  JSON.stringify(requests.filter((r) => r.url.startsWith('/api/v2/flags')))
);

// ── 3. no tool outside the granted set is reachable ────────────────────────
rule('3. AC6 on the wire — a write tool is not offered and cannot be called');

for (const guessed of ['launchdarkly_delete_feature_flag', 'launchdarkly_update_feature_flag']) {
  check(
    `${guessed} is not in the advertised tool list`,
    !toolNames.includes(guessed),
    JSON.stringify(toolNames)
  );
  const attempted = await client.request('tools/call', { name: guessed, arguments: { projectKey: 'butchr' } });
  const text = JSON.stringify(toolPayload(attempted)) + JSON.stringify(attempted?.error ?? {});
  check(
    `and calling ${guessed} anyway is refused`,
    attempted?.result?.isError === true || attempted?.error !== undefined,
    JSON.stringify(attempted).slice(0, 300)
  );
  check(
    `the refusal for ${guessed} explains that the omission is deliberate`,
    /deliberately has none/.test(text),
    text.slice(0, 400)
  );
}
check(
  'no request reached LaunchDarkly for either write attempt',
  !requests.some((r) => /flags\/butchr$/.test(r.url) && r.url.includes('delete')),
  JSON.stringify(requests.map((r) => r.url))
);

// ── 4. the failure paths, and none of them is silence ──────────────────────
rule('4. AC5 — every failure names its cause; none reads as an empty result');

// 4a. The plan-limited 403, which must NOT be reported as a dead credential.
const planned = await client.request('tools/call', {
  name: 'launchdarkly_list_ai_configs',
  arguments: { projectKey: 'butchr' }
});
const plannedPayload = toolPayload(planned);
check(
  'a plan-limited 403 is an error to the client, not an empty list',
  planned?.result?.isError === true && plannedPayload?.success === false,
  JSON.stringify(plannedPayload).slice(0, 400)
);
check(
  'it names the plan limitation',
  /ACCOUNT PLAN DOES NOT INCLUDE THIS FEATURE/.test(String(plannedPayload?.error)),
  String(plannedPayload?.error).slice(0, 500)
);
check(
  'and it is NOT a credential fault — the fleet is not told its token died',
  plannedPayload?.credentialFault === false,
  JSON.stringify({ credentialFault: plannedPayload?.credentialFault })
);
check(
  'the beta API-version header IS sent on an AI Config read',
  requests.some((r) => r.url.includes('/ai-configs') && r.apiVersion === 'beta'),
  JSON.stringify(requests.filter((r) => r.url.includes('ai-configs')))
);

// 4b. A 404, which is the query's problem.
const missing = toolPayload(
  await client.request('tools/call', {
    name: 'launchdarkly_list_feature_flags',
    arguments: { projectKey: 'no-such-project' }
  })
);
check(
  'a 404 is reported as the query\'s problem and not the credential\'s',
  missing?.success === false && missing?.credentialFault === false && /404/.test(String(missing?.error)),
  JSON.stringify(missing).slice(0, 400)
);
check(
  "and it carries LaunchDarkly's own words about it",
  /Unknown project key/.test(String(missing?.error)),
  String(missing?.error).slice(0, 300)
);

// 4c. Bad arguments never reach LaunchDarkly at all.
const before = requests.length;
const hostile = toolPayload(
  await client.request('tools/call', {
    name: 'launchdarkly_get_feature_flag',
    arguments: { projectKey: '../../../../api/v2/members/me', featureFlagKey: 'x' }
  })
);
check(
  'a path-traversal attempt is refused before any request is made',
  hostile?.success === false && requests.length === before,
  JSON.stringify({ payload: hostile, newRequests: requests.slice(before).map((r) => r.url) }).slice(0, 400)
);

// 4d. THE REVOKED CREDENTIAL. The one this whole ticket is about.
credentialAccepted = false;
const revoked = await client.request('tools/call', {
  name: 'launchdarkly_get_feature_flag',
  arguments: { projectKey: 'butchr', featureFlagKey: 'agent-runner' }
});
const revokedPayload = toolPayload(revoked);
check(
  'a revoked credential produces an ERROR, not an empty answer',
  revoked?.result?.isError === true && revokedPayload?.success === false,
  JSON.stringify(revokedPayload).slice(0, 400)
);
check(
  'the error says the fleet is affected, so nobody debugs their own query for an hour',
  /every agent using this proxy/.test(String(revokedPayload?.error)),
  String(revokedPayload?.error).slice(0, 500)
);
check(
  'it is marked a credential fault',
  revokedPayload?.credentialFault === true,
  JSON.stringify({ credentialFault: revokedPayload?.credentialFault })
);
check(
  'and it names the endpoint that refused it',
  Array.isArray(revokedPayload?.legs) &&
    revokedPayload.legs.some((leg) => typeof leg.endpoint === 'string' && leg.endpoint.includes('/api/v2/')),
  JSON.stringify(revokedPayload?.legs)
);
check(
  'the failure body is never empty and never a bare status',
  typeof revokedPayload?.error === 'string' && revokedPayload.error.length > 80,
  JSON.stringify(revokedPayload?.error)
);
// THE SECRET. The whole response, every field, checked for the token in every
// form it could take on the wire.
const revokedText = JSON.stringify(revokedPayload);
check(
  'nothing in the failure carries the token, in any encoding',
  !revokedText.includes(FAKE_TOKEN) &&
    !revokedText.includes(encodeURIComponent(FAKE_TOKEN)) &&
    !revokedText.includes(Buffer.from(FAKE_TOKEN).toString('base64')) &&
    !revokedText.includes(FAKE_TOKEN.slice(0, 16)),
  revokedText.slice(0, 400)
);
// The log, read off disk. A positive control first: if `daemonLog()` returned
// an empty string the two assertions below would both pass for the wrong
// reason, which is exactly what this script's first run did.
const logText = daemonLog();
check(
  'the daemon log was actually read — the checks below are not vacuous',
  /launchdarkly-proxy:/.test(logText),
  `no launchdarkly-proxy lines in ${path.join(butchrDir, 'daemon.log')}; ` +
    `the log is ${logText.length} bytes and its stdout said: ${on.log.join('').slice(0, 300)}`
);
check(
  "and the log carries no token, in any encoding",
  !logText.includes(FAKE_TOKEN) &&
    !logText.includes(encodeURIComponent(FAKE_TOKEN)) &&
    !logText.includes(Buffer.from(FAKE_TOKEN).toString('base64')) &&
    !logText.includes(FAKE_TOKEN.slice(0, 16)),
  logText.split('\n').filter((l) => l.includes('launchdarkly')).slice(-4).join('\n')
);
check(
  'the audit line records the refusal as well as the successes',
  /launchdarkly-proxy: task\/KAN-298 → launchdarkly_get_feature_flag GET \S+ → FAILED 401/.test(logText),
  logText.split('\n').filter((l) => l.includes('launchdarkly-proxy')).slice(-4).join('\n')
);
check(
  'and it recorded the successful reads too, so the log can answer "what has this credential done"',
  /launchdarkly-proxy: task\/KAN-298 → launchdarkly_list_feature_flags GET \S+ → 200/.test(logText),
  logText.split('\n').filter((l) => l.includes('launchdarkly-proxy')).slice(0, 4).join('\n')
);

credentialAccepted = true;

// ── 5. the switch, on the same instrument ──────────────────────────────────
rule('5. with the switch unset, the same instrument serves nothing');

try { mcp?.kill('SIGKILL'); } catch {}
try { daemon?.kill('SIGKILL'); } catch {}
await sleep(600);

const off = startDaemon({ BUTCHR_LAUNCHDARKLY_PROXY: undefined });
daemon = off.child;
await sleep(1800);

client = await connectMcp();
mcp = client.child;

const offList = await client.request('tools/list');
const offNames = (offList?.result?.tools ?? []).map((t) => t.name);
check(
  'no LaunchDarkly tool is advertised when the switch is unset',
  !offNames.some((name) => name.startsWith('launchdarkly_')),
  JSON.stringify(offNames.filter((n) => n.startsWith('launchdarkly_')))
);
check(
  'the butchr tools are still there — the daemon is up, not broken',
  offNames.includes('butchr_capacity'),
  JSON.stringify(offNames.slice(0, 6))
);
const offRequestsBefore = requests.length;
const refused = await client.request('tools/call', {
  name: 'launchdarkly_get_feature_flag',
  arguments: { projectKey: 'butchr', featureFlagKey: 'agent-runner' }
});
const refusedPayload = toolPayload(refused);
check(
  'and a call made anyway is refused by the daemon, naming the switch',
  refusedPayload?.success === false && /BUTCHR_LAUNCHDARKLY_PROXY/.test(String(refusedPayload?.error)),
  JSON.stringify(refusedPayload).slice(0, 400)
);
check(
  'nothing reached LaunchDarkly while the proxy was off',
  requests.length === offRequestsBefore,
  JSON.stringify(requests.slice(offRequestsBefore).map((r) => r.url))
);

// ── 6. the loopback clamp on the origin override ───────────────────────────
rule('6. the origin override cannot send the credential anywhere but loopback');

try { mcp?.kill('SIGKILL'); } catch {}
try { daemon?.kill('SIGKILL'); } catch {}
await sleep(600);

const hijack = startDaemon({
  BUTCHR_LAUNCHDARKLY_PROXY: 'launchdarkly-read',
  BUTCHR_LAUNCHDARKLY_API_ORIGIN: 'https://evil.example.invalid'
});
daemon = hijack.child;
await sleep(1800);
const hijackLog = daemonLog();
check(
  'a non-loopback origin override is REFUSED and says so',
  /is not a loopback address — REFUSED/.test(hijackLog),
  hijackLog.split('\n').filter((l) => l.includes('REFUSED') || l.includes('loopback')).slice(-4).join('\n')
);
check(
  'and the real LaunchDarkly origin is kept rather than the attacker-supplied one',
  /using https:\/\/app\.launchdarkly\.com/.test(hijackLog) && !hijackLog.includes('evil.example.invalid — OK'),
  hijackLog.split('\n').filter((l) => l.includes('launchdarkly:')).slice(-4).join('\n')
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — ten reads and no writes advertised over real MCP, a real proxied read served, a ' +
        'revoked credential producing a loud error that names the endpoint and says the fleet is ' +
        'affected, a plan-limited 403 told apart from it, no token in the response or the log, ' +
        'nothing served with the switch unset, and the origin override clamped to loopback.'
  }\n`
);
process.exit(failures ? 1 : 0);
