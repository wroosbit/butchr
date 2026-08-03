// Renders the settings page's Integrations section against a real
// `list_integrations` payload from a real daemon, and prints what a human
// would see — no browser required. KAN-87's proof.
//
// screenshot-agent-controls.mjs is the better proof when a browser will run,
// but headless Chrome refuses to produce a frame for these pages in some
// sandboxes (agent containers among them — it hangs rather than failing). This
// is the same escape hatch render-agent-controls.mjs opened for KAN-38, for the
// same reason: the same components, through the same build toolchain, rendered
// with react-dom/server. It emits an HTML file that IS screenshottable — static
// markup, no scripts — plus a plain-text transcription of the visible text.
//
// The payload is not invented here. By default the script talks to the running
// daemon over its own socket (~/.local/share/butchr/butchr.sock), sends
// `list_integrations`, and writes the raw response next to the HTML so the
// render is reproducible from the exact bytes that produced it.
//
//   cd extension && node scripts/render-integrations.mjs /tmp/kan87
//   cd extension && node scripts/render-integrations.mjs /tmp/kan87 --payloads /tmp/kan87
//
// Optional: --probe-rejection additionally submits a deliberately invalid
// canary token for LaunchDarkly, to capture a *real* rejection and prove the
// leg trail is rendered verbatim rather than flattened. It is off by default
// because it makes a network call. It cannot disturb a stored credential: the
// daemon stores a token only after LaunchDarkly accepts it, and this one is
// junk by construction. No real credential is involved at any point (KAN-20).

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, '..');

const argv = process.argv.slice(2);
const payloadsIdx = argv.indexOf('--payloads');
const payloadDir = payloadsIdx === -1 ? null : argv[payloadsIdx + 1];
const probeRejection = argv.includes('--probe-rejection');
const positional = argv.filter(
  (a, i) => (payloadsIdx === -1 || (i !== payloadsIdx && i !== payloadsIdx + 1)) && !a.startsWith('--')
);
const outDir = positional[0] ?? path.join(extensionDir, 'kan87-render');

const SOCKET_PATH = path.join(os.homedir(), '.local', 'share', 'butchr', 'butchr.sock');

// A token whose shape nothing else could produce by accident, so its absence
// from the rendered proof is checkable by grep.
const CANARY_TOKEN = 'api-KAN87-CANARY-not-a-real-token-0123456789';

// ------------------------------------------------------------- the payloads --

/** One request/response round trip against the live daemon socket. */
function ask(request, wantAction, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    let buffer = '';
    const done = (fn, arg) => {
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`daemon did not answer ${wantAction} within ${timeoutMs}ms`)),
      timeoutMs
    );
    socket.on('error', (err) => done(reject, err));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.action === wantAction) done(resolve, msg);
      }
    });
  });
}

const load = (name) => JSON.parse(readFileSync(path.join(payloadDir, name), 'utf8'));

let listIntegrations;
let rejection = null;

if (payloadDir) {
  if (!existsSync(path.join(payloadDir, 'list_integrations.json'))) {
    console.error(`${payloadDir} has no list_integrations.json — see the header of this script.`);
    process.exit(1);
  }
  listIntegrations = load('list_integrations.json');
  if (existsSync(path.join(payloadDir, 'ld_rejection.json'))) rejection = load('ld_rejection.json');
} else {
  if (!existsSync(SOCKET_PATH)) {
    console.error(
      `No daemon socket at ${SOCKET_PATH}. Start the daemon, or pass --payloads <dir> with a ` +
        'previously captured list_integrations.json.'
    );
    process.exit(1);
  }
  listIntegrations = await ask({ action: 'list_integrations' }, 'list_integrations_response');
  if (probeRejection) {
    rejection = await ask(
      { action: 'set_integration_credential', integration: 'launchdarkly', token: CANARY_TOKEN },
      'set_integration_credential_response'
    );
  }
}

if (!Array.isArray(listIntegrations.integrations)) {
  console.error('list_integrations_response carried no integrations array:', listIntegrations);
  process.exit(1);
}

// ----------------------------------------------------------- the components --

// The entry lives inside extension/ so its relative imports and its React
// resolution are the same ones the extension build uses.
const entryPath = path.join(extensionDir, '.kan87-render-entry.jsx');
const bundleDir = path.join(extensionDir, 'node_modules', '.kan87-render');
writeFileSync(
  entryPath,
  `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntegrationsSectionView } from './src/components/IntegrationsSection.jsx';
import { LaunchDarklyCredentialCardView } from './src/components/LaunchDarklyCredentialCard.jsx';

const r = (el) => renderToStaticMarkup(el);

export const section = (integrations) =>
  r(React.createElement(IntegrationsSectionView, { integrations }));

/** The section without its cards — the summary rows on their own. */
export const summaries = (integrations) =>
  r(React.createElement(IntegrationsSectionView, { integrations, renderCard: () => null }));

export const ldCard = (props) => r(React.createElement(LaunchDarklyCredentialCardView, props));
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

// ---------------------------------------------------------------- the page --

const rows = listIntegrations.integrations;
const ld = rows.find((i) => i.id === 'launchdarkly');

const sidepanelCss = readFileSync(path.join(extensionDir, 'sidepanel.css'), 'utf8');

const sectionBlock = (title, note, body) => `
  <div style="margin:34px 0 8px;font-size:13px;font-weight:700;color:#7dd3fc;letter-spacing:.04em;text-transform:uppercase">${title}</div>
  <div style="font-size:12px;color:#94a3b8;margin-bottom:12px;max-width:640px;line-height:1.5">${note}</div>
  ${body}
`;

const blocks = [
  sectionBlock(
    '1 · the section, as the settings page draws it',
    'Every word of it comes from one <code>list_integrations</code> response: which integrations exist, whether each is connected, and the workspace types each contributes. Nothing in the page repeats those facts, so a type added or re-prioritized in the daemon shows up here without anyone editing the extension.' +
      ' <strong>The two cards say “Checking…” on purpose</strong>: this is a static server render, so their <code>useEffect</code> never runs and they never ask the daemon for their own status. In Chrome they answer within a frame. The connection state beside each integration’s name is live either way — it comes from the response above, not from the card.',
    R.section(rows)
  ),
  sectionBlock(
    '2 · the summary rows on their own',
    "Jira's three types with the distinction that matters: <code>task</code> is recognised from the page URL, while <code>epic</code> and <code>story</code> cannot be — their URLs are byte-identical to a Task's — so they are resolved by asking Jira what the issue really is. That difference is what the credential buys, and it is read from the response rather than written down here.",
    R.summaries(rows)
  ),
  sectionBlock(
    '3 · LaunchDarkly, before a token has ever been entered',
    'Where the secret will land, said before the field rather than in the success message afterwards — the same disclosure the Jira card makes, for the same reason: which backend you get is decided by probing this machine, and once the token is sent, being told where it went is no longer a choice.',
    R.ldCard({
      status: {
        available: true,
        configured: false,
        ...(ld && ld.storageTarget ? { storageTarget: ld.storageTarget } : {})
      }
    })
  ),
  sectionBlock(
    '4 · LaunchDarkly, configured',
    'A stored token is never rendered back — not masked, not partially, not behind a reveal. "Configured" and where it lives is the whole of what can honestly be said about it; the only affordances are replace and clear.',
    R.ldCard({
      status: {
        available: true,
        ...(ld ? ld.credential : { configured: true }),
        ...(ld && ld.storageTarget ? { storageTarget: ld.storageTarget } : {})
      }
    })
  )
];

if (rejection) {
  blocks.push(
    sectionBlock(
      '5 · a rejected token, rendered verbatim',
      "The daemon's answer is a diagnosis followed by the leg that was tried and what LaunchDarkly said about it. The newlines are the structure, so <code>white-space: pre-line</code> keeps them: flattening this to a first sentence throws away the part the user can act on. The token field is already empty — it is wiped when the daemon answers, accepted or not.",
      R.ldCard({
        status: {
          available: true,
          configured: !!(rejection.status && rejection.status.configured),
          ...(rejection.status || {}),
          ...(ld && ld.storageTarget ? { storageTarget: ld.storageTarget } : {})
        },
        result: { ok: false, text: rejection.error || 'The token was rejected.' }
      })
    )
  );
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>Settings — the Integrations section</title>
<style>${sidepanelCss}</style>
<body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;margin:0;padding:24px">
<div style="max-width:640px;margin:0 auto">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;padding-bottom:20px;border-bottom:1px solid #334155">
    <span style="font-size:24px">⚙️</span>
    <div style="font-size:24px;font-weight:700">Butchr Settings</div>
  </div>
  ${blocks.join('\n')}
</div>
</body>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, 'integrations.html');
writeFileSync(htmlPath, page);
if (!payloadDir) {
  writeFileSync(
    path.join(outDir, 'list_integrations.json'),
    JSON.stringify(listIntegrations, null, 2)
  );
  if (rejection) {
    writeFileSync(path.join(outDir, 'ld_rejection.json'), JSON.stringify(rejection, null, 2));
  }
}

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
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

const show = (title, html) => {
  console.log(`\n${'-'.repeat(78)}\n${title}\n${'-'.repeat(78)}`);
  console.log(transcribe(html));
};

console.log('== KAN-87: the Integrations section, rendered from a live daemon ==');
console.log(`   source: ${payloadDir ? `payloads in ${payloadDir}` : SOCKET_PATH}`);
console.log(`   integrations reported: ${rows.map((i) => i.id).join(', ')}`);

show('the section — both entries, their connection state, and their workspace types', R.summaries(rows));
show('LaunchDarkly, before a token is entered — the storage disclosure', R.ldCard({
  status: {
    available: true,
    configured: false,
    ...(ld && ld.storageTarget ? { storageTarget: ld.storageTarget } : {})
  }
}));
if (rejection) {
  show(
    'a rejected token — the leg trail, verbatim',
    R.ldCard({
      status: { available: true, configured: !!(rejection.status && rejection.status.configured) },
      result: { ok: false, text: rejection.error || 'The token was rejected.' }
    })
  );
}

// -------------------------------------------------------------- the hygiene --
//
// The proof itself must not carry token-derived text. Nothing here has a token
// to leak — `list_integrations` returns a credential summary, never a secret —
// but a page that asserts the invariant should check it rather than claim it.
const leaks = [];
if (probeRejection || rejection) {
  for (const [form, value] of Object.entries({
    raw: CANARY_TOKEN,
    'base64 (token)': Buffer.from(CANARY_TOKEN).toString('base64'),
    'percent-encoded': encodeURIComponent(CANARY_TOKEN),
    'first 12 chars': CANARY_TOKEN.slice(0, 12)
  })) {
    if (page.includes(value) || JSON.stringify(rejection ?? {}).includes(value)) leaks.push(form);
  }
}
for (const key of ['token', 'apiToken', 'accessToken']) {
  for (const row of rows) {
    if (row.credential && row.credential[key] !== undefined) leaks.push(`${row.id}.credential.${key}`);
  }
}

console.log(`\n${'='.repeat(78)}\nSECRET HYGIENE\n${'='.repeat(78)}`);
if (leaks.length) {
  console.log(`\n  ✗ token-derived text in the proof or the payload: ${leaks.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\n  ✓ no token, and no token-derived text, in the payload or the rendered page.');
}

console.log(`\nrendered HTML: ${htmlPath}`);
