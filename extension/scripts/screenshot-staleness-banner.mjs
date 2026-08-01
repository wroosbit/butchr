// Renders the *built* Agents page against a real daemon payload and screenshots
// it, so "what the human actually sees when something is stale" is an image of
// the shipped bundle rather than a description of intent.
//
// It loads extension/dist over http (the built page uses absolute asset paths,
// so file:// will not do) with one script injected ahead of the bundle: a stub
// of the two `chrome.runtime` calls agents.jsx makes. Everything below that —
// React, the component, the styling — is the real thing.
//
// The payload is not invented here. Produce it first with:
//
//   cd daemon && npm run build
//   node scripts/verify-staleness-over-socket.mjs --dump /tmp/kan30-payload.json
//
// which starts a real daemon against a real stale checkout and dumps the exact
// `list_agents_response` it answered with. Then:
//
//   cd extension && npm run build
//   node scripts/screenshot-staleness-banner.mjs /tmp/kan30-payload.json /tmp/shots
//
// Writes collapsed.png and expanded.png (the banner's two states).

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', 'dist');
const payloadPath = process.argv[2];
const outDir = process.argv[3] ?? path.resolve(scriptDir, '..', '..', 'kan30-screenshots');

if (!existsSync(path.join(distDir, 'agents.html'))) {
  console.error('extension/dist/agents.html is missing — run `npm run build` in extension/ first.');
  process.exit(1);
}
if (!payloadPath || !existsSync(payloadPath)) {
  console.error('Pass the path to a list_agents_response JSON file (see the header of this script).');
  process.exit(1);
}

const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
if (!payload.staleness) {
  console.error(`${payloadPath} has no \`staleness\` key — nothing to screenshot.`);
  process.exit(1);
}

const chromeBin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => {
  try {
    execFileSync('which', [c], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!chromeBin) {
  console.error('No Chrome or Chromium on PATH; cannot render the page.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png'
};

/**
 * The two chrome.runtime calls agents.jsx makes, and nothing else. Deliberately
 * minimal: anything more elaborate here starts substituting for the code under
 * test instead of standing in for the browser.
 */
const shim = (expand) => `
<script>
  const listeners = [];
  const PAYLOAD = ${JSON.stringify(payload)};
  window.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        if (msg.type === 'GET_DAEMON_STATUS' && cb) cb({ connected: true });
        if (msg.type === 'FETCH_AGENTS') {
          setTimeout(() => listeners.forEach(l =>
            l({ type: 'DAEMON_RESPONSE', payload: PAYLOAD })), 0);
        }
      },
      onMessage: {
        addListener: (f) => listeners.push(f),
        removeListener: () => {}
      }
    },
    tabs: { create() {} }
  };
  ${expand ? `setTimeout(() => document.querySelector('[role=alert] button')?.click(), 400);` : ''}
</script>
`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const expand = url.searchParams.get('expand') === '1';

  if (url.pathname === '/' || url.pathname === '/agents.html') {
    // Inject ahead of the bundle so the stub exists before React mounts.
    const html = readFileSync(path.join(distDir, 'agents.html'), 'utf8').replace(
      '<script type="module"',
      `${shim(expand)}<script type="module"`
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  const filePath = path.join(distDir, path.normalize(url.pathname));
  if (!filePath.startsWith(distDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'kan30-chrome-'));

const shoot = (name, query, height) => {
  const out = path.join(outDir, name);
  execFileSync(
    chromeBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--window-size=900,${height}`,
      '--virtual-time-budget=4000',
      `--screenshot=${out}`,
      `http://127.0.0.1:${port}/agents.html${query}`
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  console.log(`wrote ${out}`);
};

console.log(`rendering the built Agents page with: ${payload.staleness.summary}`);
shoot('collapsed.png', '', 620);
shoot('expanded.png', '?expand=1', 900);

rmSync(profile, { recursive: true, force: true });
server.close();
