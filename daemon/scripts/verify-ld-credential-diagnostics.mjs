// Proof that a rejected LaunchDarkly token says *which* way it was refused —
// bad token, LD-side permission, timeout, network — with the leg named, plus
// proof that no encoded form of the token reaches any message, log line, or
// response along the way. KAN-86, mirroring verify-jira-credential-diagnostics.
//
// WHAT FAILURE THIS WOULD CATCH: a rejected LaunchDarkly token reported as one
// undifferentiated failure, with the legs — bad token, LD-side permission,
// timeout, network — collapsed into a message that names none of them. And, at
// the same time, any encoded form of the token reaching a message, a log line
// or a response.
//
// The constraint that shapes this script: no agent may hold a real credential
// (KAN-20). So every case is produced against a local stub with a fake token.
// That is not a weaker test than the real thing — the stub can produce a 403,
// a hung socket and a server that echoes your Authorization header back at
// you on demand, which LaunchDarkly will not do on request.
//
// Every scenario runs the real `validateLdToken` from dist/, so what you see
// printed is what the settings page renders verbatim.
//
// Usage: node daemon/scripts/verify-ld-credential-diagnostics.mjs [distDir]

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { validateLdToken } = await import(path.join(distDir, 'integrations', 'launchdarkly.js'));
const { VALIDATE_TIMEOUT_MS } = await import(path.join(distDir, 'jira.js'));

// A token with a shape nothing else in the output could produce by accident,
// so a grep for it is conclusive either way.
const FAKE_TOKEN = 'api-KAN86-CANARY-c0ffee-d00d-cafebabe-1234567890';

// Every on-the-wire form the canary could take. The grep at the end looks for
// all of them, not just the raw string — a leaked `Authorization` header is
// the raw value here (LD tokens travel bare), but a misbehaving proxy can
// re-encode what it quotes.
const SECRET_FORMS = {
  raw: FAKE_TOKEN,
  'base64 (token)': Buffer.from(FAKE_TOKEN).toString('base64'),
  'percent-encoded': encodeURIComponent(FAKE_TOKEN),
  'first 12 chars': FAKE_TOKEN.slice(0, 12)
};

// ---------------------------------------------------------------- the stub --

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, port });
    });
  });
}

// ------------------------------------------------------------- the harness --

const collected = []; // every string a user or an operator would ever see

function record(where, text) {
  collected.push({ where, text });
}

/**
 * Run one validation and print exactly what the settings page would show,
 * plus the log line router.ts builds for the submission.
 */
async function scenario(title, { apiOrigin, expect }) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  let result;
  try {
    result = await validateLdToken(FAKE_TOKEN, controller.signal, apiOrigin);
  } finally {
    clearTimeout(timer);
  }

  // What the daemon logs — the same string router.ts builds.
  const logLine =
    `launchdarkly: credential submitted — ` +
    (result.valid ? 'valid, stored in file' : `rejected (${result.diagnosis ?? 'unknown'})`) +
    (result.legs?.length
      ? `; legs: ${result.legs
          .map((l) => `${l.leg}=${l.failure ?? l.status}${l.traceId ? ` trace:${l.traceId}` : ''}`)
          .join(' ')}`
      : '');

  console.log(`\n  verdict ..... ${result.valid ? 'ACCEPTED' : 'REJECTED'}`);
  console.log(`  diagnosis ... ${result.diagnosis ?? '(none — accepted)'}`);
  console.log('\n  what the user sees:\n');
  const shown = result.valid ? 'Token verified.' : result.error;
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

// A port nothing is listening on, for the unreachable case.
const dead = await serve(() => {});
const DEAD_ORIGIN = dead.origin;
await new Promise((r) => dead.server.close(r));

console.log('== KAN-86: distinguishable LaunchDarkly credential-validation failures ==');
console.log(`   fake token in use: ${FAKE_TOKEN.slice(0, 8)}… (canary, ${FAKE_TOKEN.length} chars)`);
console.log('   no real credential is involved at any point.');

// ---- a deliberately bad token: LD refuses it outright ---------------------
{
  const ld = await spawn((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'stub-401-req-id' });
    res.end(JSON.stringify({ code: 'unauthorized', message: 'Invalid access token' }));
  });
  await scenario('BAD TOKEN — LaunchDarkly answers 401', {
    apiOrigin: ld.origin,
    expect: 'token-rejected'
  });
}

// ---- authenticated but not permitted: an LD-side permission problem -------
{
  const ld = await spawn((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json', 'x-request-id': 'stub-403-req-id' });
    res.end(
      JSON.stringify({ code: 'forbidden', message: 'Access token does not have permission' })
    );
  });
  await scenario('FORBIDDEN — token authenticates, LaunchDarkly denies the read (403)', {
    apiOrigin: ld.origin,
    expect: 'ld-forbidden'
  });
}

// ---- nothing is listening -------------------------------------------------
await scenario('NETWORK — app.launchdarkly.com unreachable (named as such, token untested)', {
  apiOrigin: DEAD_ORIGIN,
  expect: 'network'
});

// ---- nothing answers in time ----------------------------------------------
{
  // Accepts the connection and then says nothing at all, forever. A closed
  // port produces a network error; this produces a genuine timeout, and the
  // two get different sentences.
  const hang = await spawn(() => {});
  await scenario('TIMEOUT — the API accepts the connection and never replies', {
    apiOrigin: hang.origin,
    expect: 'timeout'
  });
}

// ---- something unexpected -------------------------------------------------
{
  const ld = await spawn((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Service unavailable' }));
  });
  await scenario('UNEXPECTED — LaunchDarkly answers 503', {
    apiOrigin: ld.origin,
    expect: 'unexpected-status'
  });
}

// ---- happy path, for contrast ---------------------------------------------
{
  const ld = await spawn((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [], totalCount: 0 }));
  });
  await scenario('CONTROL — a working token (accepted)', { apiOrigin: ld.origin });
}

// ---- hygiene: a server that echoes the credential back at us --------------
{
  // The realistic leak. A misbehaving proxy or a debug endpoint quotes your
  // request headers in its error body; anything that forwards that body
  // verbatim publishes the token. LaunchDarkly will not do this on demand,
  // which is exactly why it has to be stubbed. Padding forces the body past
  // the 200-character display cap, so truncation-after-scrubbing is exercised
  // too.
  const ld = await spawn((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 'unauthorized',
        message:
          `Rejected request with Authorization: ${req.headers.authorization}; ` +
          `token=${FAKE_TOKEN}; url-encoded=${encodeURIComponent(FAKE_TOKEN)}. ` +
          'Padding so this body exceeds the display cap and forces truncation: ' +
          'x'.repeat(300)
      })
    );
  });
  await scenario('HYGIENE — a host that echoes the Authorization header back in its error body', {
    apiOrigin: ld.origin,
    expect: 'token-rejected'
  });
}

// ------------------------------------------------------------ the grep -----

console.log(`\n${'═'.repeat(78)}\nSECRET HYGIENE\n${'═'.repeat(78)}`);
console.log(`\n  ${collected.length} strings collected across every scenario:`);
console.log('    • the exact message rendered in the settings page');
console.log('    • the daemon log line router.ts writes');
console.log('    • the complete JSON response sent back over native messaging');
console.log('\n  each grepped for every encoded form of the canary token:\n');

let leaked = 0;
for (const [label, form] of Object.entries(SECRET_FORMS)) {
  const hits = collected.filter((c) => c.text.includes(form));
  const ok = hits.length === 0;
  if (!ok) leaked += hits.length;
  console.log(
    `    ${ok ? '✓' : '✗'} ${label.padEnd(28)} ${ok ? 'not present' : `FOUND in ${hits.map((h) => h.where).join(', ')}`}`
  );
}

// The scrubbed marker should appear where the echoing host tried to leak it —
// absence of the token is only convincing if we also show the redaction fired.
const redacted = collected.filter((c) => c.text.includes('***REDACTED***'));
console.log(
  `\n    ${redacted.length > 0 ? '✓' : '✗'} redaction actually fired in ${redacted.length} of the collected strings` +
    ' (the echoing-host scenario)'
);
if (redacted.length === 0) process.exitCode = 1;

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
