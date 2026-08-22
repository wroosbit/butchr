#!/usr/bin/env node
// KAN-647: the one line a deploy gate runs so that its deploy is attributable.
//
// A gate does its own work — preflight, checkout, build, restart. This is the
// step between the build and the restart, and it is a separate script for one
// reason: the daemon judges an intent by comparing the digest in it against the
// digest it computes at startup, and TWO IMPLEMENTATIONS OF ONE HASH IS A BUG
// WAITING TO BE WRITTEN. `fingerprintDist` is imported from the tree that was
// just built, so the gate and the daemon cannot disagree about what a build is.
//
// Usage, from a gate, AFTER the build and BEFORE the restart:
//   node daemon/scripts/announce-deploy-intent.mjs --by epic/KAN-203 [--note "..."]
//
// It pins both the checkout's HEAD and the built tree's digest. The daemon
// refuses an intent that pins neither, and refuses one whose pins do not match
// what actually came up — so writing this and then restarting onto something
// else is recorded as a bypass, not as a gated deploy. That is deliberate:
// "the gate ran" and "the gate landed what it promised" are different claims.
//
// ! THIS IS NOT AN AUTHORISATION AND GRANTS NOTHING. It writes a file saying
// who is about to deploy. Anyone who can restart the daemon can write it, and
// under one shared identity nothing can tell a real one from a forged one —
// exactly as with `BUTCHR-APPROVAL` markers on a PR. What it removes is the
// SILENT case: a change to the running fleet that names nobody at all.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const by = valueOf('--by');
if (!by) {
  console.error(
    'announce-deploy-intent: --by is required and has no default.\n' +
      '  A default would make every deploy attributable to the same string, which is\n' +
      '  the unattributed case wearing a name. Pass the type/KEY doing the deploy.'
  );
  process.exit(2);
}

let ledger;
try {
  ledger = await import(path.join(DIST, 'deploy-ledger.js'));
} catch (err) {
  console.error(
    `daemon/dist/deploy-ledger.js is not importable: ${err?.message ?? err}\n` +
      `Run this AFTER the build — an intent stamped from an unbuilt tree pins a\n` +
      `digest the daemon will not come up on, and lands as \`mismatched-intent\`.`
  );
  process.exit(1);
}

const build = ledger.readBuildIdentity(valueOf('--dist') ?? DIST);
if (build.dist.error) {
  console.error(`cannot fingerprint the build: ${build.dist.error}`);
  process.exit(1);
}
if (build.head === null && build.dist.digest === null) {
  console.error(
    'neither a HEAD nor a build digest could be read, so nothing could pin this intent.\n' +
      '  The daemon would refuse it as `unpinned-intent` rather than gate on it.'
  );
  process.exit(1);
}

const intent = {
  by,
  at: new Date().toISOString(),
  intendedHead: build.head,
  intendedDist: build.dist.digest,
  note: valueOf('--note')
};

const target = valueOf('--out') ?? ledger.DEPLOY_INTENT_FILE;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(intent, null, 2)}\n`);

// Read it back rather than trusting the write — a discipline this repository
// applies to Jira and Confluence writes, and the reasoning does not stop there.
const readBack = JSON.parse(fs.readFileSync(target, 'utf8'));
const same = JSON.stringify(readBack) === JSON.stringify(intent);
console.log(`wrote ${target}`);
console.log(`  by             ${intent.by}`);
console.log(`  intendedHead   ${intent.intendedHead ?? '(none)'}`);
console.log(`  intendedDist   ${intent.intendedDist ?? '(none)'}`);
console.log(`  read back identical: ${same}`);
if (!same) {
  console.error('the file on disk is not what was written — do not restart on this.');
  process.exit(1);
}
console.log('');
console.log(`Restart the daemon within ${Math.round(ledger.INTENT_MAX_AGE_MS / 60000)} minutes:`);
console.log('  systemctl --user restart butchr-daemon.service');
console.log('Then confirm the ledger agrees:');
console.log('  node daemon/scripts/report-deploy-ledger.mjs');
