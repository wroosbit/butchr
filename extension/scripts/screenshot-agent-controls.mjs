// Screenshots of the *built* Agents page driving its new on/off controls, so
// "what the human actually sees before an agent is stopped" is an image of the
// shipped bundle rather than a description of intent.
//
// It loads extension/dist over http (the built page uses absolute asset paths,
// so file:// will not do) with one script injected ahead of the bundle: a stub
// of the chrome.runtime calls agents.jsx makes. Everything below that — React,
// the components, the styling, the state machine in useFleetControls — is the
// real thing, and so are the payloads.
//
// The payloads are not invented here. Produce them first with:
//
//   cd daemon && npm run build
//   node scripts/verify-agent-power-controls.mjs --dump /tmp/kan38-payloads
//
// which drives the real MessageRouter and writes the exact list_agents_response,
// agent_work_state_response and refused activate_response it answered with.
// Then:
//
//   cd extension && npm run build
//   node scripts/screenshot-agent-controls.mjs /tmp/kan38-payloads /tmp/shots
//
// Writes five images:
//
//   fleet.png             the page at rest — running agents, a loss, a stood-down list
//   confirm-agent.png     Off pressed on a task agent that has uncommitted work
//   confirm-epic.png      Off pressed on an epic supervisor
//   confirm-story.png     Off pressed on a story supervisor
//   refusal.png           Turn on pressed at capacity
//
// Needs a browser that will actually render. Headless Chrome fails to produce a
// frame at all in some sandboxes; when that happens the daemon-side script
// prints the same four states as text and proves the payloads behind them.

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', 'dist');
const payloadDir = process.argv[2];
const outDir = process.argv[3] ?? path.resolve(scriptDir, '..', '..', 'kan38-screenshots');

if (!existsSync(path.join(distDir, 'agents.html'))) {
  console.error('extension/dist/agents.html is missing — run `npm run build` in extension/ first.');
  process.exit(1);
}
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
 * The service worker, as far as agents.jsx can tell.
 *
 * Every branch here answers with a payload the daemon produced, and nothing
 * here decides anything: the refusal is the daemon's refusal, the work state is
 * the daemon's reading of a real dirty repository. What this stands in for is
 * the message transport, which is the one part of the page a headless browser
 * has no way to provide.
 *
 * `act` drives the page the way a person would — by clicking the button with a
 * given title — because the states worth photographing are the ones that only
 * exist after a click.
 */
const shim = (act, polls = 5) => `
<script>
  /*
    The 2-second poll, bounded.

    Not removed — a screenshot of a confirmation that survived four polls is
    worth more than one of a confirmation nobody challenged, and the poll
    running underneath these images is what makes them evidence about poll
    stability rather than about a still page. Bounded because Chrome's
    --virtual-time-budget advances the clock as fast as tasks are produced, and
    a genuine setInterval produces them for ever: the budget then never expires
    and the browser hangs instead of taking a picture.
  */
  window.setInterval = (fn, ms) => {
    let fired = 0;
    const tick = () => {
      if (fired++ >= ${polls}) return;
      fn();
      setTimeout(tick, ms);
    };
    setTimeout(tick, ms);
    return 0;
  };

  const listeners = [];
  const LIST = ${JSON.stringify(listAgents)};
  const WORK = ${JSON.stringify(workState)};
  const REFUSAL = ${JSON.stringify(refusal)};
  const emit = (payload) => setTimeout(() =>
    listeners.forEach(l => l({ type: 'DAEMON_RESPONSE', payload })), 0);

  window.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        if (msg.type === 'GET_DAEMON_STATUS' && cb) cb({ connected: true });
        if (msg.type === 'FETCH_AGENTS') emit(LIST);
        if (msg.type === 'FETCH_AGENT_WORK_STATE') {
          emit({ ...WORK, type: msg.workspaceType, key: msg.key });
        }
        if (msg.type === 'ACTIVATE_BUTCHR_BY_KEY') {
          emit({ ...REFUSAL, type: msg.workspaceType, key: msg.key });
        }
      },
      onMessage: {
        addListener: (f) => listeners.push(f),
        removeListener: () => {}
      }
    },
    tabs: { create() {} },
    storage: { sync: { get: (_k, cb) => cb({}) } }
  };

  ${act ? `
  setTimeout(() => {
    const target = Array.from(document.querySelectorAll('button'))
      .find(b => b.title === ${JSON.stringify(act)});
    if (target) target.click();
    else console.error('no button titled ${act}');
  }, 600);
  ` : ''}
</script>
`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/agents.html') {
    // Injected ahead of the bundle so the stub exists before React mounts.
    const html = readFileSync(path.join(distDir, 'agents.html'), 'utf8').replace(
      '<script type="module"',
      `${shim(url.searchParams.get('act'))}<script type="module"`
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
const profile = mkdtempSync(path.join(tmpdir(), 'kan38-chrome-'));

const shoot = (name, act, height) => {
  const out = path.join(outDir, name);
  const query = act ? `?act=${encodeURIComponent(act)}` : '';
  try {
    execFileSync(
      chromeBin,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        `--window-size=900,${height}`,
        // Long enough for the click at 600ms and the polls that follow it, and
        // finite because the shim above made the poll finite.
        '--virtual-time-budget=9000',
        `--screenshot=${out}`,
        `http://127.0.0.1:${port}/agents.html${query}`
      ],
      // A wall-clock ceiling, because the failure mode this script actually
      // meets is not an error: headless Chrome in an agent container loads this
      // page and then never produces a frame, and without a timeout the script
      // hangs indefinitely rather than saying so. Failing loudly and naming the
      // alternative is the difference between a broken tool and a tool with a
      // documented limit.
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90_000 }
    );
  } catch (e) {
    console.error(
      `\nheadless ${chromeBin} produced no frame for ${name} (${e?.signal ?? e?.code ?? e?.message}).\n` +
      'Some sandboxes — agent containers among them — will not render this page at all.\n' +
      'Use render-agent-controls.mjs instead: it renders the same components with\n' +
      'react-dom/server against the same payloads and emits a static page that every\n' +
      'headless browser can screenshot.'
    );
    process.exit(1);
  }
  console.log(`wrote ${out}`);
};

const running = listAgents.agents.map((a) => `${a.type}/${a.key}`);
console.log(`rendering the built Agents page: ${running.join(', ')}`);
console.log(`  stood down: ${listAgents.standbyAgents.map((a) => `${a.type}/${a.key}`).join(', ')}`);

// Lower-case keys: the dumped agents are sessionless census rows, and a key
// recovered from an agent name arrives as `kan-38` (see router.ts, list_agents)
// — so that is what the shipped button's title actually says.
shoot('fleet.png', null, 1200);
shoot('confirm-agent.png', 'Stop task/kan-38', 1200);
shoot('confirm-epic.png', 'Stop epic/kan-39', 1200);
shoot('confirm-story.png', 'Stop story/kan-40', 1200);
shoot('refusal.png', 'Start task/KAN-21', 1400);

rmSync(profile, { recursive: true, force: true });
server.close();
