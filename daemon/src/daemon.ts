import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';
import { MessageRouter } from './router.js';
import { BUTCHR_DIR, SOCKET_PATH, ensureButchrDir, onJsonLines, writeJsonLine } from './ipc.js';

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

const registry = new WorkspaceRegistry();
const promptLoader = new PromptLoader(repoRoot);
const herdrBridge = new HerdrBridge();
const connections = new Set<net.Socket>();

const broadcast = (msg: any) => {
  for (const conn of connections) {
    writeJsonLine(conn, msg);
  }
};

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
    broadcast
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
