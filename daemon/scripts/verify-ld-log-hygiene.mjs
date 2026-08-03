// End-to-end secret hygiene for the LaunchDarkly credential path, through the
// real MessageRouter and a real on-disk log file. KAN-86, mirroring
// verify-jira-log-hygiene.mjs.
//
// The companion script (verify-ld-credential-diagnostics.mjs) exercises the
// validator directly. This one goes the whole way: it drives
// `router.handle({action: 'set_integration_credential', integration:
// 'launchdarkly', …})` exactly as the native host does, redirects console into
// a log file the same way daemon.ts does, captures every outbound message,
// and then runs a literal `grep` over both. It also drives `list_integrations`
// — the new settings surface — so the response KAN-87 will render is captured
// verbatim and swept for secrets with everything else.
//
// Only failure paths are driven, deliberately. A validated credential gets
// *saved*, and this machine's credential store is the real one — a proof
// script has no business writing a token into it. Failure paths never reach
// `store.save`, which is itself the KAN-20 property being relied on here.
//
// No real credential is used or required. The token below is a canary.
//
// Usage: node daemon/scripts/verify-ld-log-hygiene.mjs [distDir]

import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { JiraIssueTypeService } = await import(path.join(distDir, 'jira.js'));
const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { LaunchDarklyIntegration, LAUNCHDARKLY_CREDENTIAL_SPEC, createLaunchDarklyIntegration } =
  await import(path.join(distDir, 'integrations', 'launchdarkly.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

const FAKE_TOKEN = 'api-KAN86-CANARY-c0ffee-d00d-cafebabe-1234567890';

const SECRET_FORMS = {
  raw: FAKE_TOKEN,
  'base64 (token)': Buffer.from(FAKE_TOKEN).toString('base64'),
  'percent-encoded': encodeURIComponent(FAKE_TOKEN),
  'leading 12 chars': FAKE_TOKEN.slice(0, 12)
};

// -- a log file written exactly as daemon.ts writes its own ----------------
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan86-log-'));
const logPath = path.join(workDir, 'daemon.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const realLog = console.log;
const toLog = (...args) => {
  const line = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
};

// -- stubs -----------------------------------------------------------------
const servers = [];
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}`)
    );
  });
}
process.on('exit', () => {
  servers.forEach((s) => s.close());
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A host that quotes the request's Authorization header back in its error. */
const echoingOrigin = await serve((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'stub-req-id' });
  res.end(
    JSON.stringify({
      code: 'unauthorized',
      message:
        `Refused. Authorization was ${req.headers.authorization}; token=${FAKE_TOKEN}; ` +
        `url-encoded=${encodeURIComponent(FAKE_TOKEN)}. ` +
        'Padding so this body exceeds the 200-character display cap and forces truncation: ' +
        'x'.repeat(300)
    })
  );
});

const deadOrigin = await (async () => {
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
  return origin;
})();

// -- the real router, with the LD adapter pointed at the stubs -------------
//
// Per-scenario adapters because the API origin is fixed at construction; the
// second router construction reuses everything else. The Jira service and the
// registry are the real ones, so `list_integrations` below is the production
// answer for this machine.
const outbound = [];
const send = (msg) => outbound.push(msg);
const jira = new JiraIssueTypeService(new CredentialStore());
// Registered exactly as daemon.ts registers them, which is what makes the
// `list_integrations` response below this machine's production answer rather
// than a construction of this script's. The one thing that is this script's is
// the enabled state: it goes to a throwaway file, because a proof script must
// not write into the machine's real integrations.json — and both are then
// switched on, which is what this machine's configured credentials migrate to.
const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(workDir, 'integrations.json'))
);
registry.registerIntegration(
  createAtlassianIntegration({
    issueTypeLookup: (key) => jira.getIssueTypeName(key),
    credential: jira
  })
);
registry.setEnabled('jira', true);

function routerWith(apiOrigin) {
  const ld = new LaunchDarklyIntegration(
    new CredentialStore(LAUNCHDARKLY_CREDENTIAL_SPEC),
    apiOrigin
  );
  // Re-registering by id replaces in place, so the settings surface reports
  // the adapter this router is actually driving.
  registry.registerIntegration(createLaunchDarklyIntegration(ld));
  registry.setEnabled('launchdarkly', true);
  return new MessageRouter(registry, null, null, send, undefined, jira, undefined, undefined, ld);
}

/** Drive one request through `handle` and wait for its correlated reply. */
function drive(router, data) {
  return new Promise((resolve) => {
    const id = `probe-${outbound.length}-${Math.random().toString(36).slice(2)}`;
    const seen = outbound.length;
    router.handle({ ...data, id });
    const poll = setInterval(() => {
      const reply = outbound.slice(seen).find((m) => m.id === id);
      if (reply) {
        clearInterval(poll);
        resolve(reply);
      }
    }, 25);
  });
}

console.log = toLog;
console.error = toLog;

const results = [];
{
  const router = routerWith(echoingOrigin);
  results.push([
    'echoing host, 401',
    await drive(router, {
      action: 'set_integration_credential',
      integration: 'launchdarkly',
      token: FAKE_TOKEN
    })
  ]);
  // Status, which also runs the storage probe.
  results.push([
    'credential status',
    await drive(router, { action: 'integration_credential_status', integration: 'launchdarkly' })
  ]);
  // The settings surface itself: both integrations, provided types, non-secret
  // credential summaries. Captured into outbound.jsonl and swept below.
  results.push(['list_integrations', await drive(router, { action: 'list_integrations' })]);
}
{
  const router = routerWith(deadOrigin);
  results.push([
    'unreachable API',
    await drive(router, {
      action: 'set_integration_credential',
      integration: 'launchdarkly',
      token: FAKE_TOKEN
    })
  ]);
}

console.log = realLog;
console.error = realLog;
await new Promise((r) => logStream.end(r));

// -- report ----------------------------------------------------------------
console.log('== KAN-86: LD log + outbound-message hygiene, through the real router ==\n');
console.log(`  canary token: ${FAKE_TOKEN.slice(0, 8)}… (${FAKE_TOKEN.length} chars)`);
console.log(`  log file:     ${logPath}\n`);

for (const [label, reply] of results) {
  console.log(`  ── ${label} ──`);
  if (reply.error) {
    console.log(
      reply.error
        .split('\n')
        .map((l) => `     ${l}`)
        .join('\n')
    );
  }
  if (reply.diagnosis) console.log(`     [diagnosis: ${reply.diagnosis}]`);
  if (reply.storageTarget) {
    console.log(
      `     [storageTarget: ${reply.storageTarget.storage} → ${reply.storageTarget.path ?? 'keyring'}]`
    );
  }
  if (reply.action === 'list_integrations_response') {
    const { id: _id, ...shape } = reply;
    console.log(
      JSON.stringify(shape, null, 2)
        .split('\n')
        .map((l) => `     ${l}`)
        .join('\n')
    );
  }
  console.log('');
}

console.log('  the daemon log this produced:\n');
const logText = fs.readFileSync(logPath, 'utf8');
for (const line of logText.trimEnd().split('\n')) console.log(`     ${line}`);

const outboundPath = path.join(workDir, 'outbound.jsonl');
fs.writeFileSync(outboundPath, outbound.map((m) => JSON.stringify(m)).join('\n') + '\n');

console.log(`\n  ${'─'.repeat(70)}`);
console.log('  grepping BOTH files for every encoded form of the canary:\n');
console.log(`    ${logPath}`);
console.log(`    ${outboundPath}  (${outbound.length} outbound messages, verbatim)\n`);

let failures = 0;
for (const [label, form] of Object.entries(SECRET_FORMS)) {
  // A literal grep, not an in-memory includes(): the point is that the bytes
  // on disk are clean, and grep is what anyone auditing this would reach for.
  let hits = '';
  try {
    hits = execFileSync('grep', ['-c', '-F', '--', form, logPath, outboundPath], {
      encoding: 'utf8'
    });
  } catch (e) {
    hits = e.stdout ?? '';
  }
  const total = hits
    .trim()
    .split('\n')
    .reduce((n, l) => n + Number(l.split(':').pop() || 0), 0);
  if (total > 0) failures++;
  console.log(`    ${total === 0 ? '✓' : '✗'} ${label.padEnd(28)} ${total} occurrence(s)`);
}

// Absence of the token only proves anything if the scrubber actually had
// something to remove — otherwise a stub that never echoed a credential would
// pass this script trivially.
const redactions = (
  (logText + fs.readFileSync(outboundPath, 'utf8')).match(/\*\*\*REDACTED\*\*\*/g) ?? []
).length;
console.log(
  `\n    ${redactions > 0 ? '✓' : '✗'} ***REDACTED*** appears ${redactions} time(s) across the two files — ` +
    'the scrubber demonstrably fired rather than there being nothing to scrub'
);

console.log(`\n  ${failures === 0 ? '✓ clean' : `✗ ${failures} leaked form(s)`}`);
process.exit(failures === 0 && redactions > 0 ? 0 : 1);
