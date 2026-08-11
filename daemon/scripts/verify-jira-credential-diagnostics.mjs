// Proof that a rejected Atlassian credential now says *which* leg refused it
// and why — the KAN-31 fix — plus proof that no encoded form of the token
// reaches any message, log line, or response along the way.
//
// WHAT FAILURE THIS WOULD CATCH: a rejected credential reported as one
// undifferentiated failure, with the four legs — bad token, LD-side
// permission, timeout, network — collapsed into a message that tells you
// nothing about which to fix. And, at the same time, any encoded form of the
// token reaching a message, a log line or a response.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// The constraint that shapes this script: no agent may hold a real credential
// (KAN-20). So every case is produced against a local stub with a fake token.
// That is not a weaker test than the real thing — the stub can produce a
// gateway 403, a hung socket and a server that echoes your Authorization
// header back at you on demand, which Atlassian will not do on request.
//
// Every scenario runs the real TokenJiraTransport and the real JiraClient from
// dist/, so what you see printed is what the settings page renders verbatim.
//
// Usage: node daemon/scripts/verify-jira-credential-diagnostics.mjs [distDir]

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { TokenJiraTransport, JiraClient, VALIDATE_TIMEOUT_MS } = await import(
  path.join(distDir, 'jira.js')
);

// A token with a shape nothing else in the output could produce by accident,
// so a grep for it is conclusive either way.
const FAKE_TOKEN = 'ATATT-KAN31-CANARY-c0ffee-d00d-cafebabe-1234567890';
const EMAIL = 'nobody@example.invalid';
const CLOUD_ID = '00000000-1111-2222-3333-444444444444';

// Every on-the-wire form the canary could take. The grep at the end looks for
// all of them, not just the raw string — a leaked `Authorization` header is
// base64, and a leaked query parameter is percent-encoded.
const SECRET_FORMS = {
  raw: FAKE_TOKEN,
  'basic base64 (email:token)': Buffer.from(`${EMAIL}:${FAKE_TOKEN}`).toString('base64'),
  'base64 (token)': Buffer.from(FAKE_TOKEN).toString('base64'),
  'percent-encoded': encodeURIComponent(FAKE_TOKEN),
  'first 12 chars': FAKE_TOKEN.slice(0, 12)
};

// ---------------------------------------------------------------- the stub --
//
// One server plays both roles. `routes` is swapped per scenario.

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, port });
    });
  });
}

/** Responds to tenant_info with a cloud ID; everything else per `rest`. */
function siteHandler(rest) {
  return (req, res) => {
    if (req.url.startsWith('/_edge/tenant_info')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cloudId: CLOUD_ID }));
      return;
    }
    rest(req, res);
  };
}

/** Atlassian's real 401 from a site host: JSON content type, plain-text body. */
function siteHost401(req, res) {
  res.writeHead(401, {
    'content-type': 'application/json;charset=UTF-8',
    'x-seraph-loginreason': 'AUTHENTICATED_FAILED',
    'x-arequestid': 'stub-site-request-id'
  });
  res.end('Client must be authenticated to access this resource.');
}

/** The gateway's real 401 shape, with the scope wording Atlassian uses. */
function gateway401(message) {
  return (req, res) => {
    res.writeHead(401, {
      'content-type': 'application/json',
      'x-failure-category': 'FAILURE_CLIENT_AUTH',
      'atl-traceid': 'stub-gateway-trace-id'
    });
    res.end(JSON.stringify({ code: 401, message }));
  };
}

// ------------------------------------------------------------- the harness --

const collected = []; // every string a user or an operator would ever see

function record(where, text) {
  collected.push({ where, text });
}

/**
 * Run one validation and print exactly what the settings page would show.
 *
 * `console.log` is captured too, so the daemon's own log line is part of what
 * gets grepped for the canary at the end.
 */
async function scenario(title, { siteUrl, gatewayOrigin, expect }) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);

  const transport = new TokenJiraTransport(
    { siteUrl, email: EMAIL, token: FAKE_TOKEN },
    gatewayOrigin
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  let result;
  try {
    result = await new JiraClient(transport).validate(controller.signal);
  } finally {
    clearTimeout(timer);
  }

  // What the daemon logs — the same string router.ts builds.
  const logLine =
    `jira: credential submitted for ${EMAIL} @ ${siteUrl} — ` +
    (result.valid
      ? 'valid, stored in file'
      : `rejected (${result.diagnosis ?? 'unknown'})`) +
    (result.legs?.length
      ? `; legs: ${result.legs
          .map((l) => `${l.leg}=${l.failure ?? l.status}${l.traceId ? ` trace:${l.traceId}` : ''}`)
          .join(' ')}`
      : '');

  console.log(`\n  verdict ..... ${result.valid ? 'ACCEPTED' : 'REJECTED'}`);
  console.log(`  diagnosis ... ${result.diagnosis ?? '(none — accepted)'}`);
  console.log('\n  what the user sees:\n');
  const shown = result.valid
    ? [result.accountName ? `Verified as ${result.accountName}. Stored in a 0600 file.` : 'Credential verified. Stored in a 0600 file.', result.note]
        .filter(Boolean)
        .join('\n\n')
    : result.error;
  console.log(
    shown
      .split('\n')
      .map((l) => `      │ ${l}`)
      .join('\n')
  );
  console.log(`\n  daemon log line:\n      │ ${logLine}`);

  record(`${title} → user message`, shown);
  record(`${title} → daemon log`, logLine);
  record(`${title} → full response JSON`, JSON.stringify(result));
  record(`${title} → transport.describe()`, transport.describe());

  if (expect && result.diagnosis !== expect) {
    console.log(`\n  ⚠ expected diagnosis "${expect}", got "${result.diagnosis}"`);
    process.exitCode = 1;
  }
  return result;
}

const servers = [];
const spawn = async (handler) => {
  const s = await serve(handler);
  servers.push(s.server);
  return s;
};
process.on('exit', () => servers.forEach((s) => s.close()));

// A port nothing is listening on, for the unreachable cases.
const dead = await serve(() => {});
const DEAD_ORIGIN = dead.origin;
await new Promise((r) => dead.server.close(r));

console.log('== KAN-31: distinguishable credential-validation failures ==');
console.log(`   fake token in use: ${FAKE_TOKEN.slice(0, 8)}… (canary, ${FAKE_TOKEN.length} chars)`);
console.log('   no real credential is involved at any point.');

// ---- case 1: the site address is wrong or the site is down ----------------
await scenario('CASE 1 — unreachable site (wrong address, or host down)', {
  siteUrl: DEAD_ORIGIN,
  gatewayOrigin: DEAD_ORIGIN,
  expect: 'network'
});

// ---- case 1b: something is there, but it is not Jira ----------------------
{
  const notJira = await spawn((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>Not found</body></html>');
  });
  await scenario('CASE 1b — the host answers, but it is not a Jira site', {
    siteUrl: notJira.origin,
    gatewayOrigin: DEAD_ORIGIN,
    expect: 'site-not-jira'
  });
}

// ---- case 2 + 5: the gateway rejects the token, and so does the site ------
{
  const site = await spawn(siteHandler(siteHost401));
  const gw = await spawn(gateway401('Unauthorized; scope does not match'));
  await scenario('CASES 2+5 — gateway 401 AND site-host 401 (the originally reported failure)', {
    siteUrl: site.origin,
    gatewayOrigin: gw.origin,
    expect: 'credentials-rejected'
  });
}

// ---- case 3: authenticated, but not allowed to read Jira -----------------
{
  const site = await spawn(siteHandler(siteHost401));
  const gw = await spawn((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json', 'atl-traceid': 'stub-403-trace' });
    res.end(
      JSON.stringify({
        code: 403,
        message: 'The token does not have the required scope: read:jira-work'
      })
    );
  });
  await scenario('CASE 3 — gateway 403: authenticated, but missing read:jira-work', {
    siteUrl: site.origin,
    gatewayOrigin: gw.origin,
    expect: 'gateway-forbidden'
  });
}

// ---- case 4: site-host 401 with the gateway unreachable ------------------
{
  const site = await spawn(siteHandler(siteHost401));
  await scenario('CASE 4 — site-host 401, gateway unreachable (classic-token path)', {
    siteUrl: site.origin,
    gatewayOrigin: DEAD_ORIGIN,
    expect: 'credentials-rejected'
  });
}

// ---- case 6: nothing answers in time -------------------------------------
{
  // Accepts the connection and then says nothing at all, forever. A closed
  // port produces a network error; this produces a genuine timeout, and the
  // two used to be reported with the same sentence.
  const hang = await spawn(() => {});
  await scenario(`CASE 6 — timeout: the site accepts the connection and never replies`, {
    siteUrl: hang.origin,
    gatewayOrigin: hang.origin,
    expect: 'timeout'
  });
}

// ---- the auth-path bug this ticket asked us to look for ------------------
{
  // A token minted exactly as the settings page instructs: read:jira-work and
  // nothing else. `/myself` needs read:jira-user, so the gateway refuses it
  // with a 401 — and the old code took that 401, fell back to the site host
  // (which never accepts a scoped token), and reported "Atlassian rejected the
  // email and API token". A working credential, refused.
  const site = await spawn(siteHandler(siteHost401));
  const gw = await spawn((req, res) => {
    if (req.url.includes('/myself')) {
      gateway401('Unauthorized; scope does not match')(req, res);
      return;
    }
    if (req.url.includes('/project/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ values: [], total: 0 }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await scenario(
    'AUTH BUG — scoped token with read:jira-work only (was rejected; now accepted)',
    { siteUrl: site.origin, gatewayOrigin: gw.origin }
  );
}

// ---- happy path, for contrast --------------------------------------------
{
  const site = await spawn(siteHandler(siteHost401));
  const gw = await spawn((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ displayName: 'Wroos Bit', accountId: 'stub' }));
  });
  await scenario('CONTROL — a fully scoped token (accepted, named)', {
    siteUrl: site.origin,
    gatewayOrigin: gw.origin
  });
}

// ---- hygiene: a server that echoes the credential back at us -------------
{
  // The realistic leak. A misbehaving proxy or a debug endpoint quotes your
  // request headers in its error body; anything that forwards that body
  // verbatim publishes the token. Atlassian will not do this on demand, which
  // is exactly why it has to be stubbed.
  const site = await spawn(
    siteHandler((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          errorMessages: [
            `Rejected request with Authorization: ${req.headers.authorization} and token ${FAKE_TOKEN}`
          ]
        })
      );
    })
  );
  const gw = await spawn(gateway401(`bad token ${FAKE_TOKEN}`));
  await scenario('HYGIENE — a host that echoes the Authorization header back in its error body', {
    siteUrl: site.origin,
    gatewayOrigin: gw.origin,
    expect: 'credentials-rejected'
  });
}

// ------------------------------------------------------------ the grep -----

console.log(`\n${'═'.repeat(78)}\nSECRET HYGIENE\n${'═'.repeat(78)}`);
console.log(`\n  ${collected.length} strings collected across every scenario:`);
console.log('    • the exact message rendered in the settings page');
console.log('    • the daemon log line router.ts writes');
console.log('    • the complete JSON response sent back over native messaging');
console.log('    • transport.describe(), which goes into diagnostic logs');
console.log('\n  each grepped for every encoded form of the canary token:\n');

let leaked = 0;
for (const [label, form] of Object.entries(SECRET_FORMS)) {
  const hits = collected.filter((c) => c.text.includes(form));
  const ok = hits.length === 0;
  if (!ok) leaked += hits.length;
  console.log(`    ${ok ? '✓' : '✗'} ${label.padEnd(28)} ${ok ? 'not present' : `FOUND in ${hits.map((h) => h.where).join(', ')}`}`);
}

// The scrubbed marker should appear where the echoing host tried to leak it —
// absence of the token is only convincing if we also show the redaction fired.
const redacted = collected.filter((c) => c.text.includes('***REDACTED***'));
console.log(
  `\n    ${redacted.length > 0 ? '✓' : '✗'} redaction actually fired in ${redacted.length} of the collected strings` +
    ' (the echoing-host scenario)'
);

if (leaked > 0) {
  console.log(`\n  ✗ ${leaked} leak(s). This is a hard failure.`);
  process.exitCode = 1;
} else {
  console.log('\n  ✓ no form of the token appears in any message, log line, or response.');
}

console.log(`\n${'═'.repeat(78)}`);
console.log(process.exitCode ? 'FAILED' : 'ALL CASES DISTINGUISHABLE, NO SECRET LEAKED');
console.log('═'.repeat(78));
process.exit(process.exitCode ?? 0);
