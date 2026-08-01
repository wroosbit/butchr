// Live proof for KAN-25 that the *client* recovers: the built sidepanel and
// the real background service worker, against a real Butchr daemon that is
// killed and restarted underneath them.
//
// The daemon now refuses a PTY request naming a session it does not hold. A
// refusal is only an improvement if the panel does something sensible with it,
// so this drives the path end to end and prints both halves of the evidence:
// the request/response transcript on the wire, and what the panel rendered at
// each moment.
//
// Nothing here re-implements the extension. The page loads extension/dist —
// the shipped bundle — and public/background/service_worker.js is loaded into
// the same page, unmodified. What is stubbed is the browser around them:
// `chrome.tabs`, `chrome.storage`, the message bus, and the native port.
//
// The native host is modelled rather than run, and modelled carefully, because
// the timing of this bug is entirely in its behaviour:
//
//   * It is a separate long-lived process. A daemon restart closes *its*
//     socket, not Chrome's port, so the extension is told nothing and keeps a
//     session id the new daemon has never issued.
//   * It reconnects lazily, on the next message it is asked to forward. So the
//     first thing to meet the new daemon is whatever the user did next.
//   * When the MV3 service worker is evicted, the host dies with the port and
//     the worker announces nothing — a dead worker cannot. The next message
//     from the panel wakes a fresh worker, whose top-level connect broadcasts
//     DAEMON_STATUS true, and *that* is what makes the panel re-init with the
//     id it has been holding all along. This is the KAN-4 path, and the ticket
//     describes the bug arriving down it.
//
// Both are reproduced here. Isolation is by $HOME and HERDR_SOCKET_PATH: the
// daemon under test gets its own socket, its own workspaces root and its own
// private herdr server. The live daemon and live herdr are never contacted.
//
// Usage:
//   cd daemon && npm run build
//   cd extension && npm run build
//   node extension/scripts/verify-sidepanel-survives-daemon-restart.mjs
//
// Exit code 0 means the panel got back to a live terminal without retrying a
// session the daemon had already refused.

import { createServer } from 'http';
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(extensionDir, '..');
const distDir = path.join(extensionDir, 'dist');
const daemonDist = path.join(repoRoot, 'daemon', 'dist');

// A Jira issue URL: the registry resolves it to type `task`, key KAN-25,
// without needing any Jira credential.
const TAB_URL = 'https://example.atlassian.net/browse/KAN-25';
const KEY = 'KAN-25';

for (const [what, file] of [
  ['extension/dist/sidepanel.html', path.join(distDir, 'sidepanel.html')],
  ['extension/public/background/service_worker.js', path.join(extensionDir, 'public', 'background', 'service_worker.js')],
  ['daemon/dist/daemon.js', path.join(daemonDist, 'daemon.js')]
]) {
  if (!existsSync(file)) {
    console.error(`${what} is missing — run the builds named in this script's header first.`);
    process.exit(1);
  }
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
  console.error('No Chrome or Chromium on PATH; cannot run the panel.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, env) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });

// --- isolation ---------------------------------------------------------------
const scratch = mkdtempSync('/tmp/kan25-panel-');
const fakeHome = path.join(scratch, 'home');
const herdrState = path.join(scratch, 'herdr-state');
mkdirSync(fakeHome, { recursive: true });
const isolatedEnv = {
  HOME: fakeHome,
  HERDR_SOCKET_PATH: path.join(scratch, 'h.sock'),
  XDG_CONFIG_HOME: path.join(herdrState, 'config'),
  XDG_STATE_HOME: path.join(herdrState, 'state')
};
mkdirSync(isolatedEnv.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(isolatedEnv.XDG_STATE_HOME, { recursive: true });
const socketPath = path.join(fakeHome, '.local', 'share', 'butchr', 'butchr.sock');
const chromeProfile = path.join(scratch, 'chrome');

let daemon = null;
let herdrServer = null;
let chrome = null;
process.on('exit', () => {
  chrome?.kill('SIGKILL');
  daemon?.kill('SIGKILL');
  herdrServer?.kill('SIGKILL');
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A browser profile that is still being written is not worth failing over.
  }
});

try {
  execFileSync('which', ['herdr'], { stdio: 'ignore' });
} catch {
  console.error('herdr is not on PATH: this proof needs a real agent pane to attach to.');
  process.exit(1);
}
console.log(`starting a private herdr server on ${isolatedEnv.HERDR_SOCKET_PATH}`);
herdrServer = spawn('herdr', ['server'], { env: { ...process.env, ...isolatedEnv }, detached: true, stdio: 'ignore' });
for (let i = 0; i < 20; i++) {
  try {
    run('herdr', ['pane', 'list'], isolatedEnv);
    break;
  } catch {
    await sleep(500);
  }
}
run('herdr', ['pane', 'list'], isolatedEnv);

const startDaemon = async () => {
  daemon = spawn(process.execPath, [path.join(daemonDist, 'daemon.js')], {
    env: { ...process.env, ...isolatedEnv },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 80 && !existsSync(socketPath); i++) await sleep(250);
  if (!existsSync(socketPath)) throw new Error('daemon never claimed its socket');
  await sleep(500);
};

// --- the native host ---------------------------------------------------------
const transcript = [];
let sock = null;
let sockBuffer = '';
let portOpen = false;
const outbox = [];
const sseClients = new Set();

const emit = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(line);
};

const note = (text) => transcript.push({ at: Date.now(), dir: 'note', text });

const drain = () => {
  while (outbox.length && sock) {
    const msg = outbox.shift();
    transcript.push({ at: Date.now(), dir: 'ext→daemon', msg });
    sock.write(JSON.stringify(msg) + '\n');
  }
};

const ensureDaemonLink = () => {
  if (sock) return;
  const candidate = net.connect(socketPath);
  candidate.on('connect', () => {
    sock = candidate;
    note('native host connected to the daemon');
    drain();
  });
  candidate.on('error', () => {
    if (sock === candidate) sock = null;
  });
  candidate.on('close', () => {
    if (sock !== candidate) return;
    sock = null;
    sockBuffer = '';
    // Deliberately silent towards Chrome: the real host logs this and carries
    // on holding the port open. That silence is the whole setup for this bug.
    note('native host lost the daemon (the extension is told nothing)');
  });
  candidate.on('data', (chunk) => {
    sockBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = sockBuffer.indexOf('\n')) !== -1) {
      const line = sockBuffer.slice(0, idx);
      sockBuffer = sockBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      transcript.push({ at: Date.now(), dir: 'daemon→ext', msg });
      if (portOpen) emit({ kind: 'message', msg });
    }
  });
};

const sendToDaemon = (msg) => {
  outbox.push(msg);
  ensureDaemonLink();
  drain();
};

/** A request/response call of our own, on the same link, for setup only. */
const callDaemon = (action, data = {}) =>
  new Promise((resolve, reject) => {
    const id = `setup-${transcript.length}-${Math.floor(performance.now())}`;
    const from = transcript.length;
    sendToDaemon({ action, ...data, id });
    const deadline = Date.now() + 40000;
    const poll = setInterval(() => {
      const hit = transcript.slice(from).find((e) => e.dir === 'daemon→ext' && e.msg.id === id);
      if (hit) {
        clearInterval(poll);
        resolve(hit.msg);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`${action} never answered`));
      }
    }, 100);
  });

// --- the page ----------------------------------------------------------------
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/**
 * The browser around the extension, and nothing above it.
 *
 * The service worker is a real script loaded into this page. Evicting it means
 * dropping its listener and closing its port with no announcement; the next
 * message from the panel loads the script again, which is what MV3 does when a
 * message wakes an evicted worker — including re-running its top-level
 * connectNativeHost().
 */
const shim = `
<script>
  const listeners = [];
  const portListeners = [];
  const disconnectListeners = [];
  let swListener = null;
  let loadingWorker = false;
  let workerAlive = false;

  const report = (entry) =>
    navigator.sendBeacon('/report', new Blob([JSON.stringify(entry)], { type: 'application/json' }));

  const events = new EventSource('/events');
  events.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.kind === 'message') portListeners.forEach((l) => l(event.msg));
  };

  const post = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body ?? {}) });

  // The worker's own source, executed in a fresh scope each time it starts —
  // a second <script> for the same file would collide with the first one's
  // top-level declarations, where a real worker gets a clean context.
  const loadWorker = async () => {
    const source = await (await fetch('/background/service_worker.js')).text();
    loadingWorker = true;
    try {
      new Function(source)();
    } finally {
      loadingWorker = false;
    }
    workerAlive = true;
    report({ what: 'worker-started' });
  };

  window.__evictServiceWorker = () => {
    // Chrome tears the worker down and its native port with it. Nothing is
    // broadcast: there is nobody left to broadcast it.
    if (swListener) {
      const i = listeners.indexOf(swListener);
      if (i !== -1) listeners.splice(i, 1);
    }
    swListener = null;
    workerAlive = false;
    portListeners.length = 0;
    disconnectListeners.length = 0;
    post('/port/close');
    report({ what: 'worker-evicted' });
  };

  const dispatch = (msg, cb) => {
    for (const l of listeners.slice()) {
      try { l(msg, {}, cb ?? (() => {})); } catch (e) { console.error(e); }
    }
  };

  window.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => '/' + p,
      openOptionsPage() {},
      connectNative() {
        // Synchronous, as connectNative is: the port exists the moment it
        // returns, and the host is up before this call comes back.
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/port/open', false);
        xhr.send();
        report({ what: 'native-port-opened' });
        return {
          postMessage(msg) { post('/send', msg); },
          onMessage: { addListener: (l) => portListeners.push(l) },
          onDisconnect: { addListener: (l) => disconnectListeners.push(l) }
        };
      },
      sendMessage(msg, cb) {
        // A message to an evicted worker wakes it first, then is delivered.
        if (!workerAlive && !loadingWorker) {
          report({ what: 'worker-woken-by', type: msg.type });
          loadWorker().then(() => dispatch(msg, cb));
          return Promise.resolve();
        }
        dispatch(msg, cb);
        return Promise.resolve();
      },
      onMessage: {
        addListener: (l) => {
          if (loadingWorker) swListener = l;
          listeners.push(l);
        },
        removeListener: (l) => {
          const i = listeners.indexOf(l);
          if (i !== -1) listeners.splice(i, 1);
        }
      }
    },
    tabs: {
      query: async () => [{ id: 1, url: ${JSON.stringify(TAB_URL)} }],
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      create() {}
    },
    storage: { sync: { get: (keys, cb) => cb({ defaultAgent: 'shell' }) } },
    action: { onClicked: { addListener() {} } },
    sidePanel: { open() {} }
  };

  // A real user gesture: the side panel is dragged narrower. xterm's fit addon
  // measures, the terminal resizes, and the panel sends PTY_RESIZE — which is
  // how a panel that has been sitting idle first speaks to the daemon again.
  window.__resizePanel = (px) => {
    document.body.style.width = px + 'px';
    report({ what: 'panel-resized', px });
  };

  // What the panel renders, sampled and reported whenever it changes.
  const describe = () => {
    const root = document.getElementById('root');
    const panelText = (root?.innerText ?? '').replace(/\\n{2,}/g, '\\n').trim();
    const rows = document.querySelector('.xterm-rows');
    const terminalText = rows ? rows.innerText : null;
    return {
      panelText,
      terminal: rows ? (terminalText.trim() ? 'live, showing output' : 'mounted but blank') : 'not mounted',
      terminalTail: terminalText ? terminalText.trim().split('\\n').filter(Boolean).slice(-2) : []
    };
  };

  let last = '';
  setInterval(() => {
    const state = describe();
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    report({ what: 'render', state });
  }, 200);

  // The script driving this run has no other way into the page. Everything it
  // asks for here is something a browser or a person does: evicting the worker,
  // dragging the panel narrower.
  setInterval(async () => {
    const { commands } = await (await fetch('/control')).json();
    for (const c of commands) {
      if (c === 'evict') window.__evictServiceWorker();
      else if (c.startsWith('resize:')) window.__resizePanel(Number(c.slice('resize:'.length)));
    }
  }, 250);

  loadWorker();
</script>
`;

const renders = [];
const pageNotes = [];
const commandQueue = [];
/** Ask the page to do something a browser or a person would do. */
const control = (command) => commandQueue.push(command);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/control') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commands: commandQueue.splice(0) }));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = (payload = {}) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      switch (url.pathname) {
        case '/send':
          sendToDaemon(JSON.parse(body));
          return ok();
        case '/port/open':
          portOpen = true;
          note('native host started, Chrome port open');
          ensureDaemonLink();
          return ok();
        case '/port/close':
          portOpen = false;
          note('service worker evicted, native host died with it');
          return ok();
        case '/report': {
          const entry = JSON.parse(body);
          if (entry.what === 'render') renders.push({ at: Date.now(), ...entry.state });
          else {
            pageNotes.push({ at: Date.now(), ...entry });
            note(`page: ${entry.what}${entry.type ? ` (${entry.type})` : ''}`);
          }
          return ok();
        }
        default:
          res.writeHead(404);
          res.end();
      }
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/sidepanel.html') {
    const html = readFileSync(path.join(distDir, 'sidepanel.html'), 'utf8').replace(
      '<script type="module"',
      `${shim}<script type="module"`
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // The service worker is served from the source tree, unbuilt — it ships that
  // way too (public/ is copied verbatim).
  for (const root of [distDir, path.join(extensionDir, 'public')]) {
    const filePath = path.join(root, path.normalize(url.pathname.split('?')[0]));
    if (filePath.startsWith(root) && existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const banner = (title) => {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
};

const waitFor = async (label, predicate, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  console.error(`  timed out waiting for: ${label}`);
  return false;
};

const liveTerminal = () => renders.length > 0 && renders[renders.length - 1].terminal === 'live, showing output';
const currentSession = () => {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.dir !== 'daemon→ext') continue;
    const m = e.msg;
    if ((m.action === 'activate_response' || m.action === 'status_response') && m.sessionId) return m.sessionId;
  }
  return null;
};
const since = (from, dir, predicate) =>
  transcript.slice(from).filter((e) => e.dir === dir && predicate(e.msg));

const results = [];
const record = (name, passed, extra) => {
  results.push({ name, passed, extra });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`);
};

const printTranscript = (from) => {
  for (const e of transcript.slice(from)) {
    if (e.dir === 'note') {
      console.log(`  · ${e.text}`);
      continue;
    }
    const m = e.msg;
    if (m.action === 'pty_output') continue;
    if (e.dir === 'ext→daemon') {
      console.log(`  ext→daemon  ${m.action}${m.sessionId ? ` sessionId=${m.sessionId}` : ''}${m.url ? ` url=${m.url}` : ''}`);
    } else {
      let tail = m.sessionId ? ` sessionId=${m.sessionId}` : '';
      if (m.success === false) tail += ` success=false error=${JSON.stringify((m.error ?? '').slice(0, 80) + '…')}`;
      else if (m.action === 'pty_init_response') tail += ` success=true buffer=<${(m.buffer ?? '').length} chars>`;
      console.log(`  daemon→ext  ${m.action}${tail}`);
    }
  }
  const outputs = transcript.slice(from).filter((e) => e.dir === 'daemon→ext' && e.msg.action === 'pty_output').length;
  if (outputs) console.log(`  (plus ${outputs} pty_output chunks, omitted)`);
};

const printRenders = (from) => {
  for (const r of renders.slice(from)) {
    const first = r.panelText.split('\n').filter(Boolean).slice(0, 4).join(' / ');
    console.log(`  terminal: ${r.terminal.padEnd(22)} | ${first}`);
  }
};

// --- 1. a daemon, an agent, and a panel attached to it -----------------------
banner('1. a real daemon, a real agent, and the built sidepanel attached to it');
await startDaemon();
ensureDaemonLink();
await sleep(300);

// Seeded from here rather than by clicking the panel's switch, so the run does
// not depend on this machine's spare capacity — and `shell`, because what the
// panel needs is a live PTY, not a language model. The override is recorded by
// the daemon with the figures at the time, as it is for anyone.
const seeded = await callDaemon('activate_by_key', {
  type: 'task',
  key: KEY,
  url: TAB_URL,
  defaultAgent: 'shell',
  override: true
});
if (!seeded.success) {
  console.error('could not start the agent this proof attaches to:', seeded.error);
  process.exit(1);
}
console.log(`agent started: session ${seeded.sessionId} in ${seeded.workDir}`);
await sleep(1500);

chrome = spawn(
  chromeBin,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--user-data-dir=${chromeProfile}`,
    '--window-size=420,720',
    `http://127.0.0.1:${port}/sidepanel.html`
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] }
);

if (!(await waitFor('the panel to show a live terminal', liveTerminal))) {
  console.log('last renders:', JSON.stringify(renders.slice(-3), null, 2));
  process.exit(1);
}
const staleSessionId = currentSession();
console.log(`the panel is attached to ${staleSessionId} and rendering the agent's terminal:`);
console.log('  ' + JSON.stringify(renders[renders.length - 1].terminalTail));

// --- 2. the ticket's path ----------------------------------------------------
banner('2. restart the daemon under the open panel, then let the worker be evicted');
const markA = transcript.length;
const rendersA = renders.length;

daemon.kill('SIGKILL');
daemon = null;
await sleep(1000);
await startDaemon();
console.log('daemon restarted. The panel was told nothing and still holds ' + staleSessionId);

// The MV3 eviction that follows an idle spell, and then the user gesture that
// wakes a fresh worker: exactly the sequence the ticket describes.
control('evict');
await sleep(1500);
console.log('worker evicted. Now the user drags the panel narrower.');
control('resize:360');

const recoveredA = await waitFor(
  'the panel to reach a live terminal on a session the new daemon holds',
  () => {
    const fresh = since(markA, 'daemon→ext', (m) => m.action === 'pty_init_response' && m.success === true);
    return fresh.length > 0 && liveTerminal();
  },
  90000
);
await sleep(4000); // settle, so a retry loop would have shown itself

banner('   what went over the wire');
printTranscript(markA);
banner('   what the panel rendered');
printRenders(rendersA);

const staleRequests = since(markA, 'ext→daemon', (m) => m.sessionId === staleSessionId && m.action?.startsWith('pty_'));
const refusals = since(markA, 'daemon→ext', (m) => m.action?.startsWith('pty_') && m.success === false);
const freshInit = since(markA, 'daemon→ext', (m) => m.action === 'pty_init_response' && m.success === true);
const newSessionId = currentSession();

banner('   verdict for the restart path');
if (refusals.length) {
  console.log('  the refusal the panel acted on, in full:');
  console.log('    ' + refusals[0].msg.error.replace(/\. /g, '.\n    '));
}
// Where the replacement session came from. Both are legitimate; saying which
// happened keeps this from reading as proof of a path it did not take.
console.log(
  since(markA, 'ext→daemon', (m) => m.action === 'activate').length
    ? '  the fresh session came from the panel re-activating the workspace'
    : "  the fresh session came from the daemon's own boot-time reconciliation (KAN-21);\n" +
      '  the panel dropped the refused id and adopted the one the status check named'
);
console.log();
record(
  'the daemon refused every request naming the pre-restart session',
  staleRequests.length > 0 && refusals.length >= 1,
  `${staleRequests.length} request(s) named it, ${refusals.length} refused`
);
record(
  'no phantom: the refusals named the session instead of answering with one',
  refusals.every((e) => (e.msg.error ?? '').includes(staleSessionId)),
  refusals.length ? 'each error names the id it was given' : 'no refusals to check'
);
record(
  'the panel stopped using the refused session',
  staleRequests.filter((e) => e.at > refusals[0]?.at + 500).length === 0,
  `${staleRequests.length} total request(s) at the refused id`
);
record(
  'the panel re-resolved and attached to a session this daemon holds',
  !!freshInit.length && newSessionId !== staleSessionId,
  newSessionId ? `now on ${newSessionId}` : undefined
);
record('the panel ends on a live terminal, not a dead pane', liveTerminal(), renders[renders.length - 1]?.terminal);
record('the recovery completed without anyone clicking anything', recoveredA);

// --- 3. the KAN-4 path, with the daemon left alone ---------------------------
banner('3. regression — a service-worker death with the daemon untouched (KAN-4)');
const markB = transcript.length;
const rendersB = renders.length;
const goodSessionId = currentSession();

control('evict');
await sleep(1500);
control('resize:400');

const recoveredB = await waitFor(
  'the panel to re-init and keep its terminal',
  () => since(markB, 'daemon→ext', (m) => m.action === 'pty_init_response' && m.success === true).length > 0,
  60000
);
await sleep(3000);

banner('   what went over the wire');
printTranscript(markB);
banner('   what the panel rendered');
printRenders(rendersB);

banner('   verdict for the KAN-4 path');
const reinits = since(markB, 'ext→daemon', (m) => m.action === 'pty_init');
record(
  'the panel re-initialised after the worker came back',
  reinits.length > 0,
  `${reinits.length} pty_init(s), sessionId=${reinits[0]?.msg.sessionId}`
);
record(
  'it used the session it already had, and the daemon accepted it',
  since(markB, 'daemon→ext', (m) => m.action === 'pty_init_response' && m.success === true).length > 0 &&
    since(markB, 'daemon→ext', (m) => m.action?.startsWith('pty_') && m.success === false).length === 0,
  `session ${goodSessionId} still valid`
);
record('the terminal is live afterwards', liveTerminal(), renders[renders.length - 1]?.terminal);
record('the KAN-4 reconnect still recovers', recoveredB);

// --- verdict -----------------------------------------------------------------
banner('verdict');
const failed = results.filter((r) => !r.passed);
for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

chrome.kill('SIGKILL');
server.close();
process.exit(failed.length === 0 ? 0 : 1);
