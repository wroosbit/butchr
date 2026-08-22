#!/usr/bin/env node
// KAN-647: answer "was this deploy gated?" for somebody who was not there.
//
// The ledger is written by the daemon at every start (`daemon/src/deploy-
// ledger.ts`), so it exists whether or not a deploy script ran. This is the
// read side: it turns the JSONL into something an agent can paste on a ticket.
//
// Usage:
//   node daemon/scripts/report-deploy-ledger.mjs            # last 20 starts
//   node daemon/scripts/report-deploy-ledger.mjs --all
//   node daemon/scripts/report-deploy-ledger.mjs --ungated  # only the bypasses
//   node daemon/scripts/report-deploy-ledger.mjs --json
//   node daemon/scripts/report-deploy-ledger.mjs --file <path>
//
// ⚠ AN EMPTY LEDGER IS NOT AN ALL-CLEAR, and this script refuses to let that
// reading pass silently. There are two worlds in which this file is absent —
// nothing has restarted since the ledger landed, and the running daemon is a
// build that predates it — and in the second one every deploy since is
// unrecorded and always will be. The header says which questions the file
// cannot answer rather than printing a reassuring zero.
//
// `report-` and not `verify-`: this asserts nothing and exits 0 on any readable
// ledger. It is an instrument, not a gate. What holds the ledger to account is
// `verify-deploy-ledger-is-unbypassable.mjs`.

import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

let ledger;
try {
  ledger = await import(path.join(DIST, 'deploy-ledger.js'));
} catch (err) {
  console.error(
    `daemon/dist/deploy-ledger.js is not importable: ${err?.message ?? err}\n` +
      `Build first: npm --prefix daemon run build`
  );
  process.exit(1);
}

const file = valueOf('--file') ?? ledger.DEPLOY_LEDGER_FILE;
const { records, unreadableLines, exists } = ledger.readLedger(file);

if (flag('--json')) {
  console.log(JSON.stringify({ file, exists, unreadableLines, records }, null, 2));
  process.exit(0);
}

console.log(`ledger: ${file}`);
if (!exists) {
  console.log('');
  console.log('  NO LEDGER FILE. This is not the same as "no ungated deploys", and the');
  console.log('  difference matters: the file is created by the first daemon start that');
  console.log('  carries deploy-ledger.ts, so its absence is equally consistent with');
  console.log('');
  console.log('    (a) nothing has restarted since this landed, and');
  console.log('    (b) the daemon serving right now is an older build, in which case');
  console.log('        every deploy since is unrecorded and cannot be recovered.');
  console.log('');
  console.log('  Tell them apart by asking the running daemon what it is, not this file:');
  console.log('    systemctl --user show butchr-daemon.service -p ExecMainStartTimestamp');
  console.log('    grep "deploy ledger:" ~/.local/share/butchr/daemon.log | tail -1');
  process.exit(0);
}

const shown = flag('--ungated')
  ? records.filter((r) => r.gate?.kind === 'ungated' && r.start?.kind !== 'first-record')
  : flag('--all')
    ? records
    : records.slice(-20);

const fleetChanging = records.filter((r) =>
  ['deploy', 'checkout-moved', 'indeterminate'].includes(r.start?.kind)
);
const unattributed = fleetChanging.filter((r) => r.gate?.kind === 'ungated');

console.log(
  `${records.length} start(s) recorded` +
    (unreadableLines > 0 ? `, ${unreadableLines} unreadable line(s)` : '') +
    `; ${fleetChanging.length} changed what the fleet runs, ` +
    `${unattributed.length} of those attributable to NOBODY.`
);
console.log('');

for (const r of shown) {
  const gate =
    r.gate?.kind === 'gated'
      ? `gated by ${r.gate.by} (pinned ${(r.gate.pinned ?? []).join('+') || 'nothing'})`
      : `UNGATED: ${r.gate?.because ?? '(no verdict)'}`;
  const head = r.build?.head ? r.build.head.slice(0, 12) : '(no checkout)';
  const dist = r.build?.dist?.digest ? r.build.dist.digest.slice(0, 12) : '(unreadable)';
  console.log(`${r.at}  pid ${r.pid}`);
  console.log(`  start   ${r.start?.kind}`);
  console.log(`  gate    ${gate}`);
  console.log(`  build   head ${head}  dist ${dist}`);
  if (typeof r.build?.behindOriginMain === 'number' && r.build.behindOriginMain > 0) {
    console.log(
      `  ! ${r.build.behindOriginMain} commit(s) of origin/main were NOT in this build,` +
        ` as of that clone's last fetch`
    );
  }
  if (r.gate?.kind === 'ungated' && r.start?.kind !== 'first-record') {
    console.log(`          ${r.gate.detail}`);
  }
  if (r.consumeError) console.log(`  ! ${r.consumeError}`);
  console.log('');
}

if (!flag('--all') && !flag('--ungated') && records.length > shown.length) {
  console.log(`(${records.length - shown.length} older start(s) not shown — pass --all)`);
}
