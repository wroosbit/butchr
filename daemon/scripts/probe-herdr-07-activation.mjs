#!/usr/bin/env node
// probe-herdr-07-activation.mjs — KAN-533
//
// WHAT FAILURE THIS WOULD CATCH: a ported spawn path that composes a perfectly
// good herdr 0.7 command line which herdr then REFUSES — the half
// `verify-herdr-spawn-argv.mjs` structurally cannot see, because that script
// asserts on what the daemon would say and never on what herdr does with it.
// This drives the real `HerdrBridge.spawnSession` against a real herdr server
// and reads the result out of herdr's own registry.
//
// CI-RUNNABLE: no — needs a herdr binary, a running herdr server, a workspace,
// a PTY and (for the claude arm) a logged-in Claude Code. It is the arrival
// half named in `verify-herdr-spawn-argv.mjs`'s header; that script is the
// composition half. Neither is sufficient alone.
//
// ⚠ IT MUST NOT RUN AGAINST THE FLEET'S OWN herdr. herdr sessions are named and
// each gets its own socket, so this requires --session and refuses to run
// without one: spawning probe agents into the `default` session would put panes
// in front of the live fleet, and a failed probe could close one. The shim below
// is what pins every call the daemon makes to that session.
//
// Usage:
//   node daemon/scripts/probe-herdr-07-activation.mjs \
//     --herdr /path/to/herdr-0.7.5 --session kan533 [--launcher shell|claude]

import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const dist = path.join(daemonDir, 'dist');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const herdrBin = arg('herdr');
const session = arg('session');
const launcher = arg('launcher', 'shell');
const keep = process.argv.includes('--keep');

if (!herdrBin || !session) {
  console.error(
    'Refusing to run: --herdr <path> and --session <name> are both required.\n' +
    'Without --session this would spawn probe panes into the live fleet\'s herdr.'
  );
  process.exit(1);
}

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${detail}`);
  return ok;
};

// ── The shim ──────────────────────────────────────────────────────────────
// `runHerdrCli` and the attach PTY both call the bare name `herdr`, resolved
// off PATH. Rather than thread a binary path through the product — a test-only
// parameter in shipped code is its own defect — PATH is what gets pointed
// somewhere else. Every herdr call the daemon makes, including the ones this
// script never thought about, lands on the pinned binary and session.
const shimDir = mkdtempSync(path.join(tmpdir(), 'herdr-shim-'));
const shim = path.join(shimDir, 'herdr');
writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(herdrBin)} --session ${session} "$@"\n`);
chmodSync(shim, 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const herdr = (args) => {
  const r = spawnSync(shim, args, { encoding: 'utf8' });
  try {
    return JSON.parse((r.stdout || r.stderr || '').trim());
  } catch {
    return { raw: r.stdout, err: r.stderr, status: r.status };
  }
};

say(`== herdr under test ==`);
const version = execFileSync(shim, ['--version'], { encoding: 'utf8' }).trim();
const status = execFileSync(shim, ['status', 'server'], { encoding: 'utf8' }).trim();
say(`  ${version}`);
say(status.split('\n').map((l) => `  ${l}`).join('\n'));
say('');

// A positive control on the isolation claim itself: this must NOT be the socket
// the fleet's herdr is on. Reported rather than asserted, because what counts as
// the fleet's socket is a property of the machine and not of this script.
// ⚠ Parsed, not pattern-matched. The first version of this check was
// `/0\.[7-9]|[1-9]\d*\./` and it PASSED on `herdr 0.6.4` — `[1-9]\d*\.`
// happily matches the `6.` in the middle. A check that cannot go red is not a
// weak check, it is a check that does not exist, and this one was found only
// because the 0.6.4 arm was actually run.
const vm = /(\d+)\.(\d+)/.exec(version);
const vNum = vm ? [Number(vm[1]), Number(vm[2])] : null;
check(
  vNum !== null && (vNum[0] > 0 || vNum[1] >= 7),
  'the binary under test is 0.7 or newer',
  version
);
check(/compatible: yes/.test(status), 'the client and the server agree on the protocol');

// ── The activation ────────────────────────────────────────────────────────
const type = 'probe';
// Short on purpose: herdr 0.7 caps an agent name at 32 characters, and
// `agentNameFor` prefixes `butchr-probe-`. See the KAN-533 PR body.
const key = `k533${launcher[0]}${process.pid % 10000}`;

const { HerdrBridge } = await import(`file://${path.join(dist, 'herdr.js')}`);
const { workspaceDirFor } = await import(`file://${path.join(dist, 'workspace-dir.js')}`);

const brief =
  '# Automated probe\n\n' +
  'You are an automated liveness probe for KAN-533. Do not read any other file, ' +
  'do not use any tool, and do not start any work.\n\n' +
  'Reply with exactly the word READY and then stop.\n';

say('');
say(`== driving the REAL HerdrBridge.spawnSession (launcher: ${launcher}) ==`);
say('');

const bridge = new HerdrBridge();
let session_;
try {
  session_ = bridge.spawnSession(type, key, undefined, brief, 0, false, launcher, {});
} catch (e) {
  check(false, 'spawnSession threw', e?.message ?? String(e));
}

if (session_) {
  check(session_.spawnError === undefined, 'no spawnError', session_.spawnError ?? '');
  check(session_.status === 'active', `session status is active`, `got ${session_.status}`);
}

// ── What herdr itself says ────────────────────────────────────────────────
// The verdict comes from herdr's registry, not from the daemon's own return
// value. A daemon that believed it had spawned something is exactly the false
// success (KAN-24, KAN-58) this whole path exists to make impossible.
const { agentNameFor } = await import(`file://${path.join(dist, "herdr.js")}`);
const agentName = agentNameFor(type, key);
say('');
say('== what herdr reports, which is the actual verdict ==');
say('');

let record;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const got = herdr(['agent', 'get', agentName]);
  if (got?.result?.agent) { record = got.result.agent; break; }
  // `agent start` is synchronous, so this loop is for the report-agent route
  // and for the attach PTY settling — not for herdr to catch up with itself.
  execFileSync('sleep', ['0.5']);
}

check(record !== undefined, `herdr resolves the agent by name (${agentName})`);
if (record) {
  say(`        ${JSON.stringify({
    name: record.name,
    agent: record.agent,
    pane_id: record.pane_id,
    tab_id: record.tab_id,
    agent_status: record.agent_status,
    interactive_ready: record.interactive_ready,
    cwd: record.cwd
  })}`);
  check(typeof record.pane_id === 'string', 'it has a pane');
  check(record.cwd === workspaceDirFor(type, key), 'the pane is in the agent\'s workspace dir — `--cwd` really was re-homed', record.cwd);
  // The field that separates a registration from a runtime (KAN-58): a name
  // herdr remembers is not an agent, and `agent` non-empty is what says one is
  // actually there.
  check(typeof record.agent === 'string' && record.agent !== '', 'a runtime is behind the pane', `agent=${record.agent}`);
  // One pane per agent. The 0.6 path created two and closed one; if the
  // placeholder logic had been left in, or `agent start` had split, this is
  // where it would show.
  const panes = herdr(['pane', 'list'])?.result?.panes ?? [];
  const inTab = panes.filter((p) => p.tab_id === record.tab_id);
  check(inTab.length === 1, 'exactly ONE pane in the agent\'s tab — no placeholder left behind', `${inTab.length} pane(s)`);
}

// ── Teardown ──────────────────────────────────────────────────────────────
if (!keep && record?.pane_id) {
  herdr(['pane', 'close', record.pane_id]);
}
if (!keep) {
  try { rmSync(workspaceDirFor(type, key), { recursive: true, force: true }); } catch {}
  try { rmSync(shimDir, { recursive: true, force: true }); } catch {}
}
try { bridge.closeSession?.(session_?.sessionId); } catch {}

say('');
say(failures === 0
  ? `PASS: herdr ${version.replace('herdr ', '')} accepted the ported spawn path and started ${agentName}.`
  : `FAIL: ${failures} check(s) failed.`);

process.exit(failures ? 1 : 0);
