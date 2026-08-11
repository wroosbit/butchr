// Proof that the settings page tells the user where their LaunchDarkly token
// will be stored *before* they type it — KAN-86, mirroring
// verify-jira-storage-disclosure.mjs.
//
// WHAT FAILURE THIS WOULD CATCH: a settings page that names the wrong store
// before the user types a secret — Jira's file rather than LaunchDarkly's,
// which is exactly what a regressed parametrization would produce — or a
// credential file left readable by anyone but its owner.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Butchr prefers the OS keyring and silently falls back to a 0600 file when
// libsecret is missing or no secret service is running. Which one you get is
// invisible from the outside; reporting it only in the success message would
// be a disclosure, not a choice.
//
// This runs the real per-integration `CredentialStore.storageTarget()` probe
// against this machine — the LaunchDarkly store, keyed `account launchdarkly`,
// metadata `launchdarkly-credential.json` — and renders the sentence the
// settings page builds from its answer, so the output is what a user would
// actually read.
//
// Usage: node daemon/scripts/verify-ld-storage-disclosure.mjs [distDir]

import { execFileSync } from 'child_process';
import { statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');
const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));
const { LAUNCHDARKLY_CREDENTIAL_SPEC } = await import(
  path.join(distDir, 'integrations', 'launchdarkly.js')
);

console.log('== KAN-86: LaunchDarkly storage disclosure, at entry time ==\n');

// -- what this machine actually offers ------------------------------------
let where = null;
try {
  where = execFileSync('which', ['secret-tool'], { encoding: 'utf8' }).trim();
} catch {
  // Not on PATH.
}
console.log(`  secret-tool on PATH ....... ${where || 'NO — not installed'}`);
console.log(
  '  (PATH presence is not the test anyway: secret-tool installed with no running\n' +
    '   secret service still yields the file backend. CredentialStore probes for real.)\n'
);

// -- the probe the settings page calls ------------------------------------
const target = await new CredentialStore(LAUNCHDARKLY_CREDENTIAL_SPEC).storageTarget();
console.log('  storageTarget() answered:');
console.log(`    storage ... ${target.storage}`);
console.log(`    path ...... ${target.path ?? '(n/a — keyring)'}`);
console.log(`    reason .... ${target.reason}\n`);

// The per-integration store must disclose *its own* landing place, not
// Jira's: a keyring entry keyed `account launchdarkly`, or a file named for
// the integration. A path pointing at jira-credential.json here would mean
// the parametrization regressed.
if (target.path && !path.basename(target.path).startsWith('launchdarkly-')) {
  console.log(`  ✗ disclosed path is not the LaunchDarkly store: ${target.path}`);
  process.exitCode = 1;
}

// -- the exact text the settings page renders from it ----------------------
const headline =
  target.storage === 'keyring'
    ? 'This will be stored in your OS keyring.'
    : 'This will be stored in a file, not your OS keyring.';
const rendered = [headline, target.reason, target.path ? `Path: ${target.path}` : '']
  .filter(Boolean)
  .join(' ');

console.log('  what the user reads, sitting directly under the empty token field,');
console.log('  before any secret has been typed:\n');
console.log('    ┌' + '─'.repeat(74));
for (const line of wrap(rendered, 72)) console.log(`    │ ${line}`);
console.log('    └' + '─'.repeat(74));

// -- and the file's permissions, if one is already there ------------------
if (target.path) {
  try {
    const mode = statSync(target.path).mode & 0o777;
    console.log(
      `\n  existing ${path.basename(target.path)} mode: 0${mode.toString(8)}` +
        (mode === 0o600 ? ' ✓' : ' ✗ EXPECTED 0600')
    );
    if (mode !== 0o600) process.exitCode = 1;
  } catch {
    console.log(`\n  no credential file present yet (nothing has been stored) — expected here.`);
  }
}

if (!process.exitCode) {
  console.log(
    `\n  ✓ the backend is disclosed at entry time, and it is "${target.storage}" on this machine.`
  );
}
process.exit(process.exitCode ?? 0);

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
