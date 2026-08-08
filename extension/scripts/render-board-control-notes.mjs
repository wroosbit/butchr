// Renders the real Off confirmation and the real Turn on button against real
// daemon payloads, in every board mode, and prints what a human would see.
//
// This is the "live demonstration, screenshotted or pasted" KAN-222 asks for.
// It is not a proof script and is deliberately not named `verify-` — it asserts
// nothing and exits 0 whatever it renders. The assertions live in
// daemon/scripts/verify-off-button-honesty.mjs; this shows the result to a
// person, which is a different job and the one a wording change actually needs.
//
// The payloads are not invented here — that is the whole point. Produce them
// from a real MessageRouter first:
//
//   cd daemon && npm run build
//   node scripts/verify-off-button-honesty.mjs --dump /tmp/kan222-payloads
//
// then:
//
//   cd extension && node scripts/render-board-control-notes.mjs /tmp/kan222-payloads /tmp/kan222-out
//
// Writes board-control.html (static markup, no scripts, so any headless browser
// will screenshot it) and prints a plain-text transcription to stdout.
//
// The escape hatch this reuses is render-agent-controls.mjs's, for the reason
// its header gives: headless Chrome refuses to produce a frame for the real
// page in some sandboxes, and "the proof needs a GUI" is not an acceptable
// place to stop. Same components, same build toolchain, react-dom/server.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, '..');
const payloadDir = process.argv[2];
const outDir = process.argv[3] ?? path.join(extensionDir, 'kan222-render');

const MODES = ['converge', 'report', 'off', 'none'];
for (const mode of MODES) {
  if (!payloadDir || !existsSync(path.join(payloadDir, `list_agents.${mode}.json`))) {
    console.error(
      `${payloadDir ?? '(no directory given)'} has no list_agents.${mode}.json — see the header.`
    );
    process.exit(1);
  }
}
const payloads = Object.fromEntries(
  MODES.map((m) => [m, JSON.parse(readFileSync(path.join(payloadDir, `list_agents.${m}.json`), 'utf8'))])
);

const entryPath = path.join(extensionDir, '.kan222-render-entry.jsx');
const bundleDir = path.join(extensionDir, 'node_modules', '.kan222-render');
writeFileSync(
  entryPath,
  `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentOffControl } from './src/components/AgentOffControl.jsx';
import { TurnOnButton } from './src/components/TurnOnButton.jsx';
import { describeBoardControl } from './src/lib/boardControl.js';

const noop = () => {};
const r = (el) => renderToStaticMarkup(el);

// The same call the Agents page makes, so what is drawn here is what it draws.
export const describe = (boardControl, agent) => describeBoardControl(boardControl, agent);

export const offConfirm = (agent, workState, board) =>
  r(React.createElement(AgentOffControl, {
    agent, confirming: true, workState, board,
    onRequestOff: noop, onCancelOff: noop, onConfirmOff: noop
  }));

export const turnOn = (candidate, board) =>
  r(React.createElement(TurnOnButton, { candidate, onTurnOn: noop, board }));
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
      rollupOptions: { output: { entryFileNames: 'render.js' } }
    }
  });
} finally {
  rmSync(entryPath, { force: true });
}

const R = await import(pathToFileURL(path.join(bundleDir, 'render.js')).href);

const find = (payload, name) =>
  payload.agents.find((a) => a.agentName === name) ??
  payload.standbyAgents.find((a) => a.agentName === name);

// A real dirty workspace, as the daemon's own git probe reports one. The board
// note must never displace this: unsaved work is lost either way, because an
// agent the board restarts does not come back holding what it had not
// committed.
const DIRTY = {
  checked: true,
  hasUnsavedWork: true,
  summary: '2 changed, 1 unpushed — stopping now ends that work.',
  repos: [
    { path: '.', branch: 'butchr/KAN-222', modifiedFiles: 2, untrackedFiles: 1, unpushedCommits: 1, noUpstream: false }
  ]
};

const sidepanelCss = readFileSync(path.join(extensionDir, 'sidepanel.css'), 'utf8');

const section = (title, note, body) => `
  <div style="margin:34px 0 8px;font-size:13px;font-weight:700;color:#7dd3fc;letter-spacing:.04em;text-transform:uppercase">${title}</div>
  <div style="font-size:12px;color:#94a3b8;margin-bottom:12px;max-width:660px;line-height:1.5">${note}</div>
  ${body}
`;

const TASK = 'butchr-task-kan-222';
const CONF = 'butchr-confluence-notes';
const STANDBY = 'butchr-task-kan-217';

const blocks = [];
const transcripts = [];

const add = (title, note, html) => {
  blocks.push(section(title, note, `<div style="display:flex;justify-content:flex-end">${html}</div>`));
  transcripts.push([title, html]);
};

for (const [mode, label] of [
  ['converge', 'BUTCHR_BOARD_RECONCILE=converge — the board really is in charge'],
  ['report', 'BUTCHR_BOARD_RECONCILE=report — the shipped default'],
  ['off', 'BUTCHR_BOARD_RECONCILE=off']
]) {
  const payload = payloads[mode];
  const agent = find(payload, TASK);
  add(
    `Off · ${mode}`,
    `${label}. The work summary comes first and is unchanged: the board bringing this agent
     back does not bring back what it had not committed.`,
    R.offConfirm(agent, DIRTY, R.describe(payload.boardControl, agent))
  );
}

{
  const payload = payloads.converge;
  const agent = find(payload, CONF);
  add(
    'Off · converge, but outside the board’s reach',
    `The same converging machine, on an agent a Jira issue search can never return. A blanket
     “the board controls this now” would be false here — which is the defect this ticket exists
     to remove, committed by its own fix.`,
    R.offConfirm(agent, DIRTY, R.describe(payload.boardControl, agent))
  );
}

{
  const payload = payloads.none;
  const agent = find(payload, TASK);
  add(
    'Off · a daemon with no board reconciler',
    `The field is absent, so the page says nothing about a board at all — byte-for-byte the
     pre-KAN-222 confirmation. “This daemon has no reconciler” is not a claim about the board.`,
    R.offConfirm(agent, DIRTY, R.describe(payload.boardControl, agent))
  );
}

{
  const payload = payloads.converge;
  const candidate = find(payload, STANDBY);
  add(
    'On · converge — the mirror-image problem, answered',
    `KAN-222 asked whether On has the same defect. It does, exactly: under converge, starting an
     agent whose ticket is not In Progress buys about a minute of work before the loop stands it
     down again.`,
    R.turnOn(candidate, R.describe(payload.boardControl, candidate))
  );
}

{
  const payload = payloads.report;
  const candidate = find(payload, STANDBY);
  add(
    'On · report — silent, because On is already the whole truth',
    `No note, because there is nothing the board will do about it. A page where every control
     carries a warning has no warnings.`,
    R.turnOn(candidate, R.describe(payload.boardControl, candidate))
  );
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>KAN-222 — what the Off and On controls say about the board</title>
<style>${sidepanelCss}</style>
<body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;margin:0;padding:24px">
<div style="max-width:820px;margin:0 auto">
  <div style="font-size:24px;font-weight:700;padding-bottom:20px;border-bottom:1px solid #334155">
    👥 What Off and On say once the board drives the fleet
  </div>
  ${blocks.join('\n')}
</div>
</body>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, 'board-control.html');
writeFileSync(htmlPath, page);

/** The visible text, in document order — what a human reads off the screen. */
const transcribe = (html) =>
  html
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

for (const [title, html] of transcripts) {
  console.log(`\n${'-'.repeat(78)}\n${title}\n${'-'.repeat(78)}`);
  console.log(transcribe(html));
}

console.log(`\nrendered HTML: ${htmlPath}`);
