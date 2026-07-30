import * as path from 'path';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';

import { MessageRouter } from './router.js';
import { fileURLToPath } from 'url';
import * as http from 'http';

import * as fs from 'fs';

// Redirect all standard console logging to stderr to protect stdout for binary framing
console.log = (...args: any[]) => process.stderr.write('[NativeHost LOG] ' + args.join(' ') + '\n');
console.error = (...args: any[]) => process.stderr.write('[NativeHost ERR] ' + args.join(' ') + '\n');

process.on('uncaughtException', (err) => {
  fs.appendFileSync('/tmp/native-host.log', `Uncaught exception: ${err.stack}\n`);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../');
const registry = new WorkspaceRegistry();
const promptLoader = new PromptLoader(repoRoot);
const herdrBridge = new HerdrBridge();
const clients = new Set<http.ServerResponse>();

const broadcastEvent = (msg: any) => {
  sendNativeMessage(msg);
  const dataStr = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of clients) {
    client.write(dataStr);
  }
};

// Requests arriving over HTTP register here under a generated id. The router
// echoes that id on the reply, which lets us route it back to the right
// socket instead of mutating shared state per request.
interface PendingRequest {
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 30_000;
let nextRequestId = 0;

const dispatch = (msg: any) => {
  const entry = msg?.id !== undefined ? pending.get(msg.id) : undefined;
  if (entry) {
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    const { id, ...body } = msg;
    entry.res.writeHead(200, { 'Content-Type': 'application/json' });
    entry.res.end(JSON.stringify(body));
    return;
  }
  // No pending HTTP caller: this is a reply to Chrome, or a streamed event.
  sendNativeMessage(msg);
};

const router = new MessageRouter(registry, promptLoader, herdrBridge, dispatch, broadcastEvent);

// Start local HTTP API for MCP bridge
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/api') {
      try {
        const data = JSON.parse(body);

        const id = `http-${++nextRequestId}`;
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Request timed out' }));
          }
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { res, timer });

        req.on('close', () => {
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            clearTimeout(entry.timer);
          }
        });

        router.handle({ ...data, id });
      } catch (err) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
});
server.listen(4040, '127.0.0.1');

console.log('Butchr Native Messaging Host initialized');

function sendNativeMessage(msg: any) {
  const jsonBuf = Buffer.from(JSON.stringify(msg), 'utf-8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBuf.length, 0);

  process.stdout.write(lenBuf);
  process.stdout.write(jsonBuf);
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) {
      break; // Wait for full message
    }

    const jsonBuf = inputBuffer.subarray(4, 4 + msgLen);
    inputBuffer = inputBuffer.subarray(4 + msgLen);

    try {
      const data = JSON.parse(jsonBuf.toString('utf-8'));
      console.log('Received message:', data.action);
      router.handle(data);
    } catch (err: any) {
      console.error('JSON parse error:', err);
      sendNativeMessage({ success: false, error: 'Invalid JSON payload' });
    }
  }
});

process.stdin.on('end', () => {
  console.log('Stdin closed. Native host exiting.');
  router.cleanup();
  process.exit(0);
});
