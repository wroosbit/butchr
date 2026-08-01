import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';
import { MessageRouter } from './router.js';
import { JiraIssueTypeService } from './jira.js';
import { CredentialStore } from './credentials.js';
import { BUTCHR_DIR, SOCKET_PATH, ensureButchrDir, onJsonLines, writeJsonLine } from './ipc.js';
import { resolveUserPath, which } from './env.js';
import { getStalenessReport, formatStalenessReport } from './staleness.js';
import { readFdUsage, isFdCeilingUnraised, describeFdCeiling, checkHerdrVersion } from './herdr-health.js';
import { execFileSync } from 'child_process';

// The single long-lived Butchr daemon. Owns all sessions, PTYs, and the
// workspace registry. Clients (Chrome native-host proxies, the MCP server)
// connect over a Unix domain socket speaking newline-delimited JSON, so
// filesystem permissions are the auth boundary and there is no TCP port
// for multiple browser profiles to fight over.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../');

ensureButchrDir();
const logStream = fs.createWriteStream(path.join(BUTCHR_DIR, 'daemon.log'), { flags: 'a' });
const log = (...args: any[]) => {
  const line = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
};
// The daemon normally runs detached; shared modules log via console.
console.log = log;
console.error = log;

process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log('Unhandled rejection:', err as any);
});

// Normalize PATH before anything spawns: this daemon outlives the client that
// started it, and its environment is inherited by every herdr pane and agent.
process.env.PATH = resolveUserPath();
const herdrPath = which('herdr');
log(`PATH resolved to: ${process.env.PATH}`);
if (herdrPath) {
  log(`herdr found at ${herdrPath}`);
  // Which herdr, not just whether there is one: 0.7 changed `agent start`
  // incompatibly, and without this the only symptom is `unknown option: --cwd`
  // on every activation.
  try {
    const version = execFileSync(herdrPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    log(`herdr version: ${version.trim()}`);
    const versionWarning = checkHerdrVersion(version);
    if (versionWarning) log(`WARNING: ${versionWarning}`);
  } catch (e: any) {
    log(`Could not read herdr's version: ${e?.message ?? String(e)}`);
  }
} else {
  log('WARNING: herdr not found on PATH; agent sessions will fail to attach');
}

// The pane ceiling, checked once at startup rather than left to be discovered
// as a total spawn outage. A herdr on the stock 1024 soft limit runs out of
// descriptors at ~205 panes; the fix is a setup step, and a setup step nobody
// verifies is folklore (KAN-33). Reported here and by
// daemon/scripts/butchr-doctor.mjs so the two cannot disagree.
const fdUsage = readFdUsage();
if (!fdUsage) {
  log('herdr fd limit: no running herdr server to inspect (or no /proc); skipping the check');
} else if (isFdCeilingUnraised(fdUsage)) {
  log(`WARNING: ${describeFdCeiling(fdUsage)}`);
} else {
  log(
    `herdr fd limit: soft ${fdUsage.softLimit}, ${fdUsage.openFds} open, ` +
    `headroom ≈ ${fdUsage.headroomPanes} panes (pid ${fdUsage.pid})`
  );
}

// Jira access exists for exactly one question — is this issue a Task or a
// Story? — and is strictly read-only. The service never throws and always
// answers within its own timeout, so the registry can depend on it without
// activation ever being able to hang or fail on Jira's account.
const jira = new JiraIssueTypeService(new CredentialStore());
const registry = new WorkspaceRegistry((key) => jira.getIssueTypeName(key));
const promptLoader = new PromptLoader(repoRoot);
const herdrBridge = new HerdrBridge();

const credentialStatus = jira.status();
log(
  credentialStatus.configured
    ? `Jira credential configured for ${credentialStatus.email} @ ${credentialStatus.siteUrl} (stored in ${credentialStatus.storage})`
    : 'No Jira credential configured; Jira issue URLs will all resolve to type `task`'
);
// When this process started, so the staleness check can tell a rebuilt `dist/`
// from a daemon that has actually loaded it. Captured before anything slow.
const daemonStartedAt = new Date();

// Nothing about a merged PR reaches this machine on its own: the clone is not
// pulled, `dist/` does not rebuild, Chrome does not reload. Report it at
// startup — the daemon is restarted precisely when someone has just changed
// something, which is the moment the answer matters. Local reads only; a
// blocking `git fetch` here would trade a silent failure for a slow one.
for (const line of formatStalenessReport(
  getStalenessReport({ repoRoot, daemonStartedAt, force: true })
)) {
  log(line);
}

const connections = new Set<net.Socket>();

const broadcast = (msg: any) => {
  for (const conn of connections) {
    writeJsonLine(conn, msg);
  }
};

// A PTY that dies takes the terminal with it, and the client has no other way
// to find out: output simply stops. Announcing it is what lets the sidepanel
// show a disconnected state instead of a frozen last frame.
herdrBridge.setSessionEndedListener((event) => {
  log(
    `Session ended: ${event.sessionId} (${event.type}/${event.key}) ` +
    `reason=${event.reason} exitCode=${event.exitCode}`
  );
  broadcast({ action: 'agent_detached_event', ...event });
});

const server = net.createServer((socket) => {
  connections.add(socket);
  log(`Client connected (${connections.size} total)`);

  // One router per connection: responses go back to the requesting client,
  // pty listeners registered by this client die with its connection.
  const router = new MessageRouter(
    registry,
    promptLoader,
    herdrBridge,
    (msg) => writeJsonLine(socket, msg),
    broadcast,
    jira,
    { repoRoot, daemonStartedAt }
  );

  onJsonLines(
    socket,
    (msg) => {
      try {
        router.handle(msg);
      } catch (err: any) {
        log('Handler error:', err);
        writeJsonLine(socket, {
          success: false,
          error: err?.message ?? String(err),
          ...(msg?.id !== undefined ? { id: msg.id } : {})
        });
      }
    },
    (err) => log('Bad JSON line from client:', err.message)
  );

  socket.on('error', (err) => log('Client socket error:', err.message));
  socket.on('close', () => {
    connections.delete(socket);
    router.cleanup();
    log(`Client disconnected (${connections.size} total)`);
  });
});

let retriedStaleSocket = false;
server.on('error', (err: any) => {
  if (err.code !== 'EADDRINUSE') {
    log('Server error:', err);
    process.exit(1);
  }
  // Socket file exists: either a live daemon owns it, or it's stale from a crash.
  const probe = net.connect(SOCKET_PATH);
  probe.once('connect', () => {
    probe.end();
    log('Another daemon is already running; exiting.');
    process.exit(0);
  });
  probe.once('error', () => {
    if (retriedStaleSocket) {
      log('Could not claim socket after stale-file cleanup; exiting.');
      process.exit(1);
    }
    retriedStaleSocket = true;
    log('Removing stale socket file');
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
    server.listen(SOCKET_PATH, onListen);
  });
});

function onListen() {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {}
  log(`Butchr daemon listening on ${SOCKET_PATH} (pid ${process.pid})`);
}

const shutdown = () => {
  log('Shutting down');
  server.close();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(SOCKET_PATH, onListen);
