// Renders the real StalenessBanner component against a real daemon payload and
// prints what a human would see — no browser required.
//
// screenshot-staleness-banner.mjs is the better proof when a browser will run,
// but headless Chrome and headless Firefox both refuse to render at all in some
// sandboxes (agent containers among them), and "the surfacing proof needs a GUI"
// is not an acceptable place to stop. This takes the same component through the
// same build toolchain, renders it with react-dom/server, and emits both an
// HTML file you can open and a plain-text transcription of the visible text.
//
// The payload is not invented here. Produce it first with:
//
//   cd daemon && npm run build
//   node scripts/verify-staleness-over-socket.mjs --dump /tmp/kan30-payload.json
//
// then:
//
//   cd extension && node scripts/render-staleness-banner.mjs /tmp/kan30-payload.json /tmp/out
//
// Writes banner.html (both states, on the Agents page's background) and prints
// the transcription to stdout.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, '..');
const payloadPath = process.argv[2];
const outDir = process.argv[3] ?? path.join(extensionDir, 'staleness-render');

if (!payloadPath || !existsSync(payloadPath)) {
  console.error('Pass the path to a list_agents_response JSON file (see the header of this script).');
  process.exit(1);
}
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
if (!payload.staleness) {
  console.error(`${payloadPath} has no \`staleness\` key — nothing to render.`);
  process.exit(1);
}

// The entry lives inside extension/ so its relative import and its React
// resolution are the same ones the extension build uses.
const entryPath = path.join(extensionDir, '.staleness-render-entry.jsx');
// Inside extension/, because an SSR bundle leaves `react` external and node
// resolves it from where the bundle sits.
const bundleDir = path.join(extensionDir, 'node_modules', '.staleness-render');
writeFileSync(
  entryPath,
  `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StalenessBanner } from './src/components/StalenessBanner.jsx';

export const render = (staleness, defaultExpanded) =>
  renderToStaticMarkup(React.createElement(StalenessBanner, { staleness, defaultExpanded }));
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

const { render } = await import(pathToFileURL(path.join(bundleDir, 'render.js')).href);
const collapsed = render(payload.staleness, false);
const expanded = render(payload.staleness, true);

// The Agents page's own container: same background, width and font, so what is
// shown is the banner as it sits on the page rather than on a white sheet.
const page = `<!doctype html>
<meta charset="utf-8">
<title>Agents page — staleness banner</title>
<body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;margin:0;padding:24px">
<div style="max-width:800px;margin:0 auto">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:30px;padding-bottom:20px;border-bottom:1px solid #334155">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:24px">👥</span>
      <div style="font-size:24px;font-weight:700">Active Agents</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:10px;height:10px;border-radius:50%;background:#10b981"></div><span>Daemon Online</span>
    </div>
  </div>
  ${collapsed}
  <div style="color:#64748b;font-size:11px;margin:28px 0 8px">— the same banner with details shown —</div>
  ${expanded}
</div>
</body>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, 'banner.html');
writeFileSync(htmlPath, page);

/** The visible text, in document order — what a human reads off the screen. */
const transcribe = (html) =>
  html
    .replace(/<button[^>]*>/g, '\n[ ')
    .replace(/<\/button>/g, ' ]\n')
    .replace(/<li[^>]*>/g, '\n')
    .replace(/<\/div>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

console.log('what the human sees on the Agents page (collapsed, as it first appears):');
console.log('-'.repeat(78));
console.log(transcribe(collapsed));
console.log('\nafter clicking "Show details":');
console.log('-'.repeat(78));
console.log(transcribe(expanded));
console.log(`\nrendered HTML: ${htmlPath}`);
