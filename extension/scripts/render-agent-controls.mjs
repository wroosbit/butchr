// Renders the real on/off controls against real daemon payloads and prints what
// a human would see — no browser required.
//
// screenshot-agent-controls.mjs is the better proof when a browser will run: it
// drives the shipped bundle by clicking its actual buttons. But headless Chrome
// refuses to produce a frame for that page in some sandboxes (agent containers
// among them — it hangs rather than failing), and "the confirmation proof needs
// a GUI" is not an acceptable place to stop. This is the same escape hatch
// render-staleness-banner.mjs opened for KAN-30, for the same reason: the same
// components, through the same build toolchain, rendered with react-dom/server.
//
// It emits an HTML file that IS screenshottable — static markup with no
// scripts, which every headless browser will render — plus a plain-text
// transcription of the visible text.
//
// The payloads are not invented here. Produce them first with:
//
//   cd daemon && npm run build
//   node scripts/verify-agent-power-controls.mjs --dump /tmp/kan38-payloads
//
// then:
//
//   cd extension && node scripts/render-agent-controls.mjs /tmp/kan38-payloads /tmp/out
//
// Writes controls.html and prints the transcription to stdout.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, '..');
const payloadDir = process.argv[2];
const outDir = process.argv[3] ?? path.join(extensionDir, 'kan38-render');

for (const file of ['list_agents.json', 'work_state.json', 'refusal.json']) {
  if (!payloadDir || !existsSync(path.join(payloadDir, file))) {
    console.error(`${payloadDir ?? '(no directory given)'} has no ${file} — see the header of this script.`);
    process.exit(1);
  }
}
const load = (name) => JSON.parse(readFileSync(path.join(payloadDir, name), 'utf8'));
const listAgents = load('list_agents.json');
const workState = load('work_state.json');
const refusal = load('refusal.json');

// The entry lives inside extension/ so its relative imports and its React
// resolution are the same ones the extension build uses.
const entryPath = path.join(extensionDir, '.kan38-render-entry.jsx');
const bundleDir = path.join(extensionDir, 'node_modules', '.kan38-render');
writeFileSync(
  entryPath,
  `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentOffControl } from './src/components/AgentOffControl.jsx';
import { StandbyAgents } from './src/components/StandbyAgents.jsx';
import { MissingAgentsBanner } from './src/components/MissingAgentsBanner.jsx';
import { ActivationRefusal } from './src/components/ActivationRefusal.jsx';
import { TurnOnButton } from './src/components/TurnOnButton.jsx';

const noop = () => {};
const r = (el) => renderToStaticMarkup(el);

export const offButton = (agent, pending, error) =>
  r(React.createElement(AgentOffControl, {
    agent, pending, confirming: false, error,
    onRequestOff: noop, onCancelOff: noop, onConfirmOff: noop
  }));

export const offConfirm = (agent, workState) =>
  r(React.createElement(AgentOffControl, {
    agent, confirming: true, workState,
    onRequestOff: noop, onCancelOff: noop, onConfirmOff: noop
  }));

export const standby = (standbyAgents, standbyTotal, pending) =>
  r(React.createElement(StandbyAgents, { standbyAgents, standbyTotal, pending, onTurnOn: noop }));

export const missing = (missingAgents, pending) =>
  r(React.createElement(MissingAgentsBanner, { missingAgents, pending, onTurnOn: noop }));

export const refusalBox = (refusal) =>
  r(React.createElement(ActivationRefusal, {
    refusal, onOverride: noop, onPreempt: noop, onDismiss: noop
  }));

export const turnOn = (candidate, pending) =>
  r(React.createElement(TurnOnButton, { candidate, pending, onTurnOn: noop }));
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

const agent = listAgents.agents.find((a) => a.agentName === 'butchr-task-kan-38') ?? listAgents.agents.find((a) => !a.supervisor);
const epicAgent = listAgents.agents.find((a) => a.supervisor && a.type === 'epic');
const storyAgent = listAgents.agents.find((a) => a.supervisor && a.type === 'story');
const standbyCandidate = listAgents.standbyAgents[0];

const CLEAN = { checked: true, hasUnsavedWork: false, repos: [], summary: 'Nothing uncommitted: the workspace: clean.' };

// The refusal as useFleetControls hands it to the component: the same mapping,
// so what is drawn here is what the page draws.
const refusalProps = {
  refusedBy: refusal.refusedBy ?? null,
  reason: refusal.reason ?? refusal.error ?? null,
  derivation: refusal.derivation ?? null,
  capacity: refusal.capacity ?? null,
  type: refusal.type ?? null,
  key: refusal.key ?? null,
  priority: refusal.priority ?? null,
  preemption: refusal.preemption ?? null
};

const sidepanelCss = readFileSync(path.join(extensionDir, 'sidepanel.css'), 'utf8');

const section = (title, note, body) => `
  <div style="margin:34px 0 8px;font-size:13px;font-weight:700;color:#7dd3fc;letter-spacing:.04em;text-transform:uppercase">${title}</div>
  <div style="font-size:12px;color:#94a3b8;margin-bottom:12px;max-width:640px;line-height:1.5">${note}</div>
  ${body}
`;

const row = (a, right) => `
  <div style="background:#111827;border-radius:8px;border:1px solid #334155;padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px">
      <div>
        <div style="font-weight:600;font-size:15px;margin-bottom:4px">🔑 ${a.key}
          <span style="background:#1e293b;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:8px">${a.type}</span>
          ${a.supervisor ? '<span style="background:#1e293b;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:6px;color:#fbbf24">supervisor</span>' : ''}
        </div>
        <div style="font-size:12px;color:#94a3b8">Session: ${a.sessionId ?? '—'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:12px;color:#94a3b8">${a.herdrStatus}</span>
        ${right}
      </div>
    </div>
  </div>
`;

const page = `<!doctype html>
<meta charset="utf-8">
<title>Agents page — switching agents on and off</title>
<style>${sidepanelCss}</style>
<body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;margin:0;padding:24px">
<div style="max-width:800px;margin:0 auto">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:20px;border-bottom:1px solid #334155">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:24px">👥</span>
      <div style="font-size:24px;font-weight:700">Active Agents</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:10px;height:10px;border-radius:50%;background:#10b981"></div><span>Daemon Online</span>
    </div>
  </div>

  ${section(
    '1 · the fleet, at rest',
    'Every running agent gets one control. The supervisor badge marks the rows that hand work out — the epic and story agents — and not the task agent; the type chip beside the key already says which supervisory type each one is.',
    [epicAgent, storyAgent, agent].filter(Boolean).map((a) => row(a, R.offButton(a))).join('\n')
  )}

  ${section(
    '2 · Off, pressed — an ordinary agent',
    'Not a confirm() dialog. The daemon went and looked at the workspace, and the confirmation says what is actually there. “This may destroy uncommitted work” reads the same whether there is work or not, and a warning that never varies is one nobody finishes reading.',
    `<div style="display:flex;justify-content:flex-end">${R.offConfirm(agent, workState)}</div>`
  )}

  ${section(
    '3 · Off, pressed — an epic supervisor',
    'Allowed, not refused: a supervisor you cannot stop is worse than one you can stop by accident. Different colour, different words, and a way back on the same page.',
    `<div style="display:flex;justify-content:flex-end">${R.offConfirm(epicAgent, CLEAN)}</div>`
  )}

  ${section(
    '4 · Off, pressed — a story supervisor',
    'The same guard for the other supervisory type: the title names the agent, so two supervisors on one list can never be confused for each other.',
    `<div style="display:flex;justify-content:flex-end">${R.offConfirm(storyAgent, CLEAN)}</div>`
  )}

  ${section(
    '5 · while the stop is in flight',
    'The row reports the decision rather than offering a disabled button — nothing to double-press, and nothing whose enabled-ness the 2-second poll could argue with. It stays this way until the agent leaves the census, not until the daemon replies.',
    row(agent, R.offButton(agent, 'off'))
  )}

  ${section(
    '6 · the way back — where On gets its candidates',
    'The page lists what is running, so something that is off is not in it. These come from KAN-21’s registry: the agents whose last recorded intent was a stand-down, that are not running, and whose workspace is still on disk.',
    R.standby(listAgents.standbyAgents, listAgents.standbyTotal)
  )}

  ${section(
    '7 · an agent that should be running and is not',
    'The other candidate source, and the banner that already existed. It told the reader to re-activate it; before this there was nowhere to do that from.',
    R.missing(listAgents.missingAgents)
  )}

  ${section(
    '8 · Turn on, refused at capacity',
    'The same component the sidepanel uses, rendered under the row whose button was pressed. KAN-36 exists because one surface threw this away; a second surface throwing it away differently would be that defect twice.',
    `<div style="background:#0b1220;border-radius:8px;border:1px solid #334155;padding:14px 16px">
       <div style="display:flex;justify-content:space-between;align-items:center">
         <div style="font-weight:600;font-size:14px">🔑 ${standbyCandidate.key}
           <span style="background:#1e293b;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:8px">${standbyCandidate.type}</span>
         </div>
         ${R.turnOn(standbyCandidate)}
       </div>
       <div style="margin-top:12px">${R.refusalBox(refusalProps)}</div>
     </div>`
  )}
</div>
</body>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, 'controls.html');
writeFileSync(htmlPath, page);

/** The visible text, in document order — what a human reads off the screen. */
const transcribe = (html) =>
  html
    .replace(/<button[^>]*>/g, '\n[ ')
    .replace(/<\/button>/g, ' ]\n')
    .replace(/<li[^>]*>/g, '\n')
    .replace(/<\/div>/g, '\n')
    .replace(/<summary[^>]*>/g, '\n▸ ')
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

const show = (title, html) => {
  console.log(`\n${'-'.repeat(78)}\n${title}\n${'-'.repeat(78)}`);
  console.log(transcribe(html));
};

show('the fleet list — the supervisor badge on the epic and story rows, not the task row',
  [epicAgent, storyAgent, agent].filter(Boolean).map((a) => row(a, R.offButton(a))).join('\n'));
show('the Off confirmation for an agent with uncommitted work', R.offConfirm(agent, workState));
show('the Off confirmation for an epic supervisor', R.offConfirm(epicAgent, CLEAN));
show('the Off confirmation for a story supervisor', R.offConfirm(storyAgent, CLEAN));
show('the stood-down list — where Turn on gets its candidates', R.standby(listAgents.standbyAgents, listAgents.standbyTotal));
show('a refusal at capacity, on the Agents page', R.refusalBox(refusalProps));

console.log(`\nrendered HTML: ${htmlPath}`);
