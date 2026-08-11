// KAN-272, acceptance criteria 1 and 2: a real call through the daemon-side
// Atlassian proxy, made over real MCP stdio by the real `mcp.ts` an agent runs
// — and the same call, on the same instrument, when the credential behind it
// has been revoked.
//
// WHAT FAILURE THIS WOULD CATCH: the proxy inheriting the failure mode it exists
// to remove. On 2026-08-10 every agent's Atlassian tools were dead for about
// twelve hours while the processes serving them stayed alive: the tools were
// *present*, calls did not work, and nothing an agent could see said whether
// the fault was its query or a credential the whole fleet shared. A proxy whose
// dead credential produces an empty body, a bare `success: false`, a message
// naming no endpoint, or anything an agent could mistake for "no results" has
// moved that outage rather than removed it. This script would also catch the
// proxy serving with the switch unset, and the tool list being offered while
// the daemon would refuse the call.
//
// ── THE POSITIVE CONTROL, AND WHY IT IS SECTION 2 ───────────────────────────
//
// Section 3's finding is "the call fails, loudly". A broken instrument produces
// a failing call too — a daemon that never started, a socket nothing listens
// on, a tool name nothing routes — and every assertion in section 3 would pass
// for a reason with nothing to do with credentials. So section 2 makes the
// SAME call, through the same MCP server, to the same daemon, against the same
// stub, and requires it to come back with real data. Section 3's red is only
// worth something because section 2 was green a moment earlier.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE QUOTING IT ─────────
//
// REAL: `daemon/dist/daemon.js` as its own process; `daemon/dist/mcp.js` as its
// own process, which is byte-for-byte the MCP server every agent runs; the MCP
// stdio protocol, spoken properly — initialize, initialized, tools/list,
// tools/call; the unix socket between them; the whole `mcp.ts → router.ts →
// JiraIssueTypeService → TokenJiraTransport` chain; the credential store
// reading a real 0600 metadata file.
//
// NOT REAL: Atlassian. The far end is a stub HTTP server in this process, and
// the credential is a fabricated string this script writes and deletes — no
// real token is read, written, echoed or involved, and nothing here reaches
// api.atlassian.com. Two consequences, stated rather than left to be assumed:
//
//   1. **This does not establish that Atlassian accepts these REST paths.** It
//      establishes that the proxy builds them, sends them, and reports what
//      came back. The paths themselves are the ones `jira.ts` has used against
//      real Atlassian on a 60-second timer since 2026-08-04 — see `WATCH_FIELDS`
//      and `SEARCH_PATH` — so the live evidence for that leg is the running
//      poller, and it is not this script's to give.
//   2. **This script writes the credential it then asserts on** (KAN-145's
//      shape). What that leaves uncovered is whether a *real* revoked Atlassian
//      token produces the 401 this stub produces. Nobody covers that with a
//      script and nobody can: it needs a real token to be revoked. What covers
//      it instead is `verify-jira-credential-diagnostics.mjs`, which is the
//      proof that `explainLegs` reads a real Atlassian refusal correctly, and
//      the fact that the 2026-08-10 outage was itself an observation of the
//      real thing.
//
// Usage: node daemon/scripts/verify-atlassian-proxy-failure-is-loud.mjs [--verbose]
// Run it after `npm run build` in daemon/. It needs no herdr, no network and no
// credential of yours; it never touches your real $HOME.

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { JiraIssueTypeService } from '../dist/jira.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

// ── the world ──────────────────────────────────────────────────────────────

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan272-proxy-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });

/**
 * The credential. FABRICATED HERE, BY THIS SCRIPT, and deleted with the temp
 * directory on exit. It is not a token, it has never been a token, and no real
 * credential is read at any point — the whole file lives under a `$HOME` that
 * did not exist a moment ago.
 */
const FAKE_TOKEN = 'kan272-verify-not-a-real-token-000000000000';

/** What the stub does next. Flipped between sections; the daemon sees it live. */
let credentialAccepted = true;
/** Every request the daemon actually made, so absences can be distinguished. */
const requests = [];

const stub = http.createServer((req, res) => {
  requests.push(req.url);
  const auth = req.headers.authorization ?? '';

  // The unauthenticated site-discovery endpoint. It answers, and deliberately
  // carries no cloudId: that keeps every request on the site-host leg and off
  // api.atlassian.com, which is where a scoped token would otherwise be sent.
  // Nothing invalid is ever fired at Atlassian's production gateway.
  if (req.url.startsWith('/_edge/tenant_info')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
    return;
  }

  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessages: ['Client must be authenticated to access this resource.'] }));
    return;
  }

  if (!credentialAccepted) {
    // Atlassian's own words for a revoked or expired token, verbatim from the
    // site host — the wording `extractDetail` exists to preserve.
    res.writeHead(401, {
      'content-type': 'application/json',
      'atl-traceid': 'kan272stubtrace'
    });
    res.end(JSON.stringify({ errorMessages: ['Client must be authenticated to access this resource.'], errors: {} }));
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
          parent: { key: 'KAN-39' }
        }
      })
    );
    return;
  }
  if (/^\/rest\/api\/3\/issue\/KAN-9999\?/.test(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }));
    return;
  }
  if (req.url.startsWith('/rest/api/3/search/jql')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ issues: [{ key: 'KAN-272', fields: { status: { name: 'In Progress' } } }], isLast: true }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ errorMessages: ['Not found'] }));
});

await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${stub.address().port}`;

fs.writeFileSync(
  path.join(butchrDir, 'jira-credential.json'),
  JSON.stringify({ siteUrl, email: 'verify@example.invalid', storage: 'file', token: FAKE_TOKEN }, null, 2) + '\n',
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
      // Nothing here should be reconciling a board or polling Jira; this script
      // is about one request path and a loop firing underneath it would put
      // unrelated traffic on the stub and unrelated lines in the log.
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

/** A real `mcp.ts`, spoken to over real MCP stdio. */
function startMcpClient() {
  const child = spawn(
    process.execPath,
    [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', 'KAN-272'],
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

/** Bring an MCP client all the way up, as a real client does. */
async function connectMcp() {
  const client = startMcpClient();
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kan272-verify', version: '1.0.0' }
  });
  client.notify('notifications/initialized');
  return client;
}

/** The text a tool call came back with, parsed. Tool results are JSON strings. */
function toolPayload(response) {
  const text = response?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
}

// ── 1. the proxy is on, and the daemon says exactly what it is serving ─────
rule('1. the daemon is up with BUTCHR_ATLASSIAN_PROXY=jira-read');

const on = startDaemon({ BUTCHR_ATLASSIAN_PROXY: 'jira-read' });
daemon = on.child;
await sleep(1800);

let client = await connectMcp();
mcp = client.child;

const listed = await client.request('tools/list');
const toolNames = (listed?.result?.tools ?? []).map((t) => t.name);
if (verbose) console.log(`   tools offered: ${toolNames.join(', ')}`);

check(
  'the agent is offered the three proxied read tools',
  ['atlassian_get_issue', 'atlassian_search_issues', 'atlassian_get_transitions'].every((t) =>
    toolNames.includes(t)
  ),
  JSON.stringify(toolNames)
);
check(
  'and it is offered no proxied tool that writes',
  !toolNames.some((t) => /^atlassian_(create|update|delete|add|edit|transition|post|set)/.test(t)),
  JSON.stringify(toolNames)
);

// ── 2. THE POSITIVE CONTROL — a real call, real data ───────────────────────
rule('2. positive control — a real call through the proxy comes back with real data');

const good = await client.request('tools/call', {
  name: 'atlassian_get_issue',
  arguments: { issueKey: 'KAN-272' }
});
const goodPayload = toolPayload(good);
console.log(`\n   agent called atlassian_get_issue{issueKey:"KAN-272"} and got:\n`);
console.log(
  JSON.stringify(goodPayload, null, 2)
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n')
);
console.log('');

check('the call is not flagged as an error', good?.result?.isError !== true, JSON.stringify(good?.result?.isError));
check('the envelope reports success', goodPayload?.success === true, JSON.stringify(goodPayload).slice(0, 300));
check('it carries Jira\'s HTTP 200', goodPayload?.status === 200, JSON.stringify(goodPayload?.status));
check(
  'it carries the issue Jira actually returned, not an empty shell',
  goodPayload?.body?.key === 'KAN-272' && goodPayload?.body?.fields?.status?.name === 'In Progress',
  JSON.stringify(goodPayload?.body)
);
check(
  'it says which credential served it, so a reader need not guess',
  goodPayload?.via?.servedBy === 'butchr-daemon' && typeof goodPayload?.via?.path === 'string',
  JSON.stringify(goodPayload?.via)
);
check(
  'and the response carries nothing token-shaped',
  !JSON.stringify(goodPayload).includes(FAKE_TOKEN) &&
    !JSON.stringify(goodPayload).toLowerCase().includes('authorization'),
  'a credential reached a tool response'
);
check(
  'the daemon really made the request — the stub saw the built path',
  requests.some((u) => u.startsWith('/rest/api/3/issue/KAN-272?fields=')),
  JSON.stringify(requests)
);

// A second operation, so "it works" is not one lucky path.
const searched = toolPayload(
  await client.request('tools/call', {
    name: 'atlassian_search_issues',
    arguments: { jql: 'project = KAN AND status = "In Progress"', maxResults: 5 }
  })
);
check(
  'a JQL search through the proxy returns Jira\'s rows',
  searched?.success === true && searched?.body?.issues?.[0]?.key === 'KAN-272',
  JSON.stringify(searched).slice(0, 300)
);
check(
  'and it was bounded to what the agent asked for',
  requests.some((u) => u.includes('maxResults=5')),
  JSON.stringify(requests.filter((u) => u.includes('search')))
);

// ── 3. AC2 — the credential is revoked, and the SAME call goes loud ────────
rule('3. the credential is revoked mid-flight — the same call, on the same instrument');

credentialAccepted = false;

const dead = await client.request('tools/call', {
  name: 'atlassian_get_issue',
  arguments: { issueKey: 'KAN-272' }
});
const deadPayload = toolPayload(dead);
console.log(`\n   the same agent made the same call, and got:\n`);
console.log(
  JSON.stringify(deadPayload, null, 2)
    .split('\n')
    .slice(0, 34)
    .map((l) => `      ${l}`)
    .join('\n')
);
console.log('');

check(
  'the MCP result is flagged isError — a model cannot read it as data',
  dead?.result?.isError === true,
  JSON.stringify(dead?.result?.isError)
);
check('the envelope reports failure', deadPayload?.success === false, JSON.stringify(deadPayload).slice(0, 200));
check(
  'THERE IS NO BODY — a dead credential never produces something shaped like an answer',
  deadPayload?.body === undefined,
  JSON.stringify(deadPayload?.body)
);
check(
  'it says this is a CREDENTIAL fault, so the agent knows it is the fleet\'s and not its own',
  deadPayload?.credentialFault === true,
  JSON.stringify(deadPayload?.credentialFault)
);
check('it carries the HTTP status Atlassian answered with', deadPayload?.status === 401, JSON.stringify(deadPayload?.status));
check(
  'it names the endpoint that refused it',
  typeof deadPayload?.error === 'string' && deadPayload.error.includes('127.0.0.1'),
  deadPayload?.error
);
check(
  "it quotes Atlassian's own words rather than inventing a sentence",
  /Client must be authenticated/.test(String(deadPayload?.error)),
  deadPayload?.error
);
check(
  'it tells the agent that retrying will not help and a human must act',
  /retrying will not help/.test(String(deadPayload?.error)) &&
    /human/.test(String(deadPayload?.error)),
  deadPayload?.error
);
check(
  'it says every other agent is about to hit the same thing',
  /every agent using this proxy/.test(String(deadPayload?.error)),
  deadPayload?.error
);
check(
  'the legs are on the response, so the refusal is diagnosable without the daemon log',
  Array.isArray(deadPayload?.legs) && deadPayload.legs.some((l) => l.status === 401),
  JSON.stringify(deadPayload?.legs)
);
check(
  'and Atlassian\'s trace id survives, which is what support asks for',
  JSON.stringify(deadPayload?.legs ?? []).includes('kan272stubtrace'),
  JSON.stringify(deadPayload?.legs)
);
check(
  'no part of the refusal carries the credential',
  !JSON.stringify(deadPayload).includes(FAKE_TOKEN),
  'a credential reached a failure response — the path error paths leak on'
);

// The other half of the distinction: a bad query must NOT be reported as a
// credential fault, or the field says nothing and the agent is back to guessing.
credentialAccepted = true;
const missing = toolPayload(
  await client.request('tools/call', { name: 'atlassian_get_issue', arguments: { issueKey: 'KAN-9999' } })
);
check(
  'a 404 on a real credential is NOT reported as a credential fault',
  missing?.success === false && missing?.credentialFault === false && missing?.status === 404,
  JSON.stringify(missing).slice(0, 300)
);
check(
  'and it says so in the agent\'s terms — the credential worked, the issue does not exist',
  /credential worked/.test(String(missing?.error)),
  missing?.error
);

const badArgs = toolPayload(
  await client.request('tools/call', { name: 'atlassian_get_issue', arguments: { issueKey: '../../admin' } })
);
check(
  'a path-shaped issue key is refused before any request is made',
  badArgs?.success === false && !requests.some((u) => u.includes('admin')),
  JSON.stringify({ badArgs, admin: requests.filter((u) => u.includes('admin')) })
);

// ── 4. the audit line ──────────────────────────────────────────────────────
rule('4. every proxied read is attributed in the daemon log — successes and refusals alike');

await sleep(300);
// The daemon redirects `console.log` to `~/.local/share/butchr/daemon.log` at
// startup (daemon.ts), so its own stdout is empty by design — reading the child
// pipe would report "nothing was logged" about a daemon logging perfectly, an
// absence produced by the instrument rather than by the thing under test.
// Whatever did reach stdout is kept in the failure detail so a crash during
// module load, which happens *before* that redirect, is still visible.
const logPath = path.join(butchrDir, 'daemon.log');
const daemonLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
check(
  'the daemon wrote a log at all — otherwise section 4 measures nothing',
  daemonLog.includes('atlassian-proxy'),
  `no proxy lines in ${logPath}; the daemon's own stdout said: ${on.log.join('').slice(0, 400)}`
);
if (verbose) {
  console.log(
    daemonLog
      .split('\n')
      .filter((l) => l.includes('atlassian-proxy'))
      .map((l) => `      ${l}`)
      .join('\n')
  );
}
check(
  'a successful read is logged with the caller, the tool and the status',
  /atlassian-proxy: task\/KAN-272 → atlassian_get_issue GET \/rest\/api\/3\/issue\/KAN-272\?fields=[^\s]* → 200/.test(
    daemonLog
  ),
  daemonLog.split('\n').filter((l) => l.includes('atlassian-proxy')).slice(0, 4).join('\n')
);
check(
  'a credential failure is logged as one, and named as affecting the fleet',
  /atlassian-proxy:.*FAILED 401.*credential fault/.test(daemonLog),
  daemonLog.split('\n').filter((l) => l.includes('FAILED')).join('\n')
);
check(
  'a query failure is logged as a query fault, not a credential one',
  /atlassian-proxy:.*KAN-9999.*FAILED 404.*query fault/.test(daemonLog),
  daemonLog.split('\n').filter((l) => l.includes('KAN-9999')).join('\n')
);
check(
  'the daemon log carries nothing token-shaped',
  !daemonLog.includes(FAKE_TOKEN),
  'the credential reached the log'
);

// ── 5. the switch, on the live thing ───────────────────────────────────────
rule('5. with the switch unset, the same daemon and the same agent get nothing');

mcp.kill('SIGKILL');
daemon.kill('SIGKILL');
await sleep(500);

const off = startDaemon({ BUTCHR_ATLASSIAN_PROXY: undefined });
daemon = off.child;
await sleep(1800);

const requestsBefore = requests.length;
client = await connectMcp();
mcp = client.child;

const offList = await client.request('tools/list');
const offNames = (offList?.result?.tools ?? []).map((t) => t.name);
check(
  'no proxied tool is offered at all',
  !offNames.some((t) => t.startsWith('atlassian_')),
  JSON.stringify(offNames)
);
check(
  'the agent still has every butchr tool it had before — nothing was taken away',
  offNames.includes('butchr_list_agents') && offNames.includes('butchr_send_to_agent'),
  JSON.stringify(offNames)
);

// The gate, not the menu. A client that lists tools from a cached earlier
// listing can still CALL one, and this is the check that says what happens.
const refused = await client.request('tools/call', {
  name: 'atlassian_get_issue',
  arguments: { issueKey: 'KAN-272' }
});
const refusedPayload = toolPayload(refused);
check('a call made anyway is refused', refusedPayload?.success === false, JSON.stringify(refusedPayload).slice(0, 300));
check('and it is flagged isError', refused?.result?.isError === true, JSON.stringify(refused?.result?.isError));
check(
  'the refusal names the switch an operator would have to set',
  /BUTCHR_ATLASSIAN_PROXY/.test(String(refusedPayload?.error)),
  refusedPayload?.error
);
check(
  'NO request reached Atlassian — the refusal is before the network, not after it',
  requests.length === requestsBefore,
  `${requests.length - requestsBefore} request(s) arrived: ${JSON.stringify(requests.slice(requestsBefore))}`
);

// ── 6. the diagnosis at production shape, with no stub in the way ──────────
rule('6. unit — the production-shaped refusal (gateway 401 then site 401)');

// The live sections above run site-host-only, deliberately, so that nothing
// invalid is fired at Atlassian's production gateway. The shape a real scoped
// token produces is *both* legs refusing, and that is what this covers — with
// an injected transport, so the legs are exactly what a real refusal looks like
// rather than whatever a stub happened to make convenient.
const twoLegRefusal = {
  status: 401,
  body: null,
  legs: [
    { leg: 'cloud-id', endpoint: 'https://real.atlassian.net/_edge/tenant_info', status: 200 },
    {
      leg: 'gateway',
      endpoint: 'https://api.atlassian.com/ex/jira/abc/rest/api/3/issue/KAN-1',
      status: 401,
      detail: 'Unauthorized; scope does not match'
    },
    {
      leg: 'site',
      endpoint: 'https://real.atlassian.net/rest/api/3/issue/KAN-1',
      status: 401,
      detail: 'Client must be authenticated to access this resource.'
    }
  ]
};
const injected = new JiraIssueTypeService(
  { load: async () => ({ siteUrl: 'https://real.atlassian.net', email: 'a@b.c', token: FAKE_TOKEN }) },
  undefined,
  undefined,
  () => ({ get: async () => twoLegRefusal, describe: () => 'injected' })
);
const both = await injected.proxyRead('/rest/api/3/issue/KAN-1?fields=status');
check('both legs refusing is a credential fault', both.ok === false && both.credentialFault === true, JSON.stringify(both).slice(0, 300));
check(
  'and the diagnosis is credentials-rejected, not a site-address problem',
  both.diagnosis === 'credentials-rejected',
  JSON.stringify({ diagnosis: both.diagnosis, error: both.error })
);
check(
  'the message reaches for the likely causes rather than restating the status',
  /revoked token|character missing|email that is not the one/.test(String(both.error)),
  both.error
);

// ── KAN-291: THE 404 THAT IS REALLY A DEAD CREDENTIAL ──────────────────────
//
// Found by `probe-atlassian-proxy-write.mjs` against real Atlassian, and it was
// a defect in THIS path — the read path — not in the write KAN-291 added. Jira
// answers **404, not 401**, for an issue the caller may not see, so a revoked
// credential produces `gateway=401 site=404` and the 404 branch below used to
// tell the agent *"The daemon's credential worked; the issue does not exist."*
// Every clause of that was false, and it is the 2026-08-10 misdiagnosis exactly:
// a fleet-wide credential outage reported to each agent as its own typo.
//
// Both directions are checked, because the fix is a discriminator and a
// discriminator that only ever says one thing is not one. The signature
// `gateway=401 site=404` is ALSO what a healthy *classic* token produces for a
// genuinely missing issue — classic tokens are refused at the gateway by
// design — so the identity probe is what separates them.
function injectedWith(issuePathStatus, identityStatus) {
  const legsFor = (path, status) => [
    { leg: 'cloud-id', endpoint: 'https://real.atlassian.net/_edge/tenant_info', status: 200 },
    { leg: 'gateway', endpoint: `https://api.atlassian.com/ex/jira/abc${path}`, status: 401, detail: 'Unauthorized' },
    { leg: 'site', endpoint: `https://real.atlassian.net${path}`, status, detail: 'Issue does not exist or you do not have permission to see it.' }
  ];
  return new JiraIssueTypeService(
    { load: async () => ({ siteUrl: 'https://real.atlassian.net', email: 'a@b.c', token: FAKE_TOKEN }) },
    undefined,
    undefined,
    () => ({
      get: async (path) => {
        const status = path.startsWith('/rest/api/3/myself') ? identityStatus : issuePathStatus;
        return { status, body: null, legs: legsFor(path, status) };
      },
      describe: () => 'injected-404'
    })
  );
}

const deadCred = await injectedWith(404, 401).proxyRead('/rest/api/3/issue/KAN-1?fields=status');
check(
  'a 404 whose credential is actually dead is reported as a CREDENTIAL fault',
  deadCred.ok === false && deadCred.credentialFault === true,
  JSON.stringify({ status: deadCred.status, credentialFault: deadCred.credentialFault, error: deadCred.error }).slice(0, 400)
);
check(
  'and it does not send the agent to check its issue key',
  !/credential worked|issue .{0,30}does not exist/i.test(String(deadCred.error)) &&
    /no longer being accepted/.test(String(deadCred.error)),
  deadCred.error
);

// THE OTHER DIRECTION, which is what stops the fix being "call everything a
// credential fault". A live classic token and an issue that really is missing.
const liveCred = await injectedWith(404, 200).proxyRead('/rest/api/3/issue/KAN-1?fields=status');
check(
  'a 404 whose credential is fine is still reported as a QUERY fault',
  liveCred.ok === false && liveCred.credentialFault === false,
  JSON.stringify({ status: liveCred.status, credentialFault: liveCred.credentialFault, error: liveCred.error }).slice(0, 400)
);
check(
  'and it still says the credential worked, because it did',
  /credential worked/.test(String(liveCred.error)),
  liveCred.error
);

// And when the probe itself cannot answer, neither verdict is asserted.
const unsure = await injectedWith(404, 503).proxyRead('/rest/api/3/issue/KAN-1?fields=status');
check(
  'an unconfirmable credential is reported as uncertain rather than guessed',
  unsure.credentialFault === false && /could not confirm/.test(String(unsure.error)),
  unsure.error
);

// The other direction the transport can fail: nothing answered at all.
const injectedDead = new JiraIssueTypeService(
  { load: async () => ({ siteUrl: 'https://real.atlassian.net', email: 'a@b.c', token: FAKE_TOKEN }) },
  undefined,
  undefined,
  () => ({
    get: async () => {
      const err = new Error('no leg completed');
      err.legs = [{ leg: 'site', endpoint: 'https://real.atlassian.net/rest/api/3/issue/KAN-1', failure: 'network' }];
      throw err;
    },
    describe: () => 'injected-dead'
  })
);
const nothing = await injectedDead.proxyRead('/rest/api/3/issue/KAN-1?fields=status');
check(
  'a dead transport is a credential fault too, and carries no status',
  nothing.ok === false && nothing.credentialFault === true && nothing.status === undefined,
  JSON.stringify(nothing).slice(0, 300)
);
check(
  'and it says the fleet is affected rather than reporting an empty read',
  /could not reach Atlassian at all/.test(String(nothing.error)) &&
    /Every agent using this proxy/.test(String(nothing.error)),
  nothing.error
);

// A daemon with no credential at all: not an outage, and it must not read as one.
const injectedNone = new JiraIssueTypeService({ load: async () => null }, undefined, undefined, () => {
  throw new Error('a transport must not be built when there is no credential');
});
const none = await injectedNone.proxyRead('/rest/api/3/issue/KAN-1?fields=status');
check(
  'no credential configured refuses without claiming Jira is down',
  none.ok === false && /Nothing is broken and Jira is not down/.test(String(none.error)),
  none.error
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — a real agent-side MCP call went through the proxy and came back with data, the ' +
        'same call with the credential revoked came back loud, attributed and bodiless, and ' +
        'with the switch unset nothing was offered and nothing reached the network'
  }\n`
);
process.exit(failures ? 1 : 0);
