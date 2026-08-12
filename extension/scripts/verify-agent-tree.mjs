// Live proof for KAN-81 that the Agents page arranges the fleet by who
// activated whom, and that arranging it costs nothing the four honest
// categories were carrying.
//
// WHAT FAILURE THIS WOULD CATCH: the Agents page losing the activated-by
// arrangement, or paying for it by dropping rows: an agent that appears in no
// category, a category that gains or loses members against the four honest
// counts, or an older daemon that omits `activatedBy` breaking the page
// instead of flattening it.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// WHY THE PAYLOAD IS SYNTHETIC
//
// Because this half was cleared to build against the agreed wire contract and
// rebase, ahead of the daemon sending it — sibling task KAN-80 has since put
// `activatedBy` on all four lists, and proves that end against the real router
// in `daemon/scripts/verify-parentage-in-list-agents.mjs`. The synthetic
// payload stays the intended proof rather than a stand-in for one, because
// what is under test here is the rendering of fleets a live daemon cannot be
// asked to produce on demand — including one that omits the field. The
// contract is `activatedBy: { type: string, key: string } | null` on every row of `agents`,
// `standbyAgents`, `preemptedAgents` and `missingAgents`, and an older daemon
// omitting the field entirely. Both are exercised below, the second by deleting
// the field from the first.
//
// Nothing here re-implements the page. `buildAgentTree` and the components are
// the ones agents.jsx imports, put through the extension's own build toolchain
// with react-dom/server — the same escape hatch render-agent-controls.mjs opened
// when headless Chrome would not produce a frame in an agent container.
//
// Usage:
//   cd extension && node scripts/verify-agent-tree.mjs [outDir]
//
// Exit code 0 means every assertion below held. It writes tree.html — static
// markup, no scripts, screenshottable by anything — and prints the tree, the
// control census, and the visible text. The default outDir is a temp directory
// outside the repository and the run prints the full path; see the comment on
// `outDir` below for why that default is load-bearing.

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, '..');

// KAN-326: the default output is OUTSIDE the repository, and that is the point
// rather than a tidiness preference.
//
// It used to default to `extension/kan81-render/`, and the consequence was not
// a stray file — it was two working instruments losing their credibility:
//
//   * Every run rewrites tree.html, because the render prints elapsed time
//     ("activated 8d 9h ago") from a fixed synthetic fixture against the live
//     clock. The fleet in it is invented, so the file witnesses nothing; it is
//     simply guaranteed to differ from any earlier run, at roughly one diff per
//     hour elapsed, forever. It rode along in six commits across four unrelated
//     tickets on that mechanism alone.
//   * `staleness_check` compares MTIMES, not content (`daemon/src/staleness.ts`,
//     `checkBuild`), and scans all of `extension/` for the newest file. So a
//     write here makes `extension-build` read stale even when the bytes are
//     identical — which is why freezing the fixture's clock would have fixed the
//     diffs and left the false stale exactly where it was. Only moving the write
//     out of the tree fixes both.
//
// `run-ci-verify-set.mjs` sandboxes HOME for every child, and that sandbox
// cannot reach this: the old path was resolved from `import.meta.url`, so it
// pointed into the working tree no matter what the environment said. Anyone
// running the CI set before pushing — the ordinary act, not an unusual one —
// picked the file up.
//
// Pass an explicit outDir to put the render wherever you want it, including
// back inside the repository if you have a reason to.
// `verify-render-writes-outside-the-tree.mjs` is what holds this default to
// account.
const outDir = process.argv[2] ?? path.join(os.tmpdir(), 'butchr-kan81-render');

// ---------------------------------------------------------------------------
// The synthetic fleet
// ---------------------------------------------------------------------------
//
// Shaped to be the fleet that actually broke things, not a tidy one:
//
//   * a three-level chain, epic → story → task, which is the thing asked for;
//   * `epic/KAN-39` and `task/KAN-39` both present — the collision the ticket
//     names. Indexed by key alone, the epic's children would nest under the
//     task agent, because the task is indexed later and wins;
//   * a stood-down task and a preempted task under a live story, and a live
//     task under a *missing* story — the categories, in nested positions;
//   * an agent nobody activated, and an agent whose activator is on no list;
//   * a stood-down story with no running relative, which belongs in the Stood
//     down list and nowhere else.

const running = (type, key, activatedBy, extra = {}) => ({
  sessionless: false,
  agentName: `butchr-${type}-${key.toLowerCase()}`,
  sessionId: `sess-${type}-${key.toLowerCase()}`,
  type,
  key,
  url: `https://wroosbit.atlassian.net/browse/${key}`,
  createdAt: '2026-08-03T18:00:00.000Z',
  status: 'running',
  workDir: `/home/u/.local/share/butchr/workspaces/${type}/${key.toLowerCase()}`,
  herdrStatus: 'working',
  agentRuntime: 'claude',
  supervisor: type === 'epic' || type === 'story',
  activatedBy,
  ...extra
});

const standby = (type, key, activatedBy) => ({
  agentName: `butchr-${type}-${key.toLowerCase()}`,
  type,
  key,
  workDir: `/home/u/.local/share/butchr/workspaces/${type}/${key.toLowerCase()}`,
  url: `https://wroosbit.atlassian.net/browse/${key}`,
  defaultAgent: 'claude',
  since: '2026-08-03T17:30:00.000Z',
  reason: 'deactivated',
  activatedBy
});

const missing = (type, key, activatedBy) => ({
  agentName: `butchr-${type}-${key.toLowerCase()}`,
  type,
  key,
  workDir: `/home/u/.local/share/butchr/workspaces/${type}/${key.toLowerCase()}`,
  url: `https://wroosbit.atlassian.net/browse/${key}`,
  since: '2026-08-03T16:00:00.000Z',
  reason: 'recorded active, not running',
  activatedBy
});

const preempted = (type, key, activatedBy) => ({
  agentName: `butchr-${type}-${key.toLowerCase()}`,
  type,
  key,
  priority: 1,
  herdrStatusWhenPreempted: 'working',
  at: '2026-08-03T17:50:00.000Z',
  by: { type: 'story', key: 'KAN-78', priority: 2 },
  activatedBy
});

const FLEET = {
  agents: [
    running('epic', 'KAN-39', null),
    running('story', 'KAN-78', { type: 'epic', key: 'KAN-39' }),
    running('task', 'KAN-81', { type: 'story', key: 'KAN-78' }),
    running('task', 'KAN-77', { type: 'story', key: 'KAN-75' }),
    // Same key as the epic above, and indexed *after* it on purpose: with an
    // index keyed by issue key alone this row would swallow the epic's subtree.
    running('task', 'KAN-39', null),
    running('task', 'KAN-90', null),
    running('task', 'KAN-91', { type: 'epic', key: 'KAN-99' }),
    // No `activatedBy` at all, on a daemon that sends it for everything else:
    // the field is per-row on the wire, so one row missing it must not decide
    // anything for the rest.
    running('task', 'KAN-92', undefined)
  ],
  standbyAgents: [
    standby('task', 'KAN-80', { type: 'story', key: 'KAN-78' }),
    standby('story', 'KAN-60', null)
  ],
  standbyTotal: 2,
  preemptedAgents: [preempted('task', 'KAN-84', { type: 'story', key: 'KAN-78' })],
  missingAgents: [missing('story', 'KAN-75', { type: 'epic', key: 'KAN-39' })]
};

/** The same fleet as an older daemon sends it: no `activatedBy` anywhere. */
const strip = (row) => {
  const copy = { ...row };
  delete copy.activatedBy;
  return copy;
};
const OLD_DAEMON = {
  agents: FLEET.agents.map(strip),
  standbyAgents: FLEET.standbyAgents.map(strip),
  standbyTotal: FLEET.standbyTotal,
  preemptedAgents: FLEET.preemptedAgents.map(strip),
  missingAgents: FLEET.missingAgents.map(strip)
};

// ---------------------------------------------------------------------------
// The page's own modules, through the extension's own build
// ---------------------------------------------------------------------------

const entryPath = path.join(extensionDir, '.kan81-verify-entry.jsx');
const bundleDir = path.join(extensionDir, 'node_modules', '.kan81-verify');

writeFileSync(
  entryPath,
  `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTree } from './src/components/AgentTree.jsx';
import { MissingAgentsBanner } from './src/components/MissingAgentsBanner.jsx';
import { PreemptedAgentsBanner } from './src/components/PreemptedAgentsBanner.jsx';
import { StandbyAgents } from './src/components/StandbyAgents.jsx';
import { AgentOffControl } from './src/components/AgentOffControl.jsx';
import { HerdrStateChip } from './src/components/HerdrStateChip.jsx';

export { buildAgentTree, flattenTree } from './src/lib/agentTree.js';

const noop = () => {};

// The running row as agents.jsx draws it, reduced to what this proof is about:
// the identifying line and the one Off control. Everything the page passes
// through unchanged — the priority chip, the url, the session line — is not
// what nesting could break.
const RunningRow = ({ agent }) => (
  React.createElement('div', { className: 'card', style: { backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #334155', padding: '16px' } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' } },
      React.createElement('div', null,
        React.createElement('div', { style: { fontWeight: 600, fontSize: '15px' } },
          '🔑 ' + agent.key,
          React.createElement('span', { style: { backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', marginLeft: '8px' } }, agent.type),
          agent.supervisor ? React.createElement('span', { style: { backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', marginLeft: '6px', color: '#fbbf24' } }, 'supervisor') : null
        ),
        React.createElement('div', { style: { fontSize: '12px', color: '#94a3b8' } }, 'Session: ' + agent.sessionId)
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        React.createElement(HerdrStateChip, { state: agent.herdrStatus }),
        React.createElement(AgentOffControl, {
          agent, confirming: false,
          onRequestOff: noop, onCancelOff: noop, onConfirmOff: noop
        })
      )
    )
  )
);

export const tree = (roots) =>
  renderToStaticMarkup(React.createElement(AgentTree, {
    roots,
    renderRunning: (agent) => React.createElement(RunningRow, { agent })
  }));

export const missingBanner = (missingAgents) =>
  renderToStaticMarkup(React.createElement(MissingAgentsBanner, { missingAgents, onTurnOn: noop }));

export const preemptedBanner = (preemptedAgents) =>
  renderToStaticMarkup(React.createElement(PreemptedAgentsBanner, { preemptedAgents, onTurnOn: noop }));

export const standbySection = (standbyAgents, standbyTotal) =>
  renderToStaticMarkup(React.createElement(StandbyAgents, { standbyAgents, standbyTotal, onTurnOn: noop }));
`
);

try {
  await build({
    root: extensionDir,
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    build: {
      ssr: entryPath,
      outDir: bundleDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: 'verify.js' } }
    }
  });
} finally {
  rmSync(entryPath, { force: true });
}

const R = await import(pathToFileURL(path.join(bundleDir, 'verify.js')).href);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures = [];
let checks = 0;
function check(what, condition, detail) {
  checks += 1;
  const ok = !!condition;
  if (!ok) failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${!ok && detail ? ` — ${detail}` : ''}`);
}

const live = R.buildAgentTree(FLEET);
const flat = R.buildAgentTree(OLD_DAEMON);

const nameOf = (node) => `${node.agent.type}/${node.agent.key}`;
const find = (roots, address) =>
  R.flattenTree(roots).find((node) => nameOf(node) === address) ?? null;
const childrenOf = (roots, address) => (find(roots, address)?.children ?? []).map(nameOf);

const drawTree = (roots) => {
  const lines = [];
  const walk = (nodes, prefix) => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      const label =
        node.category === 'running'
          ? `${nameOf(node)}${node.agent.supervisor ? ' (supervisor)' : ''}`
          : `${nameOf(node)}  ← ${node.category}, reference only`;
      lines.push(`${prefix}${last ? '└─ ' : '├─ '}${label}`);
      walk(node.children, `${prefix}${last ? '   ' : '│  '}`);
    });
  };
  walk(roots, '');
  return lines.join('\n');
};

console.log('\nThe fleet, as the page now arranges it');
console.log('─'.repeat(78));
console.log(drawTree(live.roots));

console.log('\nassertions');
console.log('─'.repeat(78));

check(
  'the daemon is understood to have answered the parentage question',
  live.carriesParentage === true && live.nested === true
);

// 1 — the chain the story asked for.
check(
  'epic/KAN-39 is top-level',
  live.roots.some((node) => nameOf(node) === 'epic/KAN-39')
);
check(
  'story/KAN-78 nests under epic/KAN-39',
  childrenOf(live.roots, 'epic/KAN-39').includes('story/KAN-78'),
  `epic children: ${childrenOf(live.roots, 'epic/KAN-39').join(', ') || '(none)'}`
);
check(
  'task/KAN-81 nests under story/KAN-78',
  childrenOf(live.roots, 'story/KAN-78').includes('task/KAN-81'),
  `story children: ${childrenOf(live.roots, 'story/KAN-78').join(', ') || '(none)'}`
);
check(
  'the chain is three deep and no deeper',
  find(live.roots, 'epic/KAN-39').depth === 0 &&
    find(live.roots, 'story/KAN-78').depth === 1 &&
    find(live.roots, 'task/KAN-81').depth === 2
);

// 2 — indexed by (type, key), not by key.
check(
  'task/KAN-39 stays top-level beside the epic of the same key',
  live.roots.some((node) => nameOf(node) === 'task/KAN-39')
);
check(
  'task/KAN-39 has swallowed nothing — key-alone indexing would have given it the epic’s children',
  childrenOf(live.roots, 'task/KAN-39').length === 0,
  `task/KAN-39 children: ${childrenOf(live.roots, 'task/KAN-39').join(', ')}`
);

// 3 — parentless and orphaned rows are at top level, not hidden.
check(
  'an agent nobody activated (activatedBy: null) is top-level',
  live.roots.some((node) => nameOf(node) === 'task/KAN-90')
);
check(
  'an agent whose row omits activatedBy entirely is top-level',
  live.roots.some((node) => nameOf(node) === 'task/KAN-92')
);
check(
  'an agent whose activator is on no list is top-level, not hidden and not mis-nested',
  live.roots.some((node) => nameOf(node) === 'task/KAN-91')
);

// 4 — the categories, in nested positions.
check(
  'a stood-down task shows under its live story, as a standby row',
  find(live.roots, 'task/KAN-80')?.category === 'standby' &&
    childrenOf(live.roots, 'story/KAN-78').includes('task/KAN-80')
);
check(
  'a preempted task shows under its live story, as a preempted row',
  find(live.roots, 'task/KAN-84')?.category === 'preempted' &&
    childrenOf(live.roots, 'story/KAN-78').includes('task/KAN-84')
);
check(
  'a missing story still hosts its running task, as a missing row',
  find(live.roots, 'story/KAN-75')?.category === 'missing' &&
    childrenOf(live.roots, 'story/KAN-75').includes('task/KAN-77')
);
check(
  'a stood-down agent with no running relative stays out of the tree',
  find(live.roots, 'story/KAN-60') === null
);

// 5 — a daemon bug does not become a chart that draws one agent twice.
const duplicated = R.buildAgentTree({
  ...FLEET,
  // The four lists are disjoint by design. This is what it looks like when they
  // are not: the same agent running *and* stood down.
  standbyAgents: [...FLEET.standbyAgents, standby('task', 'KAN-81', { type: 'story', key: 'KAN-78' })]
});
check(
  'an agent the daemon reported on two lists is drawn once, as the running row',
  R.flattenTree(duplicated.roots).filter((node) => nameOf(node) === 'task/KAN-81').length === 1 &&
    find(duplicated.roots, 'task/KAN-81').category === 'running'
);

// 6 — the older-daemon path is today's flat list.
const flatOrder = flat.roots.map(nameOf);
const sentOrder = OLD_DAEMON.agents.map((a) => `${a.type}/${a.key}`);
check(
  'with no activatedBy on the wire, the page knows the daemon did not answer',
  flat.carriesParentage === false && flat.nested === false
);
check(
  'with no activatedBy on the wire, the roots are the running agents in the order sent',
  JSON.stringify(flatOrder) === JSON.stringify(sentOrder),
  `got ${flatOrder.join(', ')}`
);
check(
  'with no activatedBy on the wire, nothing is nested and no reference row appears',
  R.flattenTree(flat.roots).every((node) => node.depth === 0 && node.category === 'running')
);

// 7 — one switch per agent, counted on the markup the page renders.
const page =
  R.missingBanner(FLEET.missingAgents) +
  R.preemptedBanner(FLEET.preemptedAgents) +
  R.tree(live.roots) +
  R.standbySection(FLEET.standbyAgents, FLEET.standbyTotal);

const count = (needle) => page.split(needle).length - 1;
const everyAgent = [
  ...FLEET.agents.map((a) => ({ ...a, category: 'running' })),
  ...FLEET.missingAgents.map((a) => ({ ...a, category: 'missing' })),
  ...FLEET.preemptedAgents.map((a) => ({ ...a, category: 'preempted' })),
  ...FLEET.standbyAgents.map((a) => ({ ...a, category: 'standby' }))
];

console.log('\ncontrol census — every agent on the page, and how many switches it has');
const census = everyAgent.map((agent) => {
  const address = `${agent.type}/${agent.key}`;
  const offs = count(`title="Stop ${address}"`);
  const ons = count(`title="Start ${address}"`);
  return { address, category: agent.category, offs, ons, total: offs + ons };
});
for (const row of census) {
  console.log(
    `    ${row.address.padEnd(14)} ${row.category.padEnd(10)} ` +
      `Off×${row.offs}  On×${row.ons}  → ${row.total} switch${row.total === 1 ? '' : 'es'}`
  );
}
check(
  'every agent on the page has exactly one switch',
  census.every((row) => row.total === 1),
  census.filter((row) => row.total !== 1).map((r) => `${r.address}: ${r.total}`).join(', ')
);
check(
  'a running agent’s one switch is its Off',
  census.filter((row) => row.category === 'running').every((row) => row.offs === 1 && row.ons === 0)
);
check(
  'a not-running agent’s one switch is the On in its own banner or section',
  census.filter((row) => row.category !== 'running').every((row) => row.ons === 1 && row.offs === 0)
);
check(
  'the nested references carry no switch of their own',
  R.tree(live.roots).split('title="Start ').length - 1 === 0
);
check(
  'and they still name what kind of not-running they are, and where the switch is',
  ['stood down', 'missing', 'stood down to make room'].every((phrase) =>
    R.tree(live.roots).includes(phrase)
  )
);

// ---------------------------------------------------------------------------
// What a human would see
// ---------------------------------------------------------------------------

const html = `<!doctype html>
<meta charset="utf-8">
<title>Agents page — the fleet as its org chart</title>
<body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;margin:0;padding:24px">
<div style="max-width:800px;margin:0 auto">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #334155">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:24px">👥</span><div style="font-size:24px;font-weight:700">Active Agents</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:10px;height:10px;border-radius:50%;background:#10b981"></div><span>Daemon Online</span>
    </div>
  </div>
  ${R.missingBanner(FLEET.missingAgents)}
  ${R.preemptedBanner(FLEET.preemptedAgents)}
  ${R.tree(live.roots)}
  ${R.standbySection(FLEET.standbyAgents, FLEET.standbyTotal)}
</div>
</body>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, 'tree.html');
writeFileSync(htmlPath, html);

/** The visible text, in document order — what a human reads off the screen. */
const transcribe = (markup) =>
  markup
    .replace(/<button[^>]*>/g, '\n[ ')
    .replace(/<\/button>/g, ' ]\n')
    .replace(/<li[^>]*>/g, '\n')
    .replace(/<\/div>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

console.log(`\nthe nested list, as text\n${'─'.repeat(78)}`);
console.log(transcribe(R.tree(live.roots)));

console.log(`\nrendered HTML: ${htmlPath}`);
console.log(
  `\n${failures.length ? `${failures.length} of ${checks} checks FAILED` : `all ${checks} checks passed`}`
);
process.exit(failures.length ? 1 : 0);
