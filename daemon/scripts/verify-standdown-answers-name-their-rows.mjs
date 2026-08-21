#!/usr/bin/env node
/**
 * verify-standdown-answers-name-their-rows
 *
 * WHAT FAILURE THIS WOULD CATCH: a stand-down reply whose two halves describe
 * the same census in contradictory terms without either naming the rows it
 * counted — `stillRunning.detail` saying "the runtime census still reports it
 * running" beside an `error` saying "the runtime census reports no agent at
 * task/KAN-497". Both sentences were true of DIFFERENT row sets and neither
 * said so, they imply opposite remedies, and a reader acts on whichever they
 * read first. `epic/KAN-203` met exactly that on `task/KAN-497` (KAN-552).
 *
 *
 * ⚠ WHAT THIS DOES **NOT** ASSERT, AND WHO COVERS IT. This proof writes the
 * census it then reads, so it does not establish that a real CrabCast ever
 * produces a foreign pane at a Butchr workspace path — only that IF one is
 * present, the refusal names it. The producing side is `epic/KAN-203`'s
 * measurement on KAN-552 (task/KAN-497, 2026-08-21) and the live section of
 * `verify-crabcast-census-disclosure.mjs`; neither is replaced by this.
 *
 * ⚠ AND IT DOES NOT ASSERT THE TWO PREDICATES AGREE — they must not. The
 * verdict counts `[...rows, ...foreign]` unfiltered because it asks *is
 * anything running here*; the refusal counts `rows` with `state === 'running'`
 * because it asks *may I stand this down*, and standing down a foreign pane
 * reaches a terminal somebody else owns. Making them agree is the fix this
 * proof exists to prevent someone shipping.
 */

// CI-RUNNABLE: yes — builds its fixture under `os.tmpdir()`, serves a fake
// CrabCast over a unix socket it creates itself, and points `HOME` at that temp
// tree so `workspacesRoot()` resolves inside it. It imports from `daemon/dist`,
// so it needs the build and nothing else: no herdr, no PTY, no network, no
// Jira, no wall clock, no live peer.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan552-standdown-'));
process.env.HOME = TMP;

// ⚠ DERIVED FROM THIS FILE, NEVER FROM `process.cwd()`. The first version of
// this script used `process.cwd()` and went red in CI at 0.0s with "daemon/dist
// is missing" while every other dist-importing proof in the same run passed —
// the runner does not invoke scripts from the repo root, so the guard was
// reporting the runner's working directory rather than the state of the build.
// A setup guard that fires on the wrong condition is worse than none: it fails
// the script for a reason that has nothing to do with what it tests.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.env.BUTCHR_DIST
  ? path.resolve(process.env.BUTCHR_DIST)
  : path.join(repoRoot, 'daemon', 'dist');
if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}

const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));

let failures = 0;
const check = (ok, what, detail) => {
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
};

// ── The fixture: one FOREIGN pane at a Butchr workspace path, and no running
// row this runtime owns there. That is the KAN-497 shape: the wide read finds
// something, the narrow read finds nothing, and both are correct.
const WORKSPACES = path.join(TMP, '.local', 'share', 'butchr', 'workspaces');
const TARGET = path.join(WORKSPACES, 'task', 'kan-497');
fs.mkdirSync(TARGET, { recursive: true });

const socketPath = path.join(TMP, 'crabcast.sock');
const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (body) => socket.write(`${JSON.stringify({ ...body, id: req.id })}\n`);
      if (req.action === 'daemon_status') {
        reply({ action: 'daemon_status_response', success: true, contractVersion: 13 });
      } else if (req.action === 'list_agents') {
        reply({
          action: 'list_agents_response',
          success: true,
          // Nothing this runtime owns is running at the target.
          agents: [],
          // But a pane IS there, and it is not ours to stop.
          foreignPanes: [
            {
              path: TARGET,
              workDir: TARGET,
              paneName: 'someone-elses-shell',
              state: 'running',
              herdrStatus: 'done',
              agentRuntime: 'claude'
            }
          ]
        });
      } else {
        reply({ action: `${req.action}_response`, success: true });
      }
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => server.listen(socketPath, resolve));

const link = new CrabCastLink({ socketPath, log: () => {}, reconnectDelayMs: 50 });
const runtime = new CrabCastRuntime({ link, log: () => {}, censusIntervalMs: 10_000 });

const deadline = Date.now() + 10_000;
while (Date.now() < deadline && !runtime.listHerdrAgentsChecked().reachable) {
  await new Promise((r) => setTimeout(r, 50));
}

console.log('\n1. THE REFUSAL NAMES THE ROWS IT COUNTED');
const outcome = runtime.closeAgentByKey('KAN-497', 'task');
const error = String(outcome.error ?? '');

check(outcome.success === false, 'the stand-down is refused, not reported as done', error.slice(0, 160));

check(
  /foreign/i.test(error),
  'the refusal says the pane it stepped over is FOREIGN — the word an operator can act on',
  error.slice(0, 300)
);

// ⚠ THIS ASSERTION WAS `/\b1\b/` AND IT PASSED UNDER THE RED DRIVE — the
// pre-fix refusal carries "1 connection attempt(s)" in its diagnostics, so a
// bare digit matched a number about the SOCKET while claiming to have found a
// count of panes. Caught only because the mutation was actually run. The count
// has to be pinned to the noun it counts.
check(
  /\b1 pane\(s\)[^.]*FOREIGN/i.test(error),
  'and it COUNTS them AS PANES, so "none there" and "one there I may not touch" differ',
  error.slice(0, 300)
);

check(
  !/the runtime census reports no agent/i.test(error),
  'it no longer claims the whole census is empty — that was a claim about part of it',
  error.slice(0, 300)
);

check(
  /different questions|narrower/i.test(error),
  'and it tells the reader why a refusal can sit beside a report that the agent IS running',
  error.slice(0, 300)
);

console.log('\n2. THE WIDE READ STILL SEES IT — the two predicates must NOT agree');
const wide = runtime.listHerdrAgentsChecked();
check(
  wide.reachable === true,
  'the census answered, so this reading is evidence'
);
check(
  wide.agents.some((a) => String(a.workDir ?? '') === TARGET),
  'the foreign pane IS present to the read that asks "is anything running here"',
  `agents: ${JSON.stringify(wide.agents.map((a) => a.workDir))}`
);

runtime.dispose?.();
server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('All assertions passed');
process.exit(0);
